import type { MastraCompositeStore } from '@mastra/core/storage';
import { Memory } from '@mastra/memory';
import { observerModel } from './models/observer.ts';
export function createObservedMemory(storage: MastraCompositeStore) {
  return new Memory({
    storage,
    options: {
      generateTitle: false,
      semanticRecall: false,
      observationalMemory: {
        enabled: true,
        scope: 'thread',
        observation: { model: observerModel(), messageTokens: 100_000, bufferTokens: 50_000, bufferActivation: 1 },
        reflection: { model: observerModel(), observationTokens: 100_000, bufferActivation: 1 },
      },
    },
  });
}
