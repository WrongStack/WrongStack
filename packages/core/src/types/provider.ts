import { truncate } from '../utils/string.js';
import type { ContentBlock, TextBlock } from './blocks.js';
import type { ErrorCode } from './errors.js';
import { ERROR_CODES, WrongStackError } from './errors.js';
import type { Message } from './messages.js';
import { QUOTA_EXHAUSTED_RE } from './quota-regex.js';
import type { Tool } from './tool.js';

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
}

export type StreamEvent =
  | { type: 'message_start'; model: string }
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
  | { type: 'thinking_stop' }
  | { type: 'message_stop'; stopReason: StopReason; usage: Usage };

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
  /** Canonical streaming entry point. `complete()` defaults to a wrapper that
   * aggregates this stream — providers may override for non-streaming wires. */
  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent>;
  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response>;
}

/**
 * Structured body parsed from a provider's HTTP error response. Populated
 * best-effort: providers return JSON shaped differently (Anthropic uses
 * `{error: {type, message}}`, OpenAI uses `{error: {message, code}}`,
 * Google uses `{error: {status, message}}`), so the fields here are the
 * intersection that's usable for rendering and routing.
 */
export interface ProviderErrorBody {
  /** Provider-specific kind, e.g. "overloaded_error", "rate_limit_error", "invalid_request_error". */
  type?: string | undefined;
  /** Human-readable explanation from the provider. */
  message?: string | undefined;
  /** Provider request id, when present in the body or headers. */
  requestId?: string | undefined;
  /** Parsed Retry-After header (or equivalent body hint) in milliseconds. */
  retryAfterMs?: number | undefined;
  /** The raw response body (truncated to ~2 KB), kept for debugging. */
  raw?: string | undefined;
  /** True when `raw` was truncated; check `rawLength` for the original size. */
  truncated?: boolean | undefined;
  /** Original length of the response body in bytes, when `truncated` is true. */
  rawLength?: number | undefined;
}

/**
 * Canonical provider-failure taxonomy. Computed ONCE at error-construction
 * time (`classifyProviderError`) and carried on `ProviderError.kind` so
 * every downstream consumer — retry policy, cross-provider fallback,
 * recovery strategies, the subagent error classifier — branches on the
 * same classification instead of re-deriving it from status codes and
 * message regexes. When a new provider's error format needs special
 * handling, this module is the only place to teach it.
 */
export type ProviderErrorKind =
  | 'rate_limit' // 429 / rate_limit_error — back off (honour Retry-After), then failover
  | 'quota_exhausted' // credits/plan depleted — do not retry same route; fail over immediately
  | 'overloaded' // 529 / overloaded_error — retry with backoff, then failover
  | 'server' // other 5xx — retry same provider
  | 'timeout' // 408 request timeout
  | 'network' // status 0 — connection/DNS failure before a response arrived
  | 'stream_hang' // 599 sentinel — stream stalled mid-response (StreamHangError)
  | 'auth' // 401/403 — key invalid/expired; retrying without action is pointless
  | 'context_overflow' // 413 or an overflow-shaped 4xx — compact, don't retry as-is
  | 'content_filter' // provider refused on policy grounds — a sibling model may pass, but the `content_filter_reroute` recovery strategy owns that hop, NOT the fallback engine (which surfaces this kind)
  | 'invalid_request' // other 4xx — request is malformed; retrying won't help
  | 'unknown';

/**
 * Overflow-shaped provider messages. Union of the patterns previously
 * scattered across `error-handler.ts` and `coordinator/error-classifier.ts`
 * (which had drifted apart) — keep additions here, nowhere else.
 */
const CONTEXT_OVERFLOW_RE =
  /context.length|context.window|maximum context|max.*tokens?.*exceeded|(?:prompt|request|input|messages?).{0,12}too (?:large|long)|exceeds the context|\btokens\b.*exceed|too many tokens|reduce the length|resulted in \d+ tokens|context_length_exceeded/i;

/** Content-policy refusals surfaced as HTTP errors (Azure/OpenAI `content_filter`, etc.). */
const CONTENT_FILTER_RE = /content.(filter|policy|moderation)|safety (system|filter)/i;
/** "rate limit exceeded" pattern — checked against body.message only, NOT the
 *  raw JSON text, because OpenAI's `"code":"rate_limit_exceeded"` field would
 *  produce a false positive in the combined-text regex. */
const RATE_LIMIT_EXCEEDED_RE = /rate[-_\s]*limit[-_\s]*exceeded/i;

/**
 * Classify a provider HTTP failure into the canonical taxonomy from its
 * status code plus the parsed error body (and, for message-only errors
 * without a structured body, the error message itself). Pure and total —
 * always returns a kind, never throws.
 */
export function classifyProviderError(
  status: number,
  body?: ProviderErrorBody,
  message?: string,
): ProviderErrorKind {
  const type = body?.type;
  const text = [message, body?.message, type, body?.raw].filter(Boolean).join('\n');
  if (status === 0) return 'network';
  if (status === 408) return 'timeout';
  if (status === 599) return 'stream_hang';
  // Belt-and-suspenders quota check FIRST. Many providers (Kimi, Z.AI,
  // Moonshot) answer a hard billing-cycle limit with HTTP 403 and a prose
  // message like "You've reached your usage limit for this billing cycle" or
  // "Your quota will be refreshed in the next cycle".  We must classify these
  // as quota_exhausted (→ 15-min blocked) rather than auth (→ 5-failure chain).
  // The QUOTA_EXHAUSTED_RE regex catches the message text regardless of the
  // HTTP status code, so this guard must run before the 401/403 auth branch.
  if (QUOTA_EXHAUSTED_RE.test(text)) return 'quota_exhausted';
  if (status === 402) return 'quota_exhausted';
  // A 429 that carries a hard-limit message (vs a burst rate-limit) is
  // also quota-exhausted: only check body.message so we don't false-positive
  // on OpenAI's raw JSON (which contains "rate_limit_exceeded" in the code
  // field even for transient 429s).
  if (
    status === 429 &&
    body?.message &&
    body.type !== 'rate_limit_exceeded' &&
    RATE_LIMIT_EXCEEDED_RE.test(body.message)
  ) {
    return 'quota_exhausted';
  }
  // Transient rate limits and server-side overloads come before the auth guard.
  if (type === 'rate_limit_error' || status === 429) return 'rate_limit';
  if (type === 'overloaded_error' || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  // Auth / permission failures — the 403 limb now only fires when the message
  // was NOT a quota/retry message (the QUOTA_EXHAUSTED_RE check above already
  // handled that case). A real 403 "permission denied" is non-retryable.
  if (
    type === 'authentication_error' ||
    type === 'permission_error' ||
    status === 401 ||
    status === 403
  ) {
    return 'auth';
  }
  if (type === 'content_filter' || CONTENT_FILTER_RE.test(text)) return 'content_filter';
  if (status === 413 || (status >= 400 && CONTEXT_OVERFLOW_RE.test(text))) {
    return 'context_overflow';
  }
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

// ── Prose reset-hint parsing ────────────────────────────────────────────────
//
// Many providers answer an exhausted hourly/daily/weekly/monthly budget with
// a 429/402 whose *message prose* says when the limit resets — e.g.
//   "Please try again in 6h12m"                      (OpenAI, Go durations)
//   "usage limit reached; resets in 2 hours"         (plan-cap notices)
//   "Your usage limit resets at 2026-07-28T00:00:00Z" (weekly caps)
// When no structured `Retry-After` header was captured into
// `ProviderErrorBody.retryAfterMs`, the waiting room should still honor the
// provider-published reset instead of falling back to a fixed default block
// (which probes a weekly cap every 15 minutes).
//
// `parseResetHintMs` extracts that hint. It is deliberately conservative:
// only text following an explicit lead-in ("try again in", "retry after",
// "reset(s) in/at/on", "available in") is parsed, garbage yields `undefined`,
// and any parsed delay is clamped to `MAX_RESET_HINT_MS` so a corrupt or
// absurd message cannot park a model forever (manual `retryNow()` and the
// periodic sweep remain the escape hatches).

/** Upper bound for any prose-parsed reset delay: 7 days. */
export const MAX_RESET_HINT_MS = 7 * 24 * 60 * 60 * 1_000;

const RESET_HINT_LEAD_RE =
  /(?:try again|retry|resets?|resetting|available|returns?|back online|usable again)\s+(?:in|after)\s+/i;
const RESET_AT_LEAD_RE = /resets?\s+(?:at|on)\s+/i;

/** Longest-unit-first so `minutes` wins over `m`; `(?![a-z])` keeps `12m0.5s` compound durations intact. */
const DURATION_TOKEN_RE =
  /(\d+(?:\.\d+)?)\s*(ms|secs?|seconds?|s|mins?|minutes?|m|hrs?|hours?|h|days?|d)(?![a-z])/gi;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u === 'ms') return 1;
  if (u.startsWith('s')) return UNIT_MS['s']!;
  if (u.startsWith('m')) return UNIT_MS['m']!;
  if (u.startsWith('h')) return UNIT_MS['h']!;
  return UNIT_MS['d']!;
}

const ISO_TIMESTAMP_RE =
  /(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT))?)?)/i;

/**
 * Parse a prose reset/retry hint from a provider error message into
 * milliseconds-from-`now`. Returns `undefined` when no usable hint exists.
 *
 * @param message - Provider error message (body.message / error text).
 * @param now - Reference timestamp (ms epoch); injectable for tests.
 */
export function parseResetHintMs(message: string, now: number = Date.now()): number | undefined {
  if (!message) return undefined;

  // 1. Relative duration: "try again in 6h12m", "retry after 90 seconds",
  //    "resets in 2 hours", "available in 1 day".
  const lead = RESET_HINT_LEAD_RE.exec(message);
  if (lead) {
    const window = message.slice(lead.index + lead[0].length, lead.index + lead[0].length + 80);
    let total = 0;
    let matched = false;
    DURATION_TOKEN_RE.lastIndex = 0;
    for (let m = DURATION_TOKEN_RE.exec(window); m; m = DURATION_TOKEN_RE.exec(window)) {
      const value = Number.parseFloat(m[1]!);
      if (Number.isFinite(value) && value > 0) {
        total += value * unitMs(m[2]!);
        matched = true;
      }
    }
    // Bare-word units: "try again in an hour" / "retry after a minute".
    if (!matched) {
      const bare = /^(?:an?\s+)?(second|minute|hour|day)\b/i.exec(window.trim());
      if (bare) {
        total = unitMs(bare[1]!);
        matched = true;
      }
    }
    if (matched && total > 0) {
      return Math.min(total, MAX_RESET_HINT_MS);
    }
  }

  // 2. Absolute timestamp: "resets at 2026-07-28T00:00:00Z",
  //    "reset on 2026-08-01 00:00 UTC".
  const atLead = RESET_AT_LEAD_RE.exec(message);
  if (atLead) {
    const window = message.slice(atLead.index + atLead[0].length);
    const iso = ISO_TIMESTAMP_RE.exec(window);
    if (iso) {
      // Normalize "2026-08-01 00:00 UTC" → "2026-08-01T00:00Z" so Date.parse
      // is deterministic across JS engines.
      const normalized = iso[1]!
        .replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2')
        .replace(/\s*(UTC|GMT)$/i, 'Z');
      const ts = Date.parse(normalized);
      if (Number.isFinite(ts) && ts > now) {
        return Math.min(ts - now, MAX_RESET_HINT_MS);
      }
    }
  }

  return undefined;
}

/**
 * Whether a kind is worth retrying against the SAME provider/model.
 * `context_overflow` is deliberately false — the request must shrink first;
 * `auth`/`invalid_request`/`content_filter` won't improve on replay.
 *
 * Exhaustive by construction (`Record<ProviderErrorKind, …>`): adding a new
 * kind refuses to compile until it is classified here. Every kind→X mapping
 * in the codebase follows this drift-guard pattern — see also KIND_TO_CODE
 * below, DefaultRetryPolicy.maxAttempts, fallback-model shouldFallback, and
 * the coordinator's providerErrorToSubagentError.
 */
export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE_BY_KIND[kind];
}

const RETRYABLE_BY_KIND: Record<ProviderErrorKind, boolean> = {
  rate_limit: true,
  quota_exhausted: false,
  overloaded: true,
  server: true,
  timeout: true,
  network: true,
  stream_hang: true,
  auth: false,
  context_overflow: false,
  content_filter: false,
  invalid_request: false,
  unknown: false,
};

/**
 * Whether a kind is worth HOPPING to a different provider/model — the gate for
 * the cross-provider fallback engine (agent-loop extension AND the one-shot
 * orchestrator both branch on this ONE table, so their behavior can't drift).
 *
 * A distinct question from {@link isRetryableKind} (retry the SAME model):
 * a hop only helps for capacity/transport failures. Request-shaped failures
 * surface instead — `context_overflow` needs compaction, `content_filter` is
 * owned by the `content_filter_reroute` recovery strategy, and `auth` /
 * `invalid_request` are user-actionable and would fail identically on a hop.
 * The value set is currently identical to the retryable set, but it is kept as
 * its own table on purpose: the two answer different questions and may diverge.
 *
 * Exhaustive by construction (`Record<ProviderErrorKind, …>`) — a new kind
 * refuses to compile until it is classified here.
 */
export function isFallbackWorthy(kind: ProviderErrorKind): boolean {
  return FALLBACK_WORTHY_BY_KIND[kind];
}

const FALLBACK_WORTHY_BY_KIND: Record<ProviderErrorKind, boolean> = {
  rate_limit: true,
  quota_exhausted: true,
  overloaded: true,
  server: true,
  timeout: true,
  network: true,
  stream_hang: true,
  auth: false,
  context_overflow: false,
  content_filter: false,
  invalid_request: false,
  unknown: false,
};

export class ProviderError extends WrongStackError {
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly providerId: string;
  /** Canonical failure classification — see {@link ProviderErrorKind}. */
  public readonly kind: ProviderErrorKind;
  public readonly body?: ProviderErrorBody | undefined;

  /**
   * Duck-type guard: checks whether an unknown value *looks like* a
   * ProviderError by probing for its structural properties.  Use this
   * anywhere the constructor identity might cross a package boundary
   * (e.g. `@wrongstack/providers` creates the error, but the runner in
   * `@wrongstack/core` checks it). A plain `instanceof ProviderError`
   * can fail when npm hoists duplicate copies of `@wrongstack/core`,
   * each with its own class identity.
   *
   * The check tests for the four invariant properties defined in the
   * constructor: `name === 'ProviderError'`, `status` (number),
   * `retryable` (boolean), and `kind` (string). This tolerates both
   * true `ProviderError` instances and cross-boundary copies.
   */
  static isProviderError(err: unknown): err is ProviderError {
    if (!err || typeof err !== 'object') return false;
    const e = err as Record<string, unknown>;
    // Accept both ProviderError and its subclasses (e.g. StreamHangError) by
    // checking for the structural invariant properties defined in the
    // constructor. The `name` check accepts 'ProviderError' and any subclass
    // name that ends with 'Error' — this tolerates both true instances and
    // cross-boundary copies where instanceof may fail due to npm hoisting.
    const name = e.name;
    if (typeof name !== 'string' || !name.endsWith('Error')) return false;
    return (
      typeof e.status === 'number' &&
      typeof e.retryable === 'boolean' &&
      typeof e.kind === 'string' &&
      typeof e.describe === 'function'
    );
  }

  constructor(
    message: string,
    status: number,
    retryable: boolean,
    providerId: string,
    opts: {
      body?: ProviderErrorBody | undefined;
      cause?: unknown | undefined;
      /** Override the computed classification (rarely needed — tests, custom wires). */
      kind?: ProviderErrorKind | undefined;
    } = {},
  ) {
    const kind = opts.kind ?? classifyProviderError(status, opts.body, message);
    super({
      message,
      code: kindToCode(kind),
      subsystem: 'provider',
      severity: status >= 500 ? 'error' : 'warning',
      recoverable: retryable,
      context: { providerId, status },
      cause: opts.cause,
    });
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.providerId = providerId;
    this.kind = kind;
    this.body = opts.body;
  }

  /**
   * Render a one-line, user-facing description. Designed for the CLI/TUI
   * status line and the agent's retry warning. Avoids dumping raw JSON
   * (which is what users see today when a 529 lands and the log message
   * includes the full `{"type":"error",...}` body).
   *
   * Examples:
   *   "minimax-coding-plan overloaded (529): High traffic detected. Upgrade for highspeed model. [req 06534785201de9c0…]"
   *   "openai rate limited (429): Retry after 12s"
   *   "anthropic invalid request (400): messages.0.role must be one of 'user'|'assistant'"
   *   "groq HTTP 500 (server error)"
   */
  override describe(): string {
    const kind = describeStatus(this.status, this.body?.type);
    const head = `${this.providerId} ${kind}`;
    const detail = this.body?.message?.trim();
    const reqId = this.body?.requestId
      ? ` [req ${this.body.requestId.slice(0, 16)}${this.body.requestId.length > 16 ? '…' : ''}]`
      : '';
    if (detail && detail.length > 0) {
      return `${head}: ${truncate(detail, 240)}${reqId}`;
    }
    return `${head}${reqId}`;
  }
}

/**
 * Belt-and-suspenders overflow detection for the recovery layer. Returns true
 * when a `ProviderError` is *shaped* like a context overflow even if its `kind`
 * says otherwise — an HTTP 413, or an overflow phrase anywhere in its message /
 * body. Gateways and proxies sometimes relabel an overflow as a generic
 * `invalid_request`/400 (or a caller constructs the error with an explicit
 * wrong `kind`); the `context_overflow_reduce` strategy uses this so those
 * still trigger compact-and-retry instead of failing terminally.
 */
export function isContextOverflowShaped(err: unknown): boolean {
  if (!(err instanceof ProviderError) && !ProviderError.isProviderError(err)) return false;
  const providerErr = err as ProviderError;
  if (providerErr.kind === 'context_overflow' || providerErr.status === 413) return true;
  if (providerErr.status < 400) return false;
  const text = [
    providerErr.message,
    providerErr.body?.message,
    providerErr.body?.type,
    providerErr.body?.raw,
  ]
    .filter(Boolean)
    .join('\n');
  return CONTEXT_OVERFLOW_RE.test(text);
}

function describeStatus(status: number, type?: string): string {
  if (status === 0) return 'network error';
  if (status === 599) return `stream hang (${status})`;
  if (type === 'overloaded_error' || status === 529) return `overloaded (${status})`;
  if (type === 'rate_limit_error' || status === 429) return `rate limited (${status})`;
  if (type === 'authentication_error' || status === 401) return `auth failed (${status})`;
  if (type === 'permission_error' || status === 403) return `forbidden (${status})`;
  if (type === 'not_found_error' || status === 404) return `not found (${status})`;
  if (type === 'content_filter') return `content filtered (${status})`;
  if (type === 'invalid_request_error' || status === 400) return `invalid request (${status})`;
  if (status === 408) return `timeout (${status})`;
  if (status >= 500 && status < 600) return `HTTP ${status} (server error)`;
  if (type) return `${type} (${status})`;
  return `HTTP ${status}`;
}

/**
 * Thrown when the provider stream stops delivering data mid-response.
 * This is distinct from a network error (TCP reset, DNS failure) — the
 * connection is established and the response started, but chunks stopped
 * arriving before the stream completed.
 *
 * Status 599 is used as a sentinel to distinguish stream hangs from
 * regular HTTP errors while still flowing through ProviderError-based
 * retry and fallback infrastructure.
 */
export class StreamHangError extends ProviderError {
  /** Name of the provider that hung, e.g. "zai", "anthropic". */
  public readonly hungProviderId: string;
  /** Model that was being called when the hang occurred. */
  public readonly hungModel: string;
  /** How long (ms) we waited for the next chunk before declaring a hang. */
  public readonly hangTimeoutMs: number;
  /** How many bytes were received before the hang. */
  public readonly bytesReceived: number;
  /** Elapsed time (ms) from the start of the stream until the hang. */
  public readonly elapsedMs: number;

  constructor(opts: {
    providerId: string;
    model: string;
    hangTimeoutMs: number;
    bytesReceived: number;
    elapsedMs: number;
    cause?: unknown | undefined;
  }) {
    super(
      `Stream hang: ${opts.providerId}/${opts.model} — no data for ${opts.hangTimeoutMs}ms after ${opts.bytesReceived} bytes (${opts.elapsedMs}ms elapsed)`,
      599,
      true, // always retryable
      opts.providerId,
      {
        body: {
          message: `Stream stalled after ${opts.elapsedMs}ms, ${opts.bytesReceived} bytes received`,
        },
        cause: opts.cause,
      },
    );
    this.name = 'StreamHangError';
    this.hungProviderId = opts.providerId;
    this.hungModel = opts.model;
    this.hangTimeoutMs = opts.hangTimeoutMs;
    this.bytesReceived = opts.bytesReceived;
    this.elapsedMs = opts.elapsedMs;
  }
}

/** Exhaustive kind → ErrorCode mapping — new kinds must be added here or the
 *  file stops compiling (same drift-guard pattern as RETRYABLE_BY_KIND). */
const KIND_TO_CODE: Record<ProviderErrorKind, ErrorCode> = {
  network: ERROR_CODES.PROVIDER_NETWORK_ERROR,
  timeout: ERROR_CODES.PROVIDER_NETWORK_ERROR,
  rate_limit: ERROR_CODES.PROVIDER_RATE_LIMITED,
  quota_exhausted: ERROR_CODES.PROVIDER_RATE_LIMITED,
  auth: ERROR_CODES.PROVIDER_AUTH_FAILED,
  overloaded: ERROR_CODES.PROVIDER_OVERLOADED,
  context_overflow: ERROR_CODES.PROVIDER_CONTEXT_OVERFLOW,
  server: ERROR_CODES.PROVIDER_SERVER_ERROR,
  stream_hang: ERROR_CODES.PROVIDER_SERVER_ERROR,
  content_filter: ERROR_CODES.PROVIDER_INVALID_REQUEST,
  invalid_request: ERROR_CODES.PROVIDER_INVALID_REQUEST,
  unknown: ERROR_CODES.PROVIDER_INVALID_REQUEST,
};

function kindToCode(kind: ProviderErrorKind): ErrorCode {
  return KIND_TO_CODE[kind];
}
