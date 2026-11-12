import type { LiveSettings } from '../../helpers/live-environment.ts';

export async function createLiveModel(settings: LiveSettings) {
  if (settings.provider === 'api-key') return settings.model;
  const { ociModel } = await import('./oci-model.ts');
  return ociModel(settings);
}
