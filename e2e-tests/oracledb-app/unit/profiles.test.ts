import { expect, it } from 'vitest';
import { liveEnvironment } from '../helpers/live-environment.ts';
import { acceptance, validateCoverage } from '../helpers/profiles.ts';

it('fails missing, skipped, failed and duplicate mandatory scenarios', () => {
  const complete = acceptance.smoke.map(id => ({ fullName: `${id} test`, status: 'passed' }));
  expect(() => validateCoverage('smoke', complete)).not.toThrow();
  expect(() => validateCoverage('smoke', complete.slice(1))).toThrow('A01');
  for (const status of ['pending', 'failed']) {
    expect(() => validateCoverage('smoke', [{ ...complete[0]!, status }, ...complete.slice(1)])).toThrow('A01');
  }
  expect(() => validateCoverage('smoke', [...complete, complete[0]!])).toThrow('A01');
});
it('requires explicit live-provider settings without defaults', () => {
  expect(() => liveEnvironment({})).toThrow('unconfigured');
  expect(() => liveEnvironment({ ORACLE_APP_LIVE_MODEL: 'approved/model' })).toThrow('API');
  expect(
    liveEnvironment({
      ORACLE_APP_LIVE_MODEL: 'approved/model',
      ORACLE_APP_LIVE_API_KEY_ENV: 'APPROVED_API_KEY',
      APPROVED_API_KEY: 'unit-only',
    }),
  ).toMatchObject({ model: 'approved/model', apiKeyEnv: 'APPROVED_API_KEY' });
});

it('requires all recovery, approximate recall and soak cases in addition to the application suite', () => {
  const complete = acceptance.certification.map(id => ({ fullName: id + ' scenario', status: 'passed' }));
  expect(acceptance.certification).toHaveLength(38);
  expect(() => validateCoverage('certification', complete)).not.toThrow();
  for (const id of ['Q01', 'Q02', 'R01', 'R02', 'S01']) {
    expect(() =>
      validateCoverage(
        'certification',
        complete.filter(test => !test.fullName.startsWith(id)),
      ),
    ).toThrow(id);
  }
});
