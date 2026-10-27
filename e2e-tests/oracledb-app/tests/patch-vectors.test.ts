import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { testOperation } from '../helpers/http.ts';
import { suite } from '../helpers/suite.ts';

const { server, store } = suite('patch-vectors');
const name = () => 'app_' + randomUUID().replaceAll('-', '').slice(0, 8);
const idsFrom = (value: unknown) =>
  z
    .array(z.object({ id: z.string() }))
    .parse(value)
    .map(row => row.id)
    .sort();

it('B04 deleting an unknown logical name cannot drop a registered collection with the same normalized physical name', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const registered = 'tenant-a_' + suffix;
  const colliding = 'tenant_a_' + suffix;
  const vector = server.client.getVector('oracle');
  await vector.createIndex({ indexName: registered, dimension: 3, metric: 'cosine' });
  await vector.upsert({ indexName: registered, ids: ['registered-document'], vectors: [[1, 0, 0]] });
  await vector.delete(colliding);
  await server.restart();
  const fresh = server.client.getVector('oracle');
  expect(await fresh.getIndexes()).toContain(registered);
  expect(await fresh.details(registered)).toMatchObject({ count: 1 });
  expect(idsFrom(await fresh.query({ indexName: registered, queryVector: [1, 0, 0], topK: 1 }))).toEqual([
    'registered-document',
  ]);
  recordEvidence('B04', { registeredName: registered, collidingUnknownName: colliding });
  await fresh.delete(registered);
});

it('B05 deletes only the resolved exact registry key while a distinct uppercase key stays queryable', async () => {
  const exact = 'app_case_' + randomUUID().replaceAll('-', '').slice(0, 8);
  const upper = exact.toUpperCase();
  const lowWriter = server.client.getVector('identityExact');
  const upperWriter = server.client.getVector('identityUpper');
  await lowWriter.createIndex({ indexName: exact, dimension: 3, metric: 'cosine' });
  await upperWriter.createIndex({ indexName: upper, dimension: 3, metric: 'cosine' });
  await lowWriter.upsert({ indexName: exact, ids: ['exact-document'], vectors: [[1, 0, 0]] });
  await upperWriter.upsert({ indexName: upper, ids: ['upper-document'], vectors: [[0, 1, 0]] });
  const rows = () =>
    store.db.execute<{ indexName: string; tableName: string }>(
      'SELECT index_name AS "indexName", table_name AS "tableName" FROM "APP_IDENTITY_REGISTRY" WHERE index_name IN (:exact, :upper)',
      { exact, upper },
    );
  const before = await rows();
  expect(before).toHaveLength(2);
  expect(new Set(before.map(row => row.tableName)).size).toBe(2);
  await server.client.getVector('identityReader').details(exact);
  await server.client.getVector('identityReader').details(upper);
  await lowWriter.delete(exact);
  await server.restart();
  expect(await rows()).toEqual(before.filter(row => row.indexName === upper));
  const reader = server.client.getVector('identityReader');
  expect(await reader.details(upper)).toMatchObject({ count: 1 });
  expect(idsFrom(await reader.query({ indexName: upper, queryVector: [0, 1, 0], topK: 1 }))).toEqual([
    'upper-document',
  ]);
  // With the exact key gone, this lowercase alias resolves to the surviving legacy uppercase key.
  await reader.delete(exact);
  expect(await rows()).toEqual([]);
  recordEvidence('B05', { exactName: exact, uppercaseName: upper, initialRows: before });
});

it('B06 build, rebuild and existing-table create preserve canonical registry identity through aliases', async () => {
  const outcomes = [];
  for (const operation of ['build', 'rebuild', 'create'] as const) {
    const registered = ('app_alias_' + randomUUID().replaceAll('-', '').slice(0, 8)).toUpperCase();
    const alias = registered.toLowerCase();
    const writer = server.client.getVector('identityUpper');
    await writer.createIndex({ indexName: registered, dimension: 3, metric: 'cosine' });
    const ids = Array.from({ length: 32 }, (_, index) => 'config-' + index);
    await writer.upsert({
      indexName: registered,
      ids,
      vectors: ids.map((_, index) => (index === 0 ? [1, 0, 0] : [0.1, (index + 1) / 33, 0.1])),
    });
    await writer.details(alias);
    if (operation === 'rebuild')
      await testOperation(server, 'vector/config', { indexName: registered, operation: 'build', accuracy: 90 });
    await testOperation(server, 'vector/config', { indexName: alias, operation, accuracy: 87 });
    const expected = {
      indexName: registered,
      indexType: 'ivf',
      metric: operation === 'rebuild' ? 'euclidean' : 'cosine',
      accuracy: 87,
    };
    const persisted = await store.db.execute(
      'SELECT index_name AS "indexName", index_type AS "indexType", metric AS "metric", accuracy AS "accuracy" FROM "APP_IDENTITY_REGISTRY" WHERE index_name IN (:registered, :alias)',
      { registered, alias },
    );
    expect(persisted).toEqual([expected]);
    await server.restart();
    const reader = server.client.getVector('identityReader');
    expect(await testOperation(server, 'vector/identity', { indexName: alias })).toMatchObject({
      ...expected,
      count: 32,
    });
    expect(await reader.details(alias)).toMatchObject({ dimension: 3, count: 32, metric: expected.metric });
    expect(await reader.details(registered)).toMatchObject({ dimension: 3, count: 32, metric: expected.metric });
    expect(idsFrom(await reader.query({ indexName: alias, queryVector: [1, 0, 0], topK: 32 }))).toEqual(
      [...ids].sort(),
    );
    outcomes.push({ operation, registered, alias, persisted });
    await reader.delete(alias);
  }
  recordEvidence('B06', { operations: outcomes });
});

it('B07 applies each patched JSON filter operator to actual Oracle result IDs', async () => {
  const indexName = name();
  const vector = server.client.getVector('oracle');
  const rows = [
    { id: 'a', metadata: { rank: 10, tags: ['premium', 'blue'], nullable: null, title: 'ORACLE\nDATABASE' } },
    {
      id: 'b',
      metadata: { rank: '20', tags: ['premium-plan'], nullable: 'null', title: 'prefix\noracle database\nsuffix' },
    },
    { id: 'c', metadata: { rank: 20, tags: [], title: 'oracle database' } },
    { id: 'd', metadata: { rank: 'N/A', tags: 'premium', title: 'other' } },
    { id: 'e', metadata: { rank: true, tags: { inner: 'premium' }, nullable: [] } },
  ];
  await vector.createIndex({ indexName, dimension: 3, metric: 'cosine' });
  await vector.upsert({
    indexName,
    ids: rows.map(row => row.id),
    vectors: rows.map(() => [1, 0, 0]),
    metadata: rows.map(row => row.metadata),
  });
  const cases: { operator: string; filter: Record<string, unknown>; ids: string[] }[] = [
    { operator: 'numeric-range', filter: { rank: { $gte: 15 } }, ids: ['c'] },
    { operator: 'array-contains-exact', filter: { tags: { $contains: 'premium' } }, ids: ['a', 'd'] },
    { operator: 'empty-all', filter: { tags: { $all: [] } }, ids: [] },
    { operator: 'array-nin', filter: { tags: { $nin: ['premium'] } }, ids: ['b', 'c'] },
    { operator: 'null-equality', filter: { nullable: { $eq: null } }, ids: ['a', 'c', 'd'] },
    { operator: 'null-inequality', filter: { nullable: { $ne: null } }, ids: ['b', 'e'] },
    { operator: 'array-size', filter: { tags: { $size: 0 } }, ids: ['c'] },
    { operator: 'array-size-one-excludes-nonarrays', filter: { tags: { $size: 1 } }, ids: ['b'] },
    { operator: 'array-contains-list-excludes-scalars', filter: { tags: { $contains: ['premium'] } }, ids: ['a'] },
    { operator: 'regex-dotall', filter: { title: { $regex: '^oracle.*database$', $options: 'is' } }, ids: ['a', 'c'] },
    {
      operator: 'regex-multiline',
      filter: { title: { $regex: '^oracle database$', $options: 'im' } },
      ids: ['b', 'c'],
    },
  ];
  const outcomes = [];
  for (const testCase of cases) {
    const ids = idsFrom(await vector.query({ indexName, queryVector: [1, 0, 0], topK: 10, filter: testCase.filter }));
    expect(ids, testCase.operator).toEqual(testCase.ids);
    outcomes.push({ operator: testCase.operator, expectedIds: testCase.ids, actualIds: ids });
  }
  recordEvidence('B07', { indexName, cases: outcomes });
  await vector.delete(indexName);
});

it('B08 rejects match-all destructive filters before changing any stored vector or metadata', async () => {
  const indexName = name();
  const vector = server.client.getVector('oracle');
  await vector.createIndex({ indexName, dimension: 3, metric: 'cosine' });
  await vector.upsert({
    indexName,
    ids: ['keep-a', 'keep-b'],
    vectors: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    metadata: [{ keep: true }, { keep: true }],
  });
  const before = await vector.query({ indexName, queryVector: [1, 0, 0], topK: 10 });
  const filters = [{}, { $and: [] }, { $not: { tags: { $all: [] } } }, { $not: { tags: { $in: [] } } }];
  for (const filter of filters) {
    for (const operation of ['update', 'delete']) {
      const response = await fetch(server.baseUrl + '/_test/vector/mutate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ indexName, filter, operation }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        accepted: false,
        message: expect.stringMatching(Object.keys(filter).length ? /match-all filter/i : /empty filter/i),
      });
      expect(await vector.query({ indexName, queryVector: [1, 0, 0], topK: 10 })).toEqual(before);
    }
  }
  for (const operation of ['update', 'delete']) {
    expect(
      await testOperation(server, 'vector/mutate', { indexName, filter: { tags: { $all: [] } }, operation }),
    ).toMatchObject({ accepted: true });
    expect(await vector.query({ indexName, queryVector: [1, 0, 0], topK: 10 })).toEqual(before);
  }
  recordEvidence('B08', {
    indexName,
    rejectedMutations: filters.length * 2,
    acceptedMatchNoneMutations: 2,
    preservedIds: idsFrom(before),
  });
  await vector.delete(indexName);
});
