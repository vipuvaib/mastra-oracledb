import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';

const { server, ids } = suite('scores-config');

it('E01 automatically scores an agent response and reloads its score after restart', async () => {
  const result = await server.client.getAgent('scored').generate('HELLO', {
    memory: { thread: randomUUID(), resource: ids.resource },
  });
  expect(result.text).toBe('ACK');
  const runId = z.string().parse(result.runId);
  const scores = z.array(
    z.object({ runId: z.string(), scorerId: z.string(), score: z.number(), id: z.string(), source: z.string() }),
  );
  await expect
    .poll(
      async () =>
        scores.parse((await server.client.listScoresByRunId({ runId })).scores).filter(row => row.source === 'LIVE')
          .length,
      {
        timeout: 15_000,
        interval: 100,
      },
    )
    .toBe(1);
  await server.settle();
  const before = scores
    .parse((await server.client.listScoresByRunId({ runId })).scores)
    .filter(row => row.source === 'LIVE');
  expect(before[0]).toMatchObject({ runId, scorerId: 'ack-score', score: 1 });
  await server.settle();
  await server.restart();
  const after = scores
    .parse((await server.client.listScoresByRunId({ runId })).scores)
    .filter(row => row.source === 'LIVE');
  expect(after).toEqual(before);
  const observed = await server.client.listScores({ filters: { runId, scoreSource: 'live' } });
  expect(observed.scores).toHaveLength(1);
  expect(observed.scores[0]).toMatchObject({ scorerId: 'ack-score', score: 1 });
  expect((await server.client.listScoresByRunId({ runId: randomUUID() })).scores).toEqual([]);
  recordEvidence('E01', { runId, scoreId: before[0]!.id });
});

it('E02 creates, versions, reloads and deletes stored agent configuration through HTTP', async () => {
  const id = `stored-${randomUUID()}`;
  const originalInstructions = `Stored note ${randomUUID()}`;
  const created = await server.client.createStoredAgent({
    id,
    name: id,
    instructions: originalInstructions,
    model: { provider: 'oracle-e2e', name: 'oracle-scripted' },
    autoPublish: false,
    metadata: { testRun: process.env.ORACLE_APP_RUN_ID },
  });
  expect(created).toMatchObject({ id, name: id, instructions: originalInstructions });
  const stored = server.client.getStoredAgent(id);
  await stored.update({ instructions: 'Updated deterministic configuration', changeMessage: 'E2E update' });
  await server.restart();
  const reloaded = server.client.getStoredAgent(id);
  expect(await reloaded.details()).toMatchObject({ id, instructions: 'Updated deterministic configuration' });
  const versions = await reloaded.listVersions();
  expect(versions.versions.length).toBeGreaterThanOrEqual(2);
  expect(
    (await server.client.listStoredAgents({ page: 0, perPage: 100, status: 'draft' })).agents.map(agent => agent.id),
  ).toContain(id);
  await reloaded.delete();
  await expect(reloaded.details()).rejects.toThrow();
  recordEvidence('E02', { storedAgentId: id, versionCount: versions.versions.length });
});

it('E03 rejects duplicate configuration IDs without corrupting the first record', async () => {
  const id = `conflict-${randomUUID()}`;
  const config = {
    id,
    name: id,
    instructions: 'Original',
    model: { provider: 'oracle-e2e', name: 'oracle-scripted' },
    autoPublish: false,
  };
  await server.client.createStoredAgent(config);
  await expect(server.client.createStoredAgent({ ...config, instructions: 'Replacement' })).rejects.toThrow();
  expect(await server.client.getStoredAgent(id).details()).toMatchObject({ instructions: 'Original' });
  await server.client.getStoredAgent(id).delete();
});
