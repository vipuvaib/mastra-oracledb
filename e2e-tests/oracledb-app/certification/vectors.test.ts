import { randomUUID } from 'node:crypto';
import { OracleVector } from '@mastra/oracledb';
import { expect, it } from 'vitest';
import { openStore, verifyLease } from '../helpers/database.ts';
import { environment } from '../helpers/environment.ts';
import { recordEvidence } from '../helpers/evidence.ts';

function corpus() {
  let state = 104729;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
  return Array.from({ length: 512 }, () => {
    const vector = Array.from({ length: 32 }, random);
    const length = Math.hypot(...vector);
    return vector.map(value => value / length);
  });
}
for (const [id, type] of [
  ['Q01', 'ivf'],
  ['Q02', 'hnsw'],
] as const) {
  // Percentage targets can select too few IVF partitions for this small uniform corpus.
  // Six of eight partitions keeps an approximate search with a measured recall margin.
  const searchOptions = type === 'ivf' ? { neighborPartitionProbes: 6 } : { targetAccuracy: 95 };
  it(
    id + ' measures ' + type.toUpperCase() + ' recall against exact search after reconnect',
    async () => {
      const store = openStore('certification-' + type);
      const config = environment();
      const settings = { id: 'recall-' + type, ...config.connection, schemaName: config.schema };
      const vector = new OracleVector(settings);
      const indexName = 'recall_' + randomUUID().replaceAll('-', '').slice(0, 8);
      const vectors = corpus();
      const ids = vectors.map((_, index) => 'document-' + index);
      try {
        await verifyLease(store);
        await vector.createIndex({
          indexName,
          dimension: 32,
          metric: 'cosine',
          indexConfig: { type: 'none' },
          metadataIndexes: [],
        });
        await vector.upsert({ indexName, ids, vectors });
        await vector.buildIndex({
          indexName,
          indexConfig: {
            type,
            accuracy: 95,
            ...(type === 'ivf' ? { ivf: { neighborPartitions: 8 } } : { hnsw: { neighbors: 32, efConstruction: 200 } }),
          },
        });
        expect(await vector.describeIndex({ indexName })).toMatchObject({ count: 512, dimension: 32, indexType: type });
        const status = await vector.getIndexStatus({ indexName });
        expect(status).toMatch(/^VALID\b/);
        recordEvidence(id, {
          indexName,
          status,
          corpus: { seed: 104729, count: 512, dimension: 32, normalized: true },
          topK: 10,
          minimumMeanRecall: 0.9,
          indexAccuracy: 95,
          neighborPartitions: type === 'ivf' ? 8 : undefined,
          ...searchOptions,
        });
        await vector.disconnect();
        const fresh = new OracleVector(settings);
        try {
          const queries = [];
          for (let query = 0; query < 20; query++) {
            const queryVector = vectors[query * 23]!;
            const exact = await fresh.query({ indexName, queryVector, topK: 10, queryMode: 'exact' });
            const approximate = await fresh.query({
              indexName,
              queryVector,
              topK: 10,
              queryMode: 'approx',
              ...searchOptions,
            });
            const exactIds = exact.map(row => row.id);
            const approximateIds = approximate.map(row => row.id);
            expect(exactIds).toHaveLength(10);
            expect(approximateIds).toHaveLength(10);
            expect(new Set(approximateIds).size).toBe(10);
            const recall = approximateIds.filter(value => exactIds.includes(value)).length / 10;
            queries.push({ query, exactIds, approximateIds, recall });
          }
          const meanRecall = queries.reduce((total, query) => total + query.recall, 0) / queries.length;
          recordEvidence(id, { indexName, queries, meanRecall });
          expect(meanRecall).toBeGreaterThanOrEqual(0.9);
        } finally {
          await fresh.disconnect();
        }
      } finally {
        await vector.disconnect();
        await store.disconnect();
      }
    },
    120_000,
  );
}
