import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';
const { server, store, ids } = suite('conversation');

it('A03 generates a response and persists both turns', async () => {
  const result = await server.client
    .getAgent('history')
    .generate('HELLO', { memory: { thread: ids.thread, resource: ids.resource } });
  expect(result.text).toBe('ACK');
  await server.settle();
  const memory = (await store.getStore('memory'))!;
  const { messages } = await memory.listMessages({ threadId: ids.thread, perPage: false });
  expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
});

it('A04 consumes a complete stream and persists its assistant message once', async () => {
  const thread = randomUUID();
  const stream = await server.client
    .getAgent('history')
    .stream('HELLO', { memory: { thread, resource: ids.resource } });
  let text = '';
  let finishes = 0;
  await stream.processDataStream({
    onChunk: async chunk => {
      if (chunk.type === 'text-delta') text += chunk.payload.text;
      if (chunk.type === 'finish') finishes++;
      if (chunk.type === 'error') throw new Error(JSON.stringify(chunk));
    },
  });
  expect(text).toBe('ACK');
  expect(finishes).toBe(1);
  await server.settle();
  const { messages } = await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false });
  expect(messages.filter(message => message.role === 'assistant')).toHaveLength(1);
});

it('A05 runs the calculator and persists the actual tool call/result', async () => {
  const thread = randomUUID();
  const result = await server.client
    .getAgent('history')
    .generate('ADD 17 25', { memory: { thread, resource: ids.resource } });
  expect(result.text).toBe('SUM=42');
  await server.settle();
  const { messages } = await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false });
  const calls = messages.flatMap(message => message.content.parts).filter(part => part.type === 'tool-invocation');
  expect(calls.length).toBeGreaterThan(0);
  expect(
    calls.find(part => part.toolInvocation.toolName === 'calculator' && part.toolInvocation.state === 'result')
      ?.toolInvocation,
  ).toMatchObject({ result: { result: 42 } });
  expect(calls.every(part => part.toolInvocation.toolCallId.length > 0)).toBe(true);
});

it('A06 recalls a unique fact only from persisted user context after a process restart', async () => {
  const thread = randomUUID();
  const code = randomUUID();
  const options = { memory: { thread, resource: ids.resource } };
  await server.client.getAgent('history').generate(`PROJECT CODE: ${code}`, options);
  await server.settle();
  const memory = (await store.getStore('memory'))!;
  const before = await memory.listMessages({ threadId: thread, perPage: false });
  await server.restart();
  recordEvidence('A06', {
    threadId: thread,
    resourceId: ids.resource,
    persistedMessageIds: before.messages.map(message => message.id),
    restartedPid: server.child!.pid,
  });
  const recalled = await server.client.getAgent('history').generate('RECALL PROJECT CODE', options);
  expect(recalled.text).toBe(`CODE=${code}`);
  await server.settle();
  const after = await memory.listMessages({ threadId: thread, perPage: false });
  expect(after.messages.slice(0, before.messages.length).map(message => message.id)).toEqual(
    before.messages.map(message => message.id),
  );
  const isolated = await server.client
    .getAgent('history')
    .generate('RECALL PROJECT CODE', { memory: { thread: randomUUID(), resource: randomUUID() } });
  expect(isolated.text).toBe('NO_CONTEXT');
});

it('A07 exposes stable pagination and equal-timestamp include windows through HTTP memory reads', async () => {
  const thread = randomUUID();
  const memory = (await store.getStore('memory'))!;
  const now = new Date('2026-01-01T00:00:00Z');
  await memory.saveThread({
    thread: {
      id: thread,
      resourceId: ids.resource,
      title: 'Timestamp ties',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    },
  });
  const messageIds = ['a', 'b', 'c'].map(suffix => `${thread}-${suffix}`);
  await memory.saveMessages({
    messages: [...messageIds].reverse().map(id => ({
      id,
      threadId: thread,
      resourceId: ids.resource,
      role: 'user' as const,
      createdAt: now,
      content: { format: 2 as const, parts: [{ type: 'text' as const, text: id }] },
    })),
  });
  const api = server.client.getMemoryThread({ threadId: thread, agentId: 'history' });
  const params = { perPage: 1, orderBy: { field: 'createdAt' as const, direction: 'ASC' as const } };
  const pages = await Promise.all([0, 1, 2].map(page => api.listMessages({ ...params, page })));
  expect(
    pages.flatMap(page =>
      z
        .array(z.object({ id: z.string() }))
        .parse(page.messages)
        .map(message => message.id),
    ),
  ).toEqual(messageIds);
  const expectedWindow = {
    perPage: 0,
    include: [{ id: messageIds[1]!, withPreviousMessages: 1, withNextMessages: 1 }],
  };
  const direct = await memory.listMessages({ threadId: thread, resourceId: ids.resource, ...expectedWindow });
  expect(direct.messages.map(message => message.id).sort()).toEqual(messageIds);
  const global = await server.client.getMemoryThread({ threadId: thread }).listMessages(expectedWindow);
  expect(
    z
      .array(z.object({ id: z.string() }))
      .parse(global.messages)
      .map(message => message.id)
      .sort(),
  ).toEqual(messageIds);
  // This agent path must preserve the same include contract through Memory.recall.
  const included = await api.listMessages({
    perPage: 0,
    include: [{ id: messageIds[1]!, withPreviousMessages: 1, withNextMessages: 1 }],
  });
  recordEvidence('A07', {
    threadId: thread,
    expectedIds: messageIds,
    storageIds: direct.messages.map(message => message.id),
    globalHttpIds: z
      .array(z.object({ id: z.string() }))
      .parse(global.messages)
      .map(message => message.id),
    agentHttpIds: z
      .array(z.object({ id: z.string() }))
      .parse(included.messages)
      .map(message => message.id),
  });
  expect(
    z
      .array(z.object({ id: z.string() }))
      .parse(included.messages)
      .map(message => message.id)
      .sort(),
  ).toEqual(messageIds);
});
