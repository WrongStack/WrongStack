import { truncate } from '../utils/string.js';
import type { ErrorCode } from './errors.js';
import { ERROR_CODES, WrongStackError } from './errors.js';
import { kindFromErrorCode } from './provider-error-codes.js';
import { QUOTA_EXHAUSTED_RE } from './quota-regex.js';

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
  /** Machine code beside `type` (OpenAI `error.code`); set only when it differs from `type`. */
  code?: string | undefined;
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
export const CONTEXT_OVERFLOW_RE =
  /context.length|context.window|maximum context|max.*tokens?.*exceeded|(?:prompt|request|input|messages?).{0,12}too (?:large|long)|exceeds the context|\btokens\b.*exceed|too many tokens|reduce the length|resulted in \d+ tokens|context_length_exceeded/i;

/** Content-policy refusals surfaced as HTTP errors (Azure/OpenAI `content_filter`, etc.). */
export const CONTENT_FILTER_RE = /content.(filter|policy|moderation)|safety (system|filter)/i;

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
  // Quota classification deliberately ignores `body.raw`: raw JSON often
  // contains unrelated flag fields (OpenAI's `"code":"insufficient_quota"`,
  // gateway retry hints) that false-positive the quota regex — a burst 429
  // whose message is generic rate-limit prose would then be quarantined for
  // 15 minutes. Only the structured message text is trusted for quota; `raw`
  // still feeds the content-filter / context-overflow scans below, where its
  // flag fields are the actual signal (e.g. Azure `content_filter`).
  const messageText = [message, body?.message, type].filter(Boolean).join('\n');
  const text = [messageText, body?.raw].filter(Boolean).join('\n');
  if (status === 0) return 'network';
  if (status === 408) return 'timeout';
  if (status === 599) return 'stream_hang';
  // An explicit machine code outranks status and prose (see provider-error-codes).
  const codeKind = kindFromErrorCode(body?.code) ?? kindFromErrorCode(type);
  if (codeKind) return codeKind;
  // Belt-and-suspenders quota check FIRST. Many providers (Kimi, Z.AI,
  // Moonshot) answer a hard billing-cycle limit with HTTP 403 and a prose
  // message like "You've reached your usage limit for this billing cycle" or
  // "Your quota will be refreshed in the next cycle".  We must classify these
  // as quota_exhausted (→ 15-min blocked) rather than auth (→ 5-failure chain).
  // The QUOTA_EXHAUSTED_RE regex catches the message text regardless of the
  // HTTP status code, so this guard must run before the 401/403 auth branch.
  if (QUOTA_EXHAUSTED_RE.test(messageText)) return 'quota_exhausted';
  if (status === 402) return 'quota_exhausted';
  // A bare 429 with generic "rate limit exceeded" prose stays `rate_limit`:
  // that wording is many gateways' default burst-429 message, and mapping it
  // to quota once quarantined whole providers for 15+ minutes.
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

export const RESET_HINT_LEAD_RE =
  /(?:try again|retry|resets?|resetting|available|returns?|back online|usable again)\s+(?:in|after)\s+/i;

export const RESET_AT_LEAD_RE = /resets?\s+(?:at|on)\s+/i;

/** Longest-unit-first so `minutes` wins over `m`; `(?![a-z])` keeps `12m0.5s` compound durations intact. */
export const DURATION_TOKEN_RE =
  /(\d+(?:\.\d+)?)\s*(ms|secs?|seconds?|s|mins?|minutes?|m|hrs?|hours?|h|days?|d)(?![a-z])/gi;

export const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function unitMs(unit: string): number {
  const u = unit.toLowerCase();
  if (u === 'ms') return 1;
  if (u.startsWith('s')) return UNIT_MS['s']!;
  if (u.startsWith('m')) return UNIT_MS['m']!;
  if (u.startsWith('h')) return UNIT_MS['h']!;
  return UNIT_MS['d']!;
}

export const ISO_TIMESTAMP_RE =
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
    let end = 0;
    DURATION_TOKEN_RE.lastIndex = 0;
    for (let m = DURATION_TOKEN_RE.exec(window); m; m = DURATION_TOKEN_RE.exec(window)) {
      // Only adjacent duration terms belong to the hint, not later prose.
      const separator = window.slice(end, m.index);
      if (!(end === 0 ? /^\s*$/ : /^[\s,]*(?:and\s+)?$/i).test(separator)) break;
      end = DURATION_TOKEN_RE.lastIndex;
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

export const RETRYABLE_BY_KIND: Record<ProviderErrorKind, boolean> = {
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

export const FALLBACK_WORTHY_BY_KIND: Record<ProviderErrorKind, boolean> = {
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

export function describeStatus(status: number, type?: string): string {
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
export const KIND_TO_CODE: Record<ProviderErrorKind, ErrorCode> = {
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

export function kindToCode(kind: ProviderErrorKind): ErrorCode {
  return KIND_TO_CODE[kind];
}
