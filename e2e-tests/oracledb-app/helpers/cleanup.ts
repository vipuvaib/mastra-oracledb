import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dropRecordedTables, manifestFingerprint, validateCleanupState } from './cleanup-state.ts';
import type { CleanupProgress, OwnedTable } from './cleanup-state.ts';
import { openStore, verifyLease } from './database.ts';
import { environment } from './environment.ts';
export type { OwnedTable } from './cleanup-state.ts';
export async function captureTables() {
  const store = openStore('oracle-app-manifest');
  try {
    await verifyLease(store);
    return await store.db.execute<OwnedTable>(
      'SELECT object_name AS "name", object_id AS "objectId" FROM user_objects WHERE object_type = \'TABLE\'',
    );
  } finally {
    await store.disconnect();
  }
}
export async function cleanup(artifacts: string) {
  const evidence = JSON.parse(readFileSync(join(artifacts, 'environment.json'), 'utf8')) as { runId: string };
  const database = JSON.parse(readFileSync(join(artifacts, 'database.json'), 'utf8')) as {
    schema: string;
    initiallyEmpty: boolean;
  };
  const tables = JSON.parse(readFileSync(join(artifacts, 'owned-tables.json'), 'utf8')) as OwnedTable[];
  if (!database.initiallyEmpty || database.schema !== environment().schema)
    throw new Error('Cleanup requires evidence of the same initially empty test schema.');
  process.env.ORACLE_APP_RUN_ID = evidence.runId;
  const store = openStore('oracle-app-cleanup');
  try {
    await verifyLease(store);
    const current = await captureTables();
    const progressPath = join(artifacts, 'cleanup-progress.json');
    let progress: CleanupProgress | undefined = existsSync(progressPath)
      ? (JSON.parse(readFileSync(progressPath, 'utf8')) as CleanupProgress)
      : undefined;
    validateCleanupState(tables, current, evidence.runId, progress);
    progress ??= {
      runId: evidence.runId,
      manifestFingerprint: manifestFingerprint(tables),
      startedAt: new Date().toISOString(),
      removed: [],
    };
    const persistProgress = () => {
      writeFileSync(progressPath + '.tmp', JSON.stringify(progress, null, 2));
      renameSync(progressPath + '.tmp', progressPath);
    };
    persistProgress();
    await dropRecordedTables(
      tables,
      async name => {
        const found = await store.db.execute<OwnedTable>(
          'SELECT object_name AS "name", object_id AS "objectId" FROM user_objects WHERE object_type = \'TABLE\' AND object_name = :name',
          { name },
        );
        return found[0];
      },
      async name => {
        if (name === 'ORACLE_APP_E2E_RUN') {
          const remaining = await captureTables();
          if (remaining.some(table => table.name !== name))
            throw new Error('Unremoved tables remain; preserving the run lease.');
        }
        await store.db.executeDdl('DROP TABLE "' + name + '" PURGE');
      },
      name => {
        if (!progress!.removed.includes(name)) progress!.removed.push(name);
        persistProgress();
      },
    );
    writeFileSync(
      join(artifacts, 'cleanup.json'),
      JSON.stringify(
        { runId: evidence.runId, tables: tables.map(table => table.name), completedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  } finally {
    await store.disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Supply artifacts/<run-id> to clean only the recorded test tables.');
  await cleanup(process.argv[2]);
}
