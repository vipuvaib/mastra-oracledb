import { expect, it } from 'vitest';
import { environment } from '../helpers/environment.ts';
const base = {
  ORACLE_DATABASE_USER: 'APP_E2E',
  ORACLE_DATABASE_PASSWORD: 'unit-only',
  ORACLE_DATABASE_CONNECT_STRING: 'localhost/test',
  ORACLE_APP_TEST_SCHEMA: 'APP_E2E',
};
it('refuses missing configuration rather than using the adapter database', () => {
  expect(() => environment({})).toThrow('Missing ORACLE_DATABASE_USER');
});
it('refuses cross-schema access and privileged owners', () => {
  expect(() => environment({ ...base, ORACLE_APP_TEST_SCHEMA: 'OTHER' })).toThrow('owner');
  expect(() => environment({ ...base, ORACLE_DATABASE_USER: 'SYS', ORACLE_APP_TEST_SCHEMA: 'SYS' })).toThrow(
    'non-system',
  );
});
