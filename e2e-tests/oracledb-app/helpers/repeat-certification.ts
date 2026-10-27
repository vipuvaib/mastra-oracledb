import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './cleanup.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'artifacts', 'repeat-' + randomUUID());
mkdirSync(artifacts, { recursive: true });
function fingerprint() {
  const hash = createHash('sha256');
  hash.update(execFileSync('git', ['diff', 'HEAD', '--'], { cwd: root }));
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['artifacts', 'node_modules'].includes(entry.name) || entry.name.startsWith('.env')) continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else hash.update(full.slice(root.length)).update(readFileSync(full));
    }
  }
  visit(root);
  const require = createRequire(import.meta.url);
  for (const name of [
    '@mastra/core',
    '@mastra/memory',
    '@mastra/oracledb',
    '@mastra/client-js',
    '@mastra/hono',
    '@mastra/observability',
    '@mastra/server',
    '@mastra/schema-compat',
  ]) {
    hash.update(name);
    visit(join(dirname(require.resolve(name + '/package.json')), 'dist'));
  }
  return hash.digest('hex');
}
const fixed = fingerprint();
const runs: {
  runId: string;
  passed: number;
  failed: number;
  skipped: number;
  artifact: string;
  fingerprint: string;
}[] = [];
try {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (fingerprint() !== fixed)
      throw new Error('Source changed before repeat; certification cannot combine different suites.');
    const before = new Set(readdirSync(join(root, 'artifacts')));
    const child = spawn(process.execPath, ['--import', 'tsx', 'helpers/run-tests.ts', 'certification'], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1_200_000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const added = readdirSync(join(root, 'artifacts')).filter(
      name => !before.has(name) && /^[a-f0-9-]{36}$/.test(name),
    );
    if (added.length !== 1) throw new Error('Could not identify exactly one run artifact.');
    const artifact = join(root, 'artifacts', added[0]!);
    const result = JSON.parse(readFileSync(join(artifact, 'results.json'), 'utf8'));
    const environment = JSON.parse(readFileSync(join(artifact, 'environment.json'), 'utf8'));
    const current = fingerprint();
    runs.push({
      runId: environment.runId,
      passed: result.numPassedTests,
      failed: result.numFailedTests,
      skipped: result.numPendingTests + (result.numTodoTests ?? 0),
      artifact,
      fingerprint: current,
    });
    writeFileSync(join(artifacts, 'progress.json'), JSON.stringify({ fingerprint: fixed, runs }, null, 2));
    if (
      code ||
      current !== fixed ||
      result.numFailedTests ||
      result.numPendingTests ||
      result.numTodoTests ||
      result.numPassedTests !== 38
    ) {
      throw new Error('A repeat failed or source changed; retain schema for diagnosis.');
    }
    if (attempt < 2) await cleanup(artifact);
  }
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify({ status: 'passed', fingerprint: fixed, runs, finalSchemaRetained: true }, null, 2),
  );
  console.log('Three consecutive fresh-schema certification passes: ' + artifacts);
} catch (error) {
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify({ status: 'failed', fingerprint: fixed, runs, error: String(error) }, null, 2),
  );
  throw error;
}
