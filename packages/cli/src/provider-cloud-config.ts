import type { SecretVault } from '@wrongstack/contracts/types';
import {
  cloudFieldsForProvider,
  type NativeCloudSettings,
  parseNativeCloudSettings,
} from '@wrongstack/core/cloud-provider';
import { loadConfigProviders, mutateConfigProviders } from './provider-config-utils.js';

export async function providerCloudConfig(
  id: string,
  updates: NativeCloudSettings | null | undefined,
  configPath: string,
  vault: SecretVault,
): Promise<NativeCloudSettings> {
  if (!/^[\w.-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))
    throw new Error('Invalid provider id');
  if (updates === undefined) {
    const providers = await loadConfigProviders(configPath, vault);
    if (!Object.hasOwn(providers, id)) throw new Error('Saved provider not found');
    return parseNativeCloudSettings(providers[id]?.cloud ?? {});
  }
  let saved: NativeCloudSettings = {};
  await mutateConfigProviders(configPath, vault, (providers) => {
    if (!Object.hasOwn(providers, id)) throw new Error('Saved provider not found');
    const provider = providers[id]!;
    const fields = cloudFieldsForProvider(provider.type || id);
    if (!fields.length) throw new Error('This provider has no native cloud routing settings');
    const parsed = updates === null ? {} : parseNativeCloudSettings(updates);
    if (Object.keys(parsed).some((field) => !fields.includes(field as (typeof fields)[number])))
      throw new Error('Cloud setting does not apply to this provider');
    saved = updates === null ? {} : parseNativeCloudSettings({ ...provider.cloud, ...updates });
    provider.cloud = saved;
  });
  return saved;
}
