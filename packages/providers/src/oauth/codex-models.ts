/**
 * Codex model discovery — the 3-tier resolution chain, in one place.
 *
 * Split from `./codex-protocol.ts` on purpose: this module imports the
 * `CODEX_MODELS` catalog, and the runtime provider needs the protocol (to
 * refresh a token) without paying for the catalog. Keeping them apart means
 * `../openai-codex.ts` can import one and not the other.
 *
 * Resolution order — the live backend is authoritative, the catalog is the
 * offline answer, and the inline list is the never-happens floor:
 *
 *  1. **Live backend** — `GET <baseUrl>/codex/models`; account-aware and
 *     authoritative, retaining every picker-visible id returned to that user.
 *  2. **models.dev catalog** — the `openai` provider's models whose `family`
 *     is `gpt-codex` / `gpt-codex-spark`, filtered the same way.
 *  3. **Inline fallback** — {@link FALLBACK_CODEX_MODELS}, derived from core's
 *     `CODEX_MODELS`. Only reachable on a fresh install with no network.
 *
 * @module oauth/codex-models
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { release as osRelease, type as osType } from 'node:os';
import { CODEX_MODELS } from '@wrongstack/core/models';
import type { ModelsRegistry } from '@wrongstack/core/types';
import { extractAccountId } from '../openai-codex-account.js';
import { CODEX_ORIGINATOR, codexModelsUrl } from './codex-protocol.js';

/**
 * The backend requires a semver `client_version` on /models — missing or
 * invalid values are rejected with 400 "Invalid client_version format", and
 * models whose `minimal_client_version` exceeds it are gated away. This must
 * be the providers package's own version: the same value the production
 * `fetchContextLimits` probe in `../openai-codex.ts` sends.
 */
const CODEX_MODELS_CLIENT_VERSION = ((): string => {
  const req = createRequire(import.meta.url);
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = req(rel) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.309.1';
})();

/** Model-listing request timeout. Short: this is best-effort enrichment. */
const MODELS_TIMEOUT_MS = 8_000;

/**
 * Recommended Codex models for ChatGPT sign-in. Derived from `CODEX_MODELS` in
 * core, the single source of truth for Codex id/name/description.
 */
export const FALLBACK_CODEX_MODELS: ReadonlyArray<{ id: string; name: string }> = CODEX_MODELS.map(
  (m) => ({ id: m.id, name: m.name }),
);

/** Families in the models.dev catalog that indicate Responses-API compatibility. */
export const CODEX_CATALOG_FAMILIES = new Set(['gpt-codex', 'gpt-codex-spark']);

export function fallbackCodexModelIds(): string[] {
  return FALLBACK_CODEX_MODELS.map((m) => m.id);
}

export function fallbackCodexProviderModels(): Array<{ id: string; name: string }> {
  return FALLBACK_CODEX_MODELS.map((m) => ({ id: m.id, name: m.name }));
}

/**
 * Narrow a generic/offline catalog to the bundled current fallback ids. The
 * authenticated live `/codex/models` response deliberately bypasses this
 * filter so newly rolled-out account models appear without a WrongStack release.
 */
export function filterCurrentCodexModelIds(ids: Iterable<string>): string[] {
  const available = new Set(ids);
  return FALLBACK_CODEX_MODELS.map((m) => m.id).filter((id) => available.has(id));
}

export function isCodexCatalogModel(model: { family?: string | undefined }): boolean {
  return typeof model.family === 'string' && CODEX_CATALOG_FAMILIES.has(model.family);
}

/**
 * Fetch the account's available Codex model ids live from the ChatGPT backend.
 * Best-effort: returns `[]` on any failure so login still succeeds and the
 * caller falls through to the catalog or the inline list.
 */
export async function fetchCodexModels(
  accessToken: string,
  baseUrl?: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${codexModelsUrl(baseUrl)}?client_version=${encodeURIComponent(
    CODEX_MODELS_CLIENT_VERSION,
  )}`;
  try {
    // Official Codex CLI client headers (user-agent + session_id): the /models
    // endpoint sits behind a header-level challenge that Node's default UA
    // fails; the full official set verified 200 live (client_version=0.309.1).
    const platformTag = process.platform === 'win32' ? 'Windows 11' : `${osType} ${osRelease}`;
    const accountId = extractAccountId(accessToken);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      originator: CODEX_ORIGINATOR,
      'user-agent': `codex_cli_rs/${CODEX_MODELS_CLIENT_VERSION} (${platformTag}; ${process.arch}) unknown`,
      'session-id': randomUUID(),
    };
    if (accountId) headers['chatgpt-account-id'] = accountId;
    const res = await fetch(url, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)])
        : AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as
      | { data?: Array<{ id?: string; slug?: string; visibility?: string }> }
      | { models?: Array<{ id?: string; slug?: string; visibility?: string }> }
      | null;
    if (!json) return [];
    // Standard OpenAI-compatible is `{ data: [...] }`; some deployments answer
    // with `{ models: [...] }`. Accept either, ignore anything else.
    const rawList: unknown[] =
      'data' in json && Array.isArray(json.data)
        ? (json.data as unknown[])
        : 'models' in json && Array.isArray(json.models)
          ? (json.models as unknown[])
          : [];
    const ids: string[] = [];
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      // The live ChatGPT backend identifies models by `slug` and omits `id`;
      // accept either so the identifier survives both response dialects.
      const rec = entry as Record<string, unknown>;
      const id = rec.id ?? rec.slug;
      if (rec.visibility !== undefined && rec.visibility !== 'list') continue;
      if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Resolve the available Codex model ids through the 3-tier chain documented at
 * the top of this module.
 *
 * @param modelsRegistry - optional; tier 2 is skipped when absent.
 * @param accessToken - accepted as a promise so a caller can start the request
 *   before the token has settled.
 */
export async function resolveCodexModels(
  modelsRegistry: ModelsRegistry | undefined,
  accessToken: string | Promise<string>,
  baseUrl?: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  // Tier 1 — live backend
  const token = typeof accessToken === 'string' ? accessToken : await accessToken;
  // The authenticated backend is account- and rollout-aware. Do not intersect
  // its answer with the bundled fallback: doing that hid every newly rolled
  // out model until WrongStack itself shipped a new hardcoded catalog.
  const live = await fetchCodexModels(token, baseUrl, signal);
  if (live.length > 0) return live;

  // Tier 2 — models.dev catalog (best-effort; registry is optional)
  if (modelsRegistry) {
    try {
      const openaiProvider = await modelsRegistry.getProvider('openai');
      if (openaiProvider) {
        const catalog = openaiProvider.models
          .filter(isCodexCatalogModel)
          .map((m) => m.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const currentCatalog = filterCurrentCodexModelIds(catalog);
        if (currentCatalog.length > 0) return currentCatalog;
      }
    } catch {
      /* catalog unavailable — fall through to tier 3 */
    }
  }

  // Tier 3 — inline fallback
  return fallbackCodexModelIds();
}
