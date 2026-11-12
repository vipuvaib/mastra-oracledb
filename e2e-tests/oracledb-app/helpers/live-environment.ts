import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const modelName = z.string().regex(/^[a-z][a-z0-9-]*\/[^\s/]+$/);
const ociSettings = z
  .object({
    provider: z.literal('oci'),
    model: modelName.refine(value => value.startsWith('oci/')),
    configFile: z.string().min(1),
    profile: z.string().min(1),
    auth: z.enum(['session', 'config']),
    endpoint: z.string().regex(/^https:\/\/inference\.generativeai\.[a-z0-9-]+\.oci\.oraclecloud\.com\/?$/),
    compartmentId: z.string().regex(/^ocid1\.(compartment|tenancy)\.oc1\.\.[a-z0-9]+$/),
    modelId: z.string().regex(/^ocid1\.generativeaimodel\.oc1\.[a-z0-9-]+\.[a-z0-9]+$/),
    maxTokens: z.coerce.number().int().min(1).max(4096).default(2048),
    temperature: z.coerce.number().min(0).max(2).default(0),
    timeoutMs: z.coerce.number().int().min(1000).max(120_000).default(60_000),
  })
  .superRefine((value, context) => {
    const region = value.modelId.split('.')[3];
    if (URL.canParse(value.endpoint) && new URL(value.endpoint).hostname.split('.')[2] !== region)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'Model and endpoint regions must match.',
      });
  });
export type OciLiveSettings = z.infer<typeof ociSettings>;

export function liveEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const read = (path?: string) => (path ? parseEnv(readFileSync(path, 'utf8')) : {});
  const values = { ...read(env.ORACLE_APP_TEST_ENV), ...read(env.ORACLE_APP_LIVE_ENV), ...env };
  const model = values.ORACLE_APP_LIVE_MODEL?.trim() ?? '';
  if (!modelName.safeParse(model).success)
    throw new Error('Live profile is unconfigured. Set ORACLE_APP_LIVE_MODEL to an approved provider/model.');
  if (values.ORACLE_APP_LIVE_PROVIDER === 'oci') {
    const parsed = ociSettings.safeParse({
      provider: 'oci',
      model,
      configFile: values.ORACLE_APP_OCI_CONFIG_FILE?.trim(),
      profile: values.ORACLE_APP_OCI_PROFILE?.trim(),
      auth: values.ORACLE_APP_OCI_AUTH?.trim(),
      endpoint: values.ORACLE_APP_OCI_ENDPOINT?.trim(),
      compartmentId: values.ORACLE_APP_OCI_COMPARTMENT_ID?.trim(),
      modelId: values.ORACLE_APP_OCI_MODEL_ID?.trim(),
      maxTokens: values.ORACLE_APP_OCI_MAX_TOKENS,
      temperature: values.ORACLE_APP_OCI_TEMPERATURE,
      timeoutMs: values.ORACLE_APP_OCI_TIMEOUT_MS,
    });
    if (!parsed.success)
      throw new Error(
        'Invalid OCI live configuration: ' +
          [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))].join(', '),
      );
    return parsed.data;
  }
  if (values.ORACLE_APP_LIVE_PROVIDER && values.ORACLE_APP_LIVE_PROVIDER !== 'api-key')
    throw new Error('ORACLE_APP_LIVE_PROVIDER must be api-key or oci.');
  const apiKeyEnv = values.ORACLE_APP_LIVE_API_KEY_ENV?.trim() ?? '';
  if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(apiKeyEnv) || !values[apiKeyEnv])
    throw new Error(
      'Set ORACLE_APP_LIVE_API_KEY_ENV to the name of an approved provider API-key variable and supply its value privately.',
    );
  return { provider: 'api-key' as const, model, apiKeyEnv, apiKey: values[apiKeyEnv]! };
}
export type LiveSettings = ReturnType<typeof liveEnvironment>;
