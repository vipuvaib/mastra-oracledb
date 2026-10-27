import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureTables } from './cleanup.ts';
import { liveEnvironment } from './live-environment.ts';
import { preflight } from './preflight.ts';
import { acceptance, validateCoverage } from './profiles.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const requestedMode = process.argv[2];
if (!requestedMode || !Object.hasOwn(acceptance, requestedMode))
  throw new Error('Expected smoke, e2e, certification or live.');
const mode = requestedMode as keyof typeof acceptance;
if (mode === 'live') {
  const live = liveEnvironment();
  process.env.ORACLE_APP_LIVE_MODEL = live.model;
  process.env[live.apiKeyEnv] = live.apiKey;
  process.env.ORACLE_APP_PROFILE = 'live';
} else {
  process.env.ORACLE_APP_PROFILE = mode;
}
const runId = randomUUID();
const artifacts = join(root, 'artifacts', runId);
mkdirSync(artifacts, { recursive: true });
const require = createRequire(import.meta.url);
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: process.env.ORACLE_APP_SOURCE_ROOT ?? root, encoding: 'utf8' });
const fingerprint = createHash('sha256').update(git('diff', 'HEAD', '--'));
function hashFixture(path: string) {
  for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (['node_modules', 'artifacts'].includes(item.name) || item.name.startsWith('.env')) continue;
    const target = join(path, item.name);
    if (item.isDirectory()) hashFixture(target);
    else fingerprint.update(target.slice(root.length)).update(readFileSync(target));
  }
}
hashFixture(root);
const packages = Object.fromEntries(
  [
    '@mastra/core',
    '@mastra/memory',
    '@mastra/oracledb',
    '@mastra/client-js',
    '@mastra/hono',
    '@mastra/observability',
  ].map(name => [name, require(`${name}/package.json`).version]),
);
packages.oracledb = createRequire(require.resolve('@mastra/oracledb'))('oracledb/package.json').version;
const evidence = {
  runId,
  mode,
  revision: git('rev-parse', 'HEAD').trim(),
  patchFingerprint: fingerprint.digest('hex'),
  node: process.version,
  packages,
  startedAt: new Date().toISOString(),
};
writeFileSync(join(artifacts, 'environment.json'), JSON.stringify(evidence, null, 2));
console.log(`Evidence: ${artifacts}`);
let claimed = false;
try {
  const database = await preflight(runId);
  claimed = true;
  process.env.ORACLE_APP_RUN_ID = runId;
  writeFileSync(join(artifacts, 'database.json'), JSON.stringify(database, null, 2));
  const args = [
    join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${join(artifacts, 'results.json')}`,
  ];
  if (mode === 'smoke') args.push('tests/startup.test.ts', 'tests/agent-memory.test.ts');
  if (mode === 'live') args.push('--config', 'vitest.live.config.ts');
  if (mode === 'certification') args.push('--config', 'vitest.certification.config.ts');
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ORACLE_APP_RUN_ID: runId, ORACLE_APP_ARTIFACTS: artifacts },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  const result = JSON.parse(readFileSync(join(artifacts, 'results.json'), 'utf8'));
  const assertions = result.testResults.flatMap(
    (file: { assertionResults: { fullName: string; status: string }[] }) => file.assertionResults,
  );
  const pending = result.numPendingTests + (result.numTodoTests ?? 0);
  const lines = result.testResults.flatMap(
    (file: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }) =>
      file.assertionResults.map(
        test =>
          `| ${test.fullName.replaceAll('|', '/')} | ${test.status} | ${test.failureMessages.join(' ').replaceAll('|', '/').replaceAll('\n', ' ').slice(0, 500)} |`,
      ),
  );
  writeFileSync(
    join(artifacts, 'report.md'),
    [
      '# Oracle application E2E',
      '',
      `Run: ${runId}`,
      `Revision: ${evidence.revision}`,
      `Passed: ${result.numPassedTests}; failed: ${result.numFailedTests}; skipped/todo: ${pending}`,
      '',
      '| Scenario | Status | Failure |',
      '| --- | --- | --- |',
      ...lines,
      '',
      'Schema and logs retained for diagnosis. No shared data or schema was cleared.',
    ].join('\n'),
  );
  validateCoverage(mode, assertions);
  process.exitCode = code || (pending > 0 || result.numTotalTests === 0 ? 1 : 0);
} catch (error) {
  writeFileSync(join(artifacts, 'blocked.txt'), error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  if (claimed) writeFileSync(join(artifacts, 'owned-tables.json'), JSON.stringify(await captureTables(), null, 2));
}
