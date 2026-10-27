import { Agent } from '@mastra/core/agent';
import { createScorer } from '@mastra/core/evals';
import { Mastra } from '@mastra/core/mastra';
import { registerApiRoute } from '@mastra/core/server';
import { Memory } from '@mastra/memory';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { OracleVector } from '@mastra/oracledb';
import { openStore, verifyLease } from '../helpers/database.ts';
import { environment } from '../helpers/environment.ts';
import { liveEnvironment } from '../helpers/live-environment.ts';
import { deterministicEmbedder } from './embeddings.ts';
import { scriptedModel } from './models/scripted-model.ts';
import { observationControls } from './observation-controls.ts';
import { createObservedMemory } from './observed-memory.ts';
import { retrievalTool } from './retrieval.ts';
import { calculator } from './tools.ts';
import { approvalWorkflow, failureWorkflow } from './workflows.ts';

export async function createFixture() {
  const storage = openStore('oracle-application');
  await verifyLease(storage);
  await storage.init(); // Default indexes remain enabled.
  const config = environment();
  const vector = new OracleVector({ id: 'oracle-app-vector', ...config.connection, schemaName: config.schema });
  const identity = Object.fromEntries(
    ['exact', 'upper', 'reader'].map(role => [
      role,
      new OracleVector({
        id: 'identity-' + role,
        ...config.connection,
        schemaName: config.schema,
        registryTableName: 'APP_IDENTITY_REGISTRY',
        tablePrefix: 'APP_' + role.toUpperCase() + '_VEC',
        defaultMetadataIndexes: [],
      }),
    ]),
  );
  let migrationFailureThread: string | undefined;
  const deleteVectors = vector.deleteVectors.bind(vector);
  vector.deleteVectors = async params => {
    if (
      migrationFailureThread &&
      params.filter &&
      'thread_id' in params.filter &&
      params.filter.thread_id === migrationFailureThread
    ) {
      migrationFailureThread = undefined;
      throw new Error('test-only vector migration failure before delete');
    }
    return deleteVectors(params);
  };
  const memory = new Memory({ storage, options: { lastMessages: 20, semanticRecall: false, generateTitle: false } });
  const semanticMemory = new Memory({
    storage,
    vector,
    embedder: deterministicEmbedder,
    options: {
      lastMessages: 1,
      semanticRecall: { topK: 2, messageRange: 0, scope: 'resource', threshold: 0.9 },
      generateTitle: false,
    },
  });
  const workingMemory = new Memory({
    storage,
    options: {
      lastMessages: 0,
      semanticRecall: false,
      generateTitle: false,
      workingMemory: { enabled: true, scope: 'resource', template: 'NOTE: ' },
    },
  });
  const observedMemory = createObservedMemory(storage);
  const observation = await observationControls(observedMemory, storage);
  const retrieve = retrievalTool(vector);
  const score = createScorer({
    id: 'ack-score',
    description: 'Scores ACK responses without a model.',
    type: 'agent',
  }).generateScore(({ run }) => {
    const parts = run.output as { content?: { parts?: { type: string; text?: string }[] } }[];
    return parts.some(message => message.content?.parts?.some(part => part.type === 'text' && part.text === 'ACK'))
      ? 1
      : 0;
  });
  const agent = (id: string, selectedMemory: Memory) =>
    new Agent({
      id,
      name: id,
      instructions: 'Follow the deterministic application test protocol.',
      model: scriptedModel(),
      memory: selectedMemory,
      tools: { calculator, retrieve },
    });
  const history = agent('history', memory);
  const semantic = agent('semantic', semanticMemory);
  const notes = agent('notes', workingMemory);
  const observed = agent('observed', observedMemory);
  const scored = new Agent({
    id: 'scored',
    name: 'scored',
    instructions: 'Follow the deterministic application test protocol.',
    model: scriptedModel(),
    memory,
    scorers: { ack: { scorer: score, sampling: { type: 'ratio', rate: 1 } } },
  });
  const observability = new Observability({
    configs: { default: { serviceName: 'oracle-app-e2e', exporters: [new MastraStorageExporter()] } },
  });
  const live = process.env.ORACLE_APP_PROFILE === 'live' ? liveEnvironment() : undefined;
  const liveAgent = live
    ? new Agent({
        id: 'live',
        name: 'live',
        instructions: 'Follow the user instructions precisely.',
        model: live.model,
        memory,
      })
    : undefined;
  const mastra = new Mastra({
    storage,
    ...(process.env.ORACLE_APP_DELIVERY_PORT
      ? {
          server: {
            host: '127.0.0.1',
            port: Number(process.env.ORACLE_APP_DELIVERY_PORT),
            apiRoutes: [
              registerApiRoute('/_test/ready', {
                method: 'GET',
                handler: async c => c.json({ runId: process.env.ORACLE_APP_RUN_ID, pid: process.pid }),
              }),
              registerApiRoute('/_test/settled', {
                method: 'POST',
                handler: async c => {
                  await Promise.all(
                    [memory, semanticMemory, workingMemory, observedMemory].map(memory => memory.settled()),
                  );
                  await observability.flush();
                  return c.json({ settled: true });
                },
              }),
            ],
          },
        }
      : {}),
    agents: { history, semantic, notes, observed, scored, ...(liveAgent ? { live: liveAgent } : {}) },
    tools: { calculator, retrieve },
    vectors: {
      oracle: vector,
      identityExact: identity.exact!,
      identityUpper: identity.upper!,
      identityReader: identity.reader!,
    },
    workflows: { approval: approvalWorkflow(), failure: failureWorkflow() },
    scorers: { ack: score },
    observability,
  });
  return {
    mastra,
    storage,
    memory,
    memories: [memory, semanticMemory, workingMemory, observedMemory],
    observation,
    vector,
    observability,
    identity,
    allVectors: [vector, ...Object.values(identity)],
    failNextMigration: (threadId: string) => {
      migrationFailureThread = threadId;
    },
  };
}
