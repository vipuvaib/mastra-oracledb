import { expect, it } from 'vitest';
import { dropRecordedTables, manifestFingerprint, validateCleanupState } from '../helpers/cleanup-state.ts';
const tables = [
  { name: 'ORACLE_APP_E2E_RUN', objectId: 1 },
  { name: 'VECTOR_PARENT', objectId: 2 },
  { name: 'VECTOR_AUXILIARY', objectId: 3 },
];
const progress = { runId: 'run', manifestFingerprint: manifestFingerprint(tables), startedAt: 'unit', removed: [] };
it('requires exact initial table identities and rejects additions or replacements even during resume', () => {
  expect(() => validateCleanupState(tables, tables, 'run')).not.toThrow();
  expect(() => validateCleanupState(tables, tables.slice(0, 2), 'run')).toThrow('changed');
  expect(() => validateCleanupState(tables, [...tables, { name: 'OTHER', objectId: 4 }], 'run', progress)).toThrow(
    'changed',
  );
  expect(() => validateCleanupState(tables, [{ name: 'VECTOR_PARENT', objectId: 999 }], 'run', progress)).toThrow(
    'changed',
  );
});
it('resumes only with the same run and manifest, permitting already removed recorded objects', () => {
  expect(() => validateCleanupState(tables, tables.slice(0, 1), 'run', progress)).not.toThrow();
  expect(() => validateCleanupState(tables, tables, 'other-run', progress)).toThrow('does not match');
  expect(() => validateCleanupState(tables.slice(0, 2), tables.slice(0, 1), 'run', progress)).toThrow('does not match');
});
it('drops parents before generated tables, skips dependent cascades and drops the lease last', async () => {
  const current = new Map(tables.map(row => [row.name, row]));
  const dropped: string[] = [];
  const skipped: string[] = [];
  await dropRecordedTables(
    [...tables].reverse(),
    async name => current.get(name),
    async name => {
      dropped.push(name);
      current.delete(name);
      if (name === 'VECTOR_PARENT') current.delete('VECTOR_AUXILIARY');
    },
    (name, didDrop) => {
      if (!didDrop) skipped.push(name);
    },
  );
  expect(dropped).toEqual(['VECTOR_PARENT', 'ORACLE_APP_E2E_RUN']);
  expect(skipped).toEqual(['VECTOR_AUXILIARY']);
  expect(current.size).toBe(0);
});
it('never drops a recreated object after cleanup has started', async () => {
  const dropped: string[] = [];
  await expect(
    dropRecordedTables(
      tables,
      async name => ({ name, objectId: 999 }),
      async name => {
        dropped.push(name);
      },
      () => {},
    ),
  ).rejects.toThrow('identity changed');
  expect(dropped).toEqual([]);
});
