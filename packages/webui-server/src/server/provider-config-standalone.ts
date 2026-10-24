/**
 * Standalone WebUI server helper (boot phase — not WS-connected), split out
 * of provider-config-io.ts so chunks that only need the pure load/save I/O
 * don't bundle the AES-GCM `DefaultSecretVault`.
 */
import * as path from 'node:path';
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { DefaultSecretVault } from '@wrongstack/core/security';
import { loadSavedProviders, saveProviders } from './provider-config-io.js';

/**
 * Small helper for the standalone WebUI entry point: create a
 * `{ load, save }` pair from a config path alone. Profile configs still use
 * the shared `~/.wrongstack/.key` vault key. The `--webui`
 * CLI mode and the standalone server both need to read/write the
 * `providers` map identically.
 */
export function createProviderConfigIO(configPath: string) {
  const keyFile = vaultKeyFileForConfigPath(configPath);
  const vault = new DefaultSecretVault({ keyFile });

  return {
    load: () => loadSavedProviders(configPath, vault),
    save: (providers: Record<string, ProviderConfig>) =>
      saveProviders(configPath, vault, providers),
  };
}

/** Resolve the shared vault key for either a root bootstrap or profile config path. */
export function vaultKeyFileForConfigPath(configPath: string): string {
  const configDir = path.dirname(configPath);
  const parentDir = path.dirname(configDir);
  const globalRoot = path.basename(parentDir) === 'profiles' ? path.dirname(parentDir) : configDir;
  return path.join(globalRoot, '.key');
}
