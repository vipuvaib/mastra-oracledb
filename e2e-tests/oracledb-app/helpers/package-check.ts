import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const artifacts = join(root, 'artifacts', `packages-${randomUUID()}`);
mkdirSync(artifacts, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'mastra-oracle-consumer-'));
const tarballs = join(temporary, 'tarballs');
mkdirSync(tarballs);
const logFile = join(artifacts, 'commands.log');
const { createWriteStream } = await import('node:fs');
const log = createWriteStream(logFile);
async function command(executable: string, args: string[], cwd: string, timeoutMs = 180_000) {
  const child = spawn(executable, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  const code = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
  if (code) throw new Error(`Package validation failed: ${executable} exited ${code}. Inspect ${logFile}.`);
}
const selected = [
  '@mastra/core',
  '@mastra/memory',
  '@mastra/oracledb',
  '@mastra/client-js',
  '@mastra/hono',
  '@mastra/observability',
  '@mastra/server',
  '@mastra/schema-compat',
];
const dependencies: Record<string, string> = {};
const checks: Record<string, string> = {};
const withOracle = process.argv.includes('--oracle');
const withCompiled = process.argv.includes('--compiled');
const packages: { name: string; version: string; sha256: string }[] = [];
try {
  for (const name of selected) {
    const manifestPath = require.resolve(name + '/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
    const before = new Set(readdirSync(tarballs));
    await command(
      'pnpm',
      ['--config.ignore-scripts=true', 'pack', '--pack-destination', tarballs],
      dirname(manifestPath),
    );
    const file = readdirSync(tarballs).find(file => !before.has(file) && file.endsWith('.tgz'));
    if (!file) throw new Error(`No tarball produced for ${name}.`);
    const path = join(tarballs, file);
    dependencies[name] = 'file:' + path;
    packages.push({
      name,
      version: manifest.version,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
  }
  for (const name of ['tsx', 'typescript', 'vitest', '@types/node', 'hono', 'zod', '@hono/node-server']) {
    dependencies[name] = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  dependencies['@ai-sdk/provider-v5'] = 'npm:@ai-sdk/provider@2.0.3';
  writeFileSync(
    join(temporary, 'package.json'),
    JSON.stringify(
      {
        name: 'isolated-oracle-consumer',
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(temporary, 'pnpm-workspace.yaml'),
    [
      'packages:',
      "  - '.'",
      'allowBuilds:',
      '  oracledb: false',
      'overrides:',
      ...Object.entries(dependencies).map(
        ([name, value]) => '  ' + JSON.stringify(name) + ': ' + JSON.stringify(value),
      ),
    ].join('\n'),
  );
  // This consumer is outside the checkout and installs tarballs, never workspace links.
  await command('pnpm', ['install', '--ignore-scripts', '--prefer-offline'], temporary);
  for (const name of selected) {
    const installed = realpathSync(join(temporary, 'node_modules', name));
    if (installed.includes(resolve(root, '../..'))) throw new Error(`Workspace link leaked into consumer: ${name}`);
  }
  function rejectWorkspaceLinks(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(full);
        const checkout = resolve(root, '../..');
        if (target === checkout || target.startsWith(checkout + '/'))
          throw new Error('Workspace dependency leaked into consumer: ' + full);
      } else if (entry.isDirectory()) rejectWorkspaceLinks(full);
    }
  }
  rejectWorkspaceLinks(join(temporary, 'node_modules'));
  writeFileSync(
    join(temporary, 'verify.mjs'),
    "import assert from 'node:assert/strict';\nimport { Agent } from '@mastra/core/agent';\nimport { Mastra } from '@mastra/core/mastra';\nimport { InMemoryStore } from '@mastra/core/storage';\nimport { Memory } from '@mastra/memory';\nimport { OracleStore, OracleVector } from '@mastra/oracledb';\nimport { MastraClient } from '@mastra/client-js';\nimport { MastraServer } from '@mastra/hono';\nimport { Observability, MastraStorageExporter } from '@mastra/observability';\n\nconst model = {\n  specificationVersion: 'v2', provider: 'package-test', modelId: 'scripted', supportedUrls: {},\n  async doGenerate() {\n    return { content: [{ type: 'text', text: 'ACK' }], finishReason: 'stop',\n      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };\n  },\n  async doStream() {\n    return { stream: new ReadableStream({ start(controller) {\n      for (const part of [\n        { type: 'stream-start', warnings: [] },\n        { type: 'text-start', id: 'text' },\n        { type: 'text-delta', id: 'text', delta: 'ACK' },\n        { type: 'text-end', id: 'text' },\n        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },\n      ]) controller.enqueue(part);\n      controller.close();\n    } }) };\n  },\n};\nconst storage = new InMemoryStore();\nconst memory = new Memory({ storage, options: { semanticRecall: false, generateTitle: false, lastMessages: 10 } });\nconst agent = new Agent({ id: 'package-check', name: 'package-check', instructions: 'Reply ACK.', model, memory });\nconst mastra = new Mastra({ storage, agents: { agent }, logger: false });\ntry {\n  const result = await agent.generate('HELLO', { memory: { thread: 'packed-thread', resource: 'packed-resource' } });\n  assert.equal(result.text, 'ACK');\n  await memory.settled();\n  const messages = await (await storage.getStore('memory')).listMessages({ threadId: 'packed-thread', perPage: false });\n  assert.deepEqual(messages.messages.map(message => message.role), ['user', 'assistant']);\n  const oracle = new OracleStore({ id: 'packed-store', user: 'unused', password: 'unused', connectString: 'unused', disableInit: true });\n  const vector = new OracleVector({ id: 'packed-vector', user: 'unused', password: 'unused', connectString: 'unused' });\n  assert.equal(typeof oracle.init, 'function');\n  assert.equal(typeof vector.query, 'function');\n  assert.equal(typeof MastraClient, 'function');\n  assert.equal(typeof MastraServer, 'function');\n  assert.equal(typeof Observability, 'function');\n  assert.equal(typeof MastraStorageExporter, 'function');\n  await oracle.disconnect();\n  await vector.disconnect();\n  console.log('PACKED_CONSUMER_OK');\n} finally { await mastra.shutdown(); }\n",
  );
  await command(process.execPath, ['verify.mjs'], temporary);
  checks.esm = 'passed';
  const esm = readFileSync(join(temporary, 'verify.mjs'), 'utf8');
  const cjs = esm.replace(
    /^import (.+) from '([^']+)';$/gm,
    (_, names, specifier) => 'const ' + names + ' = require(' + JSON.stringify(specifier) + ');',
  );
  writeFileSync(
    join(temporary, 'verify.cjs'),
    '(async () => {\n' + cjs + '\n})().catch(error => { console.error(error); process.exitCode = 1; });\n',
  );
  // Each export mode is executed, rather than inferring CommonJS support from file names.
  await command(process.execPath, ['verify.cjs'], temporary);
  checks.cjs = 'passed';
  for (const extension of ['mts', 'cts']) {
    writeFileSync(
      join(temporary, 'consumer.' + extension),
      [
        "import { Agent } from '@mastra/core/agent';",
        "import { Memory } from '@mastra/memory';",
        "import { OracleStore, OracleVector } from '@mastra/oracledb';",
        "import { MastraClient } from '@mastra/client-js';",
        'export const constructors = { Agent, Memory, OracleStore, OracleVector, MastraClient };',
        "export const storage = new OracleStore({ id: 'consumer', user: 'unused', password: 'unused', connectString: 'unused' });",
        "export const vector = new OracleVector({ id: 'consumer', user: 'unused', password: 'unused', connectString: 'unused' });",
        "export const query: Parameters<OracleVector['query']>[0] = { indexName: 'consumer', queryVector: [1, 0, 0], topK: 1, queryMode: 'exact' };",
      ].join('\n'),
    );
  }
  writeFileSync(
    join(temporary, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        },
        include: ['consumer.mts', 'consumer.cts'],
      },
      null,
      2,
    ),
  );
  try {
    await command(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], temporary);
    checks.typescript = 'passed';
  } catch {
    checks.typescript = 'failed';
    // Keep this required check failed, while collecting independent runtime evidence.
  }
  if (withOracle || withCompiled) {
    for (const directory of ['helpers', 'fixture', 'tests', 'live', 'unit', 'certification']) {
      cpSync(join(root, directory), join(temporary, directory), { recursive: true });
    }
    for (const file of [
      'vitest.config.ts',
      'vitest.live.config.ts',
      'vitest.harness.config.ts',
      'vitest.certification.config.ts',
    ]) {
      cpSync(join(root, file), join(temporary, file));
    }
    if (withCompiled) {
      const { build } = createRequire(resolve(root, '../../packages/deployer/package.json'))('esbuild') as {
        build(options: Record<string, unknown>): Promise<unknown>;
      };
      await build({
        entryPoints: [join(temporary, 'fixture/server.ts')],
        outfile: join(temporary, 'fixture/server.mjs'),
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        target: 'node22',
      });
      process.env.ORACLE_APP_SERVER_ENTRY = join(temporary, 'fixture/server.mjs');
      process.env.ORACLE_APP_SERVER_COMPILED = 'true';
    }
    process.env.ORACLE_APP_SOURCE_ROOT = root;
    await command(process.execPath, ['--import', 'tsx', 'helpers/run-tests.ts', 'e2e'], temporary, 1_200_000);
    checks[withCompiled ? 'compiledOracleSuite' : 'packedOracleSuite'] = 'passed';
    cpSync(join(temporary, 'artifacts'), join(artifacts, 'oracle'), { recursive: true });
  }
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify({ status: 'passed', packages, checks, isolatedConsumer: true, consumer: temporary }, null, 2),
  );
  if (Object.values(checks).includes('failed'))
    throw new Error('Required package checks failed; inspect commands.log and checks in report.json.');
  console.log(`Packed consumer passed. Evidence: ${artifacts}`);
  // Retain the installed consumer so Oracle ownership evidence and build output remain reviewable.
} catch (error) {
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify(
      { status: 'blocked-or-failed', packages, checks, consumer: temporary, error: String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  log.end();
}
