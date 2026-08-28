import { bootConfig as coreBootConfig, type DefaultLogger } from '@wrongstack/core/infrastructure';
import type { DefaultSecretVault } from '@wrongstack/core/security';
import type { Config } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';

interface BootResult {
  config: Config;
  vault: DefaultSecretVault;
  globalConfigPath: string;
  projectRoot: string;
  wpaths: WstackPaths;
  logger: InstanceType<typeof DefaultLogger>;
}

/**
 * Thin WebUI wrapper over the canonical `bootConfig` in `@wrongstack/core`
 * (mirrors packages/cli/src/boot-config.ts). All real boot behavior — wstack
 * path resolution, the AES-GCM `DefaultSecretVault`, plaintext-secret
 * migration, and config load/merge — lives in core so the WebUI server and the
 * CLI can't drift. Only the secret-migration notice label (`WebUI`) differs.
 */
export async function bootConfig(): Promise<BootResult> {
  const { config, vault, globalConfigPath, projectRoot, wpaths, logger } = await coreBootConfig({
    appLabel: 'WebUI',
  });
  return { config, vault, globalConfigPath, projectRoot, wpaths, logger };
}

export function patchConfig(config: Config, updates: Partial<Config>): Config {
  return Object.freeze({ ...config, ...updates });
}
