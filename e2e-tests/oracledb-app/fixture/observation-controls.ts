import type { MastraCompositeStore, ObservationalMemoryRecord } from '@mastra/core/storage';
import type { Memory } from '@mastra/memory';

/** Test-only scheduling boundaries; all observation and Oracle writes stay real. */
export async function observationControls(memory: Memory, storage: MastraCompositeStore) {
  const store = (await storage.getStore('memory'))!;
  const engine = (await memory.omEngine)!;
  const append = store.updateBufferedObservations.bind(store);
  const swap = store.swapBufferedToActive.bind(store);
  let ackTarget: string | undefined;
  let lateTarget: { threadId: string; resourceId: string } | undefined;
  const probe = {
    appendAttempts: [] as { recordId: string; cycleId: string }[],
    postCommitFailures: 0,
    committedChunkIds: [] as string[],
    race: null as null | {
      callerChunkIds: string[];
      lockedChunkIds: string[];
      firstCycleId: string;
      lateCycleId: string;
      callerPending: number;
      lockedPending: number;
      activatedMessageTokens: number;
      increment: number;
    },
  };
  store.updateBufferedObservations = async input => {
    probe.appendAttempts.push({ recordId: input.id, cycleId: input.chunk.cycleId });
    await append(input);
    if (ackTarget === input.id) {
      ackTarget = undefined;
      const row = await engine.getRecord(current.threadId, current.resourceId);
      probe.committedChunkIds = (row?.bufferedObservationChunks ?? []).map(chunk => chunk.id);
      probe.postCommitFailures++;
      throw Object.assign(new Error('test-only ECONNRESET after buffered observation commit'), { code: 'ECONNRESET' });
    }
  };
  let current = { threadId: '', resourceId: '' };
  store.swapBufferedToActive = async input => {
    if (lateTarget && input.id === (await engine.getRecord(lateTarget.threadId, lateTarget.resourceId))?.id) {
      const target = lateTarget;
      lateTarget = undefined;
      const first = input.bufferedChunks?.[0];
      if (!first) throw new Error('Activation race requires the original buffered chunk.');
      // Append the second real observer cycle after activate() captured its chunk snapshot.
      const buffered = await engine.buffer({ ...target, skipMinimumTokenCheck: true });
      if (!buffered.buffered) throw new Error('The late real observation cycle did not buffer.');
      const fresh = (await engine.getRecord(target.threadId, target.resourceId))!;
      const chunks = fresh.bufferedObservationChunks ?? [];
      if (chunks.length !== 2)
        throw new Error('Expected exactly two distinct buffered cycles at the row-lock boundary.');
      const late = chunks.find(chunk => chunk.id !== first.id)!;
      const increment = 17;
      const callerPending = first.messageTokens;
      const lockedPending = callerPending + late.messageTokens + increment;
      // Model another pending-token writer, using real committed Oracle storage.
      await store.setPendingMessageTokens(input.id, lockedPending);
      probe.race = {
        callerChunkIds: input.bufferedChunks!.map(chunk => chunk.id),
        lockedChunkIds: chunks.map(chunk => chunk.id),
        firstCycleId: first.cycleId,
        lateCycleId: late.cycleId,
        callerPending,
        lockedPending,
        activatedMessageTokens: first.messageTokens,
        increment,
      };
      // An explicit stale caller budget selects only the first chunk; the locked row owns membership/counters.
      return swap({
        ...input,
        currentPendingTokens: callerPending,
        activationRatio: 1,
        messageTokensThreshold: 0,
        forceMaxActivation: false,
      });
    }
    return swap(input);
  };
  return {
    probe,
    async buffer(threadId: string, resourceId: string, failAfterCommit: boolean) {
      current = { threadId, resourceId };
      const row = await engine.getRecord(threadId, resourceId);
      if (!row) throw new Error('Generate an observational-memory turn first.');
      if (failAfterCommit) ackTarget = row.id;
      const result = await engine.buffer({ threadId, resourceId, skipMinimumTokenCheck: true });
      await memory.settled();
      return { buffered: result.buffered, record: await engine.getRecord(threadId, resourceId), probe };
    },
    async activate(threadId: string, resourceId: string, appendDuringActivation: boolean) {
      if (appendDuringActivation) lateTarget = { threadId, resourceId };
      const result = await engine.activate({ threadId, resourceId });
      await memory.settled();
      return { activated: result.activated, record: await engine.getRecord(threadId, resourceId), probe };
    },
    async record(threadId: string, resourceId: string): Promise<ObservationalMemoryRecord | null> {
      return store.getObservationalMemory(threadId, resourceId);
    },
  };
}
