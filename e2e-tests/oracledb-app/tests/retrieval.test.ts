import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';

const { server, ids } = suite('retrieval');
const indexName = `app_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const tenant = randomUUID();
const docA = randomUUID();
const docB = randomUUID();
const foreign = randomUUID();

it('B01 creates, embeds and filters a real Oracle vector collection through HTTP', async () => {
  const vector = server.client.getVector('oracle');
  await vector.createIndex({ indexName, dimension: 3, metric: 'cosine' });
  await vector.upsert({
    indexName,
    ids: [docA, docB, foreign],
    vectors: [
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ],
    metadata: [
      { tenant, text: 'ALPHA document', active: true, version: 2 },
      { tenant, text: 'BETA document', active: false, version: 1 },
      { tenant: 'foreign', text: 'ALPHA secret', active: true, version: 3 },
    ],
  });
  const result = z.array(z.object({ id: z.string(), score: z.number() })).parse(
    await vector.query({
      indexName,
      queryVector: [1, 0, 0],
      topK: 5,
      filter: { $and: [{ tenant }, { active: true }, { version: { $gte: 2 } }] },
    }),
  );
  expect(result.map(row => row.id)).toEqual([docA]);
  expect(result[0]!.score).toBeCloseTo(1, 5);
  expect((await vector.details(indexName)).count).toBe(3);
});

it('B02 retrieves through an agent tool and persists the actual returned document', async () => {
  const thread = randomUUID();
  const result = await server.client
    .getAgent('history')
    .generate(`SEARCH ${indexName} ALPHA ${tenant}`, { memory: { thread, resource: ids.resource } });
  expect(JSON.parse(result.text)).toEqual({ ids: [docA], texts: ['ALPHA document'] });
  await server.settle();
  const messages = await server.client
    .getMemoryThread({ threadId: thread, agentId: 'history' })
    .listMessages({ perPage: 100 });
  expect(JSON.stringify(messages.messages)).toContain(docA);
  expect(JSON.stringify(messages.messages)).not.toContain('ALPHA secret');
});

it('B03 persists vector updates across process restart and removes only the requested collection', async () => {
  const vector = server.client.getVector('oracle');
  await vector.upsert({
    indexName,
    ids: [docA],
    vectors: [[0, 0, 1]],
    metadata: [{ tenant, text: 'GAMMA replacement', active: true, version: 4 }],
  });
  await server.restart();
  const current = server.client.getVector('oracle');
  const result = await current.query({ indexName, queryVector: [0, 0, 1], topK: 1, filter: { tenant } });
  expect(result[0]).toMatchObject({ id: docA, metadata: { text: 'GAMMA replacement' } });
  expect((await current.details(indexName)).count).toBe(3);
  recordEvidence('B03', { indexName, documentIds: [docA, docB, foreign], restartedPid: server.child!.pid });
  const sibling = 'app_' + randomUUID().replaceAll('-', '').slice(0, 8);
  await current.createIndex({ indexName: sibling, dimension: 3, metric: 'cosine' });
  await current.upsert({
    indexName: sibling,
    ids: [docB],
    vectors: [[0, 1, 0]],
    metadata: [{ tenant, text: 'Sibling BETA' }],
  });
  const beforeDelete = await current.getIndexes();
  await current.delete(indexName);
  expect((await current.getIndexes()).sort()).toEqual(beforeDelete.filter(name => name !== indexName).sort());
  expect((await current.query({ indexName: sibling, queryVector: [0, 1, 0], topK: 1 }))[0]).toMatchObject({ id: docB });
  await current.delete(sibling);
});
