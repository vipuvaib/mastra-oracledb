import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const input = z.object({ requestId: z.string().uuid(), amount: z.number().int().min(1).max(1000) });
const prepared = input.extend({ doubled: z.number().int().min(2).max(2000) });
const output = z.object({ requestId: z.string().uuid(), total: z.number().int(), approved: z.boolean() });

export function approvalWorkflow() {
  const prepare = createStep({
    id: 'prepare',
    inputSchema: input,
    outputSchema: prepared,
    execute: async ({ inputData }) => ({ ...inputData, doubled: inputData.amount * 2 }),
  });
  const approve = createStep({
    id: 'approve',
    inputSchema: prepared,
    outputSchema: output,
    suspendSchema: z.object({ requestId: z.string().uuid(), amount: z.number().int() }),
    resumeSchema: z.object({ approved: z.boolean() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData) {
        await suspend({ requestId: inputData.requestId, amount: inputData.doubled });
      }
      return { requestId: inputData.requestId, total: inputData.doubled, approved: resumeData?.approved ?? false };
    },
  });
  return createWorkflow({ id: 'approval', inputSchema: input, outputSchema: output })
    .then(prepare)
    .then(approve)
    .commit();
}

export function failureWorkflow() {
  const fail = createStep({
    id: 'fail',
    inputSchema: z.object({ reason: z.string().min(1).max(100) }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async ({ inputData }) => {
      throw new Error(`intentional-fixture-failure: ${inputData.reason}`);
    },
  });
  return createWorkflow({ id: 'failure', inputSchema: fail.inputSchema, outputSchema: fail.outputSchema })
    .then(fail)
    .commit();
}
