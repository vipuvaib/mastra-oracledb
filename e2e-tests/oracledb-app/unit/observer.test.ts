import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { observationsFromPrompt } from '../fixture/models/observer.ts';
it('distills actual user codes and cannot accept an assistant-only echo', () => {
  const code = randomUUID();
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'OBSERVE CODE: ' + code }] };
  expect(observationsFromPrompt({ prompt: [user, user] }).match(/OBSERVED CODE:/g)).toHaveLength(1);
  expect(observationsFromPrompt({ prompt: [user] })).toContain(code);
  expect(() => observationsFromPrompt({ prompt: [{ role: 'assistant', content: user.content }] })).toThrow(
    'no actual user',
  );
});
