import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider-v5';
import type { models } from 'oci-generativeaiinference';
import { z } from 'zod';
import type { OciLiveSettings } from '../../helpers/live-environment.ts';

const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});
const callSchema = z.object({
  id: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  type: z.literal('FUNCTION').optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
});
const choiceSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  message: z
    .object({
      role: z.string().optional(),
      content: z
        .array(z.object({ type: z.literal('TEXT'), text: z.string().optional() }))
        .nullable()
        .optional(),
      toolCalls: z.array(callSchema).optional(),
    })
    .optional(),
  finishReason: z.string().nullable().optional(),
  usage: usageSchema.optional(),
});
const responseSchema = z.object({ choices: z.array(choiceSchema).min(1), usage: usageSchema.optional() });
type Usage = z.infer<typeof usageSchema>;

function usage(value?: Usage) {
  return { inputTokens: value?.promptTokens, outputTokens: value?.completionTokens, totalTokens: value?.totalTokens };
}
function finishReason(value?: string | null, calls = false): LanguageModelV2FinishReason {
  if (calls) return 'tool-calls';
  switch (value?.toLowerCase()) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool-calls':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'unknown';
  }
}
function messages(options: LanguageModelV2CallOptions): models.Message[] {
  return options.prompt.flatMap((message): models.Message[] => {
    if (message.role === 'system')
      return [{ role: 'SYSTEM', content: [{ type: 'TEXT', text: message.content } as models.TextContent] }];
    if (message.role === 'tool')
      return message.content.map(part => {
        if (part.type !== 'tool-result' || !['text', 'json', 'error-text', 'error-json'].includes(part.output.type))
          throw new Error('OCI live harness supports text/JSON tool results only.');
        const output = part.output;
        const text =
          output.type === 'text' || output.type === 'error-text'
            ? output.value
            : JSON.stringify('value' in output ? output.value : undefined);
        return {
          role: 'TOOL',
          toolCallId: part.toolCallId,
          content: [{ type: 'TEXT', text } as models.TextContent],
        } as models.ToolMessage;
      });
    const content: models.TextContent[] = [];
    const toolCalls: models.FunctionCall[] = [];
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'TEXT', text: part.text });
      else if (message.role === 'assistant' && part.type === 'tool-call')
        toolCalls.push({
          type: 'FUNCTION',
          id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input),
        });
      else if (part.type !== 'reasoning')
        throw new Error('OCI live harness supports text messages and function calls only.');
    }
    return [
      {
        role: message.role === 'user' ? 'USER' : 'ASSISTANT',
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
      } as models.AssistantMessage,
    ];
  });
}
function request(
  settings: OciLiveSettings,
  options: LanguageModelV2CallOptions,
  stream: boolean,
): models.GenericChatRequest {
  if (options.responseFormat?.type === 'json')
    throw new Error('Structured output is outside the OCI live harness coverage.');
  return {
    apiFormat: 'GENERIC',
    messages: messages(options),
    isStream: stream,
    ...(stream ? { streamOptions: { isIncludeUsage: true } } : {}),
    maxTokens: Math.min(options.maxOutputTokens ?? settings.maxTokens, settings.maxTokens),
    temperature: options.temperature ?? settings.temperature,
    topP: options.topP ?? 1,
    topK: options.topK ?? 0,
    frequencyPenalty: options.frequencyPenalty ?? 0,
    presencePenalty: options.presencePenalty ?? 0,
    stop: options.stopSequences,
    isParallelToolCalls: false,
    ...(options.tools?.length
      ? {
          tools: options.tools.map(tool => {
            if (tool.type !== 'function') throw new Error('OCI live harness supports function tools only.');
            return {
              type: 'FUNCTION',
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            } as models.FunctionDefinition;
          }),
        }
      : {}),
    ...(options.toolChoice
      ? {
          toolChoice: {
            type: options.toolChoice.type.toUpperCase(),
            ...(options.toolChoice.type === 'tool' ? { type: 'FUNCTION', name: options.toolChoice.toolName } : {}),
          },
        }
      : {}),
  };
}

// OCI sends ChatChoice objects as SSE data; decoding must survive split UTF-8 and CRLF frames.
async function* events(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (done) {
        if (buffer.trim()) {
          const data = buffer
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
          if (data) yield data;
        }
        return;
      }
      if (buffer.length > 1_048_576) throw new Error('OCI stream frame exceeded the harness limit.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function ociModel(settings: OciLiveSettings): Promise<LanguageModelV2> {
  // Lazy SDK imports keep deterministic and installed-package fixtures independent of OCI authentication.
  const [{ GenerativeAiInferenceClient }, common] = await Promise.all([
    import('oci-generativeaiinference'),
    import('oci-common'),
  ]);
  const path = settings.configFile.startsWith('~/')
    ? join(homedir(), settings.configFile.slice(2))
    : settings.configFile;
  const authentication = () =>
    settings.auth === 'session'
      ? new common.SessionAuthDetailProvider(path, settings.profile)
      : new common.ConfigFileAuthenticationDetailsProvider(path, settings.profile);
  // Check local configuration before a runner claims the database schema. No inference request is sent here.
  authentication().getPrivateKey();

  async function call(options: LanguageModelV2CallOptions, stream: boolean) {
    const cancellation = new AbortController();
    const signal = AbortSignal.any([
      cancellation.signal,
      AbortSignal.timeout(settings.timeoutMs),
      ...(options.abortSignal ? [options.abortSignal] : []),
    ]);
    signal.throwIfAborted();
    const chatRequest = request(settings, options, stream);
    const client = new GenerativeAiInferenceClient(
      { authenticationDetailsProvider: authentication() },
      { retryConfiguration: common.NoRetryConfigurationDetails, httpOptions: { signal, redirect: 'error' } },
    );
    client.endpoint = settings.endpoint;
    try {
      const response = await client.chat({
        chatDetails: {
          compartmentId: settings.compartmentId,
          servingMode: { servingType: 'ON_DEMAND', modelId: settings.modelId },
          chatRequest,
        },
        retryConfiguration: common.NoRetryConfigurationDetails,
      });
      return { response, close: () => client.close(), abort: () => cancellation.abort() };
    } catch (error) {
      client.close();
      signal.throwIfAborted();
      throw error;
    }
  }

  return {
    specificationVersion: 'v2',
    provider: 'oci',
    modelId: settings.modelId,
    supportedUrls: {},
    async doGenerate(options) {
      const { response, close } = await call(options, false);
      try {
        if (!response || !('chatResult' in response)) throw new Error('Expected an OCI JSON chat response.');
        const parsed = responseSchema.safeParse(response.chatResult.chatResponse);
        if (!parsed.success) throw new Error('OCI returned an invalid GENERIC chat response.');
        const first = parsed.data.choices[0]!;
        if (!first.message) throw new Error('OCI returned no assistant message.');
        const content: LanguageModelV2Content[] = (first.message.content ?? []).map(part => ({
          type: 'text',
          text: part.text ?? '',
        }));
        for (const tool of first.message.toolCalls ?? []) {
          if (!tool.id || !tool.name || tool.arguments === undefined)
            throw new Error('OCI returned an incomplete function call.');
          content.push({ type: 'tool-call', toolCallId: tool.id, toolName: tool.name, input: tool.arguments });
        }
        if (!content.length) throw new Error('OCI returned no assistant text or function call.');
        return {
          content,
          finishReason: finishReason(first.finishReason, !!first.message.toolCalls?.length),
          usage: usage(parsed.data.usage ?? first.usage),
          warnings: [],
          response: { id: response.opcRequestId, modelId: response.chatResult.modelId },
        };
      } finally {
        close();
      }
    },
    async doStream(options) {
      const { response, close, abort } = await call(options, true);
      if (!response || !('getReader' in response)) {
        close();
        throw new Error('Expected OCI server-sent events.');
      }
      const source = response;
      async function* parts(): AsyncGenerator<LanguageModelV2StreamPart> {
        let textStarted = false,
          completed = false;
        let reason: string | null | undefined;
        let tokens: Usage | undefined;
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        try {
          yield { type: 'stream-start', warnings: [] };
          for await (const data of events(source)) {
            if (data.trim() === '[DONE]') {
              completed = true;
              break;
            }
            const parsed = choiceSchema.safeParse(JSON.parse(data));
            if (!parsed.success) throw new Error('OCI returned an invalid stream event.');
            const chunk = parsed.data;
            if (chunk.index !== undefined && chunk.index !== 0)
              throw new Error('OCI returned multiple stream choices.');
            if (chunk.usage) tokens = chunk.usage;
            for (const text of chunk.message?.content ?? [])
              if (text.text) {
                if (!textStarted) {
                  yield { type: 'text-start', id: 'text' };
                  textStarted = true;
                }
                yield { type: 'text-delta', id: 'text', delta: text.text };
              }
            for (const [index, tool] of (chunk.message?.toolCalls ?? []).entries()) {
              const slot = tool.index ?? index;
              const current = calls.get(slot) ?? { id: '', name: '', arguments: '' };
              if (tool.id) current.id = tool.id;
              if (tool.name) current.name = tool.name;
              if (tool.arguments) current.arguments += tool.arguments;
              calls.set(slot, current);
            }
            if (chunk.finishReason) {
              reason = chunk.finishReason;
              completed = true;
            }
          }
          if (!completed) throw new Error('OCI stream ended before its completion marker.');
          if (textStarted) yield { type: 'text-end', id: 'text' };
          for (const tool of calls.values()) {
            if (!tool.id || !tool.name || !tool.arguments)
              throw new Error('OCI stream returned an incomplete function call.');
            yield { type: 'tool-call', toolCallId: tool.id, toolName: tool.name, input: tool.arguments };
          }
          yield { type: 'finish', finishReason: finishReason(reason ?? 'stop', calls.size > 0), usage: usage(tokens) };
        } finally {
          close();
        }
      }
      const iterator = parts();
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            abort();
            try {
              await iterator.return(undefined);
            } finally {
              close();
            }
          },
        }),
      };
    },
  };
}
