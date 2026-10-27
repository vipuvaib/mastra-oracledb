import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';

const { server, store } = suite('lifecycle');

it('F01 handles concurrent conversations without duplicate rows or cross-resource context', async () => {
  const cases = Array.from({ length: 6 }, () => ({ thread: randomUUID(), resource: randomUUID(), code: randomUUID() }));
  await Promise.all(
    cases.map(async item => {
      expect(
        (
          await server.client.getAgent('history').generate(`PROJECT CODE: ${item.code}`, {
            memory: { thread: item.thread, resource: item.resource },
          })
        ).text,
      ).toBe('ACK');
    }),
  );
  await server.settle();
  const memory = (await store.getStore('memory'))!;
  for (const item of cases) {
    const messages = (await memory.listMessages({ threadId: item.thread, resourceId: item.resource, perPage: false }))
      .messages;
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map(message => message.id)).size).toBe(2);
    expect(messages.every(message => message.resourceId === item.resource)).toBe(true);
    expect(JSON.stringify(messages)).toContain(item.code);
    for (const other of cases.filter(other => other !== item))
      expect(JSON.stringify(messages)).not.toContain(other.code);
  }
  await server.restart();
  const recalled = await Promise.all(
    cases.map(item =>
      server.client.getAgent('history').generate('RECALL PROJECT CODE', {
        memory: { thread: item.thread, resource: item.resource },
      }),
    ),
  );
  expect(recalled.map(result => result.text)).toEqual(cases.map(item => `CODE=${item.code}`));
  recordEvidence('F01', { conversations: cases.map(({ thread, resource }) => ({ thread, resource })) });
});

it('F02 recovers committed history after abrupt process death', async () => {
  const thread = randomUUID();
  const resource = randomUUID();
  const code = randomUUID();
  await server.client.getAgent('history').generate(`PROJECT CODE: ${code}`, { memory: { thread, resource } });
  await server.settle();
  const before = await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false });
  await server.restart(true);
  expect(
    (await server.client.getAgent('history').generate('RECALL PROJECT CODE', { memory: { thread, resource } })).text,
  ).toBe(`CODE=${code}`);
  const after = await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false });
  expect(after.messages.slice(0, before.messages.length).map(message => message.id)).toEqual(
    before.messages.map(message => message.id),
  );
});

it('F03 persists queryable traces and their spans across restart', async () => {
  const result = await server.client.getAgent('history').generate('HELLO', {
    memory: { thread: randomUUID(), resource: randomUUID() },
  });
  const runId = z.string().parse(result.runId);
  await server.settle();
  const traces = await server.client.listTraces({ filters: { runId }, pagination: { page: 0, perPage: 100 } });
  expect(traces.spans.length).toBeGreaterThan(0);
  const traceId = traces.spans[0]!.traceId;
  await server.restart();
  const reloaded = await server.client.getTrace(traceId);
  expect(reloaded.spans.length).toBeGreaterThan(0);
  expect(reloaded.spans.every(span => span.traceId === traceId)).toBe(true);
  recordEvidence('F03', { runId, traceId, spanCount: reloaded.spans.length });
});

it('F04 serves valid requests after rejected requests and repeated reconnects', async () => {
  await expect(server.client.getAgent('does-not-exist').generate('HELLO')).rejects.toThrow();
  const vector = server.client.getVector('oracle');
  await expect(vector.createIndex({ indexName: 'invalid_dimension', dimension: 0 })).rejects.toThrow();
  for (let iteration = 0; iteration < 2; iteration++) {
    await server.restart();
    expect(
      (
        await server.client.getAgent('history').generate('HELLO', {
          memory: { thread: randomUUID(), resource: randomUUID() },
        })
      ).text,
    ).toBe('ACK');
  }
});
