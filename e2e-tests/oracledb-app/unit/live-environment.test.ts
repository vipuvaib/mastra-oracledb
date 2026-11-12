import { expect, it } from 'vitest';
import { liveEnvironment } from '../helpers/live-environment.ts';

const configured = {
  ORACLE_APP_LIVE_PROVIDER: 'oci',
  ORACLE_APP_LIVE_MODEL: 'oci/openai.gpt-oss-120b',
  ORACLE_APP_OCI_CONFIG_FILE: '/private/oci/config',
  ORACLE_APP_OCI_PROFILE: 'APP_TEST',
  ORACLE_APP_OCI_AUTH: 'session',
  ORACLE_APP_OCI_ENDPOINT: 'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com',
  ORACLE_APP_OCI_COMPARTMENT_ID: 'ocid1.compartment.oc1..test',
  ORACLE_APP_OCI_MODEL_ID: 'ocid1.generativeaimodel.oc1.us-chicago-1.test',
};
it('accepts OCI IAM authentication without requiring a provider API key', () => {
  expect(liveEnvironment(configured)).toMatchObject({
    provider: 'oci',
    profile: 'APP_TEST',
    auth: 'session',
    maxTokens: 2048,
    temperature: 0,
  });
  expect(liveEnvironment({ ...configured, ORACLE_APP_OCI_AUTH: 'config' })).toMatchObject({ auth: 'config' });
});
it('rejects incomplete OCI settings and unknown authentication instead of falling back to another provider', () => {
  for (const key of [
    'ORACLE_APP_OCI_CONFIG_FILE',
    'ORACLE_APP_OCI_PROFILE',
    'ORACLE_APP_OCI_AUTH',
    'ORACLE_APP_OCI_ENDPOINT',
    'ORACLE_APP_OCI_COMPARTMENT_ID',
    'ORACLE_APP_OCI_MODEL_ID',
  ]) {
    expect(() => liveEnvironment({ ...configured, [key]: '' })).toThrow('Invalid OCI');
  }
  expect(() => liveEnvironment({ ...configured, ORACLE_APP_OCI_AUTH: 'auto' })).toThrow('auth');
});
it('rejects non-OCI endpoints, cross-region models and invalid generation bounds before inference', () => {
  for (const endpoint of [
    'http://inference.generativeai.us-chicago-1.oci.oraclecloud.com',
    'https://example.com',
    'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com.evil.invalid',
    'https://inference.generativeai.us-ashburn-1.oci.oraclecloud.com',
  ]) {
    expect(() => liveEnvironment({ ...configured, ORACLE_APP_OCI_ENDPOINT: endpoint })).toThrow('endpoint');
  }
  for (const value of ['0', '1.5', '4097', 'NaN'])
    expect(() => liveEnvironment({ ...configured, ORACLE_APP_OCI_MAX_TOKENS: value })).toThrow('maxTokens');
  expect(() => liveEnvironment({ ...configured, ORACLE_APP_OCI_TIMEOUT_MS: '0' })).toThrow('timeoutMs');
});
