import type { ModelsDevModel, ResolvedProvider } from '../types/models-registry.js';
import { CODEX_MODELS, codexModelMeta } from './codex-catalog.js';

/**
 * A model descriptor shaped for the WebUI `provider.models` message. All
 * metadata fields are optional because OAuth / subscription providers that
 * models.dev doesn't list contribute only a bare id.
 */
export interface ProviderModelDescriptor {
  id: string;
  name: string;
  /** One-line capability blurb, when known (e.g. the Codex subscription models). */
  description?: string | undefined;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  /** Declared output modalities, used by agent-model pickers to exclude image/video-only models. */
  outputModalities?: string[] | undefined;
  capabilities: string[];
}

/** Map a models.dev catalog model to the WebUI descriptor shape. */
export function describeCatalogModel(m: ModelsDevModel): ProviderModelDescriptor {
  return {
    id: m.id,
    name: m.name,
    ...(m.description !== undefined ? { description: m.description } : {}),
    releaseDate: m.release_date,
    contextWindow: m.limit?.context,
    inputCost: m.cost?.input,
    outputCost: m.cost?.output,
    ...(m.modalities?.output !== undefined ? { outputModalities: m.modalities.output } : {}),
    capabilities: [
      ...(m.tool_call ? ['tools'] : []),
      ...(m.reasoning ? ['reasoning'] : []),
      ...(m.modalities?.input?.includes('image') ? ['vision'] : []),
      ...(m.open_weights ? ['open_weights'] : []),
    ],
  };
}

/**
 * Resolve the model list to offer for a provider, merging a saved-config
 * allowlist with optional models.dev catalog metadata.
 *
 * The result is a **union** of all available sources — the saved allowlist
 * (if any), the catalog models (base + curated overlay), the sibling
 * catalog models (e.g. `openai` for `openai-codex`), and the offline Codex
 * catalog (when `providerHint === 'openai-codex'`). Each source is
 * deduplicated by model id; the saved allowlist ids appear first so the
 * user's explicit preferences float to the top.
 *
 * Priority:
 *  1. The saved `models` allowlist (if non-empty) — enriched with catalog
 *     metadata or the offline Codex catalog name+description when a same-id
 *     entry exists. These ids always come first in the result.
 *  2. Catalog models (base + layered `providers.json` overlay) not already
 *     in the saved list — this ensures the curated overlay is *never* hidden
 *     by a stale saved model list. An empty `[]` saved list (not `undefined`)
 *     still shows the full catalog.
 *  3. Sibling catalog models (when `siblingCatalog` is provided) — e.g. the
 *     `openai` models from models.dev for `openai-codex` subscribers. Merged
 *     only when the sibling is a different provider from the primary catalog.
 *  4. Offline Codex catalog (`CODEX_MODELS`) for `openai-codex` — fallback
 *     when both saved list and catalog are empty/unavailable. This guarantees
 *     ChatGPT sign-in users always see the canonical model list even fully
 *     offline.
 *  5. Otherwise an empty list — *never* an error. A provider the user saved
 *     that is neither in the catalog, the curated overlay, nor the offline
 *     Codex catalog simply has no suggestions yet; callers must not raise a
 *     toast for that case (doing so produced the "not found in catalog"
 *     notification flood when the WebUI model switcher lazy-loaded every
 *     saved provider).
 */
export function resolveProviderModelList(
  savedModels: string[] | undefined,
  catalog: ResolvedProvider | undefined,
  /**
   * Provider id / wire family the list is being resolved for. Lets the
   * resolver fall back to a known offline catalog (currently the ChatGPT
   * `openai-codex` models) when the saved allowlist is empty AND the
   * models.dev catalog is unavailable — so deleting the models from config
   * never leaves the provider showing zero models.
   */
  providerHint?: string | undefined,
  /**
   * Optional sibling catalog — e.g. the `openai` catalog when resolving
   * `openai-codex` models. Merged alongside the primary `catalog` so users
   * of subscription/OAuth providers also see the wire-family models they
   * may have access to (OpenAI models for ChatGPT Codex subscribers).
   */
  siblingCatalog?: ResolvedProvider | undefined,
): ProviderModelDescriptor[] {
  const byId = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
  const seen = new Set<string>();
  const out: ProviderModelDescriptor[] = [];

  // 1. Saved model allowlist — user's explicit preferences come first.
  if (savedModels && savedModels.length > 0) {
    for (const id of savedModels) {
      seen.add(id);
      // OAuth / subscription ids (openai-codex) are absent from the models.dev
      // catalog, so layer their canonical name + description on top: enrich a
      // catalog hit with the blurb, or synthesize a full descriptor from it.
      const codex = codexModelMeta(id);
      const hit = byId.get(id);
      if (hit) {
        const described = describeCatalogModel(hit);
        out.push(codex ? { ...described, description: codex.description } : described);
      } else if (codex) {
        out.push({ id, name: codex.name, description: codex.description, capabilities: [] });
      } else {
        out.push({ id, name: id, capabilities: [] });
      }
    }
  }

  // 2. Catalog models (base + overlay) — merge in models not already listed,
  //    so the curated overlay (e.g. openai-codex from providers.json) is
  //    never hidden by a stale saved model list. This also ensures the
  //    "fetch models from server" action in the WebUI never loses models.
  for (const [id, m] of byId) {
    if (!seen.has(id)) {
      out.push(describeCatalogModel(m));
      seen.add(id);
    }
  }

  // 2b. Sibling catalog models — e.g. OpenAI models for openai-codex users
  //     who may have access through their subscription. Merged only when
  //     the sibling provider is different from the primary catalog.
  if (siblingCatalog && siblingCatalog !== catalog) {
    for (const m of siblingCatalog.models) {
      if (!seen.has(m.id)) {
        out.push(describeCatalogModel(m));
        seen.add(m.id);
      }
    }
  }

  // 3. Offline fallback — when both saved list and catalog are empty, surface
  //    the known Codex catalog so ChatGPT sign-in users always see models.
  if (providerHint === 'openai-codex') {
    for (const m of CODEX_MODELS) {
      if (!seen.has(m.id)) {
        out.push({ id: m.id, name: m.name, description: m.description, capabilities: [] });
        seen.add(m.id);
      }
    }
  }

  return out;
}
