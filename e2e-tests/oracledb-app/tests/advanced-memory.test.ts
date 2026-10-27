import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';

const { server, store, ids } = suite('advanced-memory');

it('D01 recalls a semantic fact across threads after restart in a fresh thread without local history', async () => {
  const code = randomUUID();
  const source = randomUUID();
  await server.client
    .getAgent('semantic')
    .generate(`ALPHA FACT: ${code}`, { memory: { thread: source, resource: ids.resource } });
  await server.settle();
  const memory = (await store.getStore('memory'))!;
  const persisted = await memory.listMessages({ threadId: source, resourceId: ids.resource, perPage: false });
  expect(
    persisted.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(code)),
  ).toBe(true);
  const target = randomUUID();
  expect((await memory.listMessages({ threadId: target, resourceId: ids.resource, perPage: false })).messages).toEqual(
    [],
  );
  await server.restart();
  const result = await server.client.getAgent('semantic').generate('FIND ALPHA FACT', {
    memory: { thread: target, resource: ids.resource },
  });
  expect(result.text).toBe(`FACT=${code}`);
  const isolated = await server.client.getAgent('semantic').generate('FIND ALPHA FACT', {
    memory: { thread: randomUUID(), resource: randomUUID() },
  });
  expect(isolated.text).toBe('NO_CONTEXT');
  recordEvidence('D01', {
    sourceThread: source,
    targetThread: target,
    sourceMessageIds: persisted.messages.map(message => message.id),
    resourceId: ids.resource,
    code,
    restartedPid: server.child!.pid,
  });
});

it('D02 persists resource working memory and injects it only for that resource', async () => {
  const note = randomUUID();
  const thread = randomUUID();
  await server.client.getAgent('notes').generate('HELLO', { memory: { thread, resource: ids.resource } });
  await server.client.updateWorkingMemory({
    agentId: 'notes',
    threadId: thread,
    resourceId: ids.resource,
    workingMemory: `NOTE: ${note}`,
  });
  await server.restart();
  expect(
    await server.client.getWorkingMemory({ agentId: 'notes', threadId: thread, resourceId: ids.resource }),
  ).toMatchObject({ workingMemory: `NOTE: ${note}`, source: 'resource' });
  expect(
    (
      await server.client.getAgent('notes').generate('READ WORKING NOTE', {
        memory: { thread: randomUUID(), resource: ids.resource },
      })
    ).text,
  ).toBe(`NOTE=${note}`);
  expect(
    (
      await server.client.getAgent('notes').generate('READ WORKING NOTE', {
        memory: { thread: randomUUID(), resource: randomUUID() },
      })
    ).text,
  ).toBe('NO_NOTE');
});

it('D03 clones persisted conversation with fresh IDs and deletes only the cloned thread', async () => {
  const source = randomUUID();
  const clone = randomUUID();
  const code = randomUUID();
  await server.client.getAgent('history').generate(`PROJECT CODE: ${code}`, {
    memory: { thread: source, resource: ids.resource },
  });
  await server.settle();
  const api = server.client.getMemoryThread({ threadId: source, agentId: 'history' });
  const original = z.array(z.object({ id: z.string() })).parse((await api.listMessages({ perPage: 100 })).messages);
  await api.clone({ newThreadId: clone });
  const cloneApi = server.client.getMemoryThread({ threadId: clone, agentId: 'history' });
  const copied = z.array(z.object({ id: z.string() })).parse((await cloneApi.listMessages({ perPage: 100 })).messages);
  expect(copied).toHaveLength(original.length);
  expect(copied.every(message => !original.some(row => row.id === message.id))).toBe(true);
  expect(
    (
      await server.client.getAgent('history').generate('RECALL PROJECT CODE', {
        memory: { thread: clone, resource: ids.resource },
      })
    ).text,
  ).toBe(`CODE=${code}`);
  await cloneApi.delete();
  expect((await api.listMessages({ perPage: 100 })).messages).toHaveLength(original.length);
  await expect(cloneApi.get()).rejects.toThrow();
});
