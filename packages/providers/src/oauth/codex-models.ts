/** Account-aware Codex model discovery. No generic or bundled model fallback. */

import { randomUUID } from 'node:crypto';

import type { ModelsRegistry } from '@wrongstack/contracts/types';
import { extractAccountId } from '../openai-codex-account.js';
import {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  codexClientVersion,
  codexModelsUrl,
} from './codex-protocol.js';

/** Model-listing request timeout. Short: this is best-effort enrichment. */
const MODELS_TIMEOUT_MS = 8_000;

/** @deprecated Account model discovery has no bundled fallback. */
export const FALLBACK_CODEX_MODELS: ReadonlyArray<{ id: string; name: string }> = [];

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
 * Returns `[]` on failure without inventing account model IDs.
 */
export async function fetchCodexModels(
  accessToken: string,
  baseUrl?: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${codexModelsUrl(baseUrl)}?client_version=${encodeURIComponent(
    codexClientVersion(),
  )}`;
  try {
    // Same header set the runtime probe in `../openai-codex.ts` sends, from the
    // same constants. This used to impersonate `codex_cli_rs` on the theory
    // that the endpoint challenged unknown User-Agents; it does not (verified
    // live), and diverging from the runtime probe meant the login flow and the
    // running transport could see different catalogs.
    const accountId = extractAccountId(accessToken);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
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

/** Resolve only the authenticated account catalog. The registry argument is retained for API compatibility. */
export async function resolveCodexModels(
  _modelsRegistry: ModelsRegistry | undefined,
  accessToken: string | Promise<string>,
  baseUrl?: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  // Only the authenticated backend decides which models exist for this account.
  const token = typeof accessToken === 'string' ? accessToken : await accessToken;
  // The authenticated backend is account- and rollout-aware. Do not intersect
  // its answer with the bundled fallback: doing that hid every newly rolled
  // out model until WrongStack itself shipped a new hardcoded catalog.
  const live = await fetchCodexModels(token, baseUrl, signal);
  if (live.length > 0) return live;

  return [];
}
