import { pathToFileURL } from 'node:url';
import { openStore } from './database.ts';
import { environment } from './environment.ts';

export async function preflight(claimRunId?: string) {
  const config = environment();
  const store = openStore('oracle-app-preflight');
  try {
    const [session] = await store.db.execute<{ owner: string }>(
      "SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS \"owner\" FROM dual",
    );
    if (session?.owner !== config.schema)
      throw new Error('Database session owner does not match the explicitly selected test schema.');
    const objects = await store.db.execute<{ name: string }>('SELECT object_name AS "name" FROM user_objects');
    if (objects.length)
      throw new Error(
        `Refusing nonempty schema ${config.schema}: ${objects.length} existing objects. Provision a fresh schema; nothing was cleared.`,
      );
    const version = await store
      .getPoolManager()
      .withConnection(async connection => connection.oracleServerVersionString);
    if (claimRunId) {
      // CREATE fails if another job won the claim. Never drop or steal an existing lease.
      await store.db.executeDdl('CREATE TABLE ORACLE_APP_E2E_RUN (run_id VARCHAR2(64) PRIMARY KEY)');
      await store.getPoolManager().withConnection(async connection => {
        await connection.execute(
          'INSERT INTO ORACLE_APP_E2E_RUN (run_id) VALUES (:runId)',
          { runId: claimRunId },
          { autoCommit: true },
        );
      });
    }
    return { schema: config.schema, databaseVersion: version, initiallyEmpty: true };
  } finally {
    await store.disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await preflight(), null, 2));
}
