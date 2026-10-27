import { randomUUID } from 'node:crypto';
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore } from '@mastra/core/storage';
import { expect, it } from 'vitest';
import { approvalWorkflow, failureWorkflow } from '../fixture/workflows.ts';

it('suspends and resumes the approval fixture without losing prepared input', async () => {
  const workflow = approvalWorkflow();
  const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { approval: workflow }, logger: false });
  try {
    const run = await workflow.createRun();
    const requestId = randomUUID();
    expect((await run.start({ inputData: { requestId, amount: 21 } })).status).toBe('suspended');
    expect(await run.resume({ step: 'approve', resumeData: { approved: false } })).toMatchObject({
      status: 'success',
      result: { requestId, total: 42, approved: false },
    });
    await expect((await workflow.createRun()).start({ inputData: { requestId, amount: -1 } })).rejects.toThrow();
  } finally {
    await mastra.shutdown();
  }
});
it('represents the intentional fixture exception as a failed run', async () => {
  const workflow = failureWorkflow();
  const mastra = new Mastra({ storage: new InMemoryStore(), workflows: { failure: workflow }, logger: false });
  try {
    expect((await (await workflow.createRun()).start({ inputData: { reason: 'unit' } })).status).toBe('failed');
  } finally {
    await mastra.shutdown();
  }
});
