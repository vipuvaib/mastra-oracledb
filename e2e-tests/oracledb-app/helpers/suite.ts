import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { openStore } from './database.ts';
import { ServerProcess } from './server-process.ts';
export function suite(name: string) {
  const server = new ServerProcess(name);
  const store = openStore(`assertions-${name}`);
  const ids = { thread: `${name}-${randomUUID()}`, resource: `resource-${randomUUID()}` };
  beforeAll(async () => {
    await server.start();
  });
  afterAll(async () => {
    try {
      await server.stop();
    } finally {
      await store.disconnect();
    }
  });
  return { server, store, ids };
}
