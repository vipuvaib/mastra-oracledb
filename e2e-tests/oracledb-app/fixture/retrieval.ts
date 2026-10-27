import { createTool } from '@mastra/core/tools';
import type { OracleVector } from '@mastra/oracledb';
import { z } from 'zod';
import { embedText } from './embeddings.ts';

export function retrievalTool(vector: OracleVector) {
  return createTool({
    id: 'retrieve',
    description: 'Retrieve the closest ALPHA, BETA or GAMMA document for a tenant.',
    inputSchema: z.object({
      indexName: z.string().regex(/^app_[a-f0-9]{8}$/),
      topic: z.enum(['ALPHA', 'BETA', 'GAMMA']),
      tenant: z.string().uuid(),
    }),
    outputSchema: z.object({ ids: z.array(z.string()), texts: z.array(z.string()) }),
    execute: async ({ indexName, topic, tenant }) => {
      const results = await vector.query({
        indexName,
        queryVector: embedText(topic),
        topK: 1,
        filter: { tenant },
        queryMode: 'exact',
        minScore: 0.9,
      });
      return {
        ids: results.map(result => result.id),
        texts: results.map(result => String(result.metadata?.text ?? '')),
      };
    },
  });
}
