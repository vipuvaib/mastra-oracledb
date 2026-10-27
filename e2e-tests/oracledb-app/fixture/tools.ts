import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
export const calculator = createTool({
  id: 'calculator',
  description: 'Add two integers.',
  inputSchema: z.object({ a: z.number().int().min(-1000).max(1000), b: z.number().int().min(-1000).max(1000) }),
  outputSchema: z.object({ result: z.number().int() }),
  execute: async ({ a, b }) => ({ result: a + b }),
});
