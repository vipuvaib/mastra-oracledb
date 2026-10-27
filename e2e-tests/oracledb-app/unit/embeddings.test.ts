import { expect, it } from 'vitest';
import { deterministicEmbedder, embedText } from '../fixture/embeddings.ts';

it('maps known topics to distinct axes and gives unknown text a neutral embedding', () => {
  expect(embedText('ALPHA policy')).toEqual([1, 0, 0]);
  expect(embedText('beta policy')).toEqual([0, 1, 0]);
  expect(embedText('GAMMA policy')).toEqual([0, 0, 1]);
  expect(embedText('alphabet')).toEqual([1, 1, 1]);
});
it('preserves batch order without using a provider', async () => {
  const result = await deterministicEmbedder.doEmbed({ values: ['BETA', 'ALPHA'] });
  expect(result.embeddings).toEqual([
    [0, 1, 0],
    [1, 0, 0],
  ]);
});
