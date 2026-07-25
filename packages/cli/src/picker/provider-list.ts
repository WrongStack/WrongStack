import type { Config, ResolvedProvider } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { hasApiKey, isKeylessLocalProvider, visibleModelIds } from '../provider-helpers.js';
import { appendLocalPresetProviders } from './local-presets.js';

export interface ProviderDisplayList {
  displayList: ResolvedProvider[];
  showingFallback: boolean;
}

export function buildProviderDisplayList(
  providers: ResolvedProvider[],
  config: Config | undefined,
): ProviderDisplayList {
  const supported = providers.filter((p) => p.family !== 'unsupported');
  const catalogById = new Map(supported.map((p) => [p.id, p]));
  const overlay = config?.providers ?? {};
  const seen = new Set<string>();
  const merged: ResolvedProvider[] = [];

  for (const p of supported) {
    const cfg = overlay[p.id];
    seen.add(p.id);
    if (cfg) {
      merged.push({
        ...p,
        family: cfg.family ?? p.family,
        apiBase: cfg.baseUrl ?? p.apiBase,
        envVars: cfg.envVars && cfg.envVars.length > 0 ? cfg.envVars : p.envVars,
        models: visibleModelIds(
          p.id,
          config ?? ({ providers: {} } as Config),
          p.models.map((m) => m.id),
          cfg,
        ).map((m) => p.models.find((pm) => pm.id === m) ?? { id: m, name: m }),
      });
    } else {
      merged.push(p);
    }
  }

  for (const [id, cfg] of Object.entries(overlay)) {
    if (seen.has(id)) continue;
    if (!cfg?.family || cfg.family === 'unsupported') continue;
    const catalogType = cfg.type && cfg.type !== id ? cfg.type : undefined;
    const inherited = catalogType ? catalogById.get(catalogType) : undefined;
    merged.push({
      id,
      name: inherited ? `${inherited.name} ${color.dim('(alias)')}` : id,
      family: cfg.family,
      apiBase: cfg.baseUrl ?? inherited?.apiBase,
      envVars: cfg.envVars ?? inherited?.envVars ?? [],
      models: visibleModelIds(
        id,
        config ?? ({ providers: {} } as Config),
        (inherited?.models ?? []).map((m) => m.id),
        cfg,
      ).map((m) => inherited?.models.find((pm) => pm.id === m) ?? { id: m, name: m }),
      npm: inherited?.npm,
    });
  }

  const keyed = merged.filter((p) => hasApiKey(p, config) || isKeylessLocalProvider(p));
  let displayList = keyed;
  let showingFallback = false;
  if (keyed.length === 0) {
    displayList = merged;
    showingFallback = merged.length > 0;
  }

  appendLocalPresetProviders(displayList);
  return { displayList, showingFallback };
}
