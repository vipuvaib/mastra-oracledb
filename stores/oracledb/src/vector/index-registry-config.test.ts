import { describe, expect, it, vi } from 'vitest';

import { indexNameForTable, tableNameForIndex } from './identifiers';
import type { OracleIndexStats, OracleVectorIndexConfig } from './types';
import { OracleVector } from '.';

type RegistryRow = Omit<OracleIndexStats, 'count'>;
type Operation = 'build' | 'rebuild' | 'create';
const operations: Operation[] = ['build', 'rebuild', 'create'];

function registryRow(indexName: string, overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    indexName,
    tableName: tableNameForIndex(indexName),
    dimension: 3,
    metric: 'cosine',
    indexType: 'none',
    vectorFormat: 'vector',
    accuracy: 95,
    ...overrides,
  };
}

// Keep the real lookup, DDL, configuration UPDATE, and cache paths. The connection
// models case-sensitive registry keys instead of making every UPDATE succeed.
function createRegistryFixture(registered: RegistryRow[], { loseRowOnUpdate = false } = {}) {
  const registry = new Map(registered.map(row => [row.indexName, { ...row }]));
  const tables = new Set(registered.map(row => row.tableName));
  const physicalIndexes = new Set(
    registered.filter(row => row.indexType !== 'none').map(row => indexNameForTable(row.tableName, 'VECTOR_IDX')),
  );
  const execute = vi.fn(async (sql: string, binds: Record<string, unknown> = {}) => {
    const statement = sql.trim();
    if (statement.startsWith('CREATE VECTOR INDEX')) {
      const index = /^CREATE VECTOR INDEX "([^"]+)"/.exec(statement)?.[1];
      if (!index) throw new Error(`Unexpected vector index DDL: ${statement}`);
      if (physicalIndexes.has(index)) {
        throw Object.assign(new Error('ORA-00955: name is already used by an existing object'), { errorNum: 955 });
      }
      physicalIndexes.add(index);
      return { rows: [], rowsAffected: 0 };
    }
    if (statement.startsWith('DROP INDEX')) {
      const index = /^DROP INDEX "([^"]+)"/.exec(statement)?.[1];
      if (!index) throw new Error(`Unexpected vector index DDL: ${statement}`);
      if (!physicalIndexes.delete(index)) {
        throw Object.assign(new Error('ORA-01418: specified index does not exist'), { errorNum: 1418 });
      }
      return { rows: [], rowsAffected: 0 };
    }
    if (statement.startsWith('CREATE TABLE')) {
      const table = /^CREATE TABLE "([^"]+)"/.exec(statement)?.[1];
      if (!table) throw new Error(`Unexpected table DDL: ${statement}`);
      tables.add(table);
      return { rows: [], rowsAffected: 0 };
    }
    if (statement.startsWith('ALTER TABLE')) return { rows: [], rowsAffected: 0 };
    if (statement.startsWith('UPDATE')) {
      if (!/WHERE index_name = :indexName\s*$/.test(statement)) {
        throw new Error(`Expected a single resolved-key UPDATE: ${statement}`);
      }
      const key = String(binds.indexName);
      // A concurrent removal is injected here solely to exercise zero-row handling.
      if (loseRowOnUpdate) {
        registry.delete(key);
        return { rows: [], rowsAffected: 0 };
      }
      const row = registry.get(key);
      if (!row) return { rows: [], rowsAffected: 0 };
      registry.set(key, {
        ...row,
        metric: binds.metric as RegistryRow['metric'],
        indexType: binds.index_type as RegistryRow['indexType'],
        accuracy: Number(binds.accuracy),
      });
      return { rows: [], rowsAffected: 1 };
    }
    if (statement.startsWith('SELECT') && statement.includes('table_name AS "tableName"')) {
      const row = registry.get(String(binds.indexName)) ?? registry.get(String(binds.legacyIndexName));
      return { rows: row ? [{ ...row }] : [] };
    }
    if (statement.startsWith('SELECT') && statement.includes('FROM all_tables')) {
      return { rows: tables.has(String(binds.tableName)) ? [{ exists: 1 }] : [] };
    }
    if (statement.startsWith('SELECT COUNT(*)')) return { rows: [{ count: 0 }] };
    throw new Error(`Unexpected SQL in registry configuration fixture: ${statement}`);
  });
  const connection = {
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
  const poolManager = {
    withConnection: vi.fn(async <T>(callback: (client: typeof connection) => Promise<T>) => callback(connection)),
    close: vi.fn(async () => undefined),
  };
  const createVector = () =>
    new OracleVector({
      id: 'oracle-registry-config-unit',
      poolManager,
      defaultIndexConfig: { type: 'none' },
      defaultMetadataIndexes: [],
    } as any);

  return { vector: createVector(), createVector, registry, physicalIndexes, connection };
}

function applyConfiguration(vector: OracleVector, operation: Operation, indexName: string) {
  const indexConfig: OracleVectorIndexConfig = { type: 'ivf', accuracy: 87, ivf: { neighborPartitions: 1 } };
  if (operation === 'build') return vector.buildIndex({ indexName, indexConfig });
  if (operation === 'rebuild') return vector.rebuildIndex({ indexName, metric: 'euclidean', indexConfig });
  return vector.createIndex({ indexName, dimension: 3, metric: 'cosine', indexConfig });
}

describe('OracleVector registry configuration identity', () => {
  it.each(operations)(
    '%s updates the resolved uppercase registry row when called through its lowercase alias',
    async operation => {
      const original = registryRow('CONFIG_INDEX', operation === 'rebuild' ? { indexType: 'ivf', accuracy: 90 } : {});
      const fixture = createRegistryFixture([original]);
      const indexName = 'config_index';
      // Warm the alias cache as well as the resolved-key entry before changing config.
      await expect(fixture.vector.describeIndex({ indexName })).resolves.toMatchObject(original);

      await applyConfiguration(fixture.vector, operation, indexName);

      const expected = {
        ...original,
        metric: operation === 'rebuild' ? 'euclidean' : 'cosine',
        indexType: 'ivf',
        accuracy: 87,
      };
      expect(fixture.physicalIndexes.has(indexNameForTable(original.tableName, 'VECTOR_IDX'))).toBe(true);
      expect([...fixture.registry.keys()]).toEqual(['CONFIG_INDEX']);
      expect(fixture.registry.get('CONFIG_INDEX')).toEqual(expected);
      await expect(fixture.vector.describeIndex({ indexName })).resolves.toMatchObject(expected);
      await expect(fixture.vector.describeIndex({ indexName: 'CONFIG_INDEX' })).resolves.toMatchObject(expected);
      // A new provider has no warmed metadata cache and must agree with the writer.
      await expect(fixture.createVector().describeIndex({ indexName })).resolves.toMatchObject(expected);
    },
  );

  it.each(['exact_lowercase', 'Exact_MixedCase'])('preserves the exact case-sensitive key %s', async indexName => {
    const original = registryRow(indexName);
    const fixture = createRegistryFixture([original]);

    await applyConfiguration(fixture.vector, 'build', indexName);

    expect([...fixture.registry.keys()]).toEqual([indexName]);
    expect(fixture.registry.get(indexName)).toMatchObject({ indexName, indexType: 'ivf', accuracy: 87 });
    await expect(fixture.createVector().describeIndex({ indexName })).resolves.toMatchObject({
      indexName,
      indexType: 'ivf',
      accuracy: 87,
    });
  });

  it('updates only the exact-match row when both exact and uppercase fallback keys exist', async () => {
    const exact = registryRow('config_index', { tableName: 'EXACT_CONFIG_TABLE' });
    const fallback = registryRow('CONFIG_INDEX', { tableName: 'LEGACY_CONFIG_TABLE' });
    const fixture = createRegistryFixture([exact, fallback]);

    await applyConfiguration(fixture.vector, 'build', exact.indexName);

    expect(fixture.registry.get(exact.indexName)).toMatchObject({ indexType: 'ivf', accuracy: 87 });
    expect(fixture.registry.get(fallback.indexName)).toEqual(fallback);
    expect(fixture.physicalIndexes.has(indexNameForTable(exact.tableName, 'VECTOR_IDX'))).toBe(true);
    expect(fixture.physicalIndexes.has(indexNameForTable(fallback.tableName, 'VECTOR_IDX'))).toBe(false);
  });

  it.each(operations)(
    '%s rejects a zero-row configuration UPDATE and invalidates previously cached metadata',
    async operation => {
      // Use an exact key so this tests zero-row handling independently of alias resolution.
      const original = registryRow(
        'disappearing_index',
        operation === 'rebuild' ? { indexType: 'ivf', accuracy: 90 } : {},
      );
      const fixture = createRegistryFixture([original], { loseRowOnUpdate: true });
      await fixture.vector.describeIndex({ indexName: original.indexName });

      await expect(applyConfiguration(fixture.vector, operation, original.indexName)).rejects.toThrow();

      // The DDL already succeeded: the failure must not be presented as a successful
      // registry/cache transition, nor as an atomic rollback of the physical index.
      expect(fixture.physicalIndexes.has(indexNameForTable(original.tableName, 'VECTOR_IDX'))).toBe(true);
      expect(fixture.registry.has(original.indexName)).toBe(false);
      expect(fixture.connection.commit).not.toHaveBeenCalled();
      await expect(fixture.vector.describeIndex({ indexName: original.indexName })).rejects.toThrow(/does not exist/i);
    },
  );
});
