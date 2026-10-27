import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OracleVector } from '@mastra/oracledb';
import { captureTables } from './cleanup.ts';
import { openStore, verifyLease } from './database.ts';
import { environment } from './environment.ts';
import { ServerProcess } from './server-process.ts';

const home = process.env.ORACLE_APP_RESTART_ORACLE_HOME;
const sid = process.env.ORACLE_APP_RESTART_SID;
if (!home || !sid || !/^[A-Za-z][A-Za-z0-9_]*$/.test(sid) || process.env.ORACLE_APP_RESTART_DISPOSABLE !== 'yes') {
  throw new Error(
    'Actual restart requires explicit ORACLE_APP_RESTART_DISPOSABLE=yes, ORACLE_APP_RESTART_ORACLE_HOME and ORACLE_APP_RESTART_SID for a verified disposable native instance.',
  );
}
const parentArtifacts = process.env.ORACLE_APP_ARTIFACTS;
if (!parentArtifacts) throw new Error('Supply ORACLE_APP_ARTIFACTS for the owned run.');
const artifacts = join(parentArtifacts, 'database-restart-' + randomUUID());
mkdirSync(artifacts, { recursive: true });
process.env.ORACLE_APP_ARTIFACTS = artifacts;
const store = openStore('restart-assertions');
const config = environment();
const vector = new OracleVector({ id: 'restart-vector', ...config.connection, schemaName: config.schema });
const server = new ServerProcess('database-restart');
async function admin(sql: string, name: string) {
  const child = spawn(join(home!, 'bin/sqlplus'), ['-L', '-s', '/', 'as', 'sysdba'], {
    env: { ...process.env, ORACLE_HOME: home, ORACLE_SID: sid, LD_LIBRARY_PATH: join(home!, 'lib') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: Buffer[] = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => output.push(chunk));
  child.stdin.end(
    'WHENEVER OSERROR EXIT FAILURE\nWHENEVER SQLERROR EXIT FAILURE\nSET HEADING OFF FEEDBACK ON\n' + sql + '\nEXIT\n',
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const text = Buffer.concat(output).toString('utf8');
  writeFileSync(join(artifacts, name + '.log'), text);
  assert.equal(code, 0, 'Oracle administration failed; inspect ' + name + '.log');
  return text;
}
const recoveryDirectory = mkdtempSync(join(tmpdir(), 'oracle-restart-config-'));
chmodSync(recoveryDirectory, 0o700);
const pfile = join(recoveryDirectory, 'restart.ora');
let restarted = false;
let attemptedShutdown = false;
try {
  await verifyLease(store);
  const [identity] = await store.db.execute<{ instance: string; container: string }>(
    "SELECT SYS_CONTEXT('USERENV','INSTANCE_NAME') AS \"instance\", SYS_CONTEXT('USERENV','CON_NAME') AS \"container\" FROM dual",
  );
  assert.equal(
    identity?.instance.toLowerCase(),
    sid.toLowerCase(),
    'Private env connection must match the native admin instance.',
  );
  assert.match(identity!.container, /^[A-Z][A-Z0-9_$#]*$/);
  const target = await admin("SELECT 'RESTART_TARGET=' || INSTANCE_NAME FROM v$instance;", 'identity');
  assert.ok(target.includes('RESTART_TARGET=' + sid), 'Admin target must match the application connection.');
  // This native test instance has no default spfile. Preserve the actual running
  // configuration before any shutdown; never assume startup defaults can recover it.
  await admin("CREATE PFILE='" + pfile + "' FROM MEMORY;", 'save-startup-configuration');
  chmodSync(pfile, 0o600);
  await server.start();
  const thread = randomUUID(),
    resource = randomUUID(),
    code = randomUUID(),
    workflowRun = randomUUID(),
    requestId = randomUUID();
  await server.client.getAgent('history').generate('PROJECT CODE: ' + code, { memory: { thread, resource } });
  const workflow = await server.client.getWorkflow('approval').createRun({ runId: workflowRun, resourceId: resource });
  assert.equal((await workflow.startAsync({ inputData: { requestId, amount: 21 } })).status, 'suspended');
  const indexName = 'restart_' + randomUUID().replaceAll('-', '').slice(0, 8);
  await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', indexConfig: { type: 'none' } });
  await vector.upsert({ indexName, ids: ['durable-document'], vectors: [[1, 0, 0]], metadata: [{ marker: code }] });
  const beforeVector = await vector.query({
    indexName,
    queryVector: [1, 0, 0],
    topK: 1,
    queryMode: 'exact',
    includeVector: true,
  });
  await server.settle();
  const memory = (await store.getStore('memory'))!;
  const before = await memory.listMessages({ threadId: thread, perPage: false });
  const started = Date.now();
  attemptedShutdown = true;
  try {
    await admin('SHUTDOWN IMMEDIATE;', 'shutdown');
  } finally {
    // Restore the verified instance even if shutdown acknowledgement was lost.
    await admin("STARTUP PFILE='" + pfile + "';", 'startup');
    restarted = true;
    if (identity!.container !== 'CDB$ROOT') {
      await admin(
        "DECLARE state VARCHAR2(20); BEGIN SELECT open_mode INTO state FROM v$pdbs WHERE name = '" +
          identity!.container +
          "'; IF state <> 'READ WRITE' THEN EXECUTE IMMEDIATE 'ALTER PLUGGABLE DATABASE \"" +
          identity!.container +
          '" OPEN\'; END IF; END;\n/',
        'open-target-pdb',
      );
    }
  }
  let recovered = false;
  let attempts = 0;
  while (Date.now() - started < 120_000) {
    attempts++;
    try {
      await verifyLease(store);
      recovered = true;
      break;
    } catch {
      await delay(500);
    }
  }
  assert.equal(recovered, true, 'The same adapter must reconnect after actual database restart.');
  const after = await memory.listMessages({ threadId: thread, perPage: false });
  assert.deepEqual(
    after.messages.map(row => row.id),
    before.messages.map(row => row.id),
  );
  const afterVector = await vector.query({
    indexName,
    queryVector: [1, 0, 0],
    topK: 1,
    queryMode: 'exact',
    includeVector: true,
  });
  assert.deepEqual(afterVector, beforeVector);
  assert.deepEqual(
    afterVector.map(row => row.id),
    ['durable-document'],
  );

  assert.equal(
    (await server.client.getAgent('history').generate('RECALL PROJECT CODE', { memory: { thread, resource } })).text,
    'CODE=' + code,
  );
  const restored = await server.client.getWorkflow('approval').createRun({ runId: workflowRun, resourceId: resource });
  const resumed = await restored.resumeAsync({ step: 'approve', resumeData: { approved: true } });
  assert.ok(resumed.status === 'success');
  assert.deepEqual(resumed.result, {
    requestId,
    total: 42,
    approved: true,
  });
  await server.settle();
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        identity,
        restarted,
        elapsedMs: Date.now() - started,
        attempts,
        sameAdapter: true,
        persistedVector: afterVector,
        threadId: thread,
        persistedMessageIds: before.messages.map(row => row.id),
        indexName,
        workflowRun,
      },
      null,
      2,
    ),
  );
  console.log('Database restart passed. Evidence: ' + artifacts);
} catch (error) {
  writeFileSync(
    join(artifacts, 'report.json'),
    JSON.stringify({ status: 'failed', attemptedShutdown, restarted, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await server.stop();
  await vector.disconnect();
  await store.disconnect();
  if (restarted || !attemptedShutdown) rmSync(recoveryDirectory, { recursive: true, force: true });
  writeFileSync(join(parentArtifacts, 'owned-tables.json'), JSON.stringify(await captureTables(), null, 2));
}
