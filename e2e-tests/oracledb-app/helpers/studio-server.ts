import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { captureTables } from './cleanup.ts';
import { openStore, verifyLease } from './database.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = process.env.ORACLE_APP_ARTIFACTS;
if (!parent) throw new Error('Supply the parent run artifact directory and run lease.');
const report = JSON.parse(readFileSync(resolve(process.argv[2] ?? ''), 'utf8'));
if (report.checks.esm !== 'passed' || report.checks.cjs !== 'passed')
  throw new Error('Installed ESM and CJS checks must pass first.');
const project = report.consumer as string;
const artifacts = join(root, 'artifacts', 'studio-' + randomUUID());
mkdirSync(artifacts, { recursive: true });
for (const directory of ['fixture', 'helpers'])
  cpSync(join(root, directory), join(project, directory), { recursive: true });
mkdirSync(join(project, 'src/mastra'), { recursive: true });
writeFileSync(
  join(project, 'src/mastra/index.ts'),
  "import { createFixture } from '../../fixture/mastra.ts';\nconst fixture = await createFixture();\nexport const mastra = fixture.mastra;\n",
);
const store = openStore('studio-lease');
await verifyLease(store);
await store.disconnect();
const port = Number(process.env.ORACLE_APP_STUDIO_PORT ?? 4111);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Studio port.');
const log = createWriteStream(join(artifacts, 'server.log'));
const child = spawn(
  process.execPath,
  [resolve(root, '../../packages/cli/dist/index.js'), 'dev', '--dir', 'src/mastra', '--root', project],
  {
    cwd: project,
    env: { ...process.env, ORACLE_APP_DELIVERY_PORT: String(port), MASTRA_TELEMETRY_DISABLED: '1', CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
child.stdout!.pipe(log, { end: false });
child.stderr!.pipe(log, { end: false });
const exited = new Promise<number | null>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => {
    log.end();
    resolve(code);
  });
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  void exited.finally(() => clearTimeout(timeout));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  let ready = false;
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    if (child.exitCode !== null) break;
    try {
      const result = await fetch('http://127.0.0.1:' + port + '/_test/ready', { signal: AbortSignal.timeout(1000) });
      if (result.ok && (await result.json()).runId === process.env.ORACLE_APP_RUN_ID) {
        ready = true;
        break;
      }
    } catch {
      /* bounded startup polling */
    }
    await delay(300);
  }
  if (!ready) throw new Error('Studio server did not become ready; inspect server.log.');
  writeFileSync(
    join(artifacts, 'server.json'),
    JSON.stringify({ status: 'ready', port, project, runId: process.env.ORACLE_APP_RUN_ID, parent }, null, 2),
  );
  console.log('Studio ready: ' + JSON.stringify({ port, artifacts }));
  const code = await exited;
  if (code !== 0) throw new Error('Studio child did not stop cleanly.');
} finally {
  stop();
  await exited;
  writeFileSync(join(parent, 'owned-tables.json'), JSON.stringify(await captureTables(), null, 2));
}
