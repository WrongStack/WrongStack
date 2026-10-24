import type {
  ModelCatalogSource,
  ModelProvenance,
  ModelsDevModel,
  ModelsDevPayload,
  ModelsDevProvider,
  WireFamily,
} from '@wrongstack/contracts/types/models-registry';
import type { ReasoningConfig, ReasoningEffort } from '@wrongstack/contracts/types/provider';

/** Fields an account snapshot may borrow from a same-id catalog model when it is silent. */
export const ACCOUNT_GAP_FIELDS = [
  'family',
  'tool_call',
  'reasoning',
  'temperature',
  'attachment',
  'knowledge',
  'release_date',
  'last_updated',
  'open_weights',
  'modalities',
] as const satisfies readonly (keyof ModelsDevModel)[];

export function fillAccountModelGaps(
  model: ModelsDevModel,
  ref: ModelsDevModel | undefined,
): ModelsDevModel {
  if (!ref) return model;
  const out: ModelsDevModel = { ...model };
  let filled = false;
  for (const key of ACCOUNT_GAP_FIELDS) {
    if (out[key] === undefined && ref[key] !== undefined) {
      (out as Record<string, unknown>)[key] = ref[key];
      filled = true;
    }
  }
  if (
    out.reasoning_options === undefined &&
    out.reasoningConfig === undefined &&
    ref.reasoning_options !== undefined
  ) {
    out.reasoning_options = ref.reasoning_options;
    filled = true;
  }
  // The output ceiling only: context (and an input sub-limit) are properties
  // of the account's plan, which is exactly what the snapshot already states.
  if (out.limit?.output === undefined && ref.limit?.output !== undefined) {
    out.limit = { ...out.limit, output: ref.limit.output };
    filled = true;
  }
  if (!filled || !out.provenance) return out;
  const sources = out.provenance.sources.includes('models-dev')
    ? out.provenance.sources
    : ['models-dev' as const, ...out.provenance.sources];
  return { ...out, provenance: { ...out.provenance, sources } };
}

export function annotatePayload(
  payload: ModelsDevPayload,
  source: ModelCatalogSource,
  opts: { observedAt?: string | undefined; authoritative?: boolean | undefined } = {},
): ModelsDevPayload {
  const out: ModelsDevPayload = {};
  for (const [providerId, provider] of Object.entries(payload)) {
    const models: ModelsDevProvider['models'] = {};
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const existing = model.provenance;
      const sources = [...(existing?.sources ?? [])];
      if (!sources.includes(source)) sources.push(source);
      const provenance: ModelProvenance = {
        primary: source,
        sources,
        ...(opts.observedAt ? { observedAt: opts.observedAt } : {}),
        ...(opts.authoritative !== undefined ? { authoritative: opts.authoritative } : {}),
      };
      models[modelId] = { ...model, provenance };
    }
    out[providerId] = { ...provider, models };
  }
  return out;
}

/**
 * The npm package each models.dev provider declares determines which wire
 * family WrongStack speaks. Anything not listed falls into `unsupported` and
 * can be enabled by registering a custom provider factory via a plugin.
 */
export const FAMILY_BY_NPM: Record<string, WireFamily> = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google-vertex/anthropic': 'anthropic',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@ai-sdk/groq': 'openai-compatible',
  '@ai-sdk/xai': 'openai-compatible',
  '@ai-sdk/cerebras': 'openai-compatible',
  '@ai-sdk/togetherai': 'openai-compatible',
  '@ai-sdk/mistral': 'openai-compatible',
  '@ai-sdk/perplexity': 'openai-compatible',
  '@ai-sdk/deepinfra': 'openai-compatible',
  '@openrouter/ai-sdk-provider': 'openai-compatible',
  'ai-gateway-provider': 'openai-compatible',
  '@ai-sdk/vercel': 'openai-compatible',
  '@ai-sdk/gateway': 'openai-compatible',
  '@aihubmix/ai-sdk-provider': 'openai-compatible',
  'venice-ai-sdk-provider': 'openai-compatible',
  '@ai-sdk/deepseek': 'openai-compatible',
  '@ai-sdk/google': 'google',
  '@ai-sdk/azure': 'openai',
  '@ai-sdk/cohere': 'openai-compatible',
  '@ai-sdk/amazon-bedrock': 'openai-compatible',
  '@ai-sdk/amazon-bedrock/mantle': 'openai',
  '@ai-sdk/google-vertex': 'google',
};

export const FAMILY_BY_PROVIDER_ID: Partial<Record<string, WireFamily>> = {
  'anthropic-oauth': 'anthropic-oauth',
  'github-copilot': 'github-copilot',
  'google-antigravity': 'google-antigravity',
  'openai-codex': 'openai-codex',
  // ChatGPT plan usage rides the public Responses API. Its catalog entry is
  // overlay + account discovery only, neither of which names an SDK.
  'openai-chatgpt': 'openai',
};

export function classifyFamily(npm: string | undefined): WireFamily {
  if (!npm) return 'unsupported';
  return FAMILY_BY_NPM[npm] ?? 'unsupported';
}

export function classifyProviderFamily(p: ModelsDevProvider): WireFamily {
  const byNpm = classifyFamily(p.npm);
  return byNpm !== 'unsupported' ? byNpm : (FAMILY_BY_PROVIDER_ID[p.id] ?? 'unsupported');
}

export const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** Convert models.dev's native reasoning_options schema into runtime policy. */
export function normalizeModelsDevModel(model: ModelsDevModel): ModelsDevModel {
  if (model.reasoningConfig) return model;
  const raw = model.reasoning_options;
  const options = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (model.reasoning !== true && options.length === 0) return model;

  const toggle = options.some((option) => option.type === 'toggle');
  const efforts = options
    .filter(
      (option): option is Extract<typeof option, { type: 'effort' }> => option.type === 'effort',
    )
    .flatMap((option) => option.values ?? [])
    .filter((effort): effort is ReasoningEffort => REASONING_EFFORTS.has(effort));
  const effortLevels = [...new Set(efforts)];
  const disableSupported = toggle || effortLevels.includes('none');
  const reasoningConfig: ReasoningConfig = {
    default: disableSupported ? 'enabled' : 'always_on',
    disableSupported,
    // Tri-state (see ReasoningConfig.effortSupported):
    //   options present  → documented answer (true when effort values exist;
    //                      an explicitly EMPTY array is a documented "no
    //                      effort control", not an absent field).
    //   field ABSENT     → the model is known to reason but its vocabulary is
    //                      undocumented → `undefined`, so the resolver forwards
    //                      the request and each wire adapter applies its own
    //                      transport gating. Sending `false` here would make
    //                      the resolver claim "does not support effort" — an
    //                      assertion the catalog never made.
    ...(raw === undefined ? {} : { effortSupported: effortLevels.length > 0 }),
    effortLevels,
    preserveThinking: model.interleaved ? 'always_on' : 'unsupported',
  };
  return { ...model, reasoningConfig };
}

/** Render a seconds-duration as a human-friendly "Xh Ym" or "Xd" string. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

export function hasEntries(payload: ModelsDevPayload | undefined): payload is ModelsDevPayload {
  return payload !== undefined && Object.keys(payload).length > 0;
}

/**
 * Shape-check a fetched models payload before it is cached and served for the
 * whole TTL. A captive portal or CDN error page returning `200` + valid JSON
 * (e.g. `{"error":"..."}`) would otherwise poison the catalog until a manual
 * refresh. Every provider entry must be an object — an error envelope whose
 * values are strings/numbers is rejected. `requireModels` additionally demands
 * that at least one entry carry a `models` map (the base catalog always does);
 * it is relaxed for curated overlays, which may be partial diffs.
 */
export function looksLikeModelsPayload(
  value: unknown,
  requireModels: boolean,
): value is ModelsDevPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  const allObjects = entries.every(
    (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
  if (!allObjects) return false;
  if (!requireModels) return true;
  return entries.some((entry) => {
    const models = (entry as Record<string, unknown>)['models'];
    return models !== null && typeof models === 'object';
  });
}
