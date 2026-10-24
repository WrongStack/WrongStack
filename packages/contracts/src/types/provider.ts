import type { ContentBlock, TextBlock } from './blocks.js';
import type { ImageGenerationRequest, ImageGenerationResult } from './image-generation.js';
import type { Message } from './messages.js';
import type { Tool } from './tool.js';

export { isSafetyPolicyCode } from './provider-error-codes.js';
export type { ProviderErrorBody, ProviderErrorKind } from './provider-errors.js';
export {
  classifyProviderError,
  isContextOverflowShaped,
  isFallbackWorthy,
  isRetryableKind,
  isSafetyPolicyRefusal,
  MAX_RESET_HINT_MS,
  ProviderError,
  parseResetHintMs,
  SAFETY_POLICY_GUIDANCE,
  StreamHangError,
} from './provider-errors.js';

/**
 * Token usage for a single provider call, normalized across providers.
 *
 * Disjoint semantics: the four fields never overlap. `input` is the count
 * of FRESH input tokens (billed at the full input rate); `cacheRead` and
 * `cacheWrite` are separate cached subsets each priced at their own rate.
 * The total context the model loaded for this turn is
 * `input + (cacheRead ?? 0) + (cacheWrite ?? 0)`.
 *
 * Provider quirks normalized at the adapter layer:
 *  - Anthropic: returns `input_tokens` already disjoint from cache fields.
 *  - OpenAI / OpenAI-compatible: `prompt_tokens` is the TOTAL including
 *    cached portion; the adapter subtracts `cached_tokens` to stay disjoint.
 *  - Google: `promptTokenCount` likewise includes cache; adapter subtracts
 *    `cachedContentTokenCount`.
 *
 * Cost math and the context-fullness chip both depend on the disjoint
 * invariant — a TOTAL `input` plus a separate `cacheRead` count would bill
 * cached tokens twice and skew cache-hit-ratio reporting.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The canonical runtime list of {@link ReasoningEffort} values, in
 * menu/display order. Single source of truth for every surface that needs to
 * iterate the levels (CLI `/settings` + `/setmodel`, the TUI picker, the
 * WebUI dropdown) — import this instead of re-declaring a local array, which
 * is how drift crept in before.
 *
 * `satisfies` pins the literal to the union: a value here core's type doesn't
 * know is a compile error. Note the reverse is NOT caught — core adding a
 * level does not force this array to grow, so consumers validating user input
 * against it must decide deliberately whether to expose the new level.
 */
export const REASONING_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

/** Type guard for untrusted strings (CLI args, WS payloads, config files). */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === 'string' && (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

export type CacheTtl = '5m' | '1h';

/**
 * Provider-agnostic response-format directive.
 *
 * - `{ type: 'text' }` — free-form text (default).
 * - `{ type: 'json_object' }` — valid JSON without a schema constraint.
 * - `{ type: 'json_schema', jsonSchema: { name, schema, strict? } }` — JSON
 *   constrained to the supplied JSON Schema. The `strict` flag is
 *   OpenAI-specific; Gemini ignores it in favour of `responseMimeType`.
 *
 * Each provider adapter maps this into its own wire format:
 *   OpenAI  → `response_format`
 *   Gemini  → `responseMimeType` + `responseSchema`
 *   Anthropic → (not yet supported; uses tools for structured output)
 */
export interface JsonSchemaSpec {
  name: string;
  /** OpenAI-specific: enable strict schema adherence. */
  strict?: boolean | undefined;
  /** The JSON Schema object describing the expected shape. */
  schema: Record<string, unknown>;
  /** Optional human-readable description (OpenAI). */
  description?: string | undefined;
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; jsonSchema: JsonSchemaSpec };

/**
 * Safety category threshold pair used by Google Gemini's `safetySettings`.
 *
 * Categories: `HARM_CATEGORY_HARASSMENT`, `HARM_CATEGORY_HATE_SPEECH`,
 * `HARM_CATEGORY_SEXUALLY_EXPLICIT`, `HARM_CATEGORY_DANGEROUS_CONTENT`.
 *
 * Thresholds: `BLOCK_NONE`, `BLOCK_ONLY_HIGH`, `BLOCK_MEDIUM_AND_ABOVE`,
 * `BLOCK_LOW_AND_ABOVE`.
 */
export interface SafetySetting {
  category: string;
  threshold: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  /** Back-compat aggregate of all cache-write tokens. Prefer TTL-specific fields when present. */
  cacheWrite?: number | undefined;
  cacheWrite5m?: number | undefined;
  cacheWrite1h?: number | undefined;
}

/**
 * Effective prompt tokens loaded by the model for one request.
 *
 * Provider adapters normalize `Usage` to disjoint fields: `input` is fresh
 * full-rate tokens, `cacheRead` is cached prefix tokens, and `cacheWrite` is
 * the cache-written prefix segment. Context-window pressure cares about the
 * full prompt the model saw, not only the bill-at-full-rate slice.
 */
export function effectiveInputTokens(usage: Usage): number {
  return usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** Prompt tokens that were not served by a cache read. */
export function freshInputTokens(usage: Usage): number {
  return Math.max(0, effectiveInputTokens(usage) - (usage.cacheRead ?? 0));
}

/**
 * Every token this request moved — the complete prompt the model loaded plus
 * what it generated.
 *
 * The single definition of `SessionSummary.tokenTotal`. Three call sites
 * compute that field (the live writer's tracker, the disk-rebuild summary
 * builder, and the SQLite catalog's transcript summarizer) and they had
 * drifted: two summed only `input + output` while the third also counted the
 * cache buckets. With prompt caching on, `cacheRead` is the bulk of a real
 * prompt, so the narrow reading under-reported long sessions by more than an
 * order of magnitude — one measured session listed 118,719 tokens against an
 * actual 2,466,978. Route every tokenTotal through here so the three cannot
 * disagree again.
 */
export function totalUsageTokens(usage: Usage): number {
  return effectiveInputTokens(usage) + usage.output;
}

/**
 * Cache-read share of the complete prompt context, normalized to [0, 1].
 *
 * Keeping the clamp at the shared telemetry boundary protects every UI from
 * malformed/hybrid gateway counters while provider adapters preserve the
 * real total context in the disjoint Usage buckets.
 */
export function promptCacheHitRatio(usage: Usage): number {
  const total = effectiveInputTokens(usage);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const cached = Number.isFinite(usage.cacheRead) ? Math.max(0, usage.cacheRead ?? 0) : 0;
  return Math.min(1, cached / total);
}

export interface ReasoningRequest {
  enabled?: boolean | undefined;
  effort?: ReasoningEffort | undefined;
  preserve?: boolean | undefined;
  display?: 'summarized' | 'omitted' | undefined;
}

export interface RequestCacheControl {
  ttl?: CacheTtl | undefined;
  /**
   * Provider-agnostic cache-partition key. A stable hash of the cacheable
   * system-prompt prefix (see `deriveCachePrefixKey`); requests sharing a prefix
   * share a key so provider backends route them to the same automatic-cache
   * partition. Consumed by OpenAI-family wires as `prompt_cache_key`; ignored by
   * Anthropic (which uses `ttl` + explicit `cache_control` markers).
   */
  key?: string | undefined;
  /**
   * Stable owning conversation id for transports that use connection/session
   * affinity to route prompt-cache reads. This is transport metadata, never a
   * model-request field.
   */
  sessionId?: string | undefined;
  /**
   * Thread-local transport identity. A root conversation normally uses the
   * same value as `sessionId`; child agents keep the root `sessionId` for the
   * shared prompt-cache partition while using their own thread id for sticky
   * routing and request identity.
   */
  threadId?: string | undefined;
  /**
   * Opt-in flag (from `ModelRuntimeCacheConfig.geminiExplicit`) telling the
   * Google provider to use explicit `cachedContents` for this request. Ignored
   * by other providers.
   */
  geminiExplicit?: boolean | undefined;
  /**
   * Resolved Gemini `cachedContents/*` resource name, injected by
   * `GoogleProvider.stream()` after it creates/reuses the cache. When present,
   * the Google wire sends `cachedContent` and OMITS the (now-cached) system
   * instruction + tool defs from the live body. Internal — never set by callers.
   */
  geminiCachedContentName?: string | undefined;
}

export interface ReasoningConfig {
  default: 'enabled' | 'disabled' | 'adaptive' | 'always_on';
  disableSupported: boolean;
  /**
   * Tri-state effort support:
   *   `true`      — the catalog documents this model's effort levels
   *                 (`effortLevels` is authoritative).
   *   `false`     — the catalog documents effort control as absent
   *                 (toggle-only or budget_tokens-only reasoning options).
   *   `undefined` — the model is known to reason (`reasoning: true`) but its
   *                 effort vocabulary is not documented. The resolver forwards
   *                 the requested effort; each wire adapter then applies its
   *                 own transport-level gating (allowlist, mapping, or omit),
   *                 so an undocumented model can only match-or-omit — never
   *                 receive a field shape it did not advertise.
   */
  effortSupported?: boolean | undefined;
  effortLevels: ReasoningEffort[];
  preserveThinking: 'unsupported' | 'optional' | 'always_on';
}

export interface Capabilities {
  tools: boolean;
  parallelTools: boolean;
  vision: boolean;
  /** Accepts PDF documents natively (catalog `modalities.input` lists `pdf`). */
  pdf?: boolean | undefined;
  streaming: boolean;
  promptCache: boolean;
  systemPrompt: boolean;
  jsonMode: boolean;
  reasoning: boolean;
  maxContext: number;
  /**
   * Maximum output tokens the model can produce in a single response.
   * Used as the default for `Request.maxTokens` when the caller doesn't
   * supply an explicit value — letting subagents run up to the model's
   * native ceiling instead of a fixed 8192 cap. Omit (undefined) to fall
   * back to a conservative default; populate per family in
   * `family-capabilities.ts` once you know the spec.
   */
  maxOutput?: number | undefined;
  cacheControl: 'native' | 'auto' | 'none';

  // ── Extended parameter support (optional; family defaults in CAPABILITIES_BY_FAMILY) ──

  /** Model accepts `top_k` / `topK` sampling parameter. */
  topK?: boolean | undefined;
  /** Model accepts `frequency_penalty` / `frequencyPenalty` parameter. */
  frequencyPenalty?: boolean | undefined;
  /** Model accepts `presence_penalty` / `presencePenalty` parameter. */
  presencePenalty?: boolean | undefined;
  /** Model accepts `seed` parameter for deterministic generation. */
  seed?: boolean | undefined;
  /**
   * Model accepts JSON Schema / structured-output constraints
   * (OpenAI `response_format.json_schema`, Gemini `responseMimeType`+`responseSchema`).
   * Distinct from `jsonMode` (which is just a system-prompt hint).
   */
  structuredOutput?: boolean | undefined;
  /** Model supports log-probability output (`logprobs`, `top_logprobs`). */
  logprobs?: boolean | undefined;
  /** Model supports audio input/output modality. */
  audio?: boolean | undefined;
  /** Model supports the `n` parameter for multiple completions. */
  multipleCompletions?: boolean | undefined;
  /**
   * The provider is an agent that keeps its own conversation (an ACP agent
   * leading the session): the messages WrongStack holds are a transcript of
   * it, not what the model sees. Context fill comes from the agent's own
   * report (`Response.agentContext`), and WrongStack never compacts or trims
   * the transcript to fit a window it does not fill.
   */
  keepsOwnContext?: boolean | undefined;
}

/** The context an agent provider holds itself, as the agent reports it. */
export interface AgentContextUsage {
  /** Tokens in the agent's context now. */
  used: number;
  /** The agent's context window; 0 when it did not say. */
  size: number;
}

export interface Request {
  model: string;
  system?: TextBlock[] | undefined;
  messages: Message[];
  tools?: Tool[] | undefined;
  /**
   * Cap on output tokens for this single response. Optional — when
   * omitted, the provider adapter falls back to its own
   * `capabilities.maxOutput` (which the catalog populates from
   * `ModelsDevModel.limit.output`). If neither is available, the
   * adapter applies a conservative 8192 safety net. Letting this stay
   * undefined at the call site means callers like Chimera can hand the
   * model its native output ceiling without hard-coding a number.
   */
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  frequencyPenalty?: number | undefined;
  presencePenalty?: number | undefined;
  seed?: number | undefined;
  /**
   * End-user identifier for abuse monitoring and per-user rate limiting.
   * - Anthropic → `metadata.user_id`
   * - OpenAI   → `user`
   * - Gemini   → (not supported)
   */
  user?: string | undefined;
  /**
   * Number of response candidates to generate. Google Gemini supports
   * this via `generationConfig.candidateCount`. OpenAI does not have
   * an equivalent (`n` is conceptually similar but distinct).
   */
  candidateCount?: number | undefined;
  /**
   * Whether to return log probabilities for output tokens.
   * - OpenAI → `logprobs: boolean` (+ `topLogprobs: number`)
   * - Gemini → `generationConfig.logprobs: number` (how many top candidates)
   * Default undefined = no logprobs requested.
   */
  logprobs?: boolean | undefined;
  /**
   * Number of most probable tokens to return log probabilities for
   * (OpenAI `top_logprobs`). Only meaningful when `logprobs` is true.
   * Range: 0-20. Gemini ignores this (uses `logprobs` as the count).
   */
  topLogprobs?: number | undefined;
  stopSequences?: string[] | undefined;
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool' | undefined; name: string };
  reasoning?: ReasoningRequest | undefined;
  cache?: RequestCacheControl | undefined;
  /**
   * Structured-output / response-format directive.
   * When set, the provider adapter maps this to its native response-format
   * parameter (OpenAI `response_format`, Gemini `responseMimeType`, etc.).
   * The model must advertise `capabilities.structuredOutput` for this to be
   * honoured; unsupported models will likely 400 or ignore it.
   */
  responseFormat?: ResponseFormat | undefined;
  /**
   * Safety category thresholds for filtering harmful content.
   * - Gemini → top-level `safetySettings` array with `{ category, threshold }`
   * - OpenAI → not supported (uses server-side moderation)
   * - Anthropic → not supported
   */
  safetySettings?: SafetySetting[] | undefined;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface Response {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
  /**
   * A provider that keeps its own context (`Capabilities.keepsOwnContext`):
   * the context it holds after this response. `usage` stays what the response
   * spent, which for an agent's turn is the sum of every model call in it.
   */
  agentContext?: AgentContextUsage | undefined;
  /** The backend served another model than the requested one (provider-reported, never inferred). */
  rerouted?: { requested: string; served: string; reason?: string | undefined } | undefined;
}

export type StreamEvent =
  | { type: 'message_start'; model: string }
  | { type: 'model_rerouted'; requested: string; served: string; reason?: string | undefined }
  | {
      type: 'content_block_start';
      kind: 'text' | 'tool_use' | 'thinking';
      id?: string | undefined;
      name?: string | undefined;
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partial: string }
  | { type: 'tool_use_stop'; id: string; input: unknown; providerMeta?: Record<string, unknown> }
  | { type: 'thinking_start'; providerMeta?: Record<string, unknown> }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_signature'; signature: string }
  /**
   * Provider-specific metadata for the reasoning block currently streaming,
   * delivered when the provider only reveals it as the block closes (the Codex
   * Responses wire hands back `reasoning.encrypted_content` on
   * `output_item.done`, not on `added`). Merged into the block's
   * `providerMeta`; unlike `thinking_signature` it carries no cross-provider
   * meaning, so a wire that does not understand the keys simply drops them.
   */
  | { type: 'thinking_meta'; providerMeta: Record<string, unknown> }
  | { type: 'thinking_stop' }
  | {
      type: 'message_stop';
      stopReason: StopReason;
      usage: Usage;
      agentContext?: AgentContextUsage | undefined;
    };

export interface ProviderContextLimit {
  /** Provider-authoritative context ceiling for the selected route/model. */
  maxContext: number;
  /** Origin of the live value, surfaced in diagnostics and UI warnings. */
  source: 'provider';
}

export interface Provider {
  readonly id: string;
  readonly capabilities: Capabilities;
  /**
   * Resolve the tools this provider can send before prompt composition and
   * context accounting. Preserve array identity while the selection is unchanged.
   * Providers without a tool-count restriction may omit this hook.
   */
  selectToolsForRequest?(tools: Tool[]): Tool[];
  /**
   * Optional live capability probe. The agent calls this at request boundaries
   * before context-window middleware runs, allowing a provider-side limit
   * decrease to trigger compaction before the oversized request is sent.
   * Implementations must fail open (return undefined) on transient discovery
   * failures and retain their last verified value locally.
   */
  refreshContextLimit?(
    model: string,
    opts: { signal: AbortSignal },
  ): Promise<ProviderContextLimit | undefined>;
  /**
   * Optional connection warm-up for `model`'s endpoint, called while the user
   * is still composing a prompt so DNS, TCP and TLS are done before the real
   * request. Best-effort and throttled by the implementation: it never throws
   * and never costs tokens.
   */
  warm?(model: string): Promise<void>;
  /**
   * A provider that keeps its own context (`capabilities.keepsOwnContext`)
   * compacts it when asked: `/compact` on that route. Resolves to the
   * context the agent holds afterwards, when it reports one.
   */
  compactOwnContext?(opts: {
    sessionId: string;
    signal: AbortSignal;
  }): Promise<AgentContextUsage | undefined>;
  /**
   * Optional text-to-image generation, on the wires that have an image API
   * (OpenAI images, Gemini). Absent means this provider cannot draw.
   */
  generateImage?(
    req: ImageGenerationRequest,
    opts: { signal: AbortSignal },
  ): Promise<ImageGenerationResult>;
  /** Canonical streaming entry point. `complete()` defaults to a wrapper that
   * aggregates this stream — providers may override for non-streaming wires. */
  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent>;
  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response>;
}
