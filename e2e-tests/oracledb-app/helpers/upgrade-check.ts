import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { captureTables } from './cleanup.ts';
import { openStore } from './database.ts';
import { preflight } from './preflight.ts';
import { ServerProcess } from './server-process.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageReport = JSON.parse(readFileSync(resolve(process.argv[2] ?? ''), 'utf8')) as {
  consumer: string;
  checks: Record<string, string>;
};
assert.equal(packageReport.checks.esm, 'passed');
assert.equal(packageReport.checks.cjs, 'passed');
const project = packageReport.consumer;
const old = join(project, 'previous-0.3.0');
mkdirSync(old, { recursive: true });
const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
manifest.name = 'oracle-previous-version-consumer';
manifest.dependencies['@mastra/oracledb-previous'] = 'npm:@mastra/oracledb@0.3.0';
writeFileSync(join(old, 'package.json'), JSON.stringify(manifest, null, 2));
cpSync(join(project, 'pnpm-workspace.yaml'), join(old, 'pnpm-workspace.yaml'));
const runId = randomUUID();
const artifacts = join(root, 'artifacts', 'upgrade-' + runId);
mkdirSync(artifacts, { recursive: true });
writeFileSync(
  join(artifacts, 'environment.json'),
  JSON.stringify(
    { runId, previousVersion: '0.3.0', currentPackageReport: process.argv[2], startedAt: new Date().toISOString() },
    null,
    2,
  ),
);
const log = createWriteStream(join(artifacts, 'install.log'));
const child = spawn('pnpm', ['install', '--ignore-scripts', '--prefer-offline'], {
  cwd: old,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
child.stdout!.pipe(log, { end: false });
child.stderr!.pipe(log, { end: false });
const code = await new Promise<number | null>((resolve, reject) => {
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
  child.once('error', reject);
  child.once('exit', code => {
    clearTimeout(timeout);
    log.end();
    resolve(code);
  });
});
assert.equal(code, 0, 'Previous version installation must succeed.');
assert.equal(
  JSON.parse(readFileSync(join(old, 'node_modules/@mastra/oracledb-previous/package.json'), 'utf8')).version,
  '0.3.0',
);
for (const target of [project, old]) {
  for (const directory of ['fixture', 'helpers'])
    cpSync(join(root, directory), join(target, directory), { recursive: true });
}
for (const directory of ['fixture', 'helpers']) {
  const { readdirSync } = await import('node:fs');
  function replaceProvider(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) replaceProvider(full);
      else if (entry.name.endsWith('.ts'))
        writeFileSync(
          full,
          readFileSync(full, 'utf8').replaceAll("from '@mastra/oracledb'", "from '@mastra/oracledb-previous'"),
        );
    }
  }
  replaceProvider(join(old, directory));
}
let claimed = false;
const previous = new ServerProcess('previous-provider');
const current = new ServerProcess('upgraded-provider');
const store = openStore('upgrade-assertions');
try {
  const database = await preflight(runId);
  claimed = true;
  process.env.ORACLE_APP_RUN_ID = runId;
  process.env.ORACLE_APP_ARTIFACTS = artifacts;
  writeFileSync(join(artifacts, 'database.json'), JSON.stringify(database, null, 2));
  process.env.ORACLE_APP_SERVER_ENTRY = join(old, 'fixture/server.ts');
  delete process.env.ORACLE_APP_SERVER_COMPILED;
  await previous.start();
  const thread = randomUUID(),
    resource = randomUUID(),
    code = randomUUID(),
    requestId = randomUUID(),
    workflowRun = randomUUID();
  await previous.client.getAgent('history').generate('PROJECT CODE: ' + code, { memory: { thread, resource } });
  const run = await previous.client.getWorkflow('approval').createRun({ runId: workflowRun, resourceId: resource });
  assert.equal((await run.startAsync({ inputData: { requestId, amount: 21 } })).status, 'suspended');
  const vector = previous.client.getVector('oracle');
  const indexName = 'upgrade_' + randomUUID().replaceAll('-', '').slice(0, 8);
  await vector.createIndex({ indexName, dimension: 3, metric: 'cosine' });
  await vector.upsert({
    indexName,
    ids: ['previous-document'],
    vectors: [[1, 0, 0]],
    metadata: [{ source: 'provider-0.3.0', marker: code }],
  });
  await previous.settle();
  const memory = (await store.getStore('memory'))!;
  const before = await memory.listMessages({ threadId: thread, perPage: false });
  assert.equal(before.messages.length, 2);
  await previous.stop();
  process.env.ORACLE_APP_SERVER_ENTRY = join(project, 'fixture/server.ts');
  await current.start();
  const after = await memory.listMessages({ threadId: thread, perPage: false });
  assert.deepEqual(after.messages, before.messages);
  assert.equal(
    (await current.client.getAgent('history').generate('RECALL PROJECT CODE', { memory: { thread, resource } })).text,
    'CODE=' + code,
  );
  const results = z
    .array(z.object({ id: z.string(), metadata: z.object({ marker: z.string() }), vector: z.array(z.number()) }))
    .parse(
      await current.client
        .getVector('oracle')
        .query({ indexName, queryVector: [1, 0, 0], topK: 1, includeVector: true }),
    );
  assert.deepEqual(
    results.map(row => row.id),
    ['previous-document'],
  );
  assert.equal(results[0]?.metadata?.marker, code);
  assert.deepEqual(results[0]?.vector, [1, 0, 0]);
  const snapshot = await (await store.getStore('workflows'))!.loadWorkflowSnapshot({
    workflowName: 'approval',
    runId: workflowRun,
  });
  assert.equal(snapshot?.status, 'suspended');
  const restored = await current.client.getWorkflow('approval').createRun({ runId: workflowRun, resourceId: resource });
  const resumed = await restored.resumeAsync({ step: 'approve', resumeData: { approved: true } });
  assert.ok(resumed.status === 'success');
  assert.deepEqual(resumed.result, {
    requestId,
    total: 42,
    approved: true,
  });
  await current.settle();
  await current.restart();
  assert.equal((await current.client.getWorkflow('approval').runById(workflowRun)).status, 'success');
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        previous: '0.3.0',
        current: '0.4.0',
        source: 'published npm adapter',
        threadId: thread,
        messageIds: before.messages.map(row => row.id),
        indexName,
        workflowRun,
      },
      null,
      2,
    ),
  );
  console.log('Upgrade passed. Evidence: ' + artifacts);
} catch (error) {
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify({ status: 'failed', previous: '0.3.0', error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await previous.stop();
  await current.stop();
  await store.disconnect();
  if (claimed) writeFileSync(join(artifacts, 'owned-tables.json'), JSON.stringify(await captureTables(), null, 2));
}
