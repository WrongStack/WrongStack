/**
 * Shared provider-config helpers used by the picker, main boot sequence,
 * and subcommands. Keeps provider key detection and alias resolution in
 * one place so the logic doesn't drift between call sites.
 */
import type { Config, ModelsRegistry, ProviderConfig, ResolvedProvider } from '@wrongstack/core/types';
import { catalogProviderIdFor } from '@wrongstack/providers';

// (Removed) CATALOG_REFRESHABLE_MODEL_PROVIDERS — a four-entry hand-list that
// decided whose models were allowed to come from models.dev. See visibleModelIds.

function uniqueModelIds(primary: readonly string[], fallback: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...primary, ...fallback]) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Return the provider's visible model ids: models.dev plus anything the saved
 * config names that the catalog does not carry.
 *
 * `cfg.models` is ADDITIVE, never subtractive. It used to be a strict allowlist
 * for every provider except a four-entry hand-list (chatgpt/openai/codex/
 * openai-codex), which had two failure modes that showed up in real configs:
 *
 *   - A saved `models: []` — written by an auth flow that had nothing to cache
 *     yet — pinned the provider to ZERO selectable models forever. A configured
 *     GitHub Copilot listed nothing at all.
 *   - A preset's hand-maintained list went stale against the catalog and hid
 *     real models on the user's own plan: `kimi-for-coding` offered 2 of the 4
 *     models models.dev publishes for it, hiding `k3` (131_072 output) behind
 *     `kimi-for-coding` (32_768). `alibaba-token-plan` hid 11 of 22.
 *
 * models.dev publishes a dedicated provider entry per subscription plan, so the
 * catalog already describes exactly what a plan includes — a second,
 * hand-curated copy could only ever drift below it. Narrowing what the user
 * sees is `favoriteModels`' job, not this list's.
 *
 * A model the credential cannot actually serve now surfaces as an error at
 * request time rather than being silently unselectable, which is the better
 * failure: visible and actionable. */
export function visibleModelIds(
  providerId: string,
  config: Config,
  catalogModelIds: string[],
  cfg?: ProviderConfig | undefined,
): string[] {
  const entry = cfg ?? config.providers?.[providerId];
  if (entry?.models === undefined) return [...catalogModelIds];
  return uniqueModelIds(entry.models, catalogModelIds);
}

/**
 * Is `apiBase` a loopback URL (localhost / 127.0.0.0-8 / ::1 / 0.0.0.0)?
 * Such a host is a server running on the same machine, never a remote API.
 */
function isLoopbackUrl(apiBase: string | undefined): boolean {
  if (!apiBase) return false;
  let host: string;
  try {
    host = new URL(apiBase).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL keeps the brackets around IPv6 hosts (e.g. "[::1]") — strip them.
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Is this a keyless local gateway — a server on a loopback address that
 * declares no API-key env vars (omniroute, LiteLLM/vLLM/LM Studio/Ollama
 * running locally, …)? These need no credential, so they belong in the
 * picker even though `hasApiKey` returns false for them. Accepts the
 * minimal shape both call sites can supply.
 */
export function isKeylessLocalProvider(provider: {
  apiBase?: string | undefined;
  envVars?: string[] | undefined;
}): boolean {
  if (provider.envVars && provider.envVars.length > 0) return false;
  return isLoopbackUrl(provider.apiBase);
}

/**
 * Does this provider have an API key available — either in the
 * environment (via one of its known env vars) or stored in config
 * (encrypted or plaintext)? Used to filter the picker to providers
 * the user can actually use right now.
 */
export function hasApiKey(provider: ResolvedProvider, config?: Config): boolean {
  if (provider.envVars.some((v) => !!process.env[v])) return true;
  const entry = config?.providers?.[provider.id];
  if (!entry) return false;
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => k?.apiKey)) return true;
  return false;
}

/**
 * Build the list of providers the user can switch to mid-session.
 * Only includes providers that have an API key available (env var or
 * stored config). Falls back to the full catalog when no keys are found.
 *
 * Models are inlined from the catalog (or from `cfg.models` for custom
 * entries) so the picker can show a real selection.
 */
export async function buildPickableProviders(
  modelsRegistry: ModelsRegistry,
  config: Config,
): Promise<Array<{ id: string; family: string; models: string[] }>> {
  const overlay = config.providers ?? {};
  let catalog: Awaited<ReturnType<typeof modelsRegistry.listProviders>> = [];
  try {
    catalog = await modelsRegistry.listProviders();
  } catch {
    // catalog unavailable — keyed-by-config-only path still works
  }
  const catalogById = new Map(catalog.map((p) => [p.id, p]));
  // Selectable when the provider has a usable key OR is a keyless local
  // gateway (omniroute/LiteLLM/… on a loopback address, which needs no
  // credential). Mirrors `runPicker`'s filter so the `/model` switch and
  // the startup picker agree on what's offered.
  const isSelectable = (id: string): boolean => {
    const entry = overlay[id];
    const catalogEntry = catalogById.get(id);
    const envHit = catalogEntry?.envVars.some((v) => !!process.env[v]);
    if (envHit) return true;
    if (typeof entry?.apiKey === 'string' && entry.apiKey.length > 0) return true;
    if (Array.isArray(entry?.apiKeys) && entry.apiKeys.some((k) => k?.apiKey)) return true;
    return isKeylessLocalProvider({
      apiBase: entry?.baseUrl ?? catalogEntry?.apiBase,
      envVars: entry?.envVars ?? catalogEntry?.envVars,
    });
  };
  const seen = new Set<string>();
  const out: Array<{ id: string; family: string; models: string[] }> = [];
  for (const [id, cfg] of Object.entries(overlay)) {
    if (!isSelectable(id)) continue;
    seen.add(id);
    // Shared resolution, so a gateway saved as `ai-gateway` reads its facts
    // from the models.dev id that actually publishes them (`vercel`). Computing
    // the key inline here meant the picker offered zero catalog models for it.
    const catalogType = catalogProviderIdFor(id, cfg.type);
    const inherited = catalogById.get(catalogType) ?? catalogById.get(cfg.type ?? id);
    const family = cfg.family ?? inherited?.family ?? 'unsupported';
    if (family === 'unsupported') continue;
    const models = visibleModelIds(id, config, (inherited?.models ?? []).map((m) => m.id), cfg);
    out.push({ id, family, models });
  }
  for (const p of catalog) {
    if (seen.has(p.id)) continue;
    if (p.family === 'unsupported') continue;
    if (!isSelectable(p.id)) continue;
    out.push({ id: p.id, family: p.family, models: p.models.map((m) => m.id) });
  }
  return out;
}

/**
 * Resolve a provider id that may be an alias. When the user has
 * `providers[id].type` pointing at a different catalog entry, return
 * the catalog id so downstream lookups still work. Returns the
 * original id unchanged when it's a direct catalog match.
 */
export function resolveProviderAlias(providerId: string, config: Config): string {
  const savedAlias = config.providers?.[providerId];
  if (savedAlias?.type && savedAlias.type !== providerId) {
    return savedAlias.type;
  }
  return providerId;
}
