import { createHash } from 'node:crypto';

export type OwnedTable = { name: string; objectId: number };
export type CleanupProgress = { runId: string; manifestFingerprint: string; startedAt: string; removed: string[] };
export function manifestFingerprint(tables: OwnedTable[]) {
  return createHash('sha256')
    .update(JSON.stringify([...tables].sort((a, b) => a.name.localeCompare(b.name))))
    .digest('hex');
}
export function validateCleanupState(
  tables: OwnedTable[],
  current: OwnedTable[],
  runId: string,
  progress?: CleanupProgress,
) {
  if (progress && (progress.runId !== runId || progress.manifestFingerprint !== manifestFingerprint(tables))) {
    throw new Error('Cleanup progress does not match this run and its original table manifest.');
  }
  if (
    (!progress && current.length !== tables.length) ||
    current.some(row => !tables.some(table => row.name === table.name && row.objectId === table.objectId))
  ) {
    throw new Error('Schema tables changed since evidence capture; refusing cleanup.');
  }
}
export async function dropRecordedTables(
  tables: OwnedTable[],
  inspect: (name: string) => Promise<OwnedTable | undefined>,
  drop: (name: string) => Promise<void>,
  checkpoint: (name: string, dropped: boolean) => void,
) {
  const order = [...tables.filter(table => table.name !== 'ORACLE_APP_E2E_RUN')].sort(
    (a, b) => a.objectId - b.objectId,
  );
  order.push(...tables.filter(table => table.name === 'ORACLE_APP_E2E_RUN'));
  for (const table of order) {
    if (!/^[A-Z][A-Z0-9_$#]*$/.test(table.name)) throw new Error('Unexpected table identifier in manifest.');
    const current = await inspect(table.name);
    if (!current) {
      // Dropping a parent vector table also drops Oracle's generated IVF tables.
      checkpoint(table.name, false);
      continue;
    }
    if (current.objectId !== table.objectId)
      throw new Error('Recorded table identity changed during cleanup: ' + table.name);
    await drop(table.name);
    checkpoint(table.name, true);
  }
}
