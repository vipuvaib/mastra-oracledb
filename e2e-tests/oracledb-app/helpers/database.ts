import { OracleStore } from '@mastra/oracledb';
import { environment } from './environment.ts';

export function openStore(id: string) {
  const config = environment();
  return new OracleStore({ id, ...config.connection, schemaName: config.schema, disableInit: true });
}

export async function verifyLease(store: OracleStore) {
  const runId = process.env.ORACLE_APP_RUN_ID;
  if (!runId) throw new Error('Start through test:smoke or test:e2e; no run lease is configured.');
  const rows = await store.db.execute<{ runId: string }>('SELECT run_id AS "runId" FROM ORACLE_APP_E2E_RUN');
  if (rows.length !== 1 || rows[0]?.runId !== runId) throw new Error('Schema belongs to another test run.');
}
