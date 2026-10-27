import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = resolve(packageRoot, '../..');
const artifacts = join(packageRoot, 'artifacts', 'packaging-' + randomUUID());
const consumer = mkdtempSync(join(tmpdir(), 'oracle-minimal-package-'));
const tarballs = join(consumer, 'tarballs');
mkdirSync(artifacts, { recursive: true });
mkdirSync(tarballs);
const require = createRequire(import.meta.url);
const log = createWriteStream(join(artifacts, 'commands.log'));
const packages = [];
const checks = {};
async function command(binary, args, cwd, acceptedCodes = [0]) {
  const child = spawn(binary, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => output.push(chunk));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
  assert.ok(acceptedCodes.includes(code), 'Package command failed; inspect ' + artifacts + '/commands.log');
  return { code, output: Buffer.concat(output).toString('utf8') };
}
async function run() {
  const dependencies = {};
  // Only the Oracle adapter and its current local framework/type dependency graph.
  for (const name of ['@mastra/oracledb', '@mastra/core', '@mastra/schema-compat']) {
    const path =
      name === '@mastra/schema-compat'
        ? createRequire(require.resolve('@mastra/core/package.json')).resolve(name + '/package.json')
        : require.resolve(name + '/package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const before = new Set(readdirSync(tarballs));
    await command('pnpm', ['--config.ignore-scripts=true', 'pack', '--pack-destination', tarballs], dirname(path));
    const file = readdirSync(tarballs).find(file => !before.has(file) && file.endsWith('.tgz'));
    assert.ok(file, 'No package tarball was produced.');
    const tarball = join(tarballs, file);
    dependencies[name] = 'file:' + tarball;
    packages.push({
      name,
      version: manifest.version,
      sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    });
  }
  const local = { ...dependencies };
  for (const name of ['typescript', '@types/node']) {
    dependencies[name] = JSON.parse(readFileSync(require.resolve(name + '/package.json'), 'utf8')).version;
  }
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'minimal-oracle-package-consumer', private: true, type: 'module', dependencies }, null, 2),
  );
  writeFileSync(
    join(consumer, 'pnpm-workspace.yaml'),
    [
      'packages:',
      "  - '.'",
      'allowBuilds:',
      '  oracledb: false',
      'overrides:',
      ...Object.entries(local).map(([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value)),
    ].join('\n'),
  );
  await command('pnpm', ['install', '--ignore-scripts', '--prefer-offline'], consumer);
  let installedLinks = 0;
  function assertIsolated(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        installedLinks++;
        const target = realpathSync(full);
        assert.ok(
          target !== checkout && !target.startsWith(checkout + '/'),
          'Workspace link leaked into the minimal consumer.',
        );
      } else if (entry.isDirectory()) assertIsolated(full);
    }
  }
  assertIsolated(join(consumer, 'node_modules'));
  checks.isolation = { status: 'passed', installedLinks };
  const fixture = readFileSync(join(packageRoot, 'scripts/packaging/consumer.ts.txt'), 'utf8');
  for (const extension of ['mts', 'cts']) writeFileSync(join(consumer, 'consumer.' + extension), fixture);
  const runtime = readFileSync(join(packageRoot, 'scripts/packaging/runtime.mjs'), 'utf8');
  writeFileSync(
    join(consumer, 'runtime.mjs'),
    runtime + "\nassert.match(import.meta.resolve('@mastra/oracledb'), /\\/dist\\/index\\.js$/);\n",
  );
  writeFileSync(
    join(consumer, 'runtime.cjs'),
    '(async () => {\n' +
      runtime.replace(
        /^import (.+) from '([^']+)';$/gm,
        (_, names, specifier) => 'const ' + names + ' = require(' + JSON.stringify(specifier) + ');',
      ) +
      "\nassert.match(require.resolve('@mastra/oracledb'), /\\/dist\\/index\\.cjs$/);" +
      '\n})().catch(error => { console.error(error); process.exitCode = 1; });\n',
  );
  for (const extension of ['mjs', 'cjs']) {
    await command(process.execPath, ['runtime.' + extension], consumer);
    checks[extension === 'mjs' ? 'esm' : 'cjs'] = 'passed';
  }
  const options = {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: ['node'],
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
  };
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: options, files: ['consumer.mts', 'consumer.cts'] }, null, 2),
  );
  // Invalid source files deliberately produce diagnostics; no suppression or replacement driver types.
  const negatives = {
    pool: "export const config: OracleConnectionConfig = { pool: 'invalid' };",
    poolProperty:
      "export function invalid(pool: NonNullable<OracleConnectionConfig['pool']>) { const value: string = pool.connectionsOpen; return value; }",
    connection:
      "export function invalid(manager: OraclePoolManager) { return manager.withConnection(async connection => { connection.callTimeout = 'invalid'; }); }",
    config: "export const config: OracleConnectionConfig = { poolMax: 'invalid' };",
    vector: "export const query: OracleQueryVectorParams = { indexName: 'consumer', queryVector: ['invalid'] };",
  };
  const negativeFiles = [];
  for (const extension of ['mts', 'cts'])
    for (const [name, body] of Object.entries(negatives)) {
      const file = 'invalid-' + name + '.' + extension;
      writeFileSync(
        join(consumer, file),
        "import type { OraclePoolManager, OracleConnectionConfig, OracleQueryVectorParams } from '@mastra/oracledb';\n" +
          body +
          '\n',
      );
      negativeFiles.push(file);
    }
  function diagnostics(output) {
    const result = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^(.*?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
      if (match)
        result.push({
          file: match[1],
          line: Number(match[2]),
          column: Number(match[3]),
          code: Number(match[4]),
          category: 'Error',
          message: match[5],
        });
      else {
        const global = /^error TS(\d+): (.*)$/.exec(line);
        if (global) result.push({ code: Number(global[1]), category: 'Error', message: global[2] });
        else if (line.trim() && result.length) result[result.length - 1].message += '\n' + line;
      }
    }
    return result;
  }
  const compiler = join(consumer, 'node_modules/typescript/bin/tsc');
  const strict = await command(
    process.execPath,
    [compiler, '--project', 'tsconfig.json', '--pretty', 'false'],
    consumer,
    [0, 1, 2],
  );
  const positiveDiagnostics = diagnostics(strict.output);
  assert.ok(
    strict.code === 0 || positiveDiagnostics.length > 0,
    'Compiler failed without readable TypeScript diagnostics.',
  );
  writeFileSync(join(artifacts, 'strict-diagnostics.log'), strict.output);
  writeFileSync(
    join(consumer, 'tsconfig.negative.json'),
    JSON.stringify({ compilerOptions: options, files: negativeFiles }, null, 2),
  );
  const negative = await command(
    process.execPath,
    [compiler, '--project', 'tsconfig.negative.json', '--pretty', 'false'],
    consumer,
    [0, 1, 2],
  );
  writeFileSync(join(artifacts, 'negative-diagnostics.log'), negative.output);
  let driverResolution = null;
  try {
    const driverManifest = createRequire(
      realpathSync(join(consumer, 'node_modules/@mastra/oracledb/package.json')),
    ).resolve('@types/oracledb/package.json');
    assert.ok(
      realpathSync(driverManifest).startsWith(consumer + '/'),
      'Driver types must come from the installed consumer.',
    );
    driverResolution = {
      resolvedFileName: join(
        dirname(driverManifest),
        JSON.parse(readFileSync(driverManifest, 'utf8')).types ?? 'index.d.ts',
      ),
    };
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const result = {
    options,
    positiveRoots: ['consumer.mts', 'consumer.cts'],
    diagnostics: positiveDiagnostics,
    compilerExitCode: strict.code,
    driverResolution,
    negativeDiagnostics: diagnostics(negative.output).filter(item =>
      negativeFiles.includes(item.file?.split('/').at(-1)),
    ),
    negativeFiles,
  };
  writeFileSync(join(artifacts, 'diagnostics.json'), JSON.stringify(result, null, 2));
  const errors = result.diagnostics.filter(item => item.category === 'Error');
  const oracleErrors = errors.filter(item => item.file?.includes('/@mastra/oracledb/'));
  const consumerErrors = errors.filter(item => /^consumer\.[mc]ts$/.test(item.file?.split('/').at(-1) ?? ''));
  const driverErrors = errors.filter(item => item.file?.includes('/@types/oracledb/'));
  const configurationErrors = errors.filter(item => !item.file);
  const sharedErrors = errors.filter(
    item =>
      !oracleErrors.includes(item) &&
      !consumerErrors.includes(item) &&
      !driverErrors.includes(item) &&
      !configurationErrors.includes(item),
  );
  const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/@mastra/oracledb/package.json'), 'utf8'));
  const negativeChecks = result.negativeFiles.map(file => ({
    file,
    rejected: result.negativeDiagnostics.some(
      item => item.file?.split('/').at(-1) === file && item.category === 'Error' && item.code === 2322,
    ),
  }));
  checks.oracle = {
    productionDriverTypes: Boolean(manifest.dependencies?.['@types/oracledb']),
    noConsumerDriverTypesDependency: !dependencies['@types/oracledb'],
    driverTypeResolution: result.driverResolution?.resolvedFileName ?? null,
    oracleErrors: oracleErrors.length,
    consumerErrors: consumerErrors.length,
    driverErrors: driverErrors.length,
    negativeChecks,
  };
  const oraclePassed =
    checks.oracle.productionDriverTypes &&
    checks.oracle.noConsumerDriverTypesDependency &&
    Boolean(result.driverResolution?.resolvedFileName?.includes('/@types/oracledb/')) &&
    oracleErrors.length === 0 &&
    consumerErrors.length === 0 &&
    driverErrors.length === 0 &&
    configurationErrors.length === 0 &&
    negativeChecks.every(check => check.rejected);
  const report = {
    status: !oraclePassed ? 'failed' : errors.length ? 'blocked-by-shared-declarations' : 'passed',
    oraclePackaging: oraclePassed ? 'passed' : 'failed',
    fullStrictConsumer: errors.length ? 'failed' : 'passed',
    consumer,
    packages,
    checks,
    diagnostics: {
      total: errors.length,
      oracle: oracleErrors.length,
      consumer: consumerErrors.length,
      driver: driverErrors.length,
      shared: sharedErrors.length,
      configuration: configurationErrors.length,
    },
    sharedLimitations: [
      'Shared declaration builder, schema-compat, vendored AI SDK and general Zod compatibility are outside this Oracle packaging correction.',
    ],
    excluded: ['Studio advanced trace-query support'],
    databaseConnected: false,
  };
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        artifacts,
        oraclePackaging: report.oraclePackaging,
        fullStrictConsumer: report.fullStrictConsumer,
        diagnostics: report.diagnostics,
      },
      null,
      2,
    ),
  );
  // Shared errors are never turned into a green strict-consumer certification.
  if (errors.length || !oraclePassed) process.exitCode = 1;
}
console.log('Oracle packaging evidence: ' + artifacts);
try {
  await run();
} catch (error) {
  writeFileSync(
    join(artifacts, 'failure.json'),
    JSON.stringify({ error: String(error), consumer, packages, checks }, null, 2),
  );
  throw error;
} finally {
  log.end();
}
