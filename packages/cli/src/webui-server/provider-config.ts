import * as path from 'node:path';
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { DefaultSecretVault } from '@wrongstack/core/security';
import { ProviderConfigSnapshots } from '@wrongstack/providers';
import { loadConfigProviders, mutateConfigProviders } from '../provider-config-utils.js';

const snapshots = new ProviderConfigSnapshots();

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
 * `@wrongstack/webui-server`. This PR does not move
 * them — they were never inlined in `webui-server.ts`.
 * Per the plan body's update after PR #51, they are
 * not part of this extraction.
 */

export function getVault(globalConfigPath: string | undefined): DefaultSecretVault {
  const configDir = path.dirname(globalConfigPath ?? '');
  const parentDir = path.dirname(configDir);
  const globalRoot = path.basename(parentDir) === 'profiles' ? path.dirname(parentDir) : configDir;
  const keyFile = path.join(globalRoot, '.key');
  return new DefaultSecretVault({ keyFile });
}

export async function loadSavedProviders(
  globalConfigPath: string | undefined,
): Promise<Record<string, ProviderConfig>> {
  if (!globalConfigPath) return {};
  return snapshots.track(await loadConfigProviders(globalConfigPath, getVault(globalConfigPath)));
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
      const merged = snapshots.merge(existing, providers);
      for (const key of Object.keys(existing)) delete existing[key];
      Object.assign(existing, merged);
      for (const key of Object.keys(providers)) delete providers[key];
      Object.assign(providers, merged);
    },
  );
  snapshots.track(providers);
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
 *
 * @param configProvidersRef Optional callback that returns the in-memory
 *   merged `config.providers` map (from the boot config loader which merges
 *   the profile config with `config.local.json`, extra sources and flags).
 *   Rows another layer contributes are shown read-only next to the profile's
 *   own rows, so a provider the agent can see is never invisible in the
 *   WebUI's saved-providers panel.
 *
 * The ref is a BOOT snapshot: `ConfigLoader.load()` returns a frozen Config,
 * so the credential watcher can never refresh it. Owned rows therefore always
 * come from disk on every `load()`. Serving them from the ref made the store
 * compare a stale view against fresh disk: after the first save every edit of
 * that provider was refused as "comes from another config file", a provider
 * added (or OAuth account signed in) after boot never appeared, and removing
 * it silently left it on disk.
 */
export function createProviderConfigStore(
  globalConfigPath: string | undefined,
  configProvidersRef?: () => Record<string, ProviderConfig>,
): ProviderConfigStore {
  if (configProvidersRef && globalConfigPath) {
    const views = new WeakMap<
      Record<string, ProviderConfig>,
      {
        view: Record<string, ProviderConfig>;
        disk: Record<string, ProviderConfig>;
        inherited: Record<string, ProviderConfig>;
      }
    >();
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    // Classify against the disk as it was at boot — the moment the ref was
    // built — so a later OAuth token refresh on disk is not mistaken for
    // another layer overriding the account.
    let inherited: Promise<Record<string, ProviderConfig>> | undefined;
    const inheritedRows = (): Promise<Record<string, ProviderConfig>> => {
      inherited ??= loadSavedProviders(globalConfigPath)
        .then((bootDisk) => rowsFromOtherLayers(configProvidersRef(), bootDisk))
        .catch((err: unknown) => {
          inherited = undefined;
          throw err;
        });
      return inherited;
    };
    void inheritedRows().catch(() => undefined);
    const compose = (
      disk: Record<string, ProviderConfig>,
      layered: Record<string, ProviderConfig>,
    ): Record<string, ProviderConfig> => {
      const providers = structuredClone(disk);
      for (const [id, row] of Object.entries(layered)) providers[id] = structuredClone(row);
      return providers;
    };
    return {
      load: async () => {
        const layered = await inheritedRows();
        const disk = await loadSavedProviders(globalConfigPath);
        const providers = compose(disk, layered);
        views.set(providers, { view: structuredClone(providers), disk, inherited: layered });
        return providers;
      },
      save: async (providers) => {
        const baseline = views.get(providers);
        if (!baseline) {
          throw new Error('Load the provider list before saving. Refresh and try again.');
        }
        const pending = structuredClone(baseline.disk);
        snapshots.track(pending);
        for (const id of new Set([...Object.keys(baseline.view), ...Object.keys(providers)])) {
          if (equal(baseline.view[id], providers[id])) continue;
          if (Object.hasOwn(baseline.inherited, id)) {
            throw new Error(
              `Provider "${id}" comes from another config file. Edit its source config or create a new auth profile alias.`,
            );
          }
          if (Object.hasOwn(providers, id)) pending[id] = structuredClone(providers[id]!);
          else delete pending[id];
        }
        await saveProviders(globalConfigPath, pending);
        // Preserve inherited rows in the UI, without copying their credentials
        // into the writable file. `pending` now holds concurrent edits too.
        const next = compose(pending, baseline.inherited);
        for (const id of Object.keys(providers)) delete providers[id];
        Object.assign(providers, next);
        views.set(providers, {
          view: structuredClone(providers),
          disk: structuredClone(pending),
          inherited: baseline.inherited,
        });
      },
    };
  }
  return {
    load: () =>
      configProvidersRef
        ? Promise.resolve(snapshots.track(structuredClone(configProvidersRef())))
        : loadSavedProviders(globalConfigPath),
    save: (providers) => saveProviders(globalConfigPath, providers),
  };
}

/**
 * The key the config loader resolves for a row: an explicit `apiKey` wins,
 * else the `activeKey` entry of `apiKeys[]`, else its first entry.
 */
function resolvedApiKey(cfg: ProviderConfig): string | undefined {
  if (cfg.apiKey) return cfg.apiKey;
  const keys = (Array.isArray(cfg.apiKeys) ? cfg.apiKeys : []).filter(
    (k) => !!k && typeof k.label === 'string' && typeof k.apiKey === 'string',
  );
  const chosen = cfg.activeKey ? (keys.find((k) => k.label === cfg.activeKey) ?? keys[0]) : keys[0];
  return chosen?.apiKey;
}

/**
 * Rows of the merged boot config that the profile file does not own: absent
 * from it, or overridden by another layer in a field that picks the account
 * or endpoint. Loader normalizations (`apiKey` mirrored from `apiKeys[]`,
 * inline model objects) leave those fields alone, so they do not count.
 */
function rowsFromOtherLayers(
  merged: Record<string, ProviderConfig>,
  bootDisk: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const rows: Record<string, ProviderConfig> = {};
  for (const [id, row] of Object.entries(merged)) {
    if (!row || typeof row !== 'object') continue;
    const owned = bootDisk[id];
    if (
      !owned ||
      row.type !== owned.type ||
      row.family !== owned.family ||
      row.baseUrl !== owned.baseUrl ||
      resolvedApiKey(row) !== resolvedApiKey(owned)
    ) {
      rows[id] = structuredClone(row);
    }
  }
  return rows;
}
