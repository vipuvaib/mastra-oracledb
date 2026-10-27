import type { MastraDBMessage } from '@mastra/core/agent';
import type { MemoryConfig } from '@mastra/core/memory';
import { InMemoryStore } from '@mastra/core/storage';
import type { MastraVector } from '@mastra/core/vector';
import { describe, expect, it, vi } from 'vitest';
import { Memory } from './index';

const target = { threadId: 'include-thread', resourceId: 'include-resource' };
const timestamp = new Date('2026-01-01T00:00:00Z');
const message = (
  id: string,
  offset: number,
  threadId = target.threadId,
  resourceId = target.resourceId,
): MastraDBMessage => ({
  id,
  threadId,
  resourceId,
  role: 'user',
  createdAt: new Date(timestamp.getTime() + offset * 1000),
  content: { format: 2, parts: [{ type: 'text', text: `Message ${id}` }] },
});

async function fixture(options: MemoryConfig = { lastMessages: 20 }, semantic = false) {
  const storage = new InMemoryStore();
  const query = vi.fn().mockResolvedValue([
    { id: 'vector-b', score: 0.9, metadata: { message_id: 'b', thread_id: target.threadId } },
    { id: 'vector-c', score: 0.2, metadata: { message_id: 'c', thread_id: target.threadId } },
  ]);
  const vector = {
    id: 'include-vector',
    query,
    createIndex: vi.fn().mockResolvedValue(undefined),
    listIndexes: vi.fn().mockResolvedValue([]),
    describeIndex: vi.fn().mockResolvedValue({ dimension: 3 }),
  } as unknown as MastraVector;
  const memory = new Memory({
    storage,
    options: { semanticRecall: false, generateTitle: false, ...options },
    ...(semantic
      ? {
          vector,
          embedder: {
            specificationVersion: 'v2' as const,
            provider: 'include-test',
            modelId: 'include-embedder',
            maxEmbeddingsPerCall: 10,
            supportsParallelCalls: true,
            doEmbed: async () => ({ embeddings: [[1, 0, 0]], usage: { tokens: 1 } }),
          },
        }
      : {}),
  });
  const store = (await storage.getStore('memory'))!;
  for (const [id, resourceId] of [
    [target.threadId, target.resourceId],
    ['sibling', target.resourceId],
    ['foreign', 'foreign-resource'],
  ] as const) {
    await store.saveThread({ thread: { id, resourceId, createdAt: timestamp, updatedAt: timestamp } });
  }
  await store.saveMessages({
    messages: [
      message('a', 0),
      message('b', 1),
      message('c', 2),
      message('d', 3),
      message('sibling-message', 4, 'sibling'),
      message('foreign-message', 5, 'foreign', 'foreign-resource'),
    ],
  });
  return { memory, store, query };
}

describe('recall explicit include windows', () => {
  it('returns an explicit anchor and its neighbors with perPage zero', async () => {
    const { memory } = await fixture();
    const result = await memory.recall({
      ...target,
      perPage: 0,
      include: [{ id: 'b', withPreviousMessages: 1, withNextMessages: 1 }],
    });
    expect(result.messages.map(message => message.id)).toEqual(['a', 'b', 'c']);
  });

  it('unions included messages with the paginated history without duplicates', async () => {
    const { memory } = await fixture();
    const result = await memory.recall({
      ...target,
      perPage: 1,
      include: [{ id: 'b', withPreviousMessages: 1 }, { id: 'b', withNextMessages: 1 }, { id: 'd' }],
    });
    expect(result.messages.map(message => message.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('honors explicit includes with history disabled while leaving unrequested history disabled', async () => {
    const { memory } = await fixture({ lastMessages: false });
    expect((await memory.recall({ ...target, include: [{ id: 'b' }] })).messages.map(message => message.id)).toEqual([
      'b',
    ]);
    expect((await memory.recall(target)).messages).toEqual([]);
  });

  it('keeps an empty include list on the disabled-history fast path', async () => {
    const { memory, store } = await fixture({ lastMessages: false });
    const getThread = vi.spyOn(store, 'getThreadById');
    const listMessages = vi.spyOn(store, 'listMessages');
    expect((await memory.recall({ threadId: 'missing', resourceId: target.resourceId, include: [] })).messages).toEqual(
      [],
    );
    expect(getThread).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('allows same-resource cross-thread includes and rejects another resource', async () => {
    const { memory } = await fixture();
    const result = await memory.recall({
      ...target,
      perPage: 0,
      include: [{ id: 'sibling-message' }, { id: 'foreign-message', withPreviousMessages: 5 }, { id: 'unknown' }],
    });
    expect(result.messages.map(message => message.id)).toEqual(['sibling-message']);
  });

  it('combines explicit and semantic windows without reintroducing below-threshold matches', async () => {
    const { memory, query } = await fixture(
      {
        lastMessages: false,
        semanticRecall: { scope: 'thread', topK: 2, messageRange: 0, threshold: 0.8 },
      },
      true,
    );
    const include = [{ id: 'a' }, { id: 'b' }];
    const result = await memory.recall({ ...target, vectorSearchString: 'find a memory', include });
    expect(query).toHaveBeenCalledOnce();
    expect(result.messages.map(message => message.id)).toEqual(['a', 'b']);
    expect(include).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it.each([false, true])(
    'preserves token-history boundaries when explicitly including older messages (boundary=%s)',
    async boundary => {
      const { memory, store } = await fixture({
        lastMessages: 1,
        messageHistory: { maxTokens: 1000, atMaxRemoveTokens: 100 },
      });
      if (boundary) {
        await store.patchThread({
          id: target.threadId,
          metadata: {
            memoryTokenLimiter: {
              createdAt: message('b', 1).createdAt.toISOString(),
              messageIds: ['b'],
              maxTokens: 1000,
              atMaxRemoveTokens: 100,
            },
          },
        });
      }
      const result = await memory.recall({ ...target, include: [{ id: 'b', withPreviousMessages: 1 }] });
      expect(result.messages.map(message => message.id).sort()).toEqual(boundary ? ['d'] : ['a', 'b', 'd']);
    },
  );
});
