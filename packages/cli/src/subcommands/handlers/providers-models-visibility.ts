import type { ProviderConfig } from '@wrongstack/contracts/types';
import type { DefaultModelsRegistry } from '@wrongstack/core/models';
import { color } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import { mutateConfigProviders } from '../../provider-config-utils.js';
import type { SubcommandHandler } from '../contracts.js';

export function aliasProviderId(configProviderId: string, cfg: ProviderConfig | undefined): string {
  return cfg?.type && cfg.type !== configProviderId ? cfg.type : configProviderId;
}

/**
 * One-shot `/v1/models` auto-discovery, merged into the registry overlay.
 *
 * The REPL learns a gateway's models because boot runs this; subcommands have
 * no boot, so without it `wstack models ai-gateway` reported "not in catalog"
 * for a provider serving 200+ models. Best-effort and silent, exactly as at
 * boot — a down server must not turn a listing into a hard error.
 */
export async function discoverProviderModels(
  deps: Parameters<SubcommandHandler>[1],
  ids: string[],
  onlyProviderId?: string | undefined,
): Promise<Awaited<ReturnType<typeof deps.modelsRegistry.getProvider>>> {
  if (!('mergeOverlay' in deps.modelsRegistry)) return undefined;
  try {
    const { discoverAndMergeProviders } = await import('../../boot/auto-discover-providers.js');
    const only = onlyProviderId ? deps.config.providers?.[onlyProviderId] : undefined;
    await discoverAndMergeProviders({
      config: only ? { ...deps.config, providers: { [onlyProviderId!]: only } } : deps.config,
      registry: deps.modelsRegistry as DefaultModelsRegistry,
      cacheDir: deps.paths.cacheDir,
    });
  } catch {
    return undefined;
  }
  for (const id of ids) {
    const found = await deps.modelsRegistry.getProvider(id);
    if (found) return found;
  }
  return undefined;
}

export async function getCatalogProviderForConfigProvider(
  providerId: string,
  deps: Parameters<SubcommandHandler>[1],
): Promise<{
  providerId: string;
  provider: Awaited<ReturnType<typeof deps.modelsRegistry.getProvider>>;
}> {
  const cfg = deps.config.providers?.[providerId];
  // A signed-in account's catalog entry is only the curated overlay until its
  // account snapshot is merged: listing it bare showed every model with no
  // context, output or capabilities. Boot merges the snapshot; a subcommand
  // has no boot, so merge it here (live, or the cached snapshot offline).
  if (usesAccountCatalog(cfg)) {
    const found = await discoverProviderModels(deps, [providerId], providerId);
    if (found) return { providerId, provider: found };
  }
  const lookupId = aliasProviderId(providerId, cfg);
  const provider = await deps.modelsRegistry.getProvider(lookupId);
  if (provider) return { providerId: lookupId, provider };
  // A catalog miss is not proof the provider has no models — see
  // `discoverProviderModels`. Deferred until after the miss so the offline
  // path stays offline. Discovery keys its overlay on the CONFIG id, which for
  // an alias (`gateway-work` → type `ai-gateway`) differs from `lookupId`.
  return {
    providerId: lookupId,
    provider: await discoverProviderModels(deps, [lookupId, providerId]),
  };
}

export function usesAccountCatalog(cfg: ProviderConfig | undefined): boolean {
  const active = cfg?.apiKeys?.find((key) => key.label === cfg.activeKey) ?? cfg?.apiKeys?.[0];
  return active?.authMethod === 'oauth';
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export async function modelsHide(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const providerId = args[0];
  const modelId = args[1];
  if (!providerId || !modelId) {
    deps.renderer.writeError('Usage: wstack models hide <provider> <model>');
    return 1;
  }
  const saved = deps.config.providers?.[providerId];
  if (!saved) {
    deps.renderer.writeError(`Provider "${providerId}" is not configured.`);
    return 1;
  }
  const { providerId: lookupId, provider } = await getCatalogProviderForConfigProvider(
    providerId,
    deps,
  );
  if (!provider) {
    deps.renderer.writeError(
      lookupId !== providerId
        ? `Alias "${providerId}" points at catalog id "${lookupId}" which is not in the cache.`
        : `Provider "${providerId}" not in catalog.`,
    );
    return 1;
  }
  const knownIds = provider.models.map((m) => m.id);
  const visible = saved.models !== undefined ? [...saved.models] : [...knownIds];
  if (!visible.includes(modelId)) {
    deps.renderer.writeInfo(`${providerId}/${modelId} is already hidden.`);
    return 0;
  }
  const nextVisible = visible.filter((id) => id !== modelId);
  await mutateConfigProviders(
    activeProfileConfigPath(deps.paths, deps.config),
    deps.vault,
    (providers) => {
      const p = providers[providerId];
      if (!p) return;
      p.models = nextVisible;
    },
  );
  publishProviderConfig(deps, providerId, { ...saved, models: nextVisible });
  deps.renderer.writeInfo(
    `Hidden ${providerId}/${modelId}. Visible: ${nextVisible.length}, hidden: ${Math.max(0, knownIds.length - nextVisible.length)}.`,
  );
  if (nextVisible.length === 0) {
    deps.renderer.write(
      color.dim(
        'This provider now has no visible models. Use `wstack models show` or `wstack models reset` to restore.\n',
      ),
    );
  }
  return 0;
}

export async function modelsShow(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const providerId = args[0];
  const modelId = args[1];
  if (!providerId || !modelId) {
    deps.renderer.writeError('Usage: wstack models show <provider> <model>');
    return 1;
  }
  const saved = deps.config.providers?.[providerId];
  if (!saved) {
    deps.renderer.writeError(`Provider "${providerId}" is not configured.`);
    return 1;
  }
  const { providerId: lookupId, provider } = await getCatalogProviderForConfigProvider(
    providerId,
    deps,
  );
  if (!provider) {
    deps.renderer.writeError(
      lookupId !== providerId
        ? `Alias "${providerId}" points at catalog id "${lookupId}" which is not in the cache.`
        : `Provider "${providerId}" not in catalog.`,
    );
    return 1;
  }
  const knownIds = provider.models.map((m) => m.id);
  if (saved.models === undefined) {
    deps.renderer.writeInfo(`${providerId}/${modelId} is already visible.`);
    return 0;
  }
  const nextVisible = uniqueStrings([...saved.models, modelId]);
  await mutateConfigProviders(
    activeProfileConfigPath(deps.paths, deps.config),
    deps.vault,
    (providers) => {
      const p = providers[providerId];
      if (!p) return;
      p.models = nextVisible;
    },
  );
  publishProviderConfig(deps, providerId, { ...saved, models: nextVisible });
  const isKnown = knownIds.includes(modelId);
  deps.renderer.writeInfo(
    `Visible ${providerId}/${modelId}${isKnown ? '' : ' (not in current catalog)'}. Visible: ${nextVisible.length}.`,
  );
  return 0;
}

export async function modelsHidden(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const providerId = args[0] ?? deps.config.provider;
  if (!providerId) {
    deps.renderer.writeError('Usage: wstack models hidden <provider>');
    return 1;
  }
  const saved = deps.config.providers?.[providerId];
  if (!saved) {
    deps.renderer.writeError(`Provider "${providerId}" is not configured.`);
    return 1;
  }
  const { providerId: lookupId, provider } = await getCatalogProviderForConfigProvider(
    providerId,
    deps,
  );
  if (!provider) {
    deps.renderer.writeError(
      lookupId !== providerId
        ? `Alias "${providerId}" points at catalog id "${lookupId}" which is not in the cache.`
        : `Provider "${providerId}" not in catalog.`,
    );
    return 1;
  }
  const knownIds = provider.models.map((m) => m.id);
  const visible = saved.models;
  const hidden = visible === undefined ? [] : knownIds.filter((id) => !visible.includes(id));
  deps.renderer.write(`${color.bold('Hidden models')} ${color.dim(`(${providerId})`)}\n`);
  if (hidden.length === 0) {
    deps.renderer.write(color.dim('(none hidden)\n'));
    return 0;
  }
  for (const id of hidden) deps.renderer.write(`  ${id}\n`);
  deps.renderer.write(
    color.dim(`\nRestore: wstack models show ${providerId} <model> · reset ${providerId}\n`),
  );
  return 0;
}

/**
 * Reflect a provider change in this process's config. The loaded config is
 * frozen (`ConfigLoader.load`), so assigning into it threw AFTER the change had
 * already been written to disk: the command printed a stack trace and exited
 * non-zero on success. Replace the object instead of mutating it.
 */
export function publishProviderConfig(
  deps: Parameters<SubcommandHandler>[1],
  providerId: string,
  next: ProviderConfig,
): void {
  deps.config = {
    ...deps.config,
    providers: { ...(deps.config.providers ?? {}), [providerId]: next },
  };
}
