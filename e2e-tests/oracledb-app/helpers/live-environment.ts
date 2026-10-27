import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function liveEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const fromFile = env.ORACLE_APP_TEST_ENV ? parseEnv(readFileSync(env.ORACLE_APP_TEST_ENV, 'utf8')) : {};
  const values = { ...fromFile, ...env };
  const model = values.ORACLE_APP_LIVE_MODEL?.trim() ?? '';
  const apiKeyEnv = values.ORACLE_APP_LIVE_API_KEY_ENV?.trim() ?? '';
  if (!/^[a-z][a-z0-9-]*\/[^\s/]+$/.test(model)) {
    throw new Error('Live profile is unconfigured. Set ORACLE_APP_LIVE_MODEL to an approved provider/model.');
  }
  if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(apiKeyEnv) || !values[apiKeyEnv]) {
    throw new Error(
      'Set ORACLE_APP_LIVE_API_KEY_ENV to the name of an approved provider API-key variable and supply its value privately.',
    );
  }
  return { model, apiKeyEnv, apiKey: values[apiKeyEnv]! };
}
