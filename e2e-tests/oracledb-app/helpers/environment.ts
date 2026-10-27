import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function environment(env: NodeJS.ProcessEnv = process.env) {
  // Deliberately do not fall back to the adapter's .env or a shared schema.
  const fromFile = env.ORACLE_APP_TEST_ENV ? parseEnv(readFileSync(env.ORACLE_APP_TEST_ENV, 'utf8')) : {};
  const values = { ...fromFile, ...env };
  const required = [
    'ORACLE_DATABASE_USER',
    'ORACLE_DATABASE_PASSWORD',
    'ORACLE_DATABASE_CONNECT_STRING',
    'ORACLE_APP_TEST_SCHEMA',
  ] as const;
  for (const key of required) {
    if (!values[key])
      throw new Error(`Missing ${key}. Set ORACLE_APP_TEST_ENV to a private env file for a dedicated empty schema.`);
  }
  const schema = values.ORACLE_APP_TEST_SCHEMA!;
  if (!/^[A-Z][A-Z0-9_]{0,29}$/.test(schema) || ['SYS', 'SYSTEM', 'PDBADMIN'].includes(schema)) {
    throw new Error('ORACLE_APP_TEST_SCHEMA must be a non-system uppercase Oracle identifier (max 30 characters).');
  }
  if (values.ORACLE_DATABASE_USER!.toUpperCase() !== schema)
    throw new Error('Connect as the dedicated test-schema owner.');
  return {
    schema,
    connection: {
      user: values.ORACLE_DATABASE_USER!,
      password: values.ORACLE_DATABASE_PASSWORD!,
      connectString: values.ORACLE_DATABASE_CONNECT_STRING!,
      poolMin: 0,
      poolMax: 4,
    },
  };
}
