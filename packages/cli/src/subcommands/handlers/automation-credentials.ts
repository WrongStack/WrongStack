import { readFile } from 'node:fs/promises';
import type { Config, ProviderConfig, SecretVault } from '@wrongstack/contracts/types';
import { decryptConfigSecrets, isSecretField } from '@wrongstack/core/security';
import type { WstackPaths } from '@wrongstack/core/utils';
import {
  type CredentialReference,
  isCredentialEnvName,
  type ResolvedCredentialBundle,
} from '@wrongstack/runtime';

/** Read the existing machine profile at use time, so ordinary key rotation is visible. */
export async function resolveAutomationCredentials(
  refs: readonly CredentialReference[],
  paths: Pick<WstackPaths, 'profileConfig'>,
  vault: SecretVault,
): Promise<Readonly<Record<string, string>>> {
  return (await resolveAutomationCredentialBundle(refs, paths, vault)).env;
}

/** Endpoint and key are read from the same atomic profile snapshot. */
export async function resolveAutomationCredentialBundle(
  refs: readonly CredentialReference[],
  paths: Pick<WstackPaths, 'profileConfig'>,
  vault: SecretVault,
): Promise<ResolvedCredentialBundle> {
  const values: Record<string, string> = Object.create(null);
  const providers: Record<string, ProviderConfig> = Object.create(null);
  const profiles = new Map<string, Config>();
  for (const ref of refs) {
    if (!/^[\w-]{1,64}$/.test(ref.profile) || !isCredentialEnvName(ref.envName))
      throw new Error('Invalid automation credential reference');
    let config = profiles.get(ref.profile);
    if (!config) {
      config = decryptConfigSecrets(
        // A leading UTF-8 BOM is valid (RFC 8259); the config loader accepts it.
        JSON.parse(
          (await readFile(paths.profileConfig(ref.profile), 'utf8')).replace(/^\uFEFF/, ''),
        ),
        vault,
      ) as Config;
      profiles.set(ref.profile, config);
    }
    const provider =
      config.providers && Object.hasOwn(config.providers, ref.provider)
        ? config.providers[ref.provider]
        : undefined;
    const key = provider?.apiKeys?.find((item) => item.label === ref.keyLabel);
    if (
      !key ||
      (key.authMethod !== undefined && key.authMethod !== 'api_key') ||
      typeof key.apiKey !== 'string' ||
      !key.apiKey.trim() ||
      vault.isEncrypted(key.apiKey)
    )
      throw new Error(
        `API credential reference unavailable: ${ref.profile}/${ref.provider}/${ref.keyLabel}`,
      );
    if (Object.hasOwn(values, ref.envName))
      throw new Error('Duplicate automation credential destination');
    values[ref.envName] = key.apiKey;
    if (Object.hasOwn(providers, ref.provider))
      throw new Error('A provider cannot reference two credentials in one run');
    const selected: ProviderConfig = { type: provider!.type || ref.provider, apiKey: key.apiKey };
    for (const field of [
      'family',
      'cloud',
      'baseUrl',
      'model',
      'models',
      'customModels',
      'capabilities',
      'quirks',
      'autoDiscoverModels',
      'modelDiscoveryPath',
      'modelDiscoveryAuthoritative',
    ] as const) {
      if (provider![field] !== undefined)
        (selected as unknown as Record<string, unknown>)[field] = structuredClone(provider![field]);
    }
    if (provider!.headers)
      selected.headers = Object.fromEntries(
        Object.entries(provider!.headers).filter(
          ([name, value]) => !isSecretField(name) && !value.includes(key.apiKey),
        ),
      );
    providers[ref.provider] = selected;
  }
  return { env: values, providers };
}
