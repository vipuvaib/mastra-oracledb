import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { suite } from '../helpers/suite.ts';
const { server, store, ids } = suite('live');

it('L01 generates with the explicitly configured provider and persists both roles', async () => {
  const thread = randomUUID();
  const result = await server.client
    .getAgent('live')
    .generate('Reply with exactly ORACLE_OK.', { memory: { thread, resource: ids.resource } });
  expect(result.text.trim()).toBe('ORACLE_OK');
  await server.settle();
  const messages = (await (await store.getStore('memory'))!.listMessages({ threadId: thread, perPage: false }))
    .messages;
  expect(messages.some(message => message.role === 'user')).toBe(true);
  expect(messages.some(message => message.role === 'assistant')).toBe(true);
});

it('L02 recalls a random value from Oracle history after process restart', async () => {
  const thread = randomUUID();
  const code = randomUUID();
  const options = { memory: { thread, resource: ids.resource } };
  await server.client.getAgent('live').generate(`Remember this verification code: ${code}. Reply STORED.`, options);
  await server.settle();
  await server.restart();
  const result = await server.client
    .getAgent('live')
    .generate('Return only the verification code I gave you earlier.', options);
  expect(result.text.trim()).toBe(code);
});
