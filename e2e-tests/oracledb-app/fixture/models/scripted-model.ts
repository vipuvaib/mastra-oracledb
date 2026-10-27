import { randomUUID } from 'node:crypto';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider-v5';

function response(options: LanguageModelV2CallOptions): {
  content: LanguageModelV2Content[];
  finishReason: 'stop' | 'tool-calls';
} {
  const lastUserIndex = options.prompt.findLastIndex(message => message.role === 'user');
  const lastUser = options.prompt[lastUserIndex];
  const text =
    lastUser?.role === 'user'
      ? lastUser.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n')
      : '';
  const search = /^SEARCH (app_[a-f0-9]{8}) (ALPHA|BETA|GAMMA) ([a-f0-9-]+)$/.exec(text);
  if (search) {
    const tool = options.prompt.slice(lastUserIndex + 1).find(message => message.role === 'tool');
    const result =
      tool?.role === 'tool'
        ? tool.content.find(part => part.type === 'tool-result' && part.toolName === 'retrieve')
        : undefined;
    if (result?.output.type === 'json') {
      const value = result.output.value as { ids: string[]; texts: string[] };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], finishReason: 'stop' };
    }
    return {
      content: [
        {
          type: 'tool-call',
          toolCallId: randomUUID(),
          toolName: 'retrieve',
          input: JSON.stringify({ indexName: search[1], topic: search[2], tenant: search[3] }),
        },
      ],
      finishReason: 'tool-calls',
    };
  }
  if (text === 'FIND ALPHA FACT') {
    const facts = options.prompt
      .slice(0, lastUserIndex)
      .filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text));
    // Resource-scoped recall arrives in a framework-generated system envelope.
    for (const message of options.prompt) {
      if (message.role === 'system' && message.content.includes('<remembered_from_other_conversation>')) {
        for (const match of message.content.matchAll(/User: ALPHA FACT: ([A-Za-z0-9-]+)/g)) {
          facts.push('ALPHA FACT: ' + match[1]);
        }
      }
    }
    const fact = facts.map(value => /^ALPHA FACT: ([A-Za-z0-9-]+)$/.exec(value)?.[1]).findLast(Boolean);
    return { content: [{ type: 'text', text: fact ? 'FACT=' + fact : 'NO_CONTEXT' }], finishReason: 'stop' };
  }
  if (text === 'READ WORKING NOTE') {
    const note = options.prompt
      .filter(message => message.role === 'system')
      .map(message => /NOTE: ([A-Za-z0-9-]+)/.exec(message.content)?.[1])
      .findLast(Boolean);
    return { content: [{ type: 'text', text: note ? 'NOTE=' + note : 'NO_NOTE' }], finishReason: 'stop' };
  }
  const add = /^ADD (-?\d+) (-?\d+)$/.exec(text);
  if (add) {
    const toolMessage = options.prompt.slice(lastUserIndex + 1).find(message => message.role === 'tool');
    if (toolMessage && typeof toolMessage.content !== 'string') {
      const result = toolMessage.content.find(part => part.type === 'tool-result' && part.toolName === 'calculator');
      if (result && result.output.type === 'json') {
        const value = result.output.value as { result?: number };
        if (typeof value.result !== 'number') throw new Error('Calculator returned no numeric result.');
        return { content: [{ type: 'text', text: `SUM=${value.result}` }], finishReason: 'stop' };
      }
      throw new Error('Expected a real calculator tool result.');
    }
    return {
      content: [
        {
          type: 'tool-call',
          toolCallId: randomUUID(),
          toolName: 'calculator',
          input: JSON.stringify({ a: Number(add[1]), b: Number(add[2]) }),
        },
      ],
      finishReason: 'tool-calls',
    };
  }
  if (text === 'RECALL PROJECT CODE') {
    // Only earlier user context can supply the fact; no expected value is injected.
    const history = options.prompt
      .slice(0, lastUserIndex)
      .filter(message => message.role === 'user')
      .flatMap(message =>
        typeof message.content === 'string'
          ? []
          : message.content.filter(part => part.type === 'text').map(part => part.text),
      );
    const code = history.map(value => /^PROJECT CODE: ([A-Za-z0-9-]+)$/.exec(value)?.[1]).findLast(Boolean);
    return { content: [{ type: 'text', text: code ? `CODE=${code}` : 'NO_CONTEXT' }], finishReason: 'stop' };
  }
  return { content: [{ type: 'text', text: 'ACK' }], finishReason: 'stop' };
}

export function scriptedModel(): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'oracle-e2e',
    modelId: 'oracle-scripted',
    supportedUrls: {},
    doGenerate: async options => ({
      ...response(options),
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      warnings: [],
    }),
    doStream: async options => {
      const answer = response(options);
      const parts: LanguageModelV2StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      for (const part of answer.content) {
        if (part.type === 'text')
          parts.push(
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: part.text },
            { type: 'text-end', id: 'text' },
          );
        else if (part.type === 'tool-call') parts.push(part);
      }
      parts.push({
        type: 'finish',
        finishReason: answer.finishReason,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      });
      return {
        stream: new ReadableStream({
          start(controller) {
            parts.forEach(part => controller.enqueue(part));
            controller.close();
          },
        }),
      };
    },
  };
}
