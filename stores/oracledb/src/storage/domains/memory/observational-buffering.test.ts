import type {
  BufferedObservationChunk,
  BufferedObservationChunkInput,
  ObservationalMemoryRecord,
  UpdateBufferedObservationsInput,
} from '@mastra/core/storage';
import type { Connection } from 'oracledb';
import { describe, expect, it, vi } from 'vitest';

import {
  swapBufferedReflectionToActive,
  swapBufferedToActive,
  updateBufferedObservations,
} from './observational-buffering';
import type { MemoryContext } from './utils';

// CR-11: swapBufferedReflectionToActive already locks the observational memory
// row with `SELECT ... FOR UPDATE` before deriving the next generation, but the
// new record used to copy generationCount/totalTokensObserved/config/metadata/
// observedTimezone/lastObservedAt/scope/threadId/resourceId from the CALLER'S
// (possibly stale) `input.currentRecord` instead of the row it just locked.
// These tests pin the fix: those fields must come from the locked row.

const LOCKED_ROW = {
  id: 'om-1',
  lookupKey: 'thread:thread-fresh',
  scope: 'thread',
  resourceId: 'resource-fresh',
  threadId: 'thread-fresh',
  activeObservations: 'line1\nline2\nline3',
  activeObservationsPendingUpdate: null,
  originType: 'initial',
  config: JSON.stringify({ fresh: true }),
  generationCount: 5,
  lastObservedAt: new Date('2026-01-05T00:00:00.000Z'),
  lastReflectionAt: null,
  pendingMessageTokens: 0,
  totalTokensObserved: 999,
  observationTokenCount: 50,
  isObserving: 0,
  isReflecting: 0,
  observedMessageIds: null,
  observedTimezone: 'America/New_York',
  bufferedObservations: null,
  bufferedObservationTokens: null,
  bufferedMessageIds: null,
  bufferedReflection: 'the buffered reflection text',
  bufferedReflectionTokens: 42,
  bufferedReflectionInputTokens: 84,
  reflectedObservationLineCount: 2,
  bufferedObservationChunks: null,
  isBufferingObservation: 0,
  isBufferingReflection: 1,
  lastBufferedAtTokens: 0,
  lastBufferedAtTime: null,
  metadata: JSON.stringify({ fresh: true }),
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

// Deliberately different from LOCKED_ROW on every field the fix should stop
// reading, simulating a writer that changed the row between when the caller
// read `currentRecord` and when this swap acquired its lock.
const STALE_CURRENT_RECORD: ObservationalMemoryRecord = {
  id: 'om-1',
  scope: 'resource',
  threadId: 'thread-stale',
  resourceId: 'resource-stale',
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-06-01T00:00:00.000Z'),
  lastObservedAt: new Date('2025-06-01T00:00:00.000Z'),
  originType: 'initial',
  generationCount: 0,
  activeObservations: 'stale observations',
  totalTokensObserved: 100,
  observationTokenCount: 10,
  pendingMessageTokens: 0,
  isReflecting: true,
  isObserving: false,
  isBufferingObservation: false,
  isBufferingReflection: true,
  lastBufferedAtTokens: 0,
  lastBufferedAtTime: null,
  config: { stale: true },
  metadata: { stale: true },
  observedTimezone: 'UTC',
};

function createFakeCtx(): MemoryContext {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes('FOR UPDATE')) {
      return { rows: [LOCKED_ROW] };
    }
    // insertOMRecord's INSERT and the trailing UPDATE clearing buffered
    // reflection columns don't need row data back.
    return { rowsAffected: 1 };
  });
  const connection = { execute } as unknown as Connection;
  const db = {
    tx: vi.fn(async (callback: (client: unknown, connection: Connection) => Promise<unknown>) =>
      callback({}, connection),
    ),
  };
  return { db, schemaName: undefined } as unknown as MemoryContext;
}

function createSwapCtx(lockedChunks: BufferedObservationChunk[] | null, pendingMessageTokens = 100) {
  const lockedRow = {
    id: 'om-1',
    activeObservations: 'already active',
    pendingMessageTokens,
    bufferedObservationChunks: lockedChunks ? JSON.stringify(lockedChunks) : null,
  };
  const execute = vi.fn(async (sql: string, _binds?: Record<string, unknown>) => {
    if (sql.includes('FOR UPDATE')) return { rows: [lockedRow] };
    return { rowsAffected: 1 };
  });
  const connection = { execute } as unknown as Connection;
  const db = {
    tx: vi.fn(async (callback: (client: unknown, connection: Connection) => Promise<unknown>) =>
      callback({}, connection),
    ),
  };
  const ctx = { db, schemaName: undefined } as unknown as MemoryContext;
  return { ctx, execute };
}

function makeChunk(overrides: Partial<BufferedObservationChunk> = {}): BufferedObservationChunk {
  return {
    id: 'chunk-a',
    cycleId: 'cycle-a',
    observations: 'persisted observations A',
    tokenCount: 3,
    messageIds: ['message-a'],
    messageTokens: 75,
    lastObservedAt: new Date('2026-02-01T00:00:00.000Z'),
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function getPersistedRemainingChunks(calls: readonly unknown[][]): unknown[] | null {
  const updateCall = calls.find(([sql]) => /^\s*UPDATE\b/i.test(String(sql)));
  if (!updateCall) throw new Error('Expected swapBufferedToActive to issue an UPDATE');

  const binds = updateCall?.[1] as Record<string, unknown> | undefined;
  const rawBind = binds?.bufferedObservationChunks;
  if (rawBind === null || rawBind === undefined) return null;

  const value =
    typeof rawBind === 'object' && !Array.isArray(rawBind) && 'val' in rawBind
      ? (rawBind as { val?: unknown }).val
      : rawBind;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return JSON.parse(value) as unknown[];
  return null;
}

function createAppendCtx(initialChunks: BufferedObservationChunk[] = [], errorAfterFirstCommit?: Error) {
  const lockedRow = {
    id: 'om-1',
    bufferedObservationChunks: initialChunks.length > 0 ? JSON.stringify(initialChunks) : null,
  };
  const execute = vi.fn(async (sql: string, binds?: Record<string, unknown>) => {
    if (sql.includes('FOR UPDATE')) return { rows: [{ ...lockedRow }] };
    if (/^\s*UPDATE\b/i.test(sql)) {
      const chunks = getPersistedRemainingChunks([[sql, binds]]);
      lockedRow.bufferedObservationChunks = chunks === null ? null : JSON.stringify(chunks);
      return { rowsAffected: 1 };
    }
    throw new Error(`Unexpected append SQL: ${sql}`);
  });
  const connection = { execute } as unknown as Connection;
  const db = {
    tx: vi.fn(async (callback: (client: unknown, connection: Connection) => Promise<unknown>) => {
      const result = await callback({}, connection);
      // Model a committed append whose acknowledgement or connection cleanup fails.
      // The next call must see the persisted state despite the previous rejection.
      if (errorAfterFirstCommit) {
        const error = errorAfterFirstCommit;
        errorAfterFirstCommit = undefined;
        throw error;
      }
      return result;
    }),
  };
  const ctx = { db, schemaName: undefined } as unknown as MemoryContext;
  const getChunks = (): unknown[] =>
    lockedRow.bufferedObservationChunks ? JSON.parse(lockedRow.bufferedObservationChunks) : [];
  return { ctx, getChunks };
}

function makeAppendInput(overrides: Partial<BufferedObservationChunkInput> = {}): UpdateBufferedObservationsInput {
  return {
    id: 'om-1',
    chunk: {
      cycleId: 'cycle-a',
      observations: 'persisted observations A',
      tokenCount: 3,
      messageIds: ['message-a'],
      messageTokens: 75,
      lastObservedAt: new Date('2026-02-01T00:00:00.000Z'),
      ...overrides,
    },
  };
}

describe('updateBufferedObservations cycle replay', () => {
  it('persists the same cycle only once across repeated calls', async () => {
    const { ctx, getChunks } = createAppendCtx();
    const input = makeAppendInput();

    await updateBufferedObservations(ctx, input);
    const firstPersistedChunks = getChunks();
    expect(firstPersistedChunks).toHaveLength(1);

    await expect(updateBufferedObservations(ctx, input)).resolves.toBeUndefined();

    expect(getChunks()).toHaveLength(1);
    expect(getChunks()).toEqual(firstPersistedChunks);
  });

  it('preserves the first persisted payload when the same cycle is submitted with different fields', async () => {
    const originalChunk = makeChunk({
      suggestedContinuation: 'original continuation',
      currentTask: 'original task',
      threadTitle: 'Original title',
      extractedValues: { topic: 'original' },
      extractionFailures: [{ slug: 'original-extractor', error: 'original failure' }],
    });
    const { ctx, getChunks } = createAppendCtx([originalChunk]);
    const firstPersistedChunks = getChunks();

    await expect(
      updateBufferedObservations(
        ctx,
        makeAppendInput({
          observations: 'changed observations',
          tokenCount: 999,
          messageIds: ['changed-message'],
          messageTokens: 999,
          lastObservedAt: new Date('2026-02-02T00:00:00.000Z'),
          suggestedContinuation: 'changed continuation',
          currentTask: 'changed task',
          threadTitle: 'Changed title',
          extractedValues: { topic: 'changed' },
          extractionFailures: [{ slug: 'changed-extractor', error: 'changed failure' }],
        }),
      ),
    ).resolves.toBeUndefined();

    expect(getChunks()).toEqual(firstPersistedChunks);
  });

  it('does not duplicate a cycle when replayed after persistence succeeded but the call rejected', async () => {
    const { ctx, getChunks } = createAppendCtx([], new Error('connection reset after commit'));
    const input = makeAppendInput();

    await expect(updateBufferedObservations(ctx, input)).rejects.toThrow();
    const firstPersistedChunks = getChunks();
    expect(firstPersistedChunks).toHaveLength(1);

    await expect(updateBufferedObservations(ctx, input)).resolves.toBeUndefined();

    expect(getChunks()).toHaveLength(1);
    expect(getChunks()).toEqual(firstPersistedChunks);
  });

  it('appends distinct cycles even when their observations and message IDs are identical', async () => {
    const { ctx, getChunks } = createAppendCtx();

    await updateBufferedObservations(ctx, makeAppendInput());
    await updateBufferedObservations(ctx, makeAppendInput({ cycleId: 'cycle-b' }));

    expect(getChunks()).toHaveLength(2);
    expect(getChunks()).toMatchObject([
      { cycleId: 'cycle-a', observations: 'persisted observations A', messageIds: ['message-a'] },
      { cycleId: 'cycle-b', observations: 'persisted observations A', messageIds: ['message-a'] },
    ]);
  });
});

describe('swapBufferedReflectionToActive (CR-11)', () => {
  it('derives the new generation from the locked row, not the caller-supplied currentRecord', async () => {
    const ctx = createFakeCtx();

    const result = await swapBufferedReflectionToActive(ctx, {
      currentRecord: STALE_CURRENT_RECORD,
      tokenCount: 12.7,
    });

    expect(result.scope).toBe(LOCKED_ROW.scope);
    expect(result.threadId).toBe(LOCKED_ROW.threadId);
    expect(result.resourceId).toBe(LOCKED_ROW.resourceId);
    expect(result.generationCount).toBe(LOCKED_ROW.generationCount + 1);
    expect(result.totalTokensObserved).toBe(LOCKED_ROW.totalTokensObserved);
    expect(result.config).toEqual({ fresh: true });
    expect(result.metadata).toEqual({ fresh: true });
    expect(result.observedTimezone).toBe(LOCKED_ROW.observedTimezone);
    expect(result.lastObservedAt).toEqual(LOCKED_ROW.lastObservedAt);

    // None of the stale values from input.currentRecord should leak through.
    expect(result.scope).not.toBe(STALE_CURRENT_RECORD.scope);
    expect(result.threadId).not.toBe(STALE_CURRENT_RECORD.threadId);
    expect(result.resourceId).not.toBe(STALE_CURRENT_RECORD.resourceId);
    expect(result.generationCount).not.toBe(STALE_CURRENT_RECORD.generationCount + 1);
    expect(result.totalTokensObserved).not.toBe(STALE_CURRENT_RECORD.totalTokensObserved);
    expect(result.observedTimezone).not.toBe(STALE_CURRENT_RECORD.observedTimezone);
  });

  it('still derives a fresh id and marks the new generation as originType reflection', async () => {
    const ctx = createFakeCtx();

    const result = await swapBufferedReflectionToActive(ctx, {
      currentRecord: STALE_CURRENT_RECORD,
      tokenCount: 5,
    });

    expect(result.id).not.toBe(STALE_CURRENT_RECORD.id);
    expect(result.originType).toBe('reflection');
    expect(result.isReflecting).toBe(false);
    expect(result.isBufferingReflection).toBe(false);
  });
});

describe('swapBufferedToActive buffered chunk reconciliation', () => {
  it('selects chunks using the caller budget and decrements the locked row pending tokens', async () => {
    const chunkA = makeChunk();
    const chunkB = makeChunk({
      id: 'chunk-b',
      cycleId: 'cycle-b',
      observations: 'persisted observations B',
      messageIds: ['message-b'],
      messageTokens: 25,
    });
    const { ctx, execute } = createSwapCtx([chunkA, chunkB], 140);

    const result = await swapBufferedToActive(ctx, {
      id: 'om-1',
      activationRatio: 0.5,
      messageTokensThreshold: 50,
      currentPendingTokens: 100,
      bufferedChunks: [chunkA],
    });

    // The caller budget targets 75 tokens; using the locked row's 140 would activate both chunks.
    expect(result.chunksActivated).toBe(1);
    expect(result.activatedCycleIds).toEqual(['cycle-a']);
    expect(result.messageTokensActivated).toBe(75);
    expect(getPersistedRemainingChunks(execute.mock.calls)).toMatchObject([{ id: 'chunk-b', cycleId: 'cycle-b' }]);

    // Persist against the locked counter: 140 - 75 = 65, not the caller snapshot's 100 - 75 = 25.
    const updateCall = execute.mock.calls.find(([sql]) => /^\s*UPDATE\b/i.test(sql));
    expect(updateCall?.[1]).toMatchObject({ pendingMessageTokens: 65 });
  });

  it('preserves chunks found in the locked row but missing from the caller snapshot', async () => {
    const chunkA = makeChunk();
    const chunkB = makeChunk({
      id: 'chunk-b',
      cycleId: 'cycle-b',
      observations: 'persisted observations B',
      messageIds: ['message-b'],
      messageTokens: 25,
    });
    const { ctx, execute } = createSwapCtx([chunkA, chunkB]);

    const result = await swapBufferedToActive(ctx, {
      id: 'om-1',
      activationRatio: 0.5,
      messageTokensThreshold: 50,
      currentPendingTokens: 100,
      bufferedChunks: [chunkA],
    });

    expect(result.activatedCycleIds).toEqual(['cycle-a']);
    expect(getPersistedRemainingChunks(execute.mock.calls)).toMatchObject([{ id: 'chunk-b', cycleId: 'cycle-b' }]);
  });

  it('does not reactivate a stale caller chunk when the locked row has already been cleared', async () => {
    const staleChunk = makeChunk();
    const { ctx, execute } = createSwapCtx(null);

    const result = await swapBufferedToActive(ctx, {
      id: 'om-1',
      activationRatio: 1,
      messageTokensThreshold: 50,
      currentPendingTokens: 75,
      bufferedChunks: [staleChunk],
    });

    expect(result.chunksActivated).toBe(0);
    expect(result.activatedCycleIds).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('uses refreshed message-token weights only for matching locked chunks', async () => {
    const lockedChunkA = makeChunk({ messageTokens: 10 });
    const chunkB = makeChunk({
      id: 'chunk-b',
      cycleId: 'cycle-b',
      observations: 'persisted observations B',
      messageIds: ['message-b'],
      messageTokens: 25,
    });
    const { ctx, execute } = createSwapCtx([lockedChunkA, chunkB]);
    const refreshedChunkA = makeChunk({
      messageTokens: 75,
      observations: 'stale caller observations A',
      tokenCount: 999,
      messageIds: ['stale-message-a'],
    });

    const result = await swapBufferedToActive(ctx, {
      id: 'om-1',
      activationRatio: 0.5,
      messageTokensThreshold: 50,
      currentPendingTokens: 100,
      bufferedChunks: [refreshedChunkA],
    });

    expect(result.activatedCycleIds).toEqual(['cycle-a']);
    expect(result.observations).toBe('persisted observations A');
    expect(result.activatedMessageIds).toEqual(['message-a']);
    expect(result.observationTokensActivated).toBe(3);
    expect(result.messageTokensActivated).toBe(75);
    expect(getPersistedRemainingChunks(execute.mock.calls)).toMatchObject([{ id: 'chunk-b', cycleId: 'cycle-b' }]);
  });
});
