import { randomUUID } from 'node:crypto';

import { TABLE_THREADS, TABLE_WORKFLOW_SNAPSHOT } from '@mastra/core/storage';
import type { Connection } from 'oracledb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpan } from '../../../_test-utils/src/domains/observability/data';
import { OraclePoolManager } from '../shared/connection';
import { normalizeIdentifier, qualifyName } from '../vector/identifiers';
import { generateOracleIndexSQL, OracleDB } from './db';
import { MemoryOracle } from './domains/memory';
import {
  createMessageWindowFixture,
  messageWindowCases,
  messageWindowEntryPoints,
} from './domains/memory/messages-include.test-fixtures';
import { ObservabilityOracle } from './domains/observability';
import { OracleStore } from '.';

const runIntegration = process.env.RUN_ORACLE_STORAGE_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration('OracleStore configurable schema integration', () => {
  it('creates custom memory and workflow indexes from OracleStore config', async () => {
    const suffix = Date.now();
    const threadIndexName = `IDX_ORACLE_THREADS_${suffix}`;
    const workflowIndexName = `IDX_ORACLE_WF_STATUS_${suffix}`;
    const store = new OracleStore({
      id: 'oracle-index-management-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      skipDefaultIndexes: true,
      indexes: [
        {
          name: threadIndexName,
          table: TABLE_THREADS,
          columns: ["JSON_VALUE(metadata, '$.topic' RETURNING VARCHAR2(128) NULL ON ERROR)", 'createdAt DESC'],
          compress: true,
        },
        {
          name: workflowIndexName,
          table: TABLE_WORKFLOW_SNAPSHOT,
          columns: ["JSON_VALUE(snapshot, '$.status' RETURNING VARCHAR2(64) NULL ON ERROR)", 'run_id'],
        },
      ],
    });

    try {
      await store.init();
      const indexNames = await listUserIndexes(store, [threadIndexName, workflowIndexName]);
      expect(indexNames).toEqual(expect.arrayContaining([threadIndexName, workflowIndexName]));
    } finally {
      await dropIndex(store, threadIndexName);
      await dropIndex(store, workflowIndexName);
      await store.disconnect();
    }
  });
});

describeIntegration('Oracle observability default indexes integration', () => {
  it('initializes a fresh schema with valid default indexes and round-trips entity names', async context => {
    // Explicitly opt into a dedicated, pre-created schema. Never reuse or clear
    // shared observability tables, create users, or change database settings.
    const configuredSchema = process.env.ORACLE_OBSERVABILITY_TEST_SCHEMA;
    if (!configuredSchema) {
      context.skip(
        'Set ORACLE_OBSERVABILITY_TEST_SCHEMA to a dedicated empty test schema; do not run it concurrently.',
      );
      return;
    }
    const schemaName = normalizeIdentifier(configuredSchema, 'observability test schema');
    const poolManager = new OraclePoolManager({
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
    });
    let lastFailedStatement: { sql: string; error: unknown } | undefined;
    // Observe real driver calls without replacing Oracle execution or changing
    // error codes (including expected, ignored errors such as ORA-01430).
    const diagnosticPoolManager = new Proxy(poolManager, {
      get(target, property) {
        if (property === 'withConnection') {
          return async <T>(callback: (connection: Connection) => Promise<T>): Promise<T> =>
            target.withConnection(connection =>
              callback(
                new Proxy(connection, {
                  get(client, key) {
                    if (key === 'execute') {
                      return async (...args: unknown[]) => {
                        try {
                          return await Reflect.apply(client.execute, client, args);
                        } catch (error) {
                          if (typeof args[0] === 'string') {
                            lastFailedStatement = { sql: args[0], error };
                          }
                          throw error;
                        }
                      };
                    }
                    const value = Reflect.get(client, key, client);
                    return typeof value === 'function' ? value.bind(client) : value;
                  },
                }),
              ),
            );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const db = new OracleDB({ poolManager, schemaName });
    const observability = new ObservabilityOracle({
      poolManager: diagnosticPoolManager,
      schemaName,
      skipDefaultIndexes: false,
    });
    const definitions = observability.getDefaultIndexDefinitions();
    const tableNames = ObservabilityOracle.MANAGED_TABLES.map(name => normalizeIdentifier(name, 'test table'));
    const objectNames = [...tableNames, ...definitions.map(index => index.name)];
    const nameBinds = Object.fromEntries(objectNames.map((name, index) => [`name${index}`, name]));
    const nameList = Object.keys(nameBinds)
      .map(name => `:${name}`)
      .join(', ');
    let initializationStarted = false;
    let primaryError: unknown;

    try {
      const [session] = await db.execute<{ userName: string }>(
        `SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS "userName" FROM dual`,
      );
      expect(
        session?.userName,
        'Connect as the dedicated test-schema owner; this test does not create users or require cross-schema privileges.',
      ).toBe(schemaName);
      const existing = await db.execute<{ name: string; type: string }>(
        `SELECT object_name AS "name", object_type AS "type" FROM all_objects
         WHERE owner = :owner AND object_name IN (${nameList})`,
        { owner: schemaName, ...nameBinds },
      );
      expect(
        existing,
        'Refusing to initialize or clean up pre-existing observability objects. Use an empty test schema.',
      ).toEqual([]);
      initializationStarted = true;

      try {
        await observability.init();
      } catch (error) {
        const diagnostics = await observabilityIndexDiagnostics(db, schemaName);
        throw new Error(
          `Default observability initialization failed.\n${lastFailedStatement?.sql ?? 'No failed SQL was captured.'}\n` +
            `Oracle error: ${String(lastFailedStatement?.error ?? error)}\nDiagnostics: ${JSON.stringify(diagnostics)}`,
          { cause: error },
        );
      }

      const indexes = await db.execute<{ name: string; status: string; tableName: string }>(
        `SELECT index_name AS "name", status AS "status", table_name AS "tableName" FROM all_indexes
         WHERE owner = :owner AND index_name IN (${nameList})`,
        { owner: schemaName, ...nameBinds },
      );
      expect(indexes).toHaveLength(definitions.length);
      for (const definition of definitions) {
        expect(indexes.find(index => index.name === definition.name)).toMatchObject({
          status: 'VALID',
          tableName: normalizeIdentifier(definition.table, 'indexed table'),
        });
      }
      const entityNameIndex = definitions.find(
        index => index.columns.length === 2 && index.columns[0] === 'entityType' && index.columns[1] === 'entityName',
      );
      expect(
        entityNameIndex,
        'The entityType/entityName composite must remain covered by this regression.',
      ).toBeDefined();

      if (process.env.ORACLE_OBSERVABILITY_DIAGNOSTICS === 'true' && entityNameIndex) {
        const evidence = {
          schemaName,
          // This is SQL requested by the provider, not stored DDL from DBMS_METADATA.
          providerGeneratedCompositeIndexSQL: generateOracleIndexSQL(entityNameIndex, schemaName),
          catalogIndexes: indexes,
          metadata: await observabilityIndexDiagnostics(db, schemaName, entityNameIndex.name),
          note: 'Session NLS settings are a pooled-connection snapshot, not necessarily the DDL session settings. Actual column metadata describes the resulting schema.',
        };
        console.info(
          'Oracle observability initialization evidence (before fixture cleanup):\n' +
            JSON.stringify(evidence, null, 2),
        );
      }

      const entityNames = ['default-index-agent', '客服助手 café'];
      for (const entityName of entityNames) {
        const span = createSpan({ name: 'default-index-regression', entityName });
        await observability.createSpan({ span });
        await expect(observability.getSpan({ traceId: span.traceId, spanId: span.spanId })).resolves.toMatchObject({
          span: { traceId: span.traceId, spanId: span.spanId, entityType: span.entityType, entityName },
        });
      }
      const discovered = await observability.getEntityNames({});
      expect(discovered.names).toHaveLength(entityNames.length);
      expect(discovered.names).toEqual(expect.arrayContaining(entityNames));
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (initializationStarted) {
        // These exact tables were absent at preflight and belong to this fixture.
        // Dropping them also removes their indexes, including partially created ones.
        for (const tableName of [...tableNames].reverse()) {
          try {
            await db.executeDdl(`DROP TABLE ${qualifyName(tableName, schemaName)} PURGE`, [-942]);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      try {
        await poolManager.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        if (primaryError) console.error('Observability fixture cleanup also failed:', cleanupErrors);
        else throw new AggregateError(cleanupErrors, 'Observability fixture cleanup failed');
      }
    }
  }, 60_000);
});

describeIntegration('Oracle message include timestamp ties integration', () => {
  let poolManager: OraclePoolManager;
  let memory: MemoryOracle;

  beforeAll(async () => {
    poolManager = new OraclePoolManager({
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
    });
    memory = new MemoryOracle({ poolManager, skipDefaultIndexes: true });
    await memory.init();
  }, 60_000);

  afterAll(async () => {
    await poolManager?.close();
  });

  describe.each(messageWindowEntryPoints)('%s entry point', entryPoint => {
    it.each(messageWindowCases)('$name', async testCase => {
      const fixture = createMessageWindowFixture(testCase, `window-${randomUUID()}-`);
      const createdThreadIds: string[] = [];
      try {
        for (const thread of fixture.threads) {
          await memory.saveThread({ thread });
          createdThreadIds.push(thread.id);
        }
        await memory.saveMessages({ messages: fixture.messages });
        const { threadId, ...resourceQuery } = fixture.query;
        const result =
          entryPoint === 'thread'
            ? await memory.listMessages({ threadId, ...resourceQuery })
            : await memory.listMessagesByResourceId(resourceQuery);

        expect(result.messages.map(message => message.id)).toEqual(fixture.expectedIds);
        expect(result).toMatchObject({ total: 0, page: 0, perPage: 0, hasMore: false });
        expect(new Set(result.messages.map(message => message.id)).size).toBe(result.messages.length);
      } finally {
        // Only uniquely named fixture threads/messages are removed; never clear
        // shared tables or drop schemas/tables to run these regressions.
        for (const threadId of createdThreadIds.reverse()) await memory.deleteThread({ threadId });
      }
    });
  });
});

// Read-only, best-effort diagnostics. Missing catalog privileges must not hide
// the original DDL failure. Do not assume the database's default block size is
// necessarily the block size of the tablespace holding the new indexes.
async function observabilityIndexDiagnostics(
  db: OracleDB,
  owner: string,
  indexName?: string,
): Promise<Record<string, unknown>> {
  const queries: Record<string, string> = {
    version: "SELECT product, version FROM product_component_version WHERE product LIKE 'Oracle Database%'",
    lengthSemantics: "SELECT value FROM nls_session_parameters WHERE parameter = 'NLS_LENGTH_SEMANTICS'",
    characterSet: "SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET'",
    columns: `SELECT column_name, data_type, data_length, char_length, char_used FROM all_tab_columns
              WHERE owner = :owner AND table_name = 'MASTRA_AI_SPANS'
                AND column_name IN ('entityType', 'entityName')`,
    tablespaces: `SELECT t.table_name, t.tablespace_name, s.block_size FROM all_tables t
                 LEFT JOIN user_tablespaces s ON s.tablespace_name = t.tablespace_name
                 WHERE t.owner = :owner AND t.table_name IN ('MASTRA_AI_SPANS', 'MASTRA_LOG_EVENTS')`,
    indexTablespaces: `SELECT i.index_name, i.tablespace_name, s.block_size FROM all_indexes i
                      LEFT JOIN user_tablespaces s ON s.tablespace_name = i.tablespace_name
                      WHERE i.owner = :owner AND i.table_name IN ('MASTRA_AI_SPANS', 'MASTRA_LOG_EVENTS')`,
    defaultTablespace: `SELECT u.default_tablespace, s.block_size FROM user_users u
                        LEFT JOIN user_tablespaces s ON s.tablespace_name = u.default_tablespace`,
    ...(indexName
      ? {
          compositeIndexColumns: `SELECT index_name, column_name, column_position FROM all_ind_columns
                                  WHERE index_owner = :owner AND index_name = :indexName ORDER BY column_position`,
        }
      : {}),
  };
  const diagnostics: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(queries)) {
    try {
      diagnostics[name] = await db.execute(sql, {
        ...(sql.includes(':owner') ? { owner } : {}),
        ...(sql.includes(':indexName') ? { indexName } : {}),
      });
    } catch (error) {
      diagnostics[name] = { unavailable: String(error) };
    }
  }
  return diagnostics;
}

async function listUserIndexes(store: OracleStore, indexNames: string[]): Promise<string[]> {
  const rows = await store.db.manyOrNone<{ indexName: string }>(
    `SELECT index_name AS "indexName" FROM user_indexes WHERE index_name IN (${indexNames
      .map((_, index) => `:indexName${index}`)
      .join(', ')})`,
    Object.fromEntries(indexNames.map((indexName, index) => [`indexName${index}`, indexName])),
  );
  return rows.map(row => String(row.indexName));
}

async function dropIndex(store: OracleStore, indexName: string): Promise<void> {
  const pool = await store.getPool();
  const connection = await pool.getConnection();
  try {
    await connection.execute(`DROP INDEX "${indexName}"`);
  } catch (error) {
    if (!isMissingIndex(error)) throw error;
  } finally {
    await connection.close();
  }
}

function isMissingIndex(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errorNum = 'errorNum' in error ? Number(error.errorNum) : undefined;
  if (errorNum === 1418) return true;
  const message = 'message' in error ? String(error.message) : '';
  return message.includes('ORA-01418');
}
