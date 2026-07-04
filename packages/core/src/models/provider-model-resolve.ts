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
 * Priority:
 *  1. The saved `models` allowlist is authoritative. This is the only source
 *     for OAuth / subscription / custom providers that models.dev does not
 *     list — `github-copilot`, `anthropic-oauth`, `openai-codex`,
 *     `zai-coding-plan`, etc. Each id is enriched with catalog metadata when a
 *     same-id catalog model exists, otherwise returned as a bare `{id, name}`.
 *  2. Otherwise the full catalog model list (standard API-key providers with no
 *     saved allowlist).
 *  3. Otherwise an empty list — *never* an error. A provider the user saved
 *     that is neither in the catalog nor carries an allowlist simply has no
 *     suggestions yet; callers must not raise a toast for that case (doing so
 *     produced the "not found in catalog" notification flood when the WebUI
 *     model switcher lazy-loaded every saved provider).
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
): ProviderModelDescriptor[] {
  if (savedModels && savedModels.length > 0) {
    const byId = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
    return savedModels.map((id) => {
      // OAuth / subscription ids (openai-codex) are absent from the models.dev
      // catalog, so layer their canonical name + description on top: enrich a
      // catalog hit with the blurb, or synthesize a full descriptor from it.
      const codex = codexModelMeta(id);
      const hit = byId.get(id);
      if (hit) {
        const described = describeCatalogModel(hit);
        return codex ? { ...described, description: codex.description } : described;
      }
      if (codex) {
        return { id, name: codex.name, description: codex.description, capabilities: [] };
      }
      return { id, name: id, capabilities: [] };
    });
  }
  if (catalog && catalog.models.length > 0) return catalog.models.map(describeCatalogModel);
  // No allowlist and no catalog models. For the ChatGPT sign-in provider the
  // canonical model list is known offline, so surface it rather than an empty
  // picker (the models.dev catalog omits `openai-codex`; its models live only
  // in the curated overlay, which may be missing offline).
  if (providerHint === 'openai-codex') {
    return CODEX_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      capabilities: [],
    }));
  }
  return [];
}
