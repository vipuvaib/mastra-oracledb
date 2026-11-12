import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider-v5';
import { Agent } from '@mastra/core/agent';
import { afterAll, expect, it } from 'vitest';
import { z } from 'zod';
import { ociModel } from '../fixture/models/oci-model.ts';
import { calculator } from '../fixture/tools.ts';

const directory = mkdtempSync(join(tmpdir(), 'oracle-model-wire-'));
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'pem',
  type: 'pkcs8',
});
writeFileSync(join(directory, 'key.pem'), privateKey, { mode: 0o600 });
writeFileSync(
  join(directory, 'config'),
  [
    '[DEFAULT]',
    'tenancy=ocid1.tenancy.oc1..wiretest',
    'user=ocid1.user.oc1..wiretest',
    'fingerprint=11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00',
    'key_file=' + join(directory, 'key.pem'),
    'region=us-chicago-1',
  ].join('\n'),
  { mode: 0o600 },
);
const token = [
  Buffer.from('{"alg":"RS256"}').toString('base64url'),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  'wire-signature',
].join('.');
writeFileSync(join(directory, 'token'), token, { mode: 0o600 });
writeFileSync(
  join(directory, 'session-config'),
  readFileSync(join(directory, 'config'), 'utf8') + '\nsecurity_token_file=' + join(directory, 'token'),
  { mode: 0o600 },
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const options: LanguageModelV2CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply exactly ORACLE_OK.' }] }],
};
const usage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
const json = (response: ServerResponse, message: object, finishReason = 'stop') => {
  response.writeHead(200, { 'content-type': 'application/json', 'opc-request-id': 'wire-request' });
  response.end(
    JSON.stringify({
      modelId: 'wire-model',
      modelVersion: '1',
      chatResponse: {
        apiFormat: 'GENERIC',
        timeCreated: new Date().toISOString(),
        usage,
        choices: [{ index: 0, message, finishReason }],
      },
    }),
  );
};
const wireBody = z.object({
  chatRequest: z.object({
    apiFormat: z.literal('GENERIC'),
    isStream: z.boolean(),
    messages: z.array(
      z.object({
        role: z.string(),
        toolCallId: z.string().optional(),
        content: z.array(z.object({ type: z.literal('TEXT'), text: z.string() })),
      }),
    ),
    tools: z.array(z.object({ name: z.string() })).optional(),
  }),
});
async function wire<T>(
  handler: (request: IncomingMessage, response: ServerResponse, body: z.infer<typeof wireBody>) => void | Promise<void>,
  run: (model: Awaited<ReturnType<typeof ociModel>>) => Promise<T>,
  auth: 'session' | 'config' = 'config',
) {
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      await handler(request, response, wireBody.parse(JSON.parse(body)));
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end('Wire verification failed.');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No wire-test address.');
  try {
    const model = await ociModel({
      provider: 'oci',
      model: 'oci/openai.gpt-oss-120b',
      configFile: join(directory, auth === 'session' ? 'session-config' : 'config'),
      profile: 'DEFAULT',
      auth,
      endpoint: 'http://127.0.0.1:' + address.port,
      compartmentId: 'ocid1.compartment.oc1..wiretest',
      modelId: 'ocid1.generativeaimodel.oc1.us-chicago-1.wiretest',
      maxTokens: 2048,
      temperature: 0,
      timeoutMs: 5000,
    });
    const value = await run(model);
    expect(errors).toEqual([]);
    return value;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}
async function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const result: LanguageModelV2StreamPart[] = [];
  for await (const part of stream) result.push(part);
  return result;
}
it('runs a real Mastra calculator round trip through signed OCI HTTP requests', async () => {
  let calls = 0;
  await wire(
    (req, res, body) => {
      calls++;
      expect(req.url).toBe('/20231130/actions/chat');
      expect(req.headers.authorization).toMatch(/^Signature /);
      expect(body.chatRequest.apiFormat).toBe('GENERIC');
      const result = body.chatRequest.messages.find((message: { role: string }) => message.role === 'TOOL');
      if (result) {
        expect(result.toolCallId).toBe('calculator-42');
        expect(JSON.parse(result.content[0]!.text)).toEqual({ result: 42 });
        json(res, { role: 'ASSISTANT', content: [{ type: 'TEXT', text: 'SUM=42' }] });
      } else {
        expect(body.chatRequest.tools![0]!.name).toBe('calculator');
        json(
          res,
          {
            role: 'ASSISTANT',
            content: [],
            toolCalls: [{ type: 'FUNCTION', id: 'calculator-42', name: 'calculator', arguments: '{"a":17,"b":25}' }],
          },
          'tool_calls',
        );
      }
    },
    async model => {
      const agent = new Agent({
        id: 'oci-wire',
        name: 'OCI wire',
        instructions: 'Use the calculator.',
        model,
        tools: { calculator },
      });
      const result = await agent.generate('Add 17 and 25 using the calculator.');
      expect(result.text).toBe('SUM=42');
      expect(result.usage.totalTokens).toBe(36);
    },
  );
  expect(calls).toBe(2);
});
it('streams actual SSE text and usage without losing UTF-8 or treating reasoning as the answer', async () => {
  await wire(
    async (_req, res, body) => {
      expect(body.chatRequest.isStream).toBe(true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const data = [
        { index: 0, message: { role: 'ASSISTANT', reasoningContent: 'internal' } },
        { index: 0, message: { role: 'ASSISTANT', content: [{ type: 'TEXT', text: 'Hello ' }] } },
        { index: 0, message: { role: 'ASSISTANT', content: [{ type: 'TEXT', text: 'β' }] } },
        { index: 0, finishReason: 'stop', usage },
      ]
        .map(value => 'data: ' + JSON.stringify(value) + '\r\n\r\n')
        .join('');
      const bytes = Buffer.from(data);
      const split = bytes.indexOf(Buffer.from('β')) + 1;
      res.write(bytes.subarray(0, split));
      await new Promise<void>(resolve => setImmediate(resolve));
      res.end(bytes.subarray(split));
    },
    async model => {
      const parts = await collect((await model.doStream(options)).stream);
      expect(
        parts
          .filter(part => part.type === 'text-delta')
          .map(part => part.delta)
          .join(''),
      ).toBe('Hello β');
      expect(parts.filter(part => part.type === 'finish')).toEqual([
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } },
      ]);
    },
  );
});
it('fails a truncated OCI stream instead of reporting a completed response', async () => {
  await wire(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"index":0,"message":{"content":[{"type":"TEXT","text":"partial"}]}}\n\n');
    },
    async model => {
      await expect(collect((await model.doStream(options)).stream)).rejects.toThrow('completion marker');
    },
  );
});
it('propagates OCI authorization failure without retrying', async () => {
  let calls = 0;
  await wire(
    (_req, res) => {
      calls++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NotAuthenticated', message: 'Wire authorization failure.' }));
    },
    async model => {
      await expect(model.doGenerate(options)).rejects.toMatchObject({ statusCode: 401 });
    },
  );
  expect(calls).toBe(1);
});
it('cancels an in-flight signed inference request when the caller aborts', async () => {
  let receive!: () => void;
  const arrived = new Promise<void>(resolve => {
    receive = resolve;
  });
  await wire(
    () => {
      receive();
    },
    async model => {
      const controller = new AbortController();
      const pending = model.doGenerate({ ...options, abortSignal: controller.signal });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await arrived;
      controller.abort();
      await rejection;
    },
  );
});

it('uses OCI session-token signing without requiring a provider API key', async () => {
  await wire(
    (req, res) => {
      expect(req.headers.authorization).toContain('keyId="ST$');
      json(res, { role: 'ASSISTANT', content: [{ type: 'TEXT', text: 'ORACLE_OK' }] });
    },
    async model => {
      const result = await model.doGenerate(options);
      expect(result.content).toEqual([{ type: 'text', text: 'ORACLE_OK' }]);
      expect(result.usage.totalTokens).toBe(18);
    },
    'session',
  );
});
it('executes a real calculator during a streamed Mastra tool round trip', async () => {
  let calls = 0;
  await wire(
    (_req, res, body) => {
      calls++;
      expect(body.chatRequest.isStream).toBe(true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const result = body.chatRequest.messages.find(message => message.role === 'TOOL');
      const chunks = result
        ? [
            { index: 0, message: { content: [{ type: 'TEXT', text: 'SUM=42' }] } },
            { index: 0, finishReason: 'stop', usage },
          ]
        : [
            {
              index: 0,
              message: {
                toolCalls: [{ index: 0, type: 'FUNCTION', id: 'stream-42', name: 'calculator', arguments: '{"a":17,' }],
              },
            },
            { index: 0, message: { toolCalls: [{ index: 0, arguments: '"b":25}' }] } },
            { index: 0, finishReason: 'tool_calls', usage },
          ];
      if (result) expect(JSON.parse(result.content[0]!.text)).toEqual({ result: 42 });
      res.end(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join(''));
    },
    async model => {
      const agent = new Agent({
        id: 'oci-stream-wire',
        name: 'OCI stream wire',
        instructions: 'Use the calculator.',
        model,
        tools: { calculator },
      });
      const output = await agent.stream('Add 17 and 25 using the calculator.');
      let text = '';
      for await (const chunk of output.textStream) text += chunk;
      expect(text).toBe('SUM=42');
    },
  );
  expect(calls).toBe(2);
});
it('cancels an open OCI SSE connection when its consumer stops reading', async () => {
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => {
    disconnected = resolve;
  });
  await wire(
    (_req, res) => {
      res.once('close', disconnected);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"index":0,"message":{"content":[{"type":"TEXT","text":"first"}]}}\n\n');
    },
    async model => {
      const reader = (await model.doStream(options)).stream.getReader();
      expect((await reader.read()).value?.type).toBe('stream-start');
      await reader.cancel();
      await closed;
    },
  );
});
