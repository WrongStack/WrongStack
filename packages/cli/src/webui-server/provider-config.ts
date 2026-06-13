import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { ProviderConfig } from '@wrongstack/core/types';
import { loadConfigProviders, mutateConfigProviders } from '../provider-config-utils.js';

// Re-export the provider-record transforms the webui handlers need, so
// callers (ws-handlers/providers.ts) have a single import surface for
// "webui provider config" instead of juggling this module *and*
// ../provider-config-utils.js. The transforms themselves stay in the
// broadly-shared provider-config-utils.js (auth-menu, slash-commands,
// subcommands all use it); this is a facade re-export, not a move.
// PR 4 follow-up of Issue #30.
export {
  expectDefined,
  maskedKey,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';

/**
 * PR 4 of Issue #30 (webui-server 8-PR refactor):
 * provider-config IO.
 *
 * Before this PR, the two helpers below were inlined
 * at the bottom of `webui-server.ts` as closure-captured
 * helpers that read `opts.globalConfigPath` from the
 * surrounding `runWebUI` scope. The helpers themselves
 * are pure: given a config path and a vault, they
 * load or save the providers map. The `globalConfigPath`
 * closure capture is what made them untestable in
 * isolation.
 *
 * After this PR, the helpers live in their own module
 * with explicit parameters. `runWebUI` is the only
 * caller; it now constructs the helpers at the call
 * site or threads `globalConfigPath` through a thin
 * adapter.
 *
 * Note: `writeKeysBack` and `normalizeKeys` (used by
 * the per-handler key ops) are *already* imported from
 * `@wrongstack/webui/server`. This PR does not move
 * them — they were never inlined in `webui-server.ts`.
 * Per the plan body's update after PR #51, they are
 * not part of this extraction.
 */

export function getVault(globalConfigPath: string | undefined): DefaultSecretVault {
  const keyFile = path.join(path.dirname(globalConfigPath ?? ''), '.key');
  return new DefaultSecretVault({ keyFile });
}

export async function loadSavedProviders(
  globalConfigPath: string | undefined,
): Promise<Record<string, ProviderConfig>> {
  if (!globalConfigPath) return {};
  return loadConfigProviders(globalConfigPath, getVault(globalConfigPath));
}

export async function saveProviders(
  globalConfigPath: string | undefined,
  providers: Record<string, ProviderConfig>,
): Promise<void> {
  if (!globalConfigPath) return;
  await mutateConfigProviders(
    globalConfigPath,
    getVault(globalConfigPath),
    (existing: Record<string, ProviderConfig>) => {
      // Replace the entire providers map.
      for (const key of Object.keys(existing)) delete existing[key];
      Object.assign(existing, providers);
    },
  );
}

/**
 * A provider-config store bound to one `globalConfigPath`.
 *
 * PR 4 follow-up of Issue #30: the provider ws-handlers used to take a
 * raw `globalConfigPath` and call `loadSavedProviders`/`saveProviders`
 * with it on every operation. Binding the path once into a small
 * `load`/`save` object (mirrors the standalone server's
 * `createProviderConfigIO`) removes the repeated path threading and
 * gives callers a single dependency to mock.
 */
export interface ProviderConfigStore {
  load(): Promise<Record<string, ProviderConfig>>;
  save(providers: Record<string, ProviderConfig>): Promise<void>;
}

/**
 * Build a {@link ProviderConfigStore} for `globalConfigPath`. When the
 * path is undefined the store is a no-op (load ⇒ `{}`, save ⇒ nothing),
 * matching the underlying helpers' behaviour.
 */
export function createProviderConfigStore(
  globalConfigPath: string | undefined,
): ProviderConfigStore {
  return {
    load: () => loadSavedProviders(globalConfigPath),
    save: (providers) => saveProviders(globalConfigPath, providers),
  };
}
