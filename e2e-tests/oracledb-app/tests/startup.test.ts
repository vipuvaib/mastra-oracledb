import { ObservabilityOracle } from '@mastra/oracledb';
import { expect, it } from 'vitest';
import { suite } from '../helpers/suite.ts';
const { server, store } = suite('startup');

it('A01 initializes all supported domains with valid default observability indexes', async () => {
  expect(Object.keys(store.stores).sort()).toEqual([
    'agents',
    'mcpClients',
    'memory',
    'observability',
    'scorerDefinitions',
    'scores',
    'workflows',
  ]);
  const definitions = new ObservabilityOracle({ poolManager: store.getPoolManager() }).getDefaultIndexDefinitions();
  const indexes = await store.db.execute<{ name: string; status: string }>(
    'SELECT index_name AS "name", status AS "status" FROM user_indexes',
  );
  for (const index of definitions)
    expect(indexes.find(value => value.name === index.name)).toMatchObject({ status: 'VALID' });
  expect(Object.keys(await server.client.listAgents())).toContain('history');
});

it('A02 starts a new process against the same schema without changing migration identities', async () => {
  const before = await store.listMigrations();
  const pid = server.child!.pid;
  await server.restart();
  expect(server.child!.pid).not.toBe(pid);
  expect((await store.listMigrations()).map(row => row.id)).toEqual(before.map(row => row.id));
  expect(Object.keys(await server.client.listAgents())).toContain('history');
});
