import { serve } from '@hono/node-server';
import { MastraServer } from '@mastra/hono';
import type { OracleVectorFilter } from '@mastra/oracledb';
import { Hono } from 'hono';
import { z } from 'zod';
import { createFixture } from './mastra.ts';

const fixture = await createFixture();
const app = new Hono();
const adapter = new MastraServer({ app, mastra: fixture.mastra });
adapter.registerContextMiddleware();
app.get('/_test/ready', c =>
  c.json({ pid: process.pid, runId: process.env.ORACLE_APP_RUN_ID, domains: Object.keys(fixture.storage.stores) }),
);
app.get('/_test/pools', async c => {
  const pool = await fixture.storage.getPoolManager().getPool();
  return c.json({
    storage: { connectionsOpen: pool.connectionsOpen, connectionsInUse: pool.connectionsInUse, poolMax: pool.poolMax },
  });
});
app.post('/_test/settled', async c => {
  await Promise.all(fixture.memories.map(memory => memory.settled()));
  await fixture.observability.flush();
  return c.json({ settled: true });
});
const observationInput = z.object({
  threadId: z.string().uuid(),
  resourceId: z.string().uuid(),
  inject: z.boolean().default(false),
});
const activationInput = observationInput
  .extend({ observerPort: z.number().int().min(1).max(65535).optional() })
  .refine(input => !input.inject || input.observerPort !== undefined, {
    message: 'Injected activation requires a separate loopback observer process.',
    path: ['observerPort'],
  });
app.post('/_test/observations/:operation', async c => {
  const body = await c.req.json();
  const operation = c.req.param('operation');
  if (operation === 'activate') {
    const { threadId, resourceId, inject, observerPort } = activationInput.parse(body);
    const bufferLate = inject
      ? async () => {
          const origin = 'http://127.0.0.1:' + observerPort;
          const ready = await fetch(origin + '/_test/ready', { signal: AbortSignal.timeout(5000) });
          if (!ready.ok) throw new Error('The late observer is not ready.');
          const peer = z
            .object({ pid: z.number().int().positive(), runId: z.string().uuid() })
            .parse(await ready.json());
          if (peer.runId !== process.env.ORACLE_APP_RUN_ID || peer.pid === process.pid)
            throw new Error('The late observer must be a separate process on the same test lease.');
          const response = await fetch(origin + '/_test/observations/buffer', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ threadId, resourceId, inject: false }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error('The late observer buffer failed: ' + (await response.text()));
          const result = z.object({ buffered: z.boolean() }).parse(await response.json());
          return { buffered: result.buffered, pid: peer.pid };
        }
      : undefined;
    return c.json(await fixture.observation.activate(threadId, resourceId, bufferLate));
  }
  const { threadId, resourceId, inject } = observationInput.parse(body);
  if (operation === 'buffer') return c.json(await fixture.observation.buffer(threadId, resourceId, inject));
  if (operation === 'record') return c.json({ record: await fixture.observation.record(threadId, resourceId) });
  return c.json({ error: 'Unknown operation' }, 400);
});
app.post('/_test/semantic/fail-next-migration', async c => {
  const { threadId } = z.object({ threadId: z.string().uuid() }).parse(await c.req.json());
  fixture.failNextMigration(threadId);
  return c.json({ armed: true });
});
app.post('/_test/vector/identity', async c => {
  const { indexName } = z.object({ indexName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]+$/) }).parse(await c.req.json());
  return c.json(await fixture.identity.reader!.describeIndex({ indexName }));
});
app.post('/_test/vector/config', async c => {
  const params = z
    .object({
      indexName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]+$/),
      operation: z.enum(['build', 'rebuild', 'create']),
      accuracy: z.number().int().min(1).max(100),
    })
    .parse(await c.req.json());
  const writer = fixture.identity.upper!;
  const indexConfig = { type: 'ivf' as const, accuracy: params.accuracy, ivf: { neighborPartitions: 1 } };
  if (params.operation === 'build') await writer.buildIndex({ indexName: params.indexName, indexConfig });
  if (params.operation === 'rebuild')
    await writer.rebuildIndex({ indexName: params.indexName, metric: 'euclidean', indexConfig });
  if (params.operation === 'create')
    await writer.createIndex({ indexName: params.indexName, dimension: 3, metric: 'cosine', indexConfig });
  return c.json(await writer.describeIndex({ indexName: params.indexName }));
});
app.post('/_test/vector/mutate', async c => {
  const { indexName, filter, operation } = z
    .object({
      indexName: z.string().regex(/^app_[a-f0-9]{8}$/),
      filter: z.custom<OracleVectorFilter>(
        value => value !== null && typeof value === 'object' && !Array.isArray(value),
      ),
      operation: z.enum(['update', 'delete']),
    })
    .parse(await c.req.json());
  try {
    if (operation === 'update')
      await fixture.vector.updateVector({ indexName, filter, update: { metadata: { corrupted: true } } });
    else await fixture.vector.deleteVectors({ indexName, filter });
    return c.json({ accepted: true });
  } catch (error) {
    return c.json({ accepted: false, message: error instanceof Error ? error.message : String(error) }, 400);
  }
});
await adapter.registerRoutes();
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, address => {
  process.send?.({ type: 'ready', port: address.port, pid: process.pid });
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    if ('closeIdleConnections' in server) server.closeIdleConnections();
  });
  await Promise.all(fixture.memories.map(memory => memory.settled()));
  await fixture.mastra.shutdown();
  await Promise.all(fixture.allVectors.map(vector => vector.disconnect()));
  await fixture.storage.disconnect();
  process.disconnect?.();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(
    signal,
    () =>
      void stop().catch(error => {
        console.error(error);
        process.exitCode = 1;
        process.disconnect?.();
      }),
  );
}
