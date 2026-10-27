import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { testOperation } from '../helpers/http.ts';
import { suite } from '../helpers/suite.ts';

const { server, store } = suite('patch-memory');
const vectorRows = z.array(z.object({ id: z.string(), metadata: z.record(z.string(), z.unknown()) }));
const readVectors = async (threadId: string) =>
  vectorRows.parse(
    await server.client.getVector('oracle').query({
      indexName: 'memory_messages_3',
      queryVector: [1, 0, 0],
      topK: 100,
      filter: { thread_id: threadId },
    }),
  );

it('A08 excludes foreign-resource include anchors and neighbors through scoped HTTP reads', async () => {
  const memory = (await store.getStore('memory'))!;
  const resource = randomUUID();
  const own = randomUUID();
  const foreign = randomUUID();
  const sibling = randomUUID();
  const now = new Date('2026-01-01T00:00:00.000Z');
  for (const [id, resourceId] of [
    [own, resource],
    [sibling, resource],
    [foreign, randomUUID()],
  ]) {
    await memory.saveThread({ thread: { id: id!, resourceId: resourceId!, createdAt: now, updatedAt: now } });
    await memory.saveMessages({
      messages: ['a', 'b', 'c'].map(suffix => ({
        id: id + '-' + suffix,
        threadId: id!,
        resourceId: resourceId!,
        role: 'user' as const,
        createdAt: now,
        content: { format: 2 as const, parts: [{ type: 'text' as const, text: id + '-' + suffix }] },
      })),
    });
  }
  const include = [
    { id: own + '-b', withPreviousMessages: 1, withNextMessages: 1 },
    { id: foreign + '-b', withPreviousMessages: 10, withNextMessages: 10 },
    { id: sibling + '-b' },
  ];
  const expected = [own + '-a', own + '-b', own + '-c', sibling + '-b'].sort();
  const direct = await memory.listMessages({ threadId: own, resourceId: resource, perPage: 0, include });
  expect(direct.messages.map(message => message.id).sort()).toEqual(expected);
  for (const agentId of [undefined, 'history']) {
    const api = server.client.getMemoryThread({ threadId: own, agentId });
    const result = await api.listMessages({ resourceId: resource, perPage: 0, include });
    const ids = z
      .array(z.object({ id: z.string() }))
      .parse(result.messages)
      .map(message => message.id)
      .sort();
    expect(ids).toEqual(expected);
    expect(ids.some(id => id.startsWith(foreign))).toBe(false);
  }
  recordEvidence('A08', { resourceId: resource, ownThread: own, foreignThread: foreign, expectedIds: expected });
});

it('D05 transfers storage and semantic vectors, surfaces migration failure, and repairs it on same-owner retry', async () => {
  const thread = randomUUID();
  const sibling = randomUUID();
  const oldOwner = randomUUID();
  const newOwner = randomUUID();
  const repairedOwner = randomUUID();
  const memory = (await store.getStore('memory'))!;
  await server.client
    .getAgent('semantic')
    .generate('ALPHA FACT: ' + randomUUID(), { memory: { thread, resource: oldOwner } });
  await server.client
    .getAgent('semantic')
    .generate('BETA FACT: ' + randomUUID(), { memory: { thread: sibling, resource: oldOwner } });
  await server.settle();
  const before = await memory.listMessages({ threadId: thread, perPage: false });
  const siblingVectors = await readVectors(sibling);
  const siblingMessages = (await memory.listMessages({ threadId: sibling, perPage: false })).messages;
  const api = server.client.getMemoryThread({ threadId: thread, agentId: 'semantic' });
  await api.transfer({ resourceId: newOwner });
  expect(await memory.getThreadById({ threadId: thread })).toMatchObject({ resourceId: newOwner });
  const moved = await memory.listMessages({ threadId: thread, perPage: false });
  expect(moved.messages.map(message => message.id)).toEqual(before.messages.map(message => message.id));
  expect(moved.messages.every(message => message.resourceId === newOwner)).toBe(true);
  let vectors = await readVectors(thread);
  expect(vectors.map(row => row.metadata.message_id).sort()).toEqual(before.messages.map(row => row.id).sort());
  expect(vectors.every(row => row.metadata.resource_id === newOwner)).toBe(true);
  await testOperation(server, 'semantic/fail-next-migration', { threadId: thread });
  await expect(api.transfer({ resourceId: repairedOwner })).rejects.toThrow(/transferred.*migrating|migration/i);
  expect(await memory.getThreadById({ threadId: thread })).toMatchObject({ resourceId: repairedOwner });
  expect(
    (await memory.listMessages({ threadId: thread, perPage: false })).messages.every(
      row => row.resourceId === repairedOwner,
    ),
  ).toBe(true);
  expect((await readVectors(thread)).every(row => row.metadata.resource_id === newOwner)).toBe(true);
  await api.transfer({ resourceId: repairedOwner });
  await server.restart();
  vectors = await readVectors(thread);
  expect(vectors.map(row => row.metadata.message_id).sort()).toEqual(before.messages.map(row => row.id).sort());
  expect(vectors.every(row => row.metadata.resource_id === repairedOwner)).toBe(true);
  expect(await readVectors(sibling)).toEqual(siblingVectors);
  expect((await memory.listMessages({ threadId: sibling, perPage: false })).messages).toEqual(siblingMessages);
  expect(await memory.getThreadById({ threadId: sibling })).toMatchObject({ resourceId: oldOwner });
  recordEvidence('D05', {
    threadId: thread,
    siblingThread: sibling,
    oldOwner,
    newOwner,
    repairedOwner,
    messageIds: before.messages.map(row => row.id),
  });
});

it('D06 deletes a semantic thread and its message vectors without touching another thread or resource', async () => {
  const resource = randomUUID();
  const target = randomUUID();
  const sibling = randomUUID();
  const unrelated = randomUUID();
  const unrelatedResource = randomUUID();
  for (const [thread, owner] of [
    [target, resource],
    [sibling, resource],
    [unrelated, unrelatedResource],
  ]) {
    await server.client
      .getAgent('semantic')
      .generate('ALPHA FACT: ' + randomUUID(), { memory: { thread: thread!, resource: owner! } });
  }
  await server.settle();
  const memory = (await store.getStore('memory'))!;
  const siblingMessages = (await memory.listMessages({ threadId: sibling, perPage: false })).messages;
  const unrelatedMessages = (await memory.listMessages({ threadId: unrelated, perPage: false })).messages;
  const siblingBefore = await readVectors(sibling);
  const unrelatedBefore = await readVectors(unrelated);
  expect((await readVectors(target)).length).toBeGreaterThan(0);
  await server.client.getMemoryThread({ threadId: target, agentId: 'semantic' }).delete();
  await server.settle();
  expect(await memory.getThreadById({ threadId: target })).toBeNull();
  expect((await memory.listMessages({ threadId: target, perPage: false })).messages).toEqual([]);
  expect(await readVectors(target)).toEqual([]);
  await server.restart();
  expect(await readVectors(target)).toEqual([]);
  expect(await readVectors(sibling)).toEqual(siblingBefore);
  expect(await readVectors(unrelated)).toEqual(unrelatedBefore);
  expect(await memory.getThreadById({ threadId: sibling })).toMatchObject({ resourceId: resource });
  expect(await memory.getThreadById({ threadId: unrelated })).toMatchObject({ resourceId: unrelatedResource });
  expect((await memory.listMessages({ threadId: sibling, perPage: false })).messages).toEqual(siblingMessages);
  expect((await memory.listMessages({ threadId: unrelated, perPage: false })).messages).toEqual(unrelatedMessages);
  recordEvidence('D06', {
    deletedThread: target,
    siblingThread: sibling,
    unrelatedThread: unrelated,
    siblingVectorIds: siblingBefore.map(row => row.id),
    preservedSiblingMessageIds: siblingMessages.map(row => row.id),
    preservedOtherResourceMessageIds: unrelatedMessages.map(row => row.id),
  });
});
