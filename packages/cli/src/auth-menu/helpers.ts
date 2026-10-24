import type { ProviderConfig } from '@wrongstack/contracts/types';
import { loadConfigProviders } from '../provider-config-utils.js';
import type { AuthMenuDeps } from './types.js';

/** Thin wrapper — delegates to the shared config provider loader. */
export async function loadProviders(deps: AuthMenuDeps): Promise<Record<string, ProviderConfig>> {
  return loadConfigProviders(deps.profileConfigPath, deps.vault, {
    warn: (msg: string) => deps.renderer.writeWarning(msg),
    profileConfigPath: deps.profileConfigPath,
  });
}
