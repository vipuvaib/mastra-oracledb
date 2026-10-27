import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { testOperation } from '../helpers/http.ts';
import { suite } from '../helpers/suite.ts';

const { server, store } = suite('patch-observations');
const chunkSchema = z.object({
  id: z.string(),
  cycleId: z.string(),
  observations: z.string(),
  tokenCount: z.number(),
  messageTokens: z.number(),
  messageIds: z.array(z.string()),
});
const recordSchema = z.object({
  id: z.string(),
  activeObservations: z.string(),
  pendingMessageTokens: z.number(),
  observationTokenCount: z.number(),
  totalTokensObserved: z.number(),
  generationCount: z.number(),
  bufferedObservationChunks: z.array(chunkSchema).nullish(),
});
const responseSchema = z.object({
  buffered: z.boolean().optional(),
  activated: z.boolean().optional(),
  record: recordSchema,
  probe: z.object({
    appendAttempts: z.array(z.object({ recordId: z.string(), cycleId: z.string() })),
    postCommitFailures: z.number(),
    committedChunkIds: z.array(z.string()),
    race: z
      .object({
        callerChunkIds: z.array(z.string()),
        lockedChunkIds: z.array(z.string()),
        firstCycleId: z.string(),
        lateCycleId: z.string(),
        callerPending: z.number(),
        lockedPending: z.number(),
        activatedMessageTokens: z.number(),
        increment: z.number(),
      })
      .nullable(),
  }),
});

it('D04 retries a committed real observation once and preserves late chunks and locked counters during activation', async () => {
  const threadId = randomUUID();
  const resourceId = randomUUID();
  const firstCode = randomUUID();
  const secondCode = randomUUID();
  const options = { memory: { thread: threadId, resource: resourceId } };
  expect((await server.client.getAgent('observed').generate('OBSERVE CODE: ' + firstCode, options)).text).toBe('ACK');
  await server.settle();
  const buffered = responseSchema.parse(
    await testOperation(server, 'observations/buffer', { threadId, resourceId, inject: true }),
  );
  expect(buffered.buffered).toBe(true);
  const first = buffered.record.bufferedObservationChunks!;
  expect(first).toHaveLength(1);
  expect(first[0]!.observations).toContain(firstCode);
  expect(first[0]!.messageTokens).toBeGreaterThan(0);
  expect(buffered.probe.postCommitFailures).toBe(1);
  expect(buffered.probe.appendAttempts.filter(attempt => attempt.cycleId === first[0]!.cycleId)).toHaveLength(2);
  expect(first.map(chunk => chunk.id)).toEqual(buffered.probe.committedChunkIds);
  const memory = (await store.getStore('memory'))!;
  const persisted = await memory.listMessages({ threadId, perPage: false });
  expect(first[0]!.messageIds.every(id => persisted.messages.some(message => message.id === id))).toBe(true);
  await server.client.getAgent('observed').generate('OBSERVE CODE: ' + secondCode, options);
  await server.settle();
  const activated = responseSchema.parse(
    await testOperation(server, 'observations/activate', { threadId, resourceId, inject: true }),
  );
  expect(activated.activated).toBe(true);
  const race = activated.probe.race!;
  expect(race.callerChunkIds).toEqual([first[0]!.id]);
  expect(race.lockedChunkIds).toHaveLength(2);
  expect(activated.record.bufferedObservationChunks).toHaveLength(1);
  expect(activated.record.bufferedObservationChunks![0]!.cycleId).toBe(race.lateCycleId);
  expect(activated.record.bufferedObservationChunks![0]!.observations).toContain(secondCode);
  expect(activated.record.activeObservations.split(firstCode)).toHaveLength(2);
  expect(activated.record.activeObservations).not.toContain(secondCode);
  expect(activated.record.pendingMessageTokens).toBe(race.lockedPending - race.activatedMessageTokens);
  expect(activated.record.observationTokenCount).toBe(buffered.record.observationTokenCount + first[0]!.tokenCount);
  const late = activated.record.bufferedObservationChunks![0]!;
  const finished = responseSchema.parse(await testOperation(server, 'observations/activate', { threadId, resourceId }));
  expect(finished.activated).toBe(true);
  expect(finished.record.bufferedObservationChunks ?? []).toEqual([]);
  expect(finished.record.activeObservations.split(firstCode)).toHaveLength(2);
  expect(finished.record.activeObservations.split(secondCode)).toHaveLength(2);
  expect(finished.record.pendingMessageTokens).toBe(race.increment);
  expect(finished.record.observationTokenCount).toBe(
    buffered.record.observationTokenCount + first[0]!.tokenCount + late.tokenCount,
  );
  await server.restart();
  const after = z
    .object({ record: recordSchema })
    .parse(await testOperation(server, 'observations/record', { threadId, resourceId }));
  expect(after.record.activeObservations).toBe(finished.record.activeObservations);
  expect(after.record.pendingMessageTokens).toBe(race.increment);
  expect(after.record.observationTokenCount).toBe(finished.record.observationTokenCount);
  const otherThread = randomUUID();
  await server.client
    .getAgent('observed')
    .generate('OBSERVE CODE: ' + randomUUID(), { memory: { thread: otherThread, resource: resourceId } });
  const other = await memory.getObservationalMemory(otherThread, resourceId);
  expect(other).not.toBeNull();
  await server.client.getMemoryThread({ threadId, agentId: 'observed' }).delete();
  await server.settle();
  expect(await memory.getObservationalMemory(threadId, resourceId)).toBeNull();
  expect((await memory.getObservationalMemory(otherThread, resourceId))?.id).toBe(other?.id);
  recordEvidence('D04', {
    threadId,
    resourceId,
    firstCycleId: first[0]!.cycleId,
    lateCycleId: late.cycleId,
    appendAttempts: activated.probe.appendAttempts,
    postCommitFailures: buffered.probe.postCommitFailures,
    race,
    finalPendingTokens: finished.record.pendingMessageTokens,
    observationTokens: finished.record.observationTokenCount,
  });
});
