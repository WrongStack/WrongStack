/**
 * `openai-codex` wire family — the ChatGPT-backend Responses API.
 *
 * This is the transport used by "Sign in with ChatGPT" (OAuth) credentials.
 * It speaks the OpenAI **Responses** wire format (NOT chat/completions) and
 * targets `https://chatgpt.com/backend-api/codex/responses`, authenticating
 * with the OAuth access token + `chatgpt-account-id` header. It deliberately
 * leaves the API-key `openai` family (api.openai.com/chat/completions)
 * untouched — the two coexist as separate providers.
 *
 * Token lifecycle: the access token is short-lived. This adapter refreshes it
 * transparently — before a request when it is near expiry, and once more on a
 * 401 — using the stored refresh token, then invokes `onRefresh` so the CLI
 * can persist the rotated tokens back to the vault.
 *
 * The refresh endpoint + client id used to be duplicated here, with a comment
 * explaining that `providers` must not depend on `cli`. The layering was right;
 * the conclusion was not — the constants now live in `./oauth/codex-protocol.js`,
 * below both, so the CLI login flow, the headless WebUI flow, and this refresh
 * path share one definition instead of three that had to be kept in step by hand.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type ProviderQuotaSnapshot,
  quotaResetInMs,
  recordProviderQuota,
} from '@wrongstack/core/quota';
import { scrubErrorText } from '@wrongstack/core/security';
import {
  type Capabilities,
  classifyProviderError,
  isRetryableKind,
  isVolatileSystemBlock,
  ProviderError,
  type ReasoningEffort,
  type Request,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '@wrongstack/core/types';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from './_tool-input.js';
import {
  type CodexResponseMetadata,
  type CodexWebSocketFactory,
  CodexWebSocketFallbackError,
  CodexWebSocketPool,
  defaultCodexWebSocketFactory,
} from './codex-websocket.js';
import {
  type HeadersLike,
  parseProviderErrorBody,
  parseProviderHttpError,
  scrubProviderErrorBody,
} from './error-parse.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import type { BuildBodyContext } from './model-output-limits.js';
import {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  type CodexTokens,
  codexModelsUrl,
  codexResponsesUrl,
  refreshCodexTokens,
} from './oauth/codex-protocol.js';
import { OAuthRefreshCoordinator } from './oauth-refresh-coordinator.js';
import { extractAccountId, extractPlanType } from './openai-codex-account.js';
import {
  parseCodexRateLimitEvent,
  parseCodexRateLimitHeaders,
} from './openai-codex-rate-limits.js';

// Owned by `codex-websocket.ts` (both transports carry it); re-exported here
// so the long-standing public name keeps resolving from the provider module.
export type { CodexResponseMetadata };

import { applyPromptCacheKey } from './prompt-cache-key.js';
import {
  isCacheProbeEnabled,
  recordCacheProbeRequest,
  recordCacheProbeUsage,
} from './prompt-cache-probe.js';
import { redirectSafeFetch } from './redirect-safe-fetch.js';
import { createSseLineFoldingTransform, parseSSE } from './sse.js';
import {
  CODEX_REASONING_ENCRYPTED_META,
  CODEX_REASONING_ID_META,
  messagesToResponsesInput,
  toolsToResponses,
} from './tool-format/to-responses.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

// ── OAuth refresh (shared protocol — see ./oauth/codex-protocol.ts) ──────────

const DEFAULT_CODEX_BASE = CODEX_BASE_URL;

/**
 * Does this 400 blame a replayed reasoning item?
 *
 * The Responses API's reasoning validation errors all name the item type or a
 * `rs_`-prefixed id ("Item 'rs_…' of type 'reasoning' was provided without its
 * required following item"). Matching narrowly matters: a 400 for a malformed
 * tool schema must keep surfacing as an error, not be silently retried with
 * reasoning stripped and then fail again with a confusing second message.
 */
function isReasoningReplayRejection(err: ProviderError): boolean {
  const message = `${err.message} ${JSON.stringify(err.body ?? '')}`;
  return /reasoning item|item\s+['"]?rs_[\w-]+|required following item/i.test(message);
}

/** Sticky-routing token the ChatGPT backend hands back on every response. */
const CODEX_TURN_STATE_HEADER = 'x-codex-turn-state';
/** Bound on remembered turn-state entries so a long-lived process cannot grow. */
const CODEX_TURN_STATE_MAX_SESSIONS = 64;

/**
 * Is this request a continuation of the turn already in flight, rather than a
 * new user turn?
 *
 * `x-codex-turn-state` is scoped to ONE turn: the official client keeps it in a
 * turn-scoped `OnceLock` and replays it on the requests that finish that turn
 * (the tool-call round-trips), never on the next user turn. In the canonical
 * message shape a tool-call round-trip is a user message carrying tool results,
 * so that is the boundary this reproduces.
 */
function isTurnContinuation(req: Request): boolean {
  const last = req.messages[req.messages.length - 1];
  if (last?.role !== 'user' || !Array.isArray(last.content)) return false;
  return last.content.some((block) => block.type === 'tool_result');
}

/**
 * The soonest reset among the windows that are actually exhausted.
 *
 * "Exhausted" is the window the backend named as reached
 * (`x-codex-rate-limit-reached-type`), falling back to any window at or above
 * 100%. A window at 60% has a reset time too, and parking a model until it
 * arrives would be a self-inflicted outage — only a window we cannot currently
 * spend against is worth waiting for.
 */
function codexResetHintMs(snapshots: readonly ProviderQuotaSnapshot[]): number | undefined {
  let soonest: number | undefined;
  for (const snapshot of snapshots) {
    for (const window of snapshot.windows) {
      const isReached =
        snapshot.reachedWindowId === window.id ||
        (snapshot.reachedWindowId === undefined && window.usedPercent >= 100);
      if (!isReached) continue;
      const ms = quotaResetInMs(window);
      if (ms !== undefined && (soonest === undefined || ms < soonest)) soonest = ms;
    }
  }
  return soonest;
}

const CODEX_MODELS_FAILURE_COOLDOWN_MS = 5_000;
const CODEX_MODELS_TIMEOUT_MS = 3_000;
/** Match the official client's in-memory/file model catalog freshness window. */
const CODEX_MODELS_CACHE_TTL_MS = 5 * 60_000;
/** The official client proactively refreshes ChatGPT access tokens five minutes early. */
const CODEX_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
/**
 * Fraction of a model's catalog `context_window` the backend actually lets a
 * request occupy, when the catalog does not say. The official Codex client
 * computes its usable window as
 * `resolved_context_window * effective_context_window_percent / 100`
 * (codex-rs/core/src/session/context_window.rs) and the live ChatGPT catalog
 * ships `effective_context_window_percent: 95` on every model, so 95 is the
 * value the field defaults to rather than a guess.
 */
const CODEX_DEFAULT_EFFECTIVE_CONTEXT_PERCENT = 95;

/**
 * Derive the effective SEND ceiling from a catalog entry.
 *
 * The catalog publishes TWO windows and they mean different things:
 *
 * - `context_window` is the model's DEFAULT window (272K across the current
 *   lineup, 128K on spark).
 * - `max_context_window` is the largest window the model supports — the
 *   ceiling an explicit configured override may reach. The official client
 *   resolves it as `configured.min(max_context_window)`
 *   (codex-rs/models-manager/src/model_info.rs, `with_config_overrides`).
 *
 * So `max_context_window` IS a bigger window, just one a client has to ask
 * for; on gpt-6-astra and the gpt-5.6 family it is 872K against a 272K
 * default. Reporting the default as a hard cap throws away two thirds of the
 * window these models actually have, which is why the maximum is preferred
 * here and the default is only the fallback for older catalogs. The agent loop
 * still clamps this against its own configured baseline and any learned
 * overflow limit, so this is a ceiling, not a target.
 *
 * The effective percent is the output/overhead reserve the backend keeps
 * inside whichever window applies; there is no separate fixed subtraction to
 * make on top of it.
 */
function codexSendCeiling(contextWindow: number, effectivePercent: number): number {
  const percent =
    Number.isFinite(effectivePercent) && effectivePercent > 0 && effectivePercent <= 100
      ? effectivePercent
      : CODEX_DEFAULT_EFFECTIVE_CONTEXT_PERCENT;
  return Math.max(1, Math.floor((contextWindow * percent) / 100));
}

interface CodexModelMetadata {
  slug?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  effective_context_window_percent?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  input_modalities?: unknown;
  supports_parallel_tool_calls?: unknown;
  visibility?: unknown;
  display_name?: unknown;
  description?: unknown;
}

/** One picker-visible model, as the ChatGPT backend describes it. */
export interface CodexLiveModel {
  id: string;
  name: string;
  description?: string | undefined;
  /** Largest window the model supports, before the effective-window discount. */
  maxContext?: number | undefined;
}

/** Per-model policy the catalog publishes and the transport honours. */
interface CodexModelPolicy {
  /** Input-token ceiling, already discounted by the effective-window percent. */
  sendCeiling: number;
  /** The model's own default reasoning effort, when the catalog names one. */
  defaultReasoningEffort?: ReasoningEffort | undefined;
  /**
   * Efforts this model accepts, in the catalog's own ascending order. Empty
   * when the catalog does not say, which means "send whatever was asked".
   */
  supportedReasoningEfforts: readonly ReasoningEffort[];
  /** False when the catalog lists no `image` input modality. */
  acceptsImages: boolean;
  /** False only when the catalog explicitly says the model cannot parallelise. */
  parallelToolCalls: boolean;
}

/**
 * Reasoning efforts in ascending strength. Used only to answer "which
 * supported level is nearest below the one asked for" — the catalog decides
 * what a given model supports, this decides how to walk it.
 */
const CODEX_REASONING_LADDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

const CODEX_REASONING_EFFORTS: ReadonlySet<string> = new Set(CODEX_REASONING_LADDER);

function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.has(value)
    ? (value as ReasoningEffort)
    : undefined;
}

/**
 * Read `supported_reasoning_levels`, an array of `{ effort, description }`.
 *
 * Kept in the catalog's order rather than sorted: that order is the backend's
 * own ranking, which is what makes "the nearest supported effort" meaningful
 * without this module hardcoding a ladder that the next model tier changes.
 */
function parseSupportedReasoningEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const out: ReasoningEffort[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const effort = parseReasoningEffort((raw as { effort?: unknown }).effort);
    if (effort && !out.includes(effort)) out.push(effort);
  }
  return out;
}

/**
 * Clamp a requested reasoning effort to something this model actually accepts.
 *
 * The catalog's levels differ by tier — `max` exists on gpt-6-astra and the
 * gpt-5.6 family but NOT on gpt-5.5, gpt-5.4-mini or gpt-5.3-codex-spark, and
 * `minimal` exists nowhere. Forwarding an unsupported effort spends a whole
 * request to earn a 400, then spends another on the retry; degrading to the
 * nearest supported level spends one request that works.
 *
 * "Nearest" walks DOWN the catalog's own ordering from the requested level, so
 * `max` on a low/medium/high/xhigh model becomes `xhigh` rather than the
 * timid `medium` a blind fallback would pick.
 */
function clampReasoningEffort(
  effort: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  if (supported.length === 0 || supported.includes(effort)) return effort;
  const requestedRank = CODEX_REASONING_LADDER.indexOf(effort);
  if (requestedRank < 0) return supported[supported.length - 1] ?? effort;
  let best: ReasoningEffort | undefined;
  let bestRank = -1;
  for (const candidate of supported) {
    const rank = CODEX_REASONING_LADDER.indexOf(candidate);
    if (rank < 0 || rank > requestedRank) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = candidate;
    }
  }
  // Everything the model offers is stronger than what was asked for: take the
  // weakest of those rather than silently escalating to the top.
  return best ?? supported[0] ?? effort;
}

interface CodexModelsResponse {
  models?: unknown;
}

/**
 * Token shape returned by a refresh. Structurally the shared
 * {@link CodexTokens}; kept as a named alias because it is part of this
 * package's published surface.
 */
export type CodexOAuthTokens = CodexTokens;

/**
 * Refresh an expired Codex access token using its refresh token.
 *
 * Thin alias over the shared {@link refreshCodexTokens} — the endpoint, client
 * id, body shape, and response validation are defined once in
 * `./oauth/codex-protocol.js`. The name is kept because it is exported from
 * this package's index and wired as the adapter's default `refreshFn`.
 */
export function refreshCodexAccessToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CodexOAuthTokens> {
  return refreshCodexTokens(refreshToken, signal);
}

// extractAccountId lives in openai-codex-account.ts so the oauth entry can
// use it without bundling this provider. Re-exported for API compatibility.
export { extractAccountId } from './openai-codex-account.js';

// ── Provider ────────────────────────────────────────────────────────────────

export interface CodexCredentials {
  /** The OAuth access token (a JWT). */
  accessToken: string;
  /** The refresh token, used to mint a new access token before/at expiry. */
  refreshToken?: string | undefined;
  /** Access-token expiry, epoch ms. When absent, refresh only fires on 401. */
  expiresAt?: number | undefined;
  /** Cached ChatGPT account id. Re-derived from the live token when missing. */
  accountId?: string | undefined;
}

/**
 * Decide what happens to a caller's `req.maxTokens` on the Codex wire.
 *
 * ChatGPT's subscription-backed `/backend-api/codex/responses` surface rejects
 * `max_output_tokens` with HTTP 400, even though the public Responses API
 * accepts it. Always omit the field and let the backend apply the selected
 * model's own output policy.
 *
 * Kept as an exported compatibility helper for existing callers.
 */
export function codexOutputCap(_maxTokens: number | undefined): undefined {
  return undefined;
}

export interface OpenAICodexProviderOptions {
  credentials: CodexCredentials;
  baseUrl?: string | undefined;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  /**
   * Persist rotated tokens after a successful refresh. The CLI wires this to
   * write back to the encrypted config so the new access/refresh pair survive
   * the session.
   */
  onRefresh?:
    | ((creds: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        accountId: string | undefined;
      }) => void)
    | undefined;
  /** Observe response metadata surfaced inside the Responses stream. */
  onResponseMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined;
  /**
   * Receives the account's picker-visible model list every time the live
   * `/codex/models` catalog is re-read, so a host can keep its stored list in
   * step with the backend.
   *
   * The stored list used to be written once, at login, and never again: an
   * account that gained `gpt-6-astra` a week later kept whatever the login
   * happened to resolve. This rides the catalog probe the transport already
   * performs at request boundaries, so keeping the list live costs no extra
   * request.
   */
  onModels?: ((models: CodexLiveModel[]) => void) | undefined;
  /** Enable the Responses WebSocket transport; defaults on for the real fetch. */
  webSocket?: boolean | undefined;
  /** Injectable WebSocket factory for hosts and tests. */
  webSocketFactory?: CodexWebSocketFactory | undefined;
  /** Best-effort WebSocket prewarm before the first real response. */
  webSocketPrewarm?: boolean | undefined;
  /** Override the refresh call (tests). */
  refreshFn?:
    | ((refreshToken: string, signal?: AbortSignal) => Promise<CodexOAuthTokens>)
    | undefined;
  /**
   * Reasoning effort for the Codex (gpt-5.x) reasoning models. Sent as
   * `reasoning.effort` with `summary: 'auto'` so chain-of-thought streams back
   * as thinking deltas. Request-level reasoning settings override this default.
   * Default 'medium'. Set 'none' to omit reasoning entirely.
   */
  reasoningEffort?: ReasoningEffort | undefined;
}

export class OpenAICodexProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private access: string;
  private refresh: string | undefined;
  private accountId: string | undefined;
  private readonly refreshFn: (
    refreshToken: string,
    signal?: AbortSignal,
  ) => Promise<CodexOAuthTokens>;
  /** Shared OAuth refresh machinery — see packages/providers/src/oauth-refresh-coordinator.ts */
  private readonly refreshCoordinator: OAuthRefreshCoordinator<
    CodexOAuthTokens,
    NonNullable<OpenAICodexProviderOptions['onRefresh']> extends (p: infer P) => void ? P : never
  >;
  private readonly reasoningEffort: ReasoningEffort;
  /** Explicit caller override; absent means "defer to the model's catalog default". */
  private readonly configuredReasoningEffort: ReasoningEffort | undefined;
  private readonly onResponseMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined;
  private readonly onModels?: ((models: CodexLiveModel[]) => void) | undefined;
  /** Last live list, so an unchanged catalog does not re-notify the host. */
  private lastModelsSignature: string | undefined;
  private readonly useWebSocket: boolean;
  private readonly webSocketPrewarm: boolean;
  private readonly webSocketPool: CodexWebSocketPool | undefined;
  private webSocketDisabled = false;
  private contextLimits = new Map<string, CodexModelPolicy>();
  /**
   * Per-conversation `x-codex-turn-state`, the backend's sticky-routing token.
   *
   * The backend returns it on every `/codex/responses` response and expects it
   * back on the remaining requests of the SAME turn; that is what keeps a
   * turn's tool-call round-trips pinned to the machine already holding the
   * conversation's cached prefix. Dropping it (as this transport used to)
   * re-rolls routing on every tool result — the requests with the longest
   * shared prefix in the whole session, and so the ones a cache miss costs
   * most.
   */
  private readonly turnState = new Map<string, string>();
  /**
   * Reasoning replay is disabled for the rest of the process once the backend
   * rejects it. See `stream()` — a 400 on a reasoning item must degrade to the
   * old (working) behaviour, never strand the session.
   */
  private reasoningReplayDisabled = false;
  private contextLimitsEtag: string | undefined;
  private contextLimitsRefresh: Promise<void> | undefined;
  private contextLimitsFreshUntil = 0;
  private contextLimitsRetryAfter = 0;

  constructor(opts: OpenAICodexProviderOptions) {
    super(
      opts.credentials.accessToken,
      opts.baseUrl ?? DEFAULT_CODEX_BASE,
      opts.fetchImpl,
      opts.streamOpts,
    );
    this.id = opts.id ?? 'openai-codex';
    this.access = opts.credentials.accessToken;
    this.refresh = opts.credentials.refreshToken;
    this.accountId = opts.credentials.accountId ?? extractAccountId(this.access) ?? undefined;
    this.refreshFn = opts.refreshFn ?? refreshCodexAccessToken;
    this.refreshCoordinator = new OAuthRefreshCoordinator<
      CodexOAuthTokens,
      {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        accountId: string | undefined;
      }
    >({
      initialRefreshKey: opts.credentials.refreshToken,
      initialExpiresAt: opts.credentials.expiresAt,
      refreshSkewMs: CODEX_TOKEN_REFRESH_SKEW_MS,
      label: 'Codex OAuth',
      hooks: {
        refreshFn: (key, signal) => this.refreshFn(key, signal),
        onRefresh: opts.onRefresh,
        formatPayload: (_tokens, derived) => ({
          accessToken: derived.accessToken,
          refreshToken: derived.refreshKey ?? '',
          expiresAt: derived.expiresAt,
          accountId: this.accountId,
        }),
        projectTokens: (tokens) => ({
          accessToken: tokens.access,
          expiresAt: tokens.expires,
          // Codex rotates its refresh token on every refresh.
          refreshKey: tokens.refresh,
        }),
        applyTokens: (derived) => {
          this.access = derived.accessToken;
          if (derived.refreshKey !== undefined) {
            this.refresh = derived.refreshKey;
          }
          // Re-derive the ChatGPT account id from the new access token, falling
          // back to the cached value if the new JWT lacks the claim.
          this.accountId = extractAccountId(derived.accessToken) ?? this.accountId;
          // A pooled WebSocket captured the old bearer/account headers at
          // handshake time. Never reuse it after token rotation.
          this.webSocketPool?.close();
        },
      },
    });
    this.configuredReasoningEffort = opts.reasoningEffort;
    this.reasoningEffort = opts.reasoningEffort ?? 'medium';
    this.onResponseMetadata = opts.onResponseMetadata;
    this.onModels = opts.onModels;
    this.webSocketPrewarm = opts.webSocketPrewarm ?? false;
    this.useWebSocket = opts.webSocket ?? opts.fetchImpl === undefined;
    this.webSocketPool = this.useWebSocket
      ? new CodexWebSocketPool(opts.webSocketFactory ?? defaultCodexWebSocketFactory)
      : undefined;
    this.capabilities = capabilitiesForFamily('openai-codex', { ...opts.capabilities });
  }

  /**
   * Re-check the ChatGPT Codex model catalog at request boundaries. The
   * official Codex client treats `context_window` as the default and
   * `max_context_window` as the ceiling allowed for configured overrides
   * (codex-rs/models-manager/src/model_info.rs, with_config_overrides).
   * Report that maximum, falling back to the default for older catalogs;
   * the agent loop still clamps it to its configured baseline and any
   * learned overflow limit. Using the default as a hard cap incorrectly
   * reduces a configured 1M window to 272K even on long-context models.
   * Return an input ceiling after reserving output headroom. A conditional
   * GET observes catalog changes before each provider call.
   */
  async refreshContextLimit(
    model: string,
    opts: { signal: AbortSignal },
  ): Promise<{ maxContext: number; source: 'provider' } | undefined> {
    await this.ensureFreshToken(opts.signal);
    const now = Date.now();
    if (now < this.contextLimitsFreshUntil || now < this.contextLimitsRetryAfter) {
      const cached = this.contextLimits.get(model)?.sendCeiling;
      return cached ? { maxContext: cached, source: 'provider' } : undefined;
    }
    this.contextLimitsRefresh ??= this.fetchContextLimits(opts.signal).finally(() => {
      this.contextLimitsRefresh = undefined;
    });
    await this.contextLimitsRefresh;
    const maxContext = this.contextLimits.get(model)?.sendCeiling;
    return maxContext ? { maxContext, source: 'provider' } : undefined;
  }

  private async fetchContextLimits(signal: AbortSignal): Promise<void> {
    const url = `${resolveCodexModelsUrl(this.baseUrl)}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
    const timeout = AbortSignal.timeout(CODEX_MODELS_TIMEOUT_MS);
    const probeSignal = AbortSignal.any([signal, timeout]);
    try {
      const headers = this.buildHeaders({ model: '', messages: [] });
      headers.accept = 'application/json';
      delete headers['content-type'];
      if (this.contextLimitsEtag) headers['if-none-match'] = this.contextLimitsEtag;
      const response = await redirectSafeFetch(this.fetchImpl, url, {
        method: 'GET',
        headers,
        signal: probeSignal,
      });
      if (response.status === 304) {
        this.contextLimitsFreshUntil = Date.now() + CODEX_MODELS_CACHE_TTL_MS;
        this.contextLimitsRetryAfter = 0;
        return;
      }
      if (!response.ok) {
        this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
        return;
      }
      const payload = safeParse<CodexModelsResponse>(await response.text());
      if (!payload.ok || !Array.isArray(payload.value?.models)) {
        this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
        return;
      }
      const next = new Map<string, CodexModelPolicy>();
      const live: CodexLiveModel[] = [];
      for (const raw of payload.value.models) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as CodexModelMetadata;
        if (typeof entry.slug !== 'string') continue;
        // Prefer the model's maximum; fall back to the default window for a
        // catalog too old to publish one. See codexSendCeiling.
        const window =
          positiveContextLimit(entry.max_context_window) ??
          positiveContextLimit(entry.context_window);
        // `visibility: 'list'` is what the official picker shows; `hide` marks
        // internal routes (`gpt-reserve`, `codex-auto-review`) that a user must
        // not be offered. Policy is still recorded for them — a hidden model
        // the caller names explicitly should still get the right ceiling.
        if (entry.visibility === undefined || entry.visibility === 'list') {
          live.push({
            id: entry.slug,
            name: typeof entry.display_name === 'string' ? entry.display_name : entry.slug,
            ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
            ...(window ? { maxContext: window } : {}),
          });
        }
        if (!window) continue;
        const percent =
          typeof entry.effective_context_window_percent === 'number'
            ? entry.effective_context_window_percent
            : CODEX_DEFAULT_EFFECTIVE_CONTEXT_PERCENT;
        const defaultReasoningEffort = parseReasoningEffort(entry.default_reasoning_level);
        // Absent `input_modalities` means an older catalog that predates the
        // field, not a text-only model — assume images are fine there.
        const modalities = entry.input_modalities;
        next.set(entry.slug, {
          sendCeiling: codexSendCeiling(window, percent),
          ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
          supportedReasoningEfforts: parseSupportedReasoningEfforts(
            entry.supported_reasoning_levels,
          ),
          acceptsImages: !Array.isArray(modalities) || modalities.includes('image'),
          parallelToolCalls: entry.supports_parallel_tool_calls !== false,
        });
      }
      if (next.size === 0) {
        this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
        return;
      }
      this.contextLimits = next;
      this.publishLiveModels(live);
      this.contextLimitsEtag = response.headers?.get?.('etag') ?? undefined;
      this.contextLimitsFreshUntil = Date.now() + CODEX_MODELS_CACHE_TTL_MS;
      this.contextLimitsRetryAfter = 0;
    } catch {
      // Keep the last verified catalog. The awaited probe is deliberately
      // bounded: knowing the new ceiling before send is the safety guarantee;
      // a failed probe may delay one request by at most the timeout above.
      this.contextLimitsRetryAfter = Date.now() + CODEX_MODELS_FAILURE_COOLDOWN_MS;
    }
  }

  /**
   * Hand the host the account's live model list, but only when it changed.
   *
   * The catalog is re-read on a five-minute cadence and revalidated with an
   * ETag, so most reads return the same list; notifying every time would make
   * a host that persists the list rewrite its config on a timer.
   */
  private publishLiveModels(models: CodexLiveModel[]): void {
    if (!this.onModels || models.length === 0) return;
    const signature = models.map((m) => `${m.id}:${m.maxContext ?? ''}`).join(',');
    if (signature === this.lastModelsSignature) return;
    this.lastModelsSignature = signature;
    this.onModels(models);
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    await this.ensureFreshToken(opts.signal);
    let emitted = false;
    // `track` is a plain generator expression, so it has no `this`; the probe
    // below needs the provider id from the enclosing scope.
    const providerId = this.id;
    const track = async function* (source: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
      for await (const event of source) {
        // `message_start` carries no user-visible content. A backend can emit
        // it before a response.failed envelope, and retrying at that point is
        // still safe. Every other streamed event is treated as an output
        // boundary to prevent duplicate text/tool/reasoning delivery.
        if (event.type !== 'message_start') emitted = true;
        // The charge for the request whose prefix the probe just fingerprinted.
        // Recorded here rather than in `parseStream` because the WebSocket
        // transport parses the stream itself and never calls that override.
        if (event.type === 'message_stop' && isCacheProbeEnabled()) {
          recordCacheProbeUsage({
            provider: providerId,
            sessionKey: codexCacheSessionId(req.cache?.sessionId) ?? 'no-session',
            usage: event.usage,
          });
        }
        yield event;
      }
    };
    let transportError: unknown;
    try {
      if (this.useWebSocket && !this.webSocketDisabled && this.webSocketPool) {
        yield* track(this.streamWebSocket(req, opts));
      } else {
        yield* track(super.stream(req, opts));
      }
      return;
    } catch (err) {
      transportError = err;
      if (err instanceof CodexWebSocketFallbackError && !emitted) {
        // Match the official client: once this session proves WebSocket
        // incompatible, keep using HTTP instead of paying for a failed upgrade
        // before every turn.
        this.webSocketDisabled = true;
        try {
          yield* track(super.stream(req, opts));
          return;
        } catch (sseError) {
          transportError = sseError;
        }
      }
    }

    const err = transportError;
    // A 401 means the token went stale between the pre-flight check and the
    // request (or we had no expiry to check). Refresh once and retry only before
    // any output has been emitted, so a mid-stream auth failure cannot duplicate it.
    if (!emitted && err instanceof ProviderError && err.status === 401 && this.refresh) {
      await this.doRefresh(opts.signal);
      yield* track(super.stream(req, opts));
      return;
    }
    // Reasoning replay is a token-and-quota optimisation, never a requirement.
    // If the backend rejects a replayed reasoning item before output starts, retry
    // over SSE without replay rather than stranding the session.
    if (
      !emitted &&
      !this.reasoningReplayDisabled &&
      err instanceof ProviderError &&
      err.status === 400 &&
      isReasoningReplayRejection(err)
    ) {
      this.reasoningReplayDisabled = true;
      yield* track(super.stream(req, opts));
      return;
    }
    throw err;
  }

  private streamWebSocket(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const effectiveReq = this.applyMaxToolsFilter(req);
    const body = this.buildBody(effectiveReq, {
      capabilities: this.capabilities,
      providerId: this.id,
    });
    const headers = this.buildHeaders(effectiveReq);
    headers['OpenAI-Beta'] = 'responses_websockets=2026-02-06';
    // Handshake headers are captured once per pooled connection, so a value
    // that changes per request cannot ride on them. The WebSocket protocol
    // carries turn state in the request's `client_metadata` instead, exactly
    // as the official client does.
    const turnState = headers[CODEX_TURN_STATE_HEADER];
    delete headers[CODEX_TURN_STATE_HEADER];
    return this.webSocketPool!.stream(
      {
        url: resolveCodexWebSocketUrl(this.baseUrl),
        headers,
        request: effectiveReq,
        body,
        fallbackModel: effectiveReq.model,
        providerId: this.id,
        signal: opts.signal,
        prewarm: this.webSocketPrewarm,
        ...(turnState ? { turnState } : {}),
        onTurnState: (value) => this.rememberTurnState(effectiveReq, value),
        onMetadata: (metadata) => this.handleResponseMetadata(effectiveReq, metadata),
        onHeaders: (responseHeaders) => this.onResponseHeaders(responseHeaders, effectiveReq),
      },
      parseOpenAIResponsesStream,
    );
  }

  /**
   * Consume a `response.metadata` frame.
   *
   * On the WebSocket transport there are no HTTP response headers after the
   * handshake, so this frame is the ONLY delivery of the quota windows, the
   * catalog etag and the sticky-routing token for every turn after the first.
   * Reading only the etag here left a WebSocket session's quota reporting
   * frozen at whatever the handshake happened to return.
   */
  private handleResponseMetadata(_req: Request, metadata: CodexResponseMetadata): void {
    const etag = metadata.headers['x-models-etag'];
    if (etag && etag !== this.contextLimitsEtag) {
      this.contextLimitsEtag = etag;
      this.contextLimitsFreshUntil = 0;
    }
    this.rememberTurnState(_req, metadata.headers[CODEX_TURN_STATE_HEADER]);
    const planLabel =
      metadata.headers['x-codex-plan-type'] ?? extractPlanType(this.access) ?? undefined;
    const snapshots = parseCodexRateLimitHeaders(new Headers(metadata.headers)).map((snapshot) =>
      snapshot.planLabel === undefined && planLabel !== undefined
        ? { ...snapshot, planLabel }
        : snapshot,
    );
    if (snapshots.length > 0) recordProviderQuota(this.id, snapshots);
    this.onResponseMetadata?.(metadata);
  }

  private async ensureFreshToken(signal: AbortSignal): Promise<void> {
    await this.refreshCoordinator.ensureFreshToken(signal);
  }

  private async doRefresh(signal: AbortSignal): Promise<void> {
    await this.refreshCoordinator.doRefresh(signal);
  }

  protected override buildUrl(_req: Request): string {
    return resolveCodexUrl(this.baseUrl);
  }

  /**
   * Harvest the two out-of-band signals the ChatGPT backend only sends in
   * response headers.
   *
   * Quota (`x-codex-*-used-percent`, window minutes, reset-at, credits) is the
   * ONLY place a ChatGPT-login user's remaining 5h/weekly allowance is
   * reported. Without reading it the first sign of an exhausted plan is a 429
   * mid-turn; with it, surfaces can show the burn rate before it bites.
   *
   * `x-codex-turn-state` is retained here and replayed by `buildHeaders` on the
   * remaining requests of the same turn — see `resolveTurnState`, which expires
   * it as soon as a new user turn begins.
   */
  protected override onResponseHeaders(headers: HeadersLike | undefined, _request: Request): void {
    if (!headers) return;
    this.rememberTurnState(_request, headers.get(CODEX_TURN_STATE_HEADER) ?? undefined);
    // `x-codex-plan-type` is the account's live tier as the backend sees it.
    // The JWT claim is a snapshot taken when the token was minted, so it goes
    // stale across an upgrade; prefer the header and keep the claim as the
    // fallback for backends that omit it.
    const planLabel =
      headers.get('x-codex-plan-type')?.trim() || extractPlanType(this.access) || undefined;
    const snapshots = parseCodexRateLimitHeaders(headers).map((snapshot) =>
      snapshot.planLabel === undefined && planLabel !== undefined
        ? { ...snapshot, planLabel }
        : snapshot,
    );
    if (snapshots.length > 0) recordProviderQuota(this.id, snapshots);
    const etag = headers.get('x-models-etag');
    if (etag && etag !== this.contextLimitsEtag) {
      this.contextLimitsEtag = etag;
      this.contextLimitsFreshUntil = 0;
    }
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    const headers: Record<string, string> = {
      ...super.buildHeaders(_req),
      authorization: `Bearer ${this.access}`,
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
    };
    if (this.accountId) headers['chatgpt-account-id'] = this.accountId;
    const cacheSessionId = codexCacheSessionId(_req.cache?.sessionId);
    const cacheThreadId = codexCacheSessionId(_req.cache?.threadId) ?? cacheSessionId;
    if (cacheSessionId) headers['session-id'] = cacheSessionId;
    if (cacheThreadId) {
      const clientRequestId = codexClientRequestId(cacheThreadId);
      headers['thread-id'] = clientRequestId;
      headers['x-client-request-id'] = clientRequestId;
    } else {
      headers['x-client-request-id'] = randomUUID();
    }
    const turnState = this.resolveTurnState(_req);
    if (turnState) headers[CODEX_TURN_STATE_HEADER] = turnState;
    return headers;
  }

  /** Key under which this request's turn state is remembered. */
  private turnStateKey(req: Request): string {
    return (
      codexCacheSessionId(req.cache?.threadId) ??
      codexCacheSessionId(req.cache?.sessionId) ??
      '__default__'
    );
  }

  /**
   * The sticky-routing token to send with this request, expiring the stored one
   * when the request opens a new turn.
   *
   * The catalog probe passes a synthetic empty request through `buildHeaders`;
   * it must neither send nor invalidate a conversation's turn state.
   */
  private resolveTurnState(req: Request): string | undefined {
    if (req.messages.length === 0) return undefined;
    const key = this.turnStateKey(req);
    if (!isTurnContinuation(req)) {
      this.turnState.delete(key);
      return undefined;
    }
    return this.turnState.get(key);
  }

  private rememberTurnState(req: Request, value: string | undefined): void {
    if (!value || req.messages.length === 0) return;
    const key = this.turnStateKey(req);
    // Re-insert so the map stays in least-recently-used order for the eviction
    // below; a Map preserves insertion order and delete+set moves the entry.
    this.turnState.delete(key);
    this.turnState.set(key, value);
    while (this.turnState.size > CODEX_TURN_STATE_MAX_SESSIONS) {
      const oldest = this.turnState.keys().next().value;
      if (oldest === undefined) break;
      this.turnState.delete(oldest);
    }
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    // Split the system prompt by cache stability. The Responses wire has no
    // cache breakpoints: every system block is joined into ONE `instructions`
    // string at the head of the cached prefix, so a block rebuilt each turn
    // (recalled memories, a live peer roster, a plugin's per-turn context)
    // invalidates the prefix from that point on — and everything after it is
    // the whole conversation. Measured live: 95% hits with a stable prompt,
    // 85% with one volatile block in `instructions`, 91% with the same bytes
    // after the conversation. Anthropic can leave these in place because a
    // breakpoint absorbs them; here they have to move.
    const stableSystem: string[] = [];
    const volatileSystem: string[] = [];
    for (const block of req.system ?? []) {
      (isVolatileSystemBlock(block) ? volatileSystem : stableSystem).push(block.text);
    }
    const instructions = stableSystem.length > 0 ? stableSystem.join('\n\n') : undefined;

    // The live catalog, when this session has already probed it. Absent on the
    // very first request of a process, which is why every use below falls back
    // to the previous unconditional behaviour rather than to a guess.
    const policy = this.contextLimits.get(req.model);

    const body: Record<string, unknown> = {
      model: req.model,
      // The ChatGPT Codex backend rejects `store: true` ("Store must be set to
      // false"). We send the full conversation as `input` each turn.
      store: false,
      stream: true,
      ...(instructions ? { instructions } : {}),
      // `include: reasoning.encrypted_content` below asks the backend to hand
      // back the reasoning it produced; replaying it here is the half that
      // makes asking for it worth anything. Skipped once the backend has
      // rejected a replay (see `stream`).
      input: appendVolatileSystem(
        messagesToResponsesInput(req.messages, {
          includeReasoning: !this.reasoningReplayDisabled,
          // gpt-5.3-codex-spark lists `input_modalities: ["text"]`. Sending
          // it an `input_image` part buys a 400 and a retry; dropping the
          // image costs the picture but keeps the turn, which is the better
          // half of a choice the caller already made by picking a text model.
          allowImages: policy?.acceptsImages ?? true,
        }),
        volatileSystem,
      ),
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: policy?.parallelToolCalls ?? true,
    };
    // Responses Lite (`use_responses_lite`, true for gpt-6-astra and the 5.6
    // family) is deliberately NOT opted into. The official client's lite mode
    // is a package deal — the internal
    // `x-openai-internal-codex-responses-lite` header, `parallel_tool_calls:
    // false`, `reasoning.context: 'all_turns'`, and a different input
    // formatting — and taking only the parts that are easy to send would ask
    // the backend for a pipeline this transport does not actually speak. Not
    // opting in is a supported configuration; half-opting in is not.

    if (req.tools && req.tools.length > 0) {
      body['tools'] = toolsToResponses(req.tools);
      body['tool_choice'] = mapToolChoice(req.toolChoice);
    }
    // The ChatGPT Codex backend rejects max_output_tokens. This differs from
    // API-key Responses transports, which can forward the caller's cap.
    // The ChatGPT Codex request schema used by the official client has no
    // temperature/top_p fields. Do not forward generic runtime sampling knobs
    // that this subscription endpoint may reject.
    // Precedence: an explicit per-request effort, then a configured provider
    // default, then the model's OWN default from the catalog
    // (`default_reasoning_level` — `low` for gpt-5.6-sol, `high` for
    // gpt-5.3-codex-spark, `medium` for the rest), then the generic floor.
    // A single hardcoded 'medium' silently overrode the picker's per-model
    // recommendation in both directions.
    const requestedEffort =
      req.reasoning?.effort ??
      this.configuredReasoningEffort ??
      policy?.defaultReasoningEffort ??
      this.reasoningEffort;
    const reasoningEffort = clampReasoningEffort(
      requestedEffort,
      policy?.supportedReasoningEfforts ?? [],
    );
    if (req.reasoning?.enabled !== false && reasoningEffort !== 'none') {
      body['reasoning'] = { effort: reasoningEffort, summary: 'auto' };
    }
    // `prompt_cache_key` routes requests that share a prefix to the same cache
    // partition. The official Codex client keys it on the CONVERSATION
    // (codex-rs/core/src/client.rs `prompt_cache_key` → `session_id`), and that
    // is the right granularity here: within a conversation the shared prefix is
    // the entire growing history, while the shared-system-prompt key this used
    // to send groups every concurrent session of the same agent onto one
    // partition, where they evict each other over a prefix worth only the
    // system prompt and tool defs. Fall back to the generic prefix key when a
    // request carries no conversation (one-shot helpers, embedders).
    const cacheSessionId = codexCacheSessionId(req.cache?.sessionId);
    if (cacheSessionId && ctx?.capabilities?.cacheControl === 'auto') {
      body['prompt_cache_key'] = cacheSessionId;
    } else {
      applyPromptCacheKey(body, req, ctx?.capabilities);
    }
    // Diagnostic only, and only when explicitly switched on: fingerprint the
    // segments the backend matches as a prefix, so a low hit ratio can be
    // attributed to a specific byte that moved rather than guessed at. Keyed
    // on the same partition key the body carries, so the comparison the probe
    // makes is the comparison the backend makes.
    if (isCacheProbeEnabled()) {
      recordCacheProbeRequest({
        provider: this.id,
        sessionKey: String(body['prompt_cache_key'] ?? cacheSessionId ?? 'no-session'),
        model: req.model,
        instructions: instructions ?? '',
        tools: body['tools'] as readonly unknown[] | undefined,
        items: body['input'] as readonly unknown[],
      });
    }
    return body;
  }

  protected override parseStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    fallbackModel: string,
    req: Request,
  ): AsyncIterable<StreamEvent> {
    return parseOpenAIResponsesStream(body, fallbackModel, this.id, (metadata) => {
      this.handleResponseMetadata(req, metadata);
    });
  }

  /**
   * Translate an HTTP failure, and mine the same quota headers off it.
   *
   * A 429 is the response that matters most here: it carries the quota
   * headers like any other, and its `x-codex-*-reset-at` is an EXACT epoch for
   * when the window reopens. Without it the waiting room falls back to
   * exponential backoff and re-probes a five-hour (or weekly) cap every few
   * minutes — every probe a request against an account that has none left.
   * With it, the model parks until the published reset and wakes once.
   */
  protected override translateError(
    status: number,
    text: string,
    headers?: HeadersLike,
  ): ProviderError {
    const error = parseProviderHttpError(this.id, status, text, headers);
    if (!headers) return error;

    const snapshots = parseCodexRateLimitHeaders(headers);
    if (snapshots.length > 0) recordProviderQuota(this.id, snapshots);

    if (!error.body || error.body.retryAfterMs !== undefined) return error;
    const resetIn = codexResetHintMs(snapshots);
    if (resetIn !== undefined) error.body.retryAfterMs = resetIn;
    return error;
  }
}

/**
 * Put the volatile system blocks after the conversation.
 *
 * They still reach the model, and being last they are also the most recent
 * thing it read — but nothing cacheable sits behind them any more.
 */
function appendVolatileSystem(
  input: Record<string, unknown>[],
  volatileSystem: readonly string[],
): Record<string, unknown>[] {
  if (volatileSystem.length === 0) return input;
  return [
    ...input,
    { role: 'user', content: [{ type: 'input_text', text: volatileSystem.join('\n\n') }] },
  ];
}

/** Header-safe, session-stable affinity key used by the Codex backend. */
export function codexCacheSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const normalized = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return normalized || undefined;
}

/** Stable UUID-shaped thread/request id derived from WrongStack's opaque session id. */
function codexClientRequestId(sessionId: string | undefined): string {
  if (!sessionId) return randomUUID();
  const hex = createHash('sha256').update(sessionId).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

// ── URL + tool-choice helpers ────────────────────────────────────────────────

/** Normalize a base URL to the `/codex/responses` endpoint. */
export function resolveCodexUrl(baseUrl: string | undefined): string {
  return codexResponsesUrl(baseUrl ?? DEFAULT_CODEX_BASE);
}

/** Convert the HTTP Responses endpoint to the Codex WebSocket endpoint. */
export function resolveCodexWebSocketUrl(baseUrl: string | undefined): string {
  const httpUrl = resolveCodexUrl(baseUrl);
  return httpUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

/** Resolve the authenticated Codex model-catalog endpoint beside `/responses`. */
export function resolveCodexModelsUrl(baseUrl: string | undefined): string {
  return codexModelsUrl(baseUrl ?? DEFAULT_CODEX_BASE);
}

function positiveContextLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function mapToolChoice(
  choice: Request['toolChoice'],
): 'auto' | 'required' | 'none' | { type: 'function'; name: string } {
  if (choice === undefined) return 'auto';
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}

// ── Responses SSE → StreamEvent ──────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface StreamingArgBuffer {
  chunks: string[];
  length: number;
}

function appendArgChunk(buf: StreamingArgBuffer, chunk: string): void {
  if (chunk.length === 0) return;
  buf.chunks.push(chunk);
  buf.length += chunk.length;
}

function joinArgBuffer(buf: StreamingArgBuffer): string {
  return buf.chunks.length === 1 ? (buf.chunks[0] ?? '') : buf.chunks.join('');
}

/**
 * Join the text of a Responses `message` item's `content` array. The backend
 * echoes assistant prose as `content: [{ type: 'output_text', text }, ...]`
 * (and refusals as `{ type: 'refusal', refusal }`). Returns the concatenated
 * text, or '' for any non-message / malformed shape.
 */
function extractOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: unknown; text?: unknown; refusal?: unknown };
    if ((p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') {
      out += p.text;
    } else if (p.type === 'refusal' && typeof p.refusal === 'string') {
      out += p.refusal;
    }
  }
  return out;
}

/**
 * Read a response-metadata event, whichever dialect the backend used.
 *
 * The live ChatGPT WebSocket sends `{ type: 'codex.response.metadata',
 * headers: {...} }` — the headers sit at the TOP LEVEL, not under a `metadata`
 * envelope. Upstream documents the same two shapes ("`response.headers` for
 * standard Responses stream events; top-level `headers` for websocket metadata
 * events") and accepts both event names.
 *
 * This mattered more than a parsing nicety: after the handshake a WebSocket has
 * no HTTP response headers, so this frame is the only delivery of
 * `x-codex-turn-state` and `x-models-etag` for every turn of a WebSocket
 * session — which is the default transport. Matching only the envelope dialect
 * left both silently unread there.
 */
function responseMetadataFromEvent(
  evt: Record<string, unknown>,
): CodexResponseMetadata | undefined {
  const raw =
    (evt['metadata'] as Record<string, unknown> | undefined) ??
    ((evt['response'] as Record<string, unknown> | undefined)?.['metadata'] as
      | Record<string, unknown>
      | undefined) ??
    evt;
  if (!raw || typeof raw !== 'object') return undefined;
  const rawHeaders = raw['headers'];
  if (!rawHeaders || typeof rawHeaders !== 'object') return undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) headers[name.toLowerCase()] = value;
  }
  if (Object.keys(headers).length === 0) return undefined;
  const requestId =
    typeof raw['request_id'] === 'string'
      ? raw['request_id']
      : typeof raw['requestId'] === 'string'
        ? raw['requestId']
        : undefined;
  const model = typeof raw['model'] === 'string' ? raw['model'] : undefined;
  return { headers, ...(requestId ? { requestId } : {}), ...(model ? { model } : {}) };
}

export async function* parseOpenAIResponsesStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  fallbackModel: string,
  providerId = 'openai-codex',
  onResponseMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined,
): AsyncIterable<StreamEvent> {
  let model = fallbackModel;
  let started = false;
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let sawToolUse = false;
  // Set once a terminal envelope (`response.completed`/`response.incomplete`,
  // or `[DONE]`) is seen. If the stream closes without one after we started,
  // the response was cut mid-stream and must surface as retryable.
  let sawTerminal = false;

  // Server id of the reasoning item currently streaming, so its encrypted
  // payload can be paired with it when the item closes.
  let reasoningItemId: string | undefined;

  // Currently-streaming function call (Responses streams one item at a time).
  let toolCallId: string | undefined;
  let toolArgBuf: StreamingArgBuffer = { chunks: [], length: 0 };

  // Assistant-text recovery. The ChatGPT Responses backend does not always
  // stream a message's text as `output_text.delta` chunks — reasoning turns
  // (gpt-5-codex) frequently deliver the full text only in the terminal
  // `response.output_text.done` (`text`) or the message `output_item.done`
  // (`content[].text`) events. We count how many text chars we have already
  // emitted for the current message item; the terminal events then emit ONLY
  // the un-streamed remainder, so a fully-streamed message adds nothing and a
  // never-streamed one is recovered in full — no duplication either way.
  let msgTextStreamed = 0;
  const flushRemainingText = (full: string): StreamEvent | undefined => {
    if (full.length <= msgTextStreamed) return undefined;
    const remainder = full.slice(msgTextStreamed);
    msgTextStreamed = full.length;
    return { type: 'text_delta', text: remainder };
  };

  const ensureStart = (): StreamEvent | undefined => {
    if (started) return undefined;
    started = true;
    return { type: 'message_start', model };
  };

  // The ChatGPT-backend Responses API occasionally emits a single `data:`
  // field (typically a `response.completed` envelope echoing large input, or
  // a `function_call` with multi-KB JSON `arguments`) that exceeds parseSSE's
  // 256 KiB safety cap. We fold any oversized `data:` line into multiple
  // JSON-safe continuation lines before handing the stream to the parser —
  // the parser then rejoins them via `dataLines.join('\n')` and JSON.parse
  // reconstructs the original object. Wrapped only when the body is a Web
  // ReadableStream; Node streams hit the existing path unchanged.
  const foldedBody =
    body && typeof (body as ReadableStream<Uint8Array>).getReader === 'function'
      ? createSseLineFoldingTransform(body as ReadableStream<Uint8Array>)
      : body;
  for await (const msg of parseSSE(foldedBody)) {
    if (msg.data === '[DONE]') {
      sawTerminal = true;
      continue;
    }
    if (!msg.data) continue;
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) continue;
    const evt = parsed.value;
    const type = typeof evt['type'] === 'string' ? (evt['type'] as string) : '';

    switch (type) {
      case 'response.metadata':
      case 'codex.response.metadata': {
        const metadata = responseMetadataFromEvent(evt);
        if (metadata) onResponseMetadata?.(metadata);
        break;
      }

      case 'response.created':
      case 'response.in_progress': {
        const resp = evt['response'] as { model?: string } | undefined;
        if (typeof resp?.model === 'string') model = resp.model;
        const s = ensureStart();
        if (s) yield s;
        break;
      }

      case 'response.output_item.added': {
        const s = ensureStart();
        if (s) yield s;
        const item = evt['item'] as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
              content?: unknown;
            }
          | undefined;
        if (!item) break;
        if (item.type === 'reasoning') {
          // Keep the server's item id on the block. Replaying a reasoning item
          // needs BOTH the id and the encrypted payload (which only arrives on
          // `output_item.done`), so the id is stashed now and the payload is
          // attached below as the block's signature.
          reasoningItemId = typeof item.id === 'string' ? item.id : undefined;
          yield reasoningItemId
            ? {
                type: 'thinking_start',
                providerMeta: { [CODEX_REASONING_ID_META]: reasoningItemId },
              }
            : { type: 'thinking_start' };
        } else if (item.type === 'function_call') {
          toolCallId = item.call_id ?? item.id ?? `call_${Math.random().toString(36).slice(2)}`;
          toolArgBuf = { chunks: [], length: 0 };
          if (item.arguments) appendArgChunk(toolArgBuf, item.arguments);
          sawToolUse = true;
          yield { type: 'tool_use_start', id: toolCallId, name: item.name ?? 'unknown' };
          for (const partial of toolArgBuf.chunks) {
            yield { type: 'tool_use_input_delta', id: toolCallId, partial };
          }
        } else if (item.type === 'message') {
          // A fresh message item begins — reset the per-message text counter so
          // its terminal events emit only its own un-streamed text. Some backends
          // inline the full text on `added` (no deltas at all); recover it now.
          msgTextStreamed = 0;
          const prefilled = extractOutputText(item.content);
          const ev0 = flushRemainingText(prefilled);
          if (ev0) yield ev0;
        }
        break;
      }

      case 'codex.rate_limits': {
        // Some ChatGPT backends restate the quota windows as an SSE event
        // instead of (or in addition to) the response headers. Same numbers,
        // same store — a surface reading the quota must not care which path
        // delivered it.
        const snapshot = parseCodexRateLimitEvent(evt);
        if (snapshot) recordProviderQuota(providerId, [snapshot]);
        break;
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (delta) {
          msgTextStreamed += delta.length;
          yield { type: 'text_delta', text: delta };
        }
        break;
      }

      case 'response.output_text.done': {
        // Terminal text event carrying the full message text. Emit only the
        // remainder we have not already streamed (nothing when deltas covered
        // it; the whole text when the backend skipped deltas entirely).
        const full = typeof evt['text'] === 'string' ? (evt['text'] as string) : '';
        const ev1 = flushRemainingText(full);
        if (ev1) yield ev1;
        break;
      }

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (delta) yield { type: 'thinking_delta', text: delta };
        break;
      }

      case 'response.function_call_arguments.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (toolCallId && delta) {
          appendArgChunk(toolArgBuf, delta);
          yield { type: 'tool_use_input_delta', id: toolCallId, partial: delta };
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        // Final arguments authoritative — captured at output_item.done below.
        const args =
          typeof evt['arguments'] === 'string' ? (evt['arguments'] as string) : undefined;
        if (args !== undefined) {
          toolArgBuf = { chunks: [args], length: args.length };
        }
        break;
      }

      case 'response.output_item.done': {
        const item = evt['item'] as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
              content?: unknown;
            }
          | undefined;
        if (!item) break;
        if (item.type === 'reasoning') {
          const encrypted = (item as { encrypted_content?: unknown }).encrypted_content;
          const itemId = reasoningItemId ?? (typeof item.id === 'string' ? item.id : undefined);
          if (typeof encrypted === 'string' && encrypted.length > 0 && itemId) {
            yield {
              type: 'thinking_meta',
              providerMeta: {
                [CODEX_REASONING_ID_META]: itemId,
                [CODEX_REASONING_ENCRYPTED_META]: encrypted,
              },
            };
          }
          reasoningItemId = undefined;
          yield { type: 'thinking_stop' };
        } else if (item.type === 'function_call') {
          const id = item.call_id ?? toolCallId ?? `call_${Math.random().toString(36).slice(2)}`;
          const raw =
            item.arguments && item.arguments.length > 0
              ? item.arguments
              : joinArgBuffer(toolArgBuf);
          yield { type: 'tool_use_stop', id, input: parseToolInput(raw || '{}') };
          toolCallId = undefined;
          toolArgBuf = { chunks: [], length: 0 };
        } else if (item.type === 'message') {
          // Final safety net: recover any message text the backend delivered
          // only in the completed item's `content` (no deltas, no
          // output_text.done). flushRemainingText dedupes against what we
          // already streamed, so this is a no-op on the normal delta path.
          const full = extractOutputText(item.content);
          const ev2 = flushRemainingText(full);
          if (ev2) yield ev2;
        }
        break;
      }

      case 'response.completed':
      case 'response.incomplete': {
        const resp = evt['response'] as { status?: string; usage?: ResponsesUsage } | undefined;
        if (resp?.usage) {
          usage = normalizeUsage(resp.usage);
          // A usage-bearing terminal envelope must never silently drop its
          // telemetry, even when the backend skipped every start-producing
          // event (`response.created`/`in_progress`/`output_item.added`):
          // emit message_start here so the final `if (started)` yields the
          // paired usage-bearing message_stop. No-op on the normal path where
          // message_start was already emitted.
          const s = ensureStart();
          if (s) yield s;
        }
        stopReason = mapResponsesStatus(resp?.status, sawToolUse);
        sawTerminal = true;
        break;
      }

      case 'error':
      case 'response.failed': {
        // These are application-level failures delivered over an HTTP 200 SSE
        // stream, not HTTP 502 responses. Parse the entire envelope so the
        // provider's code/message can drive canonical classification (notably
        // context_overflow) and remain available in persisted diagnostics.
        // Serialize once to reuse the shared tolerant parser and preserve its
        // bounded raw-envelope diagnostics instead of duplicating extraction.
        const raw = JSON.stringify(evt);
        const errorBody = parseProviderErrorBody(raw);
        const response = evt['response'] as Record<string, unknown> | undefined;
        const statusCode =
          typeof response?.['status_code'] === 'number' ? response['status_code'] : undefined;
        const status = responseFailureStatus(errorBody.type, errorBody.message, statusCode);
        const rawMessage = errorBody.message ?? 'OpenAI Responses request failed';
        const kind = classifyProviderError(status, errorBody, rawMessage);
        const body = scrubProviderErrorBody(errorBody);
        const message = scrubErrorText(rawMessage);
        throw new ProviderError(message, status, isRetryableKind(kind), providerId, { body, kind });
      }

      default:
        break;
    }
  }

  if (started && !sawTerminal) {
    // Output arrived, then the stream closed with no `response.completed` and
    // no `[DONE]` — cut mid-stream. Retryable rather than a synthetic end_turn.
    throw new ProviderError(
      'OpenAI Responses stream ended without a terminal envelope (response.completed/[DONE]) — response truncated mid-stream',
      599,
      true,
      providerId,
      { body: { message: 'stream truncated before completion' } },
    );
  }
  if (started) {
    yield { type: 'message_stop', stopReason, usage };
  }
}

function responseFailureStatus(
  type: string | undefined,
  message: string | undefined,
  statusCode?: number,
): number {
  if (statusCode !== undefined) return statusCode;
  const text = `${type ?? ''}\n${message ?? ''}`;
  if (/rate.?limit/i.test(text)) return 429;
  if (/insufficient.quota|quota.exhausted/i.test(text)) return 402;
  if (/overload|server_error|internal_error/i.test(text)) return 529;

  const kind = classifyProviderError(400, { type, message }, message);
  switch (kind) {
    case 'context_overflow':
      return 413;
    case 'quota_exhausted':
      return 402;
    case 'auth':
      return 401;
    case 'content_filter':
    case 'invalid_request':
      return 400;
    default:
      return 502;
  }
}

function normalizeUsage(u: ResponsesUsage): Usage {
  const cached = nonNegative(u.input_tokens_details?.cached_tokens);
  const cacheWrite = nonNegative(u.input_tokens_details?.cache_write_tokens);
  const total = nonNegative(u.input_tokens);
  return {
    input: Math.max(0, total - cached - cacheWrite),
    output: nonNegative(u.output_tokens),
    cacheRead: cached || undefined,
    cacheWrite: cacheWrite || undefined,
  };
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function mapResponsesStatus(status: string | undefined, sawToolUse: boolean): StopReason {
  if (status === 'incomplete') return 'max_tokens';
  // 'completed' (and anything else benign) → tool_use when a call was emitted.
  return sawToolUse ? 'tool_use' : 'end_turn';
}
