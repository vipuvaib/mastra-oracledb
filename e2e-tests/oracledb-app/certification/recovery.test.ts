import { createServer, connect, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { OracleStore } from '@mastra/oracledb';
import { expect, it } from 'vitest';
import { verifyLease } from '../helpers/database.ts';
import { environment } from '../helpers/environment.ts';
import { recordEvidence } from '../helpers/evidence.ts';

function destination() {
  const config = environment();
  // This test owns only its loopback relay. It never changes the actual listener.
  const match = /^(?:\/\/)?([^/:?]+):(\d+)\/([^?]+)(?:\?.*)?$/.exec(config.connection.connectString);
  if (!match) throw new Error('Recovery relay requires an Easy Connect host:port/service connect string.');
  return { config, host: match[1]!, port: Number(match[2]), service: match[3]! };
}
it('R01 rejects an unavailable listener within a bounded interval', async () => {
  const { config, service } = destination();
  const listener = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No test port.');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const store = new OracleStore({
    id: 'unavailable-listener',
    ...config.connection,
    connectString:
      '127.0.0.1:' + address.port + '/' + service + '?connect_timeout=2&transport_connect_timeout=1&retry_count=0',
    schemaName: config.schema,
    disableInit: true,
  });
  const started = performance.now();
  let rejected = false;
  try {
    await store.db.execute('SELECT 1 FROM dual');
  } catch {
    rejected = true;
  } finally {
    await store.disconnect();
  }
  const elapsedMs = performance.now() - started;
  recordEvidence('R01', { rejected, elapsedMs, limitMs: 10_000 });
  expect(rejected).toBe(true);
  expect(elapsedMs).toBeLessThan(10_000);
}, 15_000);

it('R02 reconnects the same store after its private TCP relay drops pooled connections', async () => {
  const { config, host, port, service } = destination();
  let enabled = true;
  const sockets = new Set<Socket>();
  const listener = createServer(client => {
    if (!enabled) {
      client.destroy();
      return;
    }
    const upstream = connect({ host, port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No relay port.');
  const store = new OracleStore({
    id: 'relay-recovery',
    ...config.connection,
    connectString:
      '127.0.0.1:' + address.port + '/' + service + '?connect_timeout=2&transport_connect_timeout=1&retry_count=0',
    schemaName: config.schema,
    disableInit: true,
  });
  try {
    await verifyLease(store);
    const pool = await store.getPoolManager().getPool();
    const before = await store.db.execute<{ runId: string }>('SELECT run_id AS "runId" FROM ORACLE_APP_E2E_RUN');
    enabled = false;
    for (const socket of sockets) socket.destroy();
    await delay(100);
    await expect(store.db.execute('SELECT 1 FROM dual')).rejects.toThrow();
    enabled = true;
    const started = performance.now();
    let attempts = 0;
    let recovered = false;
    while (performance.now() - started < 10_000) {
      attempts++;
      try {
        await verifyLease(store);
        recovered = true;
        break;
      } catch {
        await delay(200);
      }
    }
    const after = await store.db.execute<{ runId: string }>('SELECT run_id AS "runId" FROM ORACLE_APP_E2E_RUN');
    recordEvidence('R02', {
      recovered,
      attempts,
      recoveryMs: performance.now() - started,
      sameStore: true,
      before,
      after,
      pool: { connectionsOpen: pool.connectionsOpen, connectionsInUse: pool.connectionsInUse },
      databaseRestarted: false,
    });
    expect(recovered).toBe(true);
    expect(after).toEqual(before);
  } finally {
    await store.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}, 30_000);
