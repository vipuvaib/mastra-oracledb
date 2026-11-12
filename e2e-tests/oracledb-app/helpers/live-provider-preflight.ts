import { pathToFileURL } from 'node:url';
import { ociModel } from '../fixture/models/oci-model.ts';
import type { OciLiveSettings } from './live-environment.ts';
import { liveEnvironment } from './live-environment.ts';

export async function checkOciProvider(settings: OciLiveSettings) {
  const model = await ociModel(settings);
  const result = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly ORACLE_LIVE_READY.' }] }],
  });
  const text = result.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('')
    .trim();
  if (text !== 'ORACLE_LIVE_READY') throw new Error('OCI readiness response did not match the requested marker.');
  return {
    provider: 'oci',
    model: settings.model,
    modelId: settings.modelId,
    endpoint: settings.endpoint,
    returnedModelId: result.response?.modelId,
    checkedAt: new Date().toISOString(),
    usage: result.usage,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const settings = liveEnvironment();
  if (settings.provider !== 'oci') throw new Error('This connectivity check requires the OCI live configuration.');
  console.log(JSON.stringify(await checkOciProvider(settings), null, 2));
}
