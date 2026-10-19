import { describe, expect, it, vi } from 'vitest';

import { tableNameForIndex } from './identifiers';
import { OracleVector } from '.';

type RegistryRow = {
  indexName: string;
  tableName: string;
  dimension: number;
  metric: string;
  indexType: string;
  vectorFormat: string;
  accuracy: number;
};

function registryRow(indexName: string, tableName = tableNameForIndex(indexName)): RegistryRow {
  return {
    indexName,
    tableName,
    dimension: 3,
    metric: 'cosine',
    indexType: 'none',
    vectorFormat: 'vector',
    accuracy: 95,
  };
}

// Exercise the public API and real registry lookup/deletion SQL against mutable state.
// Only the connection is mocked; an unsafe DROP must actually remove the simulated table.
function createDeletionFixture({
  registered = [],
  physicalTables = registered.map(row => row.tableName),
  tablePrefix = 'MASTRA_VEC',
  schemaName,
}: {
  registered?: RegistryRow[];
  physicalTables?: string[];
  tablePrefix?: string;
  schemaName?: string;
} = {}) {
  const registry = new Map(registered.map(row => [row.indexName, row]));
  const tables = new Set(physicalTables);
  const execute = vi.fn(async (sql: string, binds: Record<string, unknown> = {}) => {
    const statement = sql.trim();
    if (statement.startsWith('CREATE TABLE') || statement.startsWith('ALTER TABLE')) {
      return { rows: [], rowsAffected: 0 };
    }
    if (statement.startsWith('DROP TABLE')) {
      const tableName = /^DROP TABLE (?:"[^"]+"\.)?"([^"]+)"/.exec(statement)?.[1];
      if (!tableName) throw new Error(`Unexpected DROP statement: ${statement}`);
      if (!tables.delete(tableName)) {
        throw Object.assign(new Error('ORA-00942: table or view does not exist'), { errorNum: 942 });
      }
      return { rows: [], rowsAffected: 0 };
    }
    if (statement.startsWith('DELETE FROM')) {
      const exact = /WHERE index_name = :(\w+)\s*$/.exec(statement);
      const membership = /WHERE index_name IN \(([^)]+)\)\s*$/.exec(statement);
      const bindNames = exact ? [exact[1]!] : membership?.[1]?.match(/:\w+/g)?.map(name => name.slice(1));
      if (!bindNames) throw new Error(`Unexpected registry DELETE: ${statement}`);
      let rowsAffected = 0;
      for (const key of new Set(bindNames.map(name => binds[name]))) {
        if (typeof key === 'string' && registry.delete(key)) rowsAffected += 1;
      }
      return { rows: [], rowsAffected };
    }
    if (statement.startsWith('SELECT') && statement.includes('table_name AS "tableName"')) {
      const exact = registry.get(String(binds.indexName));
      const legacy = registry.get(String(binds.legacyIndexName));
      return { rows: exact ? [exact] : legacy ? [legacy] : [] };
    }
    if (statement.startsWith('SELECT') && statement.includes('WHERE table_name = :tableName')) {
      const owner = [...registry.values()].find(row => row.tableName === binds.tableName);
      return { rows: owner ? [{ indexName: owner.indexName }] : [] };
    }
    if (statement.startsWith('SELECT') && statement.includes('FROM all_tables')) {
      return { rows: tables.has(String(binds.tableName)) ? [{ exists: 1 }] : [] };
    }
    if (statement.startsWith('SELECT COUNT(*)')) {
      const tableName = /FROM (?:"[^"]+"\.)?"([^"]+)"/.exec(statement)?.[1];
      if (!tableName || !tables.has(tableName)) {
        throw Object.assign(new Error('ORA-00942: table or view does not exist'), { errorNum: 942 });
      }
      return { rows: [{ count: 0 }] };
    }
    throw new Error(`Unexpected SQL in deletion fixture: ${statement}`);
  });
  const connection = {
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
  const createVector = () =>
    new OracleVector({
      id: 'oracle-vector-delete-regression',
      poolManager: {
        withConnection: vi.fn(async <T>(callback: (client: typeof connection) => Promise<T>) => callback(connection)),
        close: vi.fn(async () => undefined),
      },
      tablePrefix,
      schemaName,
      defaultIndexConfig: { type: 'none' },
    } as any);
  const drops = () => execute.mock.calls.map(([sql]) => sql.trim()).filter(sql => sql.startsWith('DROP TABLE'));
  const deletes = () => execute.mock.calls.map(([sql]) => sql.trim()).filter(sql => sql.startsWith('DELETE FROM'));

  return { vector: createVector(), createVector, registry, tables, drops, deletes };
}

describe('OracleVector registry-authoritative deletion', () => {
  it('does not drop another registered index when an unknown logical name collides with its physical name', async () => {
    const registeredName = 'tenant-a';
    const unknownName = 'tenant_a';
    const originalRow = registryRow(registeredName);
    expect(tableNameForIndex(unknownName)).toBe(originalRow.tableName);
    const fixture = createDeletionFixture({ registered: [originalRow] });

    await expect(fixture.vector.deleteIndex({ indexName: unknownName })).resolves.toBeUndefined();

    expect(fixture.drops()).toEqual([]);
    expect(fixture.deletes()).toEqual([]);
    expect(fixture.tables.has(originalRow.tableName)).toBe(true);
    expect(fixture.registry.get(registeredName)).toEqual(originalRow);
  });

  it('treats an unknown index with no physical table as a no-op', async () => {
    const fixture = createDeletionFixture();

    await expect(fixture.vector.deleteIndex({ indexName: 'never_created' })).resolves.toBeUndefined();

    expect(fixture.drops()).toEqual([]);
    expect(fixture.deletes()).toEqual([]);
    expect(fixture.registry.size).toBe(0);
  });

  it('leaves an unregistered physical table untouched instead of implicitly cleaning up an orphan', async () => {
    const indexName = 'orphan_index';
    const tableName = tableNameForIndex(indexName);
    const fixture = createDeletionFixture({ physicalTables: [tableName] });

    await expect(fixture.vector.deleteIndex({ indexName })).resolves.toBeUndefined();

    expect(fixture.drops()).toEqual([]);
    expect(fixture.deletes()).toEqual([]);
    expect(fixture.tables.has(tableName)).toBe(true);
  });

  it('deletes a registered index and its registry entry without touching another index', async () => {
    const target = registryRow('delete_me');
    const survivor = registryRow('keep_me');
    const fixture = createDeletionFixture({ registered: [target, survivor] });

    await fixture.vector.deleteIndex({ indexName: target.indexName });

    expect(fixture.drops()).toEqual([`DROP TABLE "${target.tableName}" CASCADE CONSTRAINTS PURGE`]);
    expect(fixture.tables.has(target.tableName)).toBe(false);
    expect(fixture.registry.has(target.indexName)).toBe(false);
    expect(fixture.tables.has(survivor.tableName)).toBe(true);
    expect(fixture.registry.get(survivor.indexName)).toEqual(survivor);
  });

  it('removes a stale registry entry when its recorded physical table is already missing', async () => {
    const target = registryRow('missing_table');
    const fixture = createDeletionFixture({ registered: [target], physicalTables: [] });

    await expect(fixture.vector.deleteIndex({ indexName: target.indexName })).resolves.toBeUndefined();

    expect(fixture.drops()).toEqual([`DROP TABLE "${target.tableName}" CASCADE CONSTRAINTS PURGE`]);
    expect(fixture.registry.has(target.indexName)).toBe(false);
  });

  it('uses the recorded schema-qualified table even when the configured prefix has changed', async () => {
    const target = registryRow('prefix_changed', 'OLD_VEC_PREFIX_CHANGED');
    const derivedTable = tableNameForIndex(target.indexName, 'NEW_VEC');
    const fixture = createDeletionFixture({
      registered: [target],
      physicalTables: [target.tableName, derivedTable],
      tablePrefix: 'NEW_VEC',
      schemaName: 'APP_SCHEMA',
    });

    await fixture.vector.deleteIndex({ indexName: target.indexName });

    expect(fixture.drops()).toEqual([`DROP TABLE "APP_SCHEMA"."${target.tableName}" CASCADE CONSTRAINTS PURGE`]);
    expect(fixture.registry.has(target.indexName)).toBe(false);
    expect(fixture.tables.has(target.tableName)).toBe(false);
    expect(fixture.tables.has(derivedTable)).toBe(true);
  });

  it('still resolves and deletes an uppercase legacy registry row', async () => {
    const target = registryRow('LEGACY_INDEX', 'OLD_VEC_LEGACY_INDEX');
    const fixture = createDeletionFixture({ registered: [target] });

    await fixture.vector.deleteIndex({ indexName: 'legacy_index' });

    expect(fixture.drops()).toEqual([`DROP TABLE "${target.tableName}" CASCADE CONSTRAINTS PURGE`]);
    expect(fixture.registry.has(target.indexName)).toBe(false);
    expect(fixture.tables.has(target.tableName)).toBe(false);
  });

  it('makes a repeated deletion a no-op without attempting another DROP or registry DELETE', async () => {
    const target = registryRow('delete_twice');
    const fixture = createDeletionFixture({ registered: [target] });
    await fixture.vector.deleteIndex({ indexName: target.indexName });
    const originalDrops = fixture.drops();
    const originalDeletes = fixture.deletes();

    await expect(fixture.vector.deleteIndex({ indexName: target.indexName })).resolves.toBeUndefined();

    expect(fixture.drops()).toEqual(originalDrops);
    expect(fixture.deletes()).toEqual(originalDeletes);
    expect(fixture.registry.size).toBe(0);
    expect(fixture.tables.size).toBe(0);
  });
});

describe('OracleVector resolved-key deletion', () => {
  it.each([
    { indexName: 'config_index', schemaName: undefined },
    { indexName: 'Config_Index', schemaName: 'APP_SCHEMA' },
  ])('preserves the separate uppercase registry entry when deleting $indexName', async ({ indexName, schemaName }) => {
    const target = registryRow(indexName, 'EXACT_CASE_TABLE');
    const survivor = registryRow(indexName.toUpperCase(), 'UPPER_CASE_TABLE');
    const fixture = createDeletionFixture({ registered: [target, survivor], schemaName });
    // Cached metadata must not conceal the surviving row's deletion.
    await fixture.vector.describeIndex({ indexName: target.indexName });
    await fixture.vector.describeIndex({ indexName: survivor.indexName });

    await fixture.vector.deleteIndex({ indexName: target.indexName });

    expect(fixture.tables.has(target.tableName)).toBe(false);
    expect(fixture.tables.has(survivor.tableName)).toBe(true);
    expect([...fixture.registry.keys()]).toEqual([survivor.indexName]);
    expect(fixture.registry.get(survivor.indexName)).toEqual(survivor);
    expect(fixture.drops()).toHaveLength(1);
    await expect(fixture.createVector().describeIndex({ indexName: survivor.indexName })).resolves.toMatchObject(
      survivor,
    );
  });

  it('preserves the separate uppercase entry when the exact entry points to an already-missing table', async () => {
    const target = registryRow('config_index', 'MISSING_EXACT_TABLE');
    const survivor = registryRow('CONFIG_INDEX', 'UPPER_CASE_TABLE');
    const fixture = createDeletionFixture({ registered: [target, survivor], physicalTables: [survivor.tableName] });

    await expect(fixture.vector.deleteIndex({ indexName: target.indexName })).resolves.toBeUndefined();

    expect(fixture.tables.has(survivor.tableName)).toBe(true);
    expect([...fixture.registry.keys()]).toEqual([survivor.indexName]);
    expect(fixture.registry.get(survivor.indexName)).toEqual(survivor);
    await expect(fixture.createVector().describeIndex({ indexName: survivor.indexName })).resolves.toMatchObject(
      survivor,
    );
  });

  it('preserves the lowercase exact entry when deleting the uppercase exact entry', async () => {
    const target = registryRow('CONFIG_INDEX', 'UPPER_CASE_TABLE');
    const survivor = registryRow('config_index', 'LOWER_CASE_TABLE');
    const fixture = createDeletionFixture({ registered: [survivor, target] });

    await fixture.vector.deleteIndex({ indexName: target.indexName });

    expect(fixture.tables.has(target.tableName)).toBe(false);
    expect(fixture.tables.has(survivor.tableName)).toBe(true);
    expect([...fixture.registry.keys()]).toEqual([survivor.indexName]);
    await expect(fixture.createVector().describeIndex({ indexName: survivor.indexName })).resolves.toMatchObject(
      survivor,
    );
  });
});
