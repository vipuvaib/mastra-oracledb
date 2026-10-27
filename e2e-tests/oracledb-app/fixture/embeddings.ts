import type { EmbeddingModelV2 } from '@ai-sdk/provider-v5';

/** Deliberately tiny vocabulary: test retrieval wiring, not model quality. */
export function embedText(text: string): number[] {
  if (/\bALPHA\b/i.test(text)) return [1, 0, 0];
  if (/\bBETA\b/i.test(text)) return [0, 1, 0];
  if (/\bGAMMA\b/i.test(text)) return [0, 0, 1];
  return [1, 1, 1];
}

export const deterministicEmbedder: EmbeddingModelV2<string> = {
  specificationVersion: 'v2',
  provider: 'oracle-e2e',
  modelId: 'deterministic-three-axis',
  maxEmbeddingsPerCall: 64,
  supportsParallelCalls: true,
  doEmbed: async ({ values }) => ({ embeddings: values.map(embedText), usage: { tokens: values.length } }),
};
