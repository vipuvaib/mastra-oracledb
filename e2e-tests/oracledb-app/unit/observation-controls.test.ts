import { randomUUID } from 'node:crypto';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { expect, it } from 'vitest';
import { scriptedModel } from '../fixture/models/scripted-model.ts';
import { observationControls } from '../fixture/observation-controls.ts';
import { createObservedMemory } from '../fixture/observed-memory.ts';

it('validates the OM configuration and retries a lost acknowledgment through the real engine', async () => {
  const storage = new InMemoryStore();
  const memory = createObservedMemory(storage);
  const agent = new Agent({
    id: 'unit-observed',
    name: 'unit-observed',
    instructions: 'Follow the protocol.',
    model: scriptedModel(),
    memory,
  });
  const mastra = new Mastra({ storage, agents: { agent }, logger: false });
  try {
    const controls = await observationControls(memory, storage);
    const threadId = randomUUID();
    const resourceId = randomUUID();
    const code = randomUUID();
    await agent.generate('OBSERVE CODE: ' + code, { memory: { thread: threadId, resource: resourceId } });
    await memory.settled();
    const result = await controls.buffer(threadId, resourceId, true);
    expect(result.buffered).toBe(true);
    expect(result.probe.postCommitFailures).toBe(1);
    expect(result.probe.appendAttempts).toHaveLength(2);
    expect(new Set(result.probe.appendAttempts.map(row => row.cycleId)).size).toBe(1);
    expect(result.record?.bufferedObservationChunks).toHaveLength(1);
    expect(result.record?.bufferedObservationChunks?.[0]?.observations).toContain(code);
    expect(result.record?.bufferedObservationChunks?.map(chunk => chunk.id)).toEqual(result.probe.committedChunkIds);
  } finally {
    await memory.settled();
    await mastra.shutdown();
  }
}, 20_000);
