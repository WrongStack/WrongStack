import type { ModelMatrixEntry, ProviderConfig } from '@wrongstack/contracts/types';
import { color, updateJsonObjectFile } from '@wrongstack/core/utils';
import { catalogProviderIdFor } from '@wrongstack/providers';
import { backupCurrent } from '../config-history.js';

/**
 * Catalog model ids per provider, resolved through the same alias rules as the
 * capability overlay so a gateway saved as `ai-gateway` reads the models.dev id
 * that actually publishes it. Includes anything auto-discovery merged into the
 * registry at boot. Best-effort: a missing or failing registry yields an empty
 * map and callers fall back to the saved list.
 */
export async function resolveCatalogModelIds(
  registry: import('@wrongstack/contracts/types').ModelsRegistry | undefined,
  config: import('@wrongstack/contracts/types').Config,
  providerIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!registry) return out;
  await Promise.all(
    providerIds.map(async (id) => {
      try {
        const catalogId = catalogProviderIdFor(id, config.providers?.[id]?.type);
        const provider = await registry.getProvider(catalogId);
        if (provider)
          out.set(
            id,
            provider.models.map((m) => m.id),
          );
      } catch {
        // Best-effort — an unreachable catalog must not break the command.
      }
    }),
  );
  return out;
}

/** Keep a 300-model gateway list readable in a terminal. */
export function summarizeModelIds(ids: string[], limit = 8): string {
  if (ids.length <= limit) return ids.join(', ');
  return `${ids.slice(0, limit).join(', ')} ${color.dim(`… +${ids.length - limit} more`)}`;
}

/** A provider is selectable when it has a stored key, a key list, or a
 *  populated env var. Mirrors `hasApiKey` but config-only (no registry). */
export function providerHasKey(entry: ProviderConfig | undefined): boolean {
  if (!entry) return false;
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => k?.apiKey)) return true;
  if (Array.isArray(entry.envVars) && entry.envVars.some((v) => !!process.env[v])) return true;
  return false;
}

/** Provider ids the user can target — those with a key, plus the active one. */
export function keyedProviderIds(config: {
  provider: string;
  providers?: Record<string, ProviderConfig>;
}): string[] {
  const ids = new Set<string>();
  if (config.provider) ids.add(config.provider);
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    if (providerHasKey(entry)) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Parse `<provider>/<model>`, `<provider> <model>`, or a bare `<model>`
 * (provider omitted → leader provider at resolve time) into a matrix entry.
 */
export function parseTarget(
  tokens: string[],
  profiles: Record<string, string[]> = {},
): ModelMatrixEntry | { error: string } {
  if (tokens.length >= 2) {
    return { provider: tokens[0], model: tokens.slice(1).join(' ') };
  }
  const only = tokens[0];
  if (!only) return { error: 'missing <provider>/<model>' };
  if (profiles[only]) return { fallbackProfile: only };
  if (only.includes('/')) {
    const i = only.indexOf('/');
    return { provider: only.slice(0, i), model: only.slice(i + 1) };
  }
  return { model: only };
}

// REASONING_EFFORT_LEVELS / isReasoningEffort are imported from
// @wrongstack/core/types — the canonical single source of truth.

export function isReasoningMode(value: string | undefined): value is 'auto' | 'on' | 'off' {
  return value === 'auto' || value === 'on' || value === 'off';
}

export function parseBoolWord(value: string | undefined): boolean | undefined {
  if (value === 'on' || value === 'true' || value === 'yes') return true;
  if (value === 'off' || value === 'false' || value === 'no') return false;
  return undefined;
}

function fmtRuntime(e: ModelMatrixEntry): string {
  const reasoning = e.modelRuntime?.reasoning;
  if (!reasoning) return '';
  const parts = [
    reasoning.mode ? `mode:${reasoning.mode}` : '',
    reasoning.effort ? `effort:${reasoning.effort}` : '',
    reasoning.preserve !== undefined ? `preserve:${reasoning.preserve ? 'on' : 'off'}` : '',
  ].filter(Boolean);
  return parts.length ? color.dim(` reasoning(${parts.join(' ')})`) : '';
}

export function fmtEntry(e: ModelMatrixEntry): string {
  const runtime = fmtRuntime(e);
  if (e.fallbackProfile && !e.model) return `profile:${e.fallbackProfile}${runtime}`;
  if (e.fallbackProfile && e.model) {
    const base = e.provider
      ? `${e.provider}/${e.model}`
      : `${e.model} ${color.dim('(leader provider)')}`;
    return `${base} ${color.dim(`+ profile:${e.fallbackProfile}`)}${runtime}`;
  }
  if (!e.model) return `${color.dim('(leader model)')}${runtime}`;
  return `${e.provider ? `${e.provider}/${e.model}` : `${e.model} ${color.dim('(leader provider)')}`}${runtime}`;
}

/**
 * Read the active profile config, apply `mutate`, write it back atomically, and
 * mirror the change into the in-memory config store. Pure I/O — safe under
 * both the plain REPL and the Ink TUI.
 */
export async function patchProfileConfig(
  mutate: (cfg: Record<string, unknown>) => void,
  profileConfigPath: string,
): Promise<Record<string, unknown>> {
  return updateJsonObjectFile(profileConfigPath, async (config) => {
    await backupCurrent(undefined, profileConfigPath);
    mutate(config);
    return config;
  });
}
