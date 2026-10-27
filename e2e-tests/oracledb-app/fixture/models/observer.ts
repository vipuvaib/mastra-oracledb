import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider-v5';

export function observationsFromPrompt(options: LanguageModelV2CallOptions): string {
  const text = options.prompt
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
    .join('\n');
  const codes = [...new Set([...text.matchAll(/OBSERVE CODE: ([a-f0-9-]{36})/g)].map(match => match[1]!))];
  if (!codes.length) throw new Error('Observer fixture received no actual user observation code.');
  return '<observations>\n' + codes.map(code => '* OBSERVED CODE: ' + code).join('\n') + '\n</observations>';
}
export function observerModel(): LanguageModelV2 {
  return {
    specificationVersion: 'v2',
    provider: 'oracle-e2e',
    modelId: 'deterministic-observer',
    supportedUrls: {},
    doGenerate: async options => ({
      content: [{ type: 'text', text: observationsFromPrompt(options) }],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      warnings: [],
    }),
    doStream: async options => {
      const parts: LanguageModelV2StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'observation' },
        { type: 'text-delta', id: 'observation', delta: observationsFromPrompt(options) },
        { type: 'text-end', id: 'observation' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
      ];
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
