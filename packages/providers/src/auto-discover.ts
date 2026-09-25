import type {
  Config,
  ModelsDevModel,
  ModelsDevProvider,
  ProviderConfig,
} from '@wrongstack/core/types';
import { projectCompatibleProviderPresets } from './provider-definitions.js';
import { redirectSafeFetch } from './redirect-safe-fetch.js';

/**
 * Auto-discovery of an OpenAI-compatible server's model catalog.
 *
 * Many proxy/gateway servers (omniroute, LiteLLM, vLLM, LM Studio, …) expose a
 * `/v1/models` endpoint that returns far richer metadata than the bare OpenAI
 * spec — per-model `capabilities`, `context_length`, `max_output_tokens`,
 * `input_modalities`, a display `name`, etc. This module fetches that list and
 * maps it onto a `ModelsDevProvider` so the discovered models flow through the
 * exact same registry path as catalog (models.dev) models: factories are built
 * for them and per-model `Capabilities` resolve automatically — no hand-entered
 * model lists or capability overrides required.
 *
 * The wire format is the OpenAI "list" object. We read the documented OpenAI
 * fields and the common extended fields; anything missing degrades to a sane
 * default rather than failing.
 */

/** One entry from a `/v1/models` response. Only the fields we read are typed. */
interface CompatibleModelEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  /** OpenAI-spec field used by some servers in place of the extended ones. */
  max_tokens?: unknown;
  /** Vercel AI Gateway names the context window this way. */
  context_window?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  /** Vercel AI Gateway nests both directions under one object. */
  modalities?: {
    input?: unknown;
    output?: unknown;
  };
  created?: unknown;
  capabilities?: {
    tool_calling?: unknown;
    tools?: unknown;
    reasoning?: unknown;
    thinking?: unknown;
    vision?: unknown;
    temperature?: unknown;
  };
  /** OpenRouter nests modalities here rather than at the top level. */
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  /** OpenRouter reports the routed upstream's real ceilings here. */
  top_provider?: {
    context_length?: unknown;
    max_completion_tokens?: unknown;
  };
  /**
   * OpenRouter enumerates supported request parameters instead of a
   * capabilities object. The ARRAY'S PRESENCE is itself the signal: a server
   * that lists its parameters and omits `tools` is saying "no tools", whereas
   * a server that sends no array at all is saying nothing.
   */
  supported_parameters?: unknown;
  /** Per-token USD, as STRINGS on both OpenRouter and the Vercel Gateway. */
  pricing?: Record<string, unknown>;
  /** xAI quotes integer USD cents per 100 million tokens at the top level. */
  prompt_text_token_price?: unknown;
  cached_prompt_text_token_price?: unknown;
  completion_text_token_price?: unknown;
  /**
   * Model class. The Gateway sends `type` on `/v1/models`; `modelType` is the
   * AI SDK's own metadata field. Measured against the live endpoint: 315 models,
   * of which only 208 are `language` — the rest are embedding/video/image/
   * reranking/transcription/realtime/speech and must never reach a chat picker.
   */
  type?: unknown;
  modelType?: unknown;
  /** Requesty names the model class `api` (`chat`, `embedding`, ...). */
  api?: unknown;
  /** Requesty states capabilities as top-level booleans. */
  supports_tool_calling?: unknown;
  supports_vision?: unknown;
  supports_reasoning?: unknown;
  /** Requesty quotes per-token USD as top-level numbers. */
  input_price?: unknown;
  output_price?: unknown;
  cached_price?: unknown;
  caching_price?: unknown;
}

/** One provider that should have its model list fetched at boot. */
export interface DiscoveryTarget {
  id: string;
  cfg: ProviderConfig;
  baseUrl: string;
  apiKey?: string | undefined;
  /** Stable cache key. Shared so every host hits the same cache entries. */
  cacheKey: string;
  modelDiscoveryPath?: string | undefined;
  modelDiscoveryAuthoritative?: boolean | undefined;
}

/** Active API key from a ProviderConfig (mirrors the provider factory's resolver). */
function resolveActiveKey(cfg: ProviderConfig): string | undefined {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const active = cfg.activeKey ? cfg.apiKeys.find((k) => k.label === cfg.activeKey) : undefined;
    return (active ?? cfg.apiKeys[0])?.apiKey;
  }
  return cfg.apiKey && cfg.apiKey.length > 0 ? cfg.apiKey : undefined;
}

/**
 * Providers eligible for `/v1/models` auto-discovery, with their resolved base
 * URL and key.
 *
 * Single source of truth for BOTH hosts (CLI boot and the WebUI server). They
 * previously carried near-identical private copies whose cache keys used
 * different separators, so the two never shared a cache entry despite writing
 * to the same file.
 *
 * The preset is looked up by the config key AND by `cfg.type`, so a user alias
 * (`gateway-work` → `type: "ai-gateway"`) inherits `autoDiscover` and the
 * default base URL instead of silently opting out of discovery.
 */
export function resolveDiscoveryTargets(config: Config): DiscoveryTarget[] {
  const presets = projectCompatibleProviderPresets();
  const out: DiscoveryTarget[] = [];
  for (const [id, cfg] of Object.entries(config.providers ?? {})) {
    const preset = presets[id] ?? (cfg.type ? presets[cfg.type] : undefined);
    const enabled = cfg.autoDiscoverModels ?? preset?.autoDiscover ?? false;
    if (!enabled) continue;
    const baseUrl = cfg.baseUrl ?? preset?.defaultBaseUrl;
    if (!baseUrl) continue;
    const modelDiscoveryPath = cfg.modelDiscoveryPath ?? preset?.modelDiscoveryPath;
    const modelDiscoveryAuthoritative =
      cfg.modelDiscoveryAuthoritative ?? preset?.modelDiscoveryAuthoritative;
    out.push({
      id,
      cfg,
      baseUrl,
      apiKey: resolveActiveKey(cfg),
      cacheKey: `${id}\u0000${baseUrl}${modelDiscoveryPath ? `\u0000${modelDiscoveryPath}` : ''}`,
      ...(modelDiscoveryPath ? { modelDiscoveryPath } : {}),
      ...(modelDiscoveryAuthoritative !== undefined ? { modelDiscoveryAuthoritative } : {}),
    });
  }
  return out;
}

export interface DiscoverOptions {
  /** Server base URL, e.g. `http://localhost:20128/v1`. */
  baseUrl: string;
  /** Bearer token. Some local servers accept any value; pass what you have. */
  apiKey?: string | undefined;
  /** Extra headers merged into the request. */
  headers?: Record<string, string> | undefined;
  /** Display name for the resulting provider (defaults to the id). */
  providerName?: string | undefined;
  /** Provider-specific model-list path below baseUrl. Defaults to `models`. */
  modelDiscoveryPath?: string | undefined;
  /** Abort the fetch after this many ms (default 8000). 0 disables. */
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Tri-state capability read. `undefined` means "the source said nothing" and is
 * NOT the same as `false` — an unknown capability inherits the transport's
 * baseline downstream, whereas an explicit `false` restricts it. Collapsing the
 * two is what made every metadata-less discovered model tool-less.
 */
function asTriBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** Any `true` wins; `false` only survives when at least one source spoke. */
function foldSignals(...signals: Array<boolean | undefined>): boolean | undefined {
  let sawFalse = false;
  for (const signal of signals) {
    if (signal === true) return true;
    if (signal === false) sawFalse = true;
  }
  return sawFalse ? false : undefined;
}

/**
 * models.dev quotes cost in USD per 1M tokens; OpenRouter and the Vercel
 * Gateway both quote per-token, as strings. Normalize to the models.dev unit.
 */
function asPricePerMillion(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim().length === 0) return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  // Scaling a per-token price lands on binary-float noise
  // (`0.0000002 * 1e6 === 0.19999999999999998`), which then renders verbatim in
  // cost readouts. Six decimals is far finer than any published rate.
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

const PRICE_FIELDS: Array<[target: string, sources: string[]]> = [
  ['input', ['input', 'prompt']],
  ['output', ['output', 'completion']],
  ['cache_read', ['cachedInputTokens', 'input_cache_read']],
  ['cache_write', ['cacheCreationInputTokens', 'input_cache_write']],
];

function mapPricing(
  pricing: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (!pricing) return undefined;
  const cost: Record<string, number> = {};
  for (const [target, sources] of PRICE_FIELDS) {
    for (const source of sources) {
      const value = asPricePerMillion(pricing[source]);
      if (value !== undefined) {
        cost[target] = value;
        break;
      }
    }
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
}

/** xAI top-level prices are USD cents per 100M tokens → USD per 1M tokens. */
function mapXaiPricing(entry: CompatibleModelEntry): Record<string, number> | undefined {
  const cost: Record<string, number> = {};
  const fields: Array<[string, unknown]> = [
    ['input', entry.prompt_text_token_price],
    ['output', entry.completion_text_token_price],
    ['cache_read', entry.cached_prompt_text_token_price],
  ];
  for (const [name, raw] of fields) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) cost[name] = raw / 10_000;
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
}

/** Requesty top-level prices are per-token USD numbers → USD per 1M tokens. */
function mapRequestyPricing(entry: CompatibleModelEntry): Record<string, number> | undefined {
  const cost: Record<string, number> = {};
  const fields: Array<[string, unknown]> = [
    ['input', entry.input_price],
    ['output', entry.output_price],
    ['cache_read', entry.cached_price],
    ['cache_write', entry.caching_price],
  ];
  for (const [name, raw] of fields) {
    const value = typeof raw === 'number' ? asPricePerMillion(raw) : undefined;
    if (value !== undefined) cost[name] = value;
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function asPosInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

/** Map one `/v1/models` entry to a `ModelsDevModel`. Returns undefined when the
 *  entry has no usable id. */
export function mapCompatibleModel(entry: CompatibleModelEntry): ModelsDevModel | undefined {
  const id = typeof entry.id === 'string' ? entry.id : undefined;
  if (!id) return undefined;

  // A gateway lists far more than chat models — embeddings, image, speech,
  // video. Offering `whisper-1` in a model picker is worse than omitting it.
  const modelClass = entry.type ?? entry.modelType;
  if (typeof modelClass === 'string' && modelClass !== 'language') return undefined;
  if (typeof entry.api === 'string' && entry.api !== 'chat') return undefined;

  const caps = entry.capabilities ?? {};
  const inputModalities =
    asStringArray(entry.input_modalities) ??
    asStringArray(entry.modalities?.input) ??
    asStringArray(entry.architecture?.input_modalities);
  const outputModalities =
    asStringArray(entry.output_modalities) ??
    asStringArray(entry.modalities?.output) ??
    asStringArray(entry.architecture?.output_modalities);
  if (outputModalities && !outputModalities.includes('text')) return undefined;

  const params = asStringArray(entry.supported_parameters);
  const vision = foldSignals(
    asTriBool(caps.vision),
    asTriBool(entry.supports_vision),
    inputModalities ? inputModalities.includes('image') : undefined,
  );
  const context =
    asPosInt(entry.context_length) ??
    asPosInt(entry.context_window) ??
    asPosInt(entry.max_input_tokens) ??
    asPosInt(entry.top_provider?.context_length);
  const output =
    asPosInt(entry.max_output_tokens) ??
    asPosInt(entry.max_tokens) ??
    asPosInt(entry.top_provider?.max_completion_tokens);

  const toolCall = foldSignals(
    asTriBool(caps.tool_calling),
    asTriBool(caps.tools),
    asTriBool(entry.supports_tool_calling),
    params ? params.includes('tools') || params.includes('tool_choice') : undefined,
  );
  // omniroute splits these: `reasoning` (effort) and `thinking` (extended).
  // Either implies the model can reason for capability purposes.
  const reasoning = foldSignals(
    asTriBool(caps.reasoning),
    asTriBool(caps.thinking),
    asTriBool(entry.supports_reasoning),
    params ? params.includes('reasoning') || params.includes('include_reasoning') : undefined,
  );
  const temperature = foldSignals(
    asTriBool(caps.temperature),
    params ? params.includes('temperature') : undefined,
  );

  const model: ModelsDevModel = {
    id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : id,
    // Only assert what the source actually stated — see `asTriBool`.
    ...(toolCall !== undefined ? { tool_call: toolCall } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(typeof entry.description === 'string' && entry.description
      ? { description: entry.description }
      : {}),
  };
  if (inputModalities || outputModalities || vision !== undefined) {
    const input = inputModalities ?? (vision ? ['text', 'image'] : ['text']);
    model.modalities = {
      input: vision && !input.includes('image') ? [...input, 'image'] : input,
      output: outputModalities ?? ['text'],
    };
  }
  if (context !== undefined || output !== undefined) {
    model.limit = {
      ...(context !== undefined ? { context } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }
  const cost = mapPricing(entry.pricing) ?? mapXaiPricing(entry) ?? mapRequestyPricing(entry);
  if (cost) model.cost = cost;
  if (typeof entry.created === 'number' && entry.created > 0) {
    // ISO date helps the picker's newest-first sort.
    model.last_updated = new Date(entry.created * 1000).toISOString().slice(0, 10);
  }
  return model;
}

/**
 * Fetch and map a `/v1/models` listing into a `ModelsDevProvider`. Resolves to
 * `undefined` (never throws) on any network/parse/shape failure or an empty
 * list, so callers can treat discovery as best-effort and fall back to a cache.
 */
export async function discoverOpenAICompatibleModels(
  providerId: string,
  opts: DiscoverOptions,
): Promise<ModelsDevProvider | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const modelPath = (opts.modelDiscoveryPath ?? 'models').replace(/^\/+/, '');
  const url = /\/v\d+$/i.test(base) ? `${base}/${modelPath}` : `${base}/v1/${modelPath}`;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    // Via `redirectSafeFetch`, not bare `fetch` (WS-084). This request carries
    // `authorization` plus any configured custom headers, and the default
    // `redirect: 'follow'` would replay them to whatever host a 302 named — so
    // a gateway that redirects hands the caller's API key to the redirect
    // target. `wire-adapter.ts` and `openai-codex.ts` already route through
    // this helper; discovery never adopted it.
    const res = await redirectSafeFetch(fetchImpl, url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        ...opts.headers,
      },
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: unknown; models?: unknown } | unknown;
    const list = Array.isArray(json)
      ? json
      : Array.isArray((json as { data?: unknown })?.data)
        ? (json as { data: unknown[] }).data
        : Array.isArray((json as { models?: unknown })?.models)
          ? (json as { models: unknown[] }).models
          : undefined;
    if (!list) return undefined;
    const models: Record<string, ModelsDevModel> = {};
    for (const raw of list) {
      const mapped = mapCompatibleModel((raw ?? {}) as CompatibleModelEntry);
      if (mapped) models[mapped.id] = mapped;
    }
    if (Object.keys(models).length === 0) return undefined;
    return {
      id: providerId,
      name: opts.providerName ?? providerId,
      // Classifies to the openai-compatible wire family in the registry.
      npm: '@ai-sdk/openai-compatible',
      api: base,
      env: [],
      models,
    };
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
