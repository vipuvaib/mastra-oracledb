import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type { StorageListMessagesInput } from '@mastra/core/storage';

export const messageWindowEntryPoints = ['thread', 'resource'] as const;

type FixtureMessage = { id: string; offset: number; otherThread?: boolean; foreignResource?: boolean };
type MessageWindowCase = {
  name: string;
  messages: FixtureMessage[];
  include: NonNullable<StorageListMessagesInput['include']>;
  expectedIds: string[];
};
const tied: FixtureMessage[] = ['a', 'b', 'c'].map(id => ({ id, offset: 1000 }));

// Expected membership is explicit, not computed with the same algorithm as the
// provider. Shared by mocked-connection and real Oracle result tests.
export const messageWindowCases: MessageWindowCase[] = [
  {
    name: 'returns the first tied anchor without context',
    messages: tied,
    include: [{ id: 'a' }],
    expectedIds: ['a'],
  },
  {
    name: 'returns the middle tied anchor without context',
    messages: tied,
    include: [{ id: 'b' }],
    expectedIds: ['b'],
  },
  {
    name: 'returns the last tied anchor without context',
    messages: tied,
    include: [{ id: 'c' }],
    expectedIds: ['c'],
  },
  {
    name: 'selects previous tied messages rather than later IDs',
    messages: tied,
    include: [{ id: 'b', withPreviousMessages: 1 }],
    expectedIds: ['a', 'b'],
  },
  {
    name: 'selects following tied messages without losing the anchor',
    messages: tied,
    include: [{ id: 'b', withNextMessages: 1 }],
    expectedIds: ['b', 'c'],
  },
  {
    name: 'selects both sides of a middle tied anchor',
    messages: tied,
    include: [{ id: 'b', withPreviousMessages: 1, withNextMessages: 1 }],
    expectedIds: ['a', 'b', 'c'],
  },
  {
    name: 'crosses timestamp boundaries while retaining nearest tied neighbors',
    messages: [{ id: 'earlier', offset: 0 }, ...tied, { id: 'later', offset: 2000 }],
    include: [{ id: 'a', withPreviousMessages: 1, withNextMessages: 1 }],
    expectedIds: ['earlier', 'a', 'b'],
  },
  {
    name: 'deduplicates overlapping windows while preserving both anchors',
    messages: tied,
    include: [
      { id: 'a', withNextMessages: 1 },
      { id: 'b', withNextMessages: 1 },
    ],
    expectedIds: ['a', 'b', 'c'],
  },
  {
    name: 'preserves ordinary windows with distinct timestamps',
    messages: [
      { id: 'a', offset: 0 },
      { id: 'b', offset: 1000 },
      { id: 'c', offset: 2000 },
    ],
    include: [{ id: 'b', withPreviousMessages: 1, withNextMessages: 1 }],
    expectedIds: ['a', 'b', 'c'],
  },
  {
    name: 'keeps the context window inside the discovered anchor thread',
    messages: [...tied, { id: 'z', offset: 1000, otherThread: true }],
    include: [{ id: 'c', withPreviousMessages: 5, withNextMessages: 5 }],
    expectedIds: ['a', 'b', 'c'],
  },
  {
    name: 'rejects an anchor owned by another resource',
    messages: [...tied, { id: 'z', offset: 1000, foreignResource: true }],
    include: [{ id: 'z', withPreviousMessages: 5, withNextMessages: 5 }],
    expectedIds: [],
  },
  {
    name: 'filters foreign-resource neighbors before applying the window limit',
    messages: [
      { id: 'a', offset: 1000 },
      { id: 'b', offset: 1000, foreignResource: true },
      { id: 'c', offset: 1000 },
    ],
    include: [{ id: 'c', withPreviousMessages: 1 }],
    expectedIds: ['a', 'c'],
  },
  {
    name: 'allows an included anchor from another thread of the same resource',
    messages: [
      { id: 'a', offset: 1000 },
      { id: 'b', offset: 1000, otherThread: true },
      { id: 'c', offset: 1000, otherThread: true },
    ],
    include: [{ id: 'c', withPreviousMessages: 1 }],
    expectedIds: ['b', 'c'],
  },
  { name: 'ignores an unknown anchor', messages: tied, include: [{ id: 'missing' }], expectedIds: [] },
];

export function createMessageWindowFixture(testCase: MessageWindowCase, prefix = '') {
  const base = Date.UTC(2026, 0, 1);
  const threadId = `${prefix}thread-main`;
  const otherThreadId = `${prefix}thread-other`;
  const resourceId = `${prefix}resource-primary`;
  const threads: StorageThreadType[] = [threadId, otherThreadId].map(id => ({
    id,
    resourceId,
    title: 'Message include window regression',
    createdAt: new Date(base),
    updatedAt: new Date(base),
    metadata: {},
  }));
  const messages: MastraDBMessage[] = testCase.messages.map(message => ({
    id: `${prefix}${message.id}`,
    threadId: message.otherThread ? otherThreadId : threadId,
    resourceId: message.foreignResource ? `${prefix}resource-foreign` : resourceId,
    role: 'user',
    createdAt: new Date(base + message.offset),
    content: { format: 2, parts: [{ type: 'text', text: `Message ${message.id}` }] },
  }));
  return {
    threads,
    // Deliberately differ from chronological/ID order; insertion order is not the contract.
    messages: messages.reverse(),
    query: {
      threadId,
      resourceId,
      perPage: 0 as const,
      orderBy: { field: 'createdAt' as const, direction: 'ASC' as const },
      include: testCase.include.map(item => ({ ...item, id: `${prefix}${item.id}` })),
    },
    expectedIds: testCase.expectedIds.map(id => `${prefix}${id}`),
  };
}
