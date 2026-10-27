import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { recordEvidence } from '../helpers/evidence.ts';
import { suite } from '../helpers/suite.ts';

const { server, store, ids } = suite('workflows');

it('C01 suspends a workflow, persists its snapshot, and resumes in a new process', async () => {
  const runId = randomUUID();
  const requestId = randomUUID();
  const run = await server.client.getWorkflow('approval').createRun({ runId, resourceId: ids.resource });
  const suspended = await run.startAsync({ inputData: { requestId, amount: 21 } });
  expect(suspended.status).toBe('suspended');
  const workflows = (await store.getStore('workflows'))!;
  const snapshot = await workflows.loadWorkflowSnapshot({ workflowName: 'approval', runId });
  expect(snapshot).toMatchObject({ status: 'suspended' });
  expect(snapshot?.context.prepare).toMatchObject({ status: 'success', output: { doubled: 42 } });
  await server.restart();
  const workflow = server.client.getWorkflow('approval');
  expect(await workflow.runById(runId)).toMatchObject({ status: 'suspended' });
  const restored = await workflow.createRun({ runId, resourceId: ids.resource });
  const result = await restored.resumeAsync({ step: 'approve', resumeData: { approved: true } });
  expect(result).toMatchObject({ status: 'success', result: { requestId, total: 42, approved: true } });
  expect(await workflows.loadWorkflowSnapshot({ workflowName: 'approval', runId })).toMatchObject({
    status: 'success',
  });
  recordEvidence('C01', { runId, requestId, restartedPid: server.child!.pid });
});

it('C02 lists only the requested resource runs and persists an explicit rejection', async () => {
  const workflow = server.client.getWorkflow('approval');
  const resourceId = randomUUID();
  const run = await workflow.createRun({ resourceId });
  const requestId = randomUUID();
  await run.startAsync({ inputData: { requestId, amount: 3 } });
  expect(await run.resumeAsync({ step: 'approve', resumeData: { approved: false } })).toMatchObject({
    status: 'success',
    result: { requestId, total: 6, approved: false },
  });
  const list = await workflow.runs({ resourceId, page: 0, perPage: 1 });
  expect(list.runs.map(row => row.runId)).toEqual([run.runId]);
  expect(list.runs.every(row => row.resourceId === resourceId)).toBe(true);
});

it('C03 records a failing workflow and rejects schema-invalid input without poisoning later runs', async () => {
  const failure = await server.client.getWorkflow('failure').createRun({ resourceId: ids.resource });
  expect((await failure.startAsync({ inputData: { reason: 'test-error' } })).status).toBe('failed');
  expect(await server.client.getWorkflow('failure').runById(failure.runId)).toMatchObject({ status: 'failed' });
  const invalid = await server.client.getWorkflow('approval').createRun({ resourceId: ids.resource });
  await expect(invalid.startAsync({ inputData: { requestId: randomUUID(), amount: -1 } })).rejects.toThrow();
  const valid = await server.client.getWorkflow('approval').createRun({ resourceId: ids.resource });
  expect((await valid.startAsync({ inputData: { requestId: randomUUID(), amount: 1 } })).status).toBe('suspended');
});

it('C04 cancels a suspended workflow and preserves its terminal status after restart', async () => {
  const run = await server.client.getWorkflow('approval').createRun({ resourceId: ids.resource });
  await run.startAsync({ inputData: { requestId: randomUUID(), amount: 2 } });
  await run.cancel();
  await server.restart();
  expect(await server.client.getWorkflow('approval').runById(run.runId)).toMatchObject({ status: 'canceled' });
});
