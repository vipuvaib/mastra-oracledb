import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, createWriteStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MastraClient } from '@mastra/client-js';
import { captureTables } from './cleanup.ts';
import { openStore, verifyLease } from './database.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(process.argv[2] ?? '');
const packageReport = JSON.parse(readFileSync(reportPath, 'utf8')) as {
  consumer: string;
  checks: Record<string, string>;
};
if (packageReport.checks.esm !== 'passed' || packageReport.checks.cjs !== 'passed')
  throw new Error('First run package validation; ESM and CJS must pass.');
const project = packageReport.consumer;
for (const name of ['core', 'memory', 'oracledb', 'client-js', 'hono', 'observability']) {
  if (realpathSync(join(project, 'node_modules/@mastra', name)).includes(resolve(root, '../..')))
    throw new Error('Workspace resolution leaked into installed consumer.');
}
for (const directory of ['fixture', 'helpers'])
  cpSync(join(root, directory), join(project, directory), { recursive: true });
const artifact = join(root, 'artifacts', 'delivery-' + randomUUID());
mkdirSync(artifact, { recursive: true });
const store = openStore('delivery-assertions');
await verifyLease(store);
const socket = createServer();
await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
const address = socket.address();
if (!address || typeof address === 'string') throw new Error('No delivery port.');
const port = address.port;
await new Promise<void>(resolve => socket.close(() => resolve()));
const baseUrl = 'http://127.0.0.1:' + port;
const sourceDirectory = join(project, 'src/mastra');
mkdirSync(sourceDirectory, { recursive: true });
writeFileSync(
  join(sourceDirectory, 'index.ts'),
  [
    "import { createFixture } from '../../fixture/mastra.ts';",
    'const fixture = await createFixture();',
    'export const mastra = fixture.mastra;',
  ].join('\n'),
);
const environment = {
  ...process.env,
  ORACLE_APP_DELIVERY_PORT: String(port),
  MASTRA_TELEMETRY_DISABLED: '1',
  CI: 'true',
};
const cli = resolve(root, '../../packages/cli/dist/index.js');
let child: ChildProcess | undefined;
let exited: Promise<number | null> | undefined;
let generation = 0;
const results: Record<string, unknown>[] = [];
function launch(args: string[]) {
  const log = createWriteStream(join(artifact, 'command-' + ++generation + '.log'));
  child = spawn(process.execPath, [cli, ...args], {
    cwd: project,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  exited = new Promise((resolve, reject) => {
    child!.once('error', reject);
    child!.once('exit', code => {
      log.end();
      resolve(code);
    });
  });
}
async function ready() {
  const began = Date.now();
  while (Date.now() - began < 120_000) {
    if (child?.exitCode !== null) throw new Error('Delivery command exited before readiness; inspect command log.');
    try {
      const response = await fetch(baseUrl + '/_test/ready', { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).runId === process.env.ORACLE_APP_RUN_ID) return;
    } catch {
      /* Wait only for readiness, bounded above. */
    }
    await delay(300);
  }
  throw new Error('Delivery readiness timed out.');
}
async function stop() {
  if (!child) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 20_000);
  const code = await exited;
  clearTimeout(timer);
  child = undefined;
  assert.equal(code, 0, 'Delivery process must shut down cleanly.');
}
async function settled() {
  const response = await fetch(baseUrl + '/_test/settled', { method: 'POST', signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true);
}
const client = new MastraClient({ baseUrl, retries: 0 });
const thread = randomUUID(),
  resource = randomUUID(),
  code = randomUUID(),
  requestId = randomUUID(),
  runId = randomUUID();
try {
  launch(['dev', '--dir', 'src/mastra', '--root', project]);
  await ready();
  assert.equal(
    (await client.getAgent('history').generate('PROJECT CODE: ' + code, { memory: { thread, resource } })).text,
    'ACK',
  );
  const tool = await client.getAgent('history').generate('ADD 17 25', { memory: { thread: randomUUID(), resource } });
  assert.equal(tool.text, 'SUM=42');
  const run = await client.getWorkflow('approval').createRun({ runId, resourceId: resource });
  assert.equal((await run.startAsync({ inputData: { requestId, amount: 21 } })).status, 'suspended');
  await settled();
  const memory = (await store.getStore('memory'))!;
  const before = await memory.listMessages({ threadId: thread, perPage: false });
  assert.equal(before.messages.length, 2);
  results.push({
    mode: 'mastra dev',
    status: 'passed',
    threadId: thread,
    persistedIds: before.messages.map(row => row.id),
    runId,
    workflowStatus: 'suspended',
    tool: tool.text,
  });
  await stop();
  launch(['build', '--dir', 'src/mastra', '--root', project, '--studio']);
  const buildTimer = setTimeout(() => child?.kill('SIGKILL'), 180_000);
  const buildCode = await exited;
  clearTimeout(buildTimer);
  child = undefined;
  assert.equal(buildCode, 0, 'mastra build must succeed.');
  for (let restart = 0; restart < 2; restart++) {
    launch(['start']);
    await ready();
    const result = await client.getAgent('history').generate('RECALL PROJECT CODE', { memory: { thread, resource } });
    assert.equal(result.text, 'CODE=' + code);
    await settled();
    const messages = await memory.listMessages({ threadId: thread, perPage: false });
    assert.deepEqual(
      messages.messages.slice(0, 2).map(row => row.id),
      before.messages.map(row => row.id),
    );
    if (restart === 0) {
      const restored = await client.getWorkflow('approval').createRun({ runId, resourceId: resource });
      const resumed = await restored.resumeAsync({ step: 'approve', resumeData: { approved: true } });
      assert.ok(resumed.status === 'success');
      assert.deepEqual(resumed.result, {
        requestId,
        total: 42,
        approved: true,
      });
    } else {
      assert.equal((await client.getWorkflow('approval').runById(runId)).status, 'success');
    }
    results.push({ mode: 'mastra start', restart, status: 'passed', messages: messages.messages.length, runId });
    await stop();
  }
  writeFileSync(
    join(artifact, 'report.json'),
    JSON.stringify({ status: 'passed', installedProject: project, cli, results }, null, 2),
  );
  console.log('Delivery checks passed. Evidence: ' + artifact);
} catch (error) {
  writeFileSync(
    join(artifact, 'report.json'),
    JSON.stringify({ status: 'failed', installedProject: project, cli, results, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  if (child) await stop();
  writeFileSync(join(artifact, 'owned-tables.json'), JSON.stringify(await captureTables(), null, 2));
  await store.disconnect();
}
