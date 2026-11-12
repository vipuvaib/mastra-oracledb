import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';
const { server, store, ids } = suite('live');

it('L01 generates with the configured live model and persists the exact conversation', async () => {
  const thread = randomUUID();
  const prompt = 'Reply with exactly ORACLE_OK.';
  const result = await server.client.getAgent('live').generate(prompt, { memory: { thread, resource: ids.resource } });
  expect(result.text.trim()).toBe('ORACLE_OK');
  await server.settle();
  const messages = (await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false }))
    .messages;
  expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
  const text = (role: string) =>
    messages
      .filter(message => message.role === role)
      .flatMap(message => message.content.parts)
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('');
  expect(text('user')).toBe(prompt);
  expect(text('assistant').trim()).toBe(result.text.trim());
  recordEvidence('L01', {
    thread,
    messageIds: messages.map(message => message.id),
    text: result.text,
    usage: result.usage,
  });
});

it('L02 recalls a random value from Oracle history after process restart', async () => {
  const thread = randomUUID();
  const code = randomUUID();
  const options = { memory: { thread, resource: ids.resource } };
  const stored = await server.client
    .getAgent('live')
    .generate(`Remember this verification code: ${code}. Reply with exactly STORED.`, options);
  expect(stored.text.trim()).toBe('STORED');
  await server.settle();
  const memory = (await store.getStore('memory'))!;
  const before = (await memory.listMessages({ threadId: thread, perPage: false })).messages;
  expect(before.map(message => message.role)).toEqual(['user', 'assistant']);
  expect(JSON.stringify(before)).toContain(code);
  const pid = server.child!.pid;
  await server.restart();
  expect(server.child!.pid).not.toBe(pid);
  const result = await server.client
    .getAgent('live')
    .generate('Return only the verification code I gave you earlier.', options);
  expect(result.text.trim()).toBe(code);
  await server.settle();
  const after = (await memory.listMessages({ threadId: thread, perPage: false })).messages;
  expect(after.slice(0, before.length).map(message => message.id)).toEqual(before.map(message => message.id));
  recordEvidence('L02', {
    thread,
    beforePid: pid,
    afterPid: server.child!.pid,
    preservedMessageIds: before.map(message => message.id),
    recalled: result.text,
  });
});

it('L03 completes a live stream and persists its assistant response once', async () => {
  const thread = randomUUID();
  const marker = 'STREAM_' + randomUUID().replaceAll('-', '');
  const stream = await server.client
    .getAgent('live')
    .stream(`Reply with exactly ${marker} and no other text.`, { memory: { thread, resource: ids.resource } });
  let text = '';
  let finishes = 0;
  await stream.processDataStream({
    onChunk: async chunk => {
      if (chunk.type === 'text-delta') text += chunk.payload.text;
      if (chunk.type === 'finish') finishes++;
      if (chunk.type === 'error') throw new Error('Live model stream returned an error.');
    },
  });
  expect(text.trim()).toBe(marker);
  expect(finishes).toBe(1);
  await server.settle();
  const messages = (await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false }))
    .messages;
  const assistant = messages.filter(message => message.role === 'assistant');
  expect(assistant).toHaveLength(1);
  expect(
    assistant[0]!.content.parts
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
      .trim(),
  ).toBe(marker);
  recordEvidence('L03', { thread, text, finishes, assistantMessageId: assistant[0]!.id });
});

it('L04 executes the real calculator from a live model function call and persists its result', async () => {
  const thread = randomUUID();
  const result = await server.client
    .getAgent('live')
    .generate(
      'Use the calculator tool to add 31 and 47. You must call the tool. After receiving its result, reply with exactly SUM=78.',
      { memory: { thread, resource: ids.resource } },
    );
  expect(result.text.trim()).toBe('SUM=78');
  await server.settle();
  const messages = (await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false }))
    .messages;
  const calls = messages.flatMap(message => message.content.parts).filter(part => part.type === 'tool-invocation');
  const executed = calls.find(
    part => part.toolInvocation.toolName === 'calculator' && part.toolInvocation.state === 'result',
  );
  expect(executed?.toolInvocation).toMatchObject({ args: { a: 31, b: 47 }, result: { result: 78 } });
  expect(executed!.toolInvocation.toolCallId.length).toBeGreaterThan(0);
  recordEvidence('L04', { thread, invocation: executed!.toolInvocation, text: result.text });
});
