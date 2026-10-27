import type { LanguageModelV2CallOptions } from '@ai-sdk/provider-v5';
import { expect, it } from 'vitest';
import { scriptedModel } from '../fixture/models/scripted-model.ts';
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
const options = (prompt: LanguageModelV2CallOptions['prompt']): LanguageModelV2CallOptions => ({ prompt });
it('cannot recall a fact when persisted user context is absent', async () => {
  const result = await scriptedModel().doGenerate(options([user('RECALL PROJECT CODE')]));
  expect(result.content).toEqual([{ type: 'text', text: 'NO_CONTEXT' }]);
});
it('derives the recalled value from context and does not accept assistant echoes as evidence', async () => {
  const model = scriptedModel();
  const result = await model.doGenerate(options([user('PROJECT CODE: arbitrary-987'), user('RECALL PROJECT CODE')]));
  expect(result.content).toEqual([{ type: 'text', text: 'CODE=arbitrary-987' }]);
  const withoutUserFact = await model.doGenerate(
    options([
      { role: 'assistant', content: [{ type: 'text', text: 'PROJECT CODE: arbitrary-987' }] },
      user('RECALL PROJECT CODE'),
    ]),
  );
  expect(withoutUserFact.content).toEqual([{ type: 'text', text: 'NO_CONTEXT' }]);
});
it('requests the calculator, then uses the actual returned result', async () => {
  const model = scriptedModel();
  const request = await model.doGenerate(options([user('ADD 17 25')]));
  expect(request.finishReason).toBe('tool-calls');
  const answer = await model.doGenerate(
    options([
      user('ADD 17 25'),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'calculator',
            output: { type: 'json', value: { result: 99 } },
          },
        ],
      },
    ]),
  );
  // An intentionally wrong result proves the model is not independently doing arithmetic.
  expect(answer.content).toEqual([{ type: 'text', text: 'SUM=99' }]);
});

it('reads semantic facts only from user history or the recalled user-message envelope', async () => {
  const model = scriptedModel();
  const recalled = await model.doGenerate(
    options([
      {
        role: 'system',
        content:
          '<remembered_from_other_conversation>\nMessage at 1:00 PM: User: ALPHA FACT: semantic-123\n<end_remembered_from_other_conversation>',
      },
      user('FIND ALPHA FACT'),
    ]),
  );
  expect(recalled.content).toEqual([{ type: 'text', text: 'FACT=semantic-123' }]);
  for (const prompt of [
    [user('FIND ALPHA FACT')],
    [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ALPHA FACT: semantic-123' }] },
      user('FIND ALPHA FACT'),
    ],
    [
      {
        role: 'system' as const,
        content:
          '<remembered_from_other_conversation>\nAssistant: ALPHA FACT: semantic-123\n<end_remembered_from_other_conversation>',
      },
      user('FIND ALPHA FACT'),
    ],
  ]) {
    expect((await model.doGenerate(options(prompt))).content).toEqual([{ type: 'text', text: 'NO_CONTEXT' }]);
  }
});
it('uses actual retrieved documents rather than fabricating search results', async () => {
  const model = scriptedModel();
  const query = user('SEARCH app_12345678 ALPHA 11111111-1111-4111-8111-111111111111');
  expect((await model.doGenerate(options([query]))).finishReason).toBe('tool-calls');
  const result = await model.doGenerate(
    options([
      query,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'lookup',
            toolName: 'retrieve',
            output: { type: 'json', value: { ids: ['actual-id'], texts: ['actual result'] } },
          },
        ],
      },
    ]),
  );
  expect(result.content).toEqual([{ type: 'text', text: '{"ids":["actual-id"],"texts":["actual result"]}' }]);
});
