import type {
  ModelProvenance,
  ModelsDevModel,
  ResolvedProvider,
} from '@wrongstack/contracts/types/models-registry';

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
  maxOutput?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  /** Declared output modalities, used by agent-model pickers to exclude image/video-only models. */
  outputModalities?: string[] | undefined;
  /** models.dev lifecycle marker (`deprecated` / `beta`); absent = GA or unknown. */
  status?: string | undefined;
  /** models.dev version line (`minimax`, `glm`, `claude-opus`) shared across releases. */
  family?: string | undefined;
  provenance?: ModelProvenance | undefined;
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
    maxOutput: m.limit?.output,
    inputCost: m.cost?.input,
    outputCost: m.cost?.output,
    ...(m.modalities?.output !== undefined ? { outputModalities: m.modalities.output } : {}),
    ...(m.status ? { status: m.status } : {}),
    ...(m.family ? { family: m.family } : {}),
    ...(m.provenance ? { provenance: m.provenance } : {}),
    capabilities: [
      ...(m.tool_call ? ['tools'] : []),
      ...(m.reasoning ? ['reasoning'] : []),
      ...(m.modalities?.input?.includes('image') ? ['vision'] : []),
      ...(m.open_weights ? ['open_weights'] : []),
    ],
  };
}

function withUserProvenance(model: ProviderModelDescriptor): ProviderModelDescriptor {
  const sources = [...(model.provenance?.sources ?? [])];
  if (!sources.includes('user-config')) sources.push('user-config');
  return {
    ...model,
    provenance: { ...model.provenance, primary: 'user-config', sources },
  };
}

/** Account snapshots define membership; API-key catalogs may contribute additional suggestions. */
export function resolveProviderModelList(
  savedModels: string[] | undefined,
  catalog: ResolvedProvider | undefined,
  /** Provider/family hint for legacy account transports. */
  providerHint?: string | undefined,
  /** Generic sibling metadata; never adds IDs to account snapshots. */
  siblingCatalog?: ResolvedProvider | undefined,
  accountOwned = false,
): ProviderModelDescriptor[] {
  const byId = new Map((catalog?.models ?? []).map((m) => [m.id, m]));
  if (
    accountOwned ||
    ['openai-codex', 'github-copilot', 'anthropic-oauth'].includes(providerHint ?? '')
  ) {
    // Account snapshots plus explicitly curated ChatGPT suggestions define
    // membership. Never add generic or sibling OpenAI catalog IDs here.
    const ids = new Set(savedModels ?? []);
    if (['openai-codex', 'openai-chatgpt'].includes(catalog?.id ?? providerHint ?? '')) {
      for (const model of byId.values()) {
        if (
          model.provenance?.sources.includes('wrongstack-overlay') ||
          model.provenance?.authoritative === true
        )
          ids.add(model.id);
      }
    }
    return [...ids].map((id) => {
      const hit = byId.get(id);
      return hit ? describeCatalogModel(hit) : { id, name: id, capabilities: [] };
    });
  }
  const seen = new Set<string>();
  const out: ProviderModelDescriptor[] = [];

  // 1. Saved model allowlist — user's explicit preferences come first.
  if (savedModels && savedModels.length > 0) {
    for (const id of savedModels) {
      seen.add(id);
      const hit = byId.get(id);
      if (hit) {
        out.push(withUserProvenance(describeCatalogModel(hit)));
      } else {
        out.push(withUserProvenance({ id, name: id, capabilities: [] }));
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

  return out;
}
