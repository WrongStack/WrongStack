import type { CacheTtl, ReasoningEffort } from '../provider.js';

export interface ModelRuntimeReasoningConfig {
  /**
   * Whether to send explicit reasoning enable/disable.
   * - 'auto'    → do not send explicit fields; provider/model default wins
   * - 'on'      → send `reasoning.enabled = true`
   * - 'off'     → send `reasoning.enabled = false` only when the model supports disable
   */
  mode?: 'auto' | 'on' | 'off' | undefined;
  /** Reasoning effort. Only sent when the model advertises `effortSupported`. */
  effort?: ReasoningEffort | undefined;
  /** Preserve thinking across turns. Only sent when `preserveThinking !== 'unsupported'`. */
  preserve?: boolean | undefined;
}

/**
 * Runtime prompt-cache controls mapped into `Request.cache`. Currently only the
 * Anthropic TTL toggle (5m vs 1h) is exposed; other providers ignore it.
 */
export interface ModelRuntimeCacheConfig {
  ttl?: CacheTtl | undefined;
  /**
   * Opt-in explicit Gemini context caching. When true, the Google provider
   * creates a server-side `cachedContents` resource for the stable system
   * prefix (system instruction + tool defs) and references it by name instead
   * of resending it every turn. Default false: Gemini's automatic *implicit*
   * caching already covers a byte-stable prefix with no setup. Ignored by every
   * non-Google provider. Any failure in the create flow falls back to the
   * normal inline request, so enabling it can never break a request.
   */
  geminiExplicit?: boolean | undefined;
}

/**
 * Shared runtime controls applied to every provider request, regardless of host
 * (REPL / TUI / WebUI). The CLI installs a single request-pipeline middleware
 * that reads these and mutates the outgoing `Request`.
 */
export interface ModelRuntimeConfig {
  reasoning?: ModelRuntimeReasoningConfig | undefined;
  cache?: ModelRuntimeCacheConfig | undefined;
  /**
   * Generic generation parameters mapped directly onto `Request` fields.
   * Only sent when the active model's `Capabilities` advertise support.
   */
  parameters?: ModelRuntimeParametersConfig | undefined;
}

/**
 * Selects which built-in/base system identity prompt file is used when building
 * the host system prompt. Surfaces keep `default` unless explicitly told to use
 * the lite or pro prompt.
 */
export interface SystemPromptConfig {
  variant?: 'default' | 'lite' | 'pro' | undefined;
}

/**
 * Generic generation parameters the user can set per-session / per-project.
 * Each field maps to a `Request` field of the same name and is gated by the
 * corresponding `Capabilities` flag so unsupported models don't receive
 * parameters they'd reject.
 */
export interface ModelRuntimeParametersConfig {
  /** Top-K sampling (Anthropic, Gemini). Gated by `capabilities.topK`. */
  topK?: number | undefined;
  /** Frequency penalty (OpenAI, Gemini). Gated by `capabilities.frequencyPenalty`. */
  frequencyPenalty?: number | undefined;
  /** Presence penalty (OpenAI, Gemini). Gated by `capabilities.presencePenalty`. */
  presencePenalty?: number | undefined;
  /** Random seed (OpenAI, Gemini). Gated by `capabilities.seed`. */
  seed?: number | undefined;
  /** End-user identifier for abuse monitoring. */
  user?: string | undefined;
  /** Log probabilities (OpenAI, Gemini). Gated by `capabilities.logprobs`. */
  logprobs?: boolean | undefined;
  /** Number of top logprobs to return (OpenAI). Only when `logprobs` is true. */
  topLogprobs?: number | undefined;
}

/**
 * HQ client connection settings. Same-machine clients can auto-discover the
 * local HQ auth file; remote clients use this config-backed URL/token pair.
 */
export interface HqClientConfig {
  /** Enable HQ publishing. Env WRONGSTACK_HQ_ENABLED still overrides at runtime. */
  enabled?: boolean | undefined;
  /** HQ HTTP base URL, e.g. http://host:3499. */
  url?: string | undefined;
  /** Client token for /ws/client. Stored encrypted by SecretVault when persisted. */
  token?: string | undefined;
  /** Optional HQ data dir for same-machine auth.json discovery. */
  dataDir?: string | undefined;
  /** Send raw content previews to HQ instead of redacted previews. */
  rawContent?: boolean | undefined;
  /** Override project display name in HQ. */
  projectAlias?: string | undefined;
}

/**
 * Cloud config-sync settings for my.wrongstack.com (the account portal —
 * distinct from the local HQ command center configured via `hq`). The full
 * client contract, including which config sections sync and which stay
 * local, is the server repo's docs/CLIENT_SYNC_CONTRACT.md.
 */
export interface CloudSyncConfig {
  /** Enable background config synchronization. */
  enabled?: boolean | undefined;
  /** Portal base URL, e.g. https://my.wrongstack.com. */
  url?: string | undefined;
  /** Machine bearer token (wst_…). Stored encrypted by SecretVault when persisted. */
  token?: string | undefined;
  /** Seconds between background sync passes. Default 300, minimum 60. */
  intervalSeconds?: number | undefined;
}

/**
 * Token-saving mode tier levels. Controls how aggressively the system prompt
 * is compacted to reduce per-request token consumption.
 *
 * - 'off'        — Full prompt, all tools, complete guidance (no reduction)
 * - 'minimal'    — TIER1 tools (13, including codebase index lifecycle), stripped guidance
 * - 'light'      — Same Tier 1 tool surface, common patterns, minimal guidance
 * - 'medium'     — TIER1 + TIER2 development tools, some guidance (default when `true`)
 * - 'aggressive' — Maximum savings before tools become unusable (~4-5k tokens saved)
 */
/**
 * Prompt token-saving tiers. `'auto'` is an INPUT-only sentinel meaning "pick a
 * concrete tier from the model's context window" — it is resolved to one of the
 * concrete tiers by {@link resolveTokenSavingTier} before reaching the prompt
 * builder (which never sees `'auto'`; if it somehow does, it behaves as `'off'`,
 * i.e. the full prompt — the safe fallback).
 */
export type TokenSavingTier = 'off' | 'auto' | 'minimal' | 'light' | 'medium' | 'aggressive';

/** Concrete tiers the prompt builder actually consumes ('auto' excluded). */
export type ConcreteTokenSavingTier = Exclude<TokenSavingTier, 'auto'>;

/**
 * Normalize a TokenSavingTier value, handling backward-compatible boolean inputs.
 * - `true`  → 'medium' (existing behavior)
 * - `false` → 'off'
 * - `'auto'` → `'medium'` — consumers without model-window context use a stable,
 *   useful development baseline instead of silently expanding to the full tool
 *   catalog. The prompt builder may refine `'auto'` with
 *   {@link resolveTokenSavingTier} when the model window is known.
 * - other valid strings are returned as-is; `undefined`/invalid → 'off'
 */
export function normalizeTokenSavingTier(val?: TokenSavingTier | boolean): ConcreteTokenSavingTier {
  if (val === undefined) return 'off';
  if (typeof val === 'boolean') return val ? 'medium' : 'off';
  if (val === 'auto') return 'medium';
  const validTiers = new Set<ConcreteTokenSavingTier>([
    'off',
    'minimal',
    'light',
    'medium',
    'aggressive',
  ]);
  return validTiers.has(val as ConcreteTokenSavingTier) ? (val as ConcreteTokenSavingTier) : 'off';
}

/**
 * Resolve the effective (concrete) token-saving tier for the **prompt builder**,
 * expanding the `'auto'` sentinel from the model's context window. This is
 * **cache-safe**: the window is stable for a session, so it resolves to the same
 * tier every turn — the system-prompt prefix stays byte-stable and the provider
 * prompt cache is never busted by a shifting tier (unlike a per-turn
 * pressure-driven tier). It re-resolves only on `/model` switch, which busts the
 * cache anyway.
 *
 * Modern threshold mapping — the system prompt (~12K tokens) is roughly the same
 * size regardless of context window; paying full price for it on every turn when
 * there is abundant headroom is wasteful. The tiers apply minimal trimming first,
 * escalating only when the window is genuinely tight:
 *   - `< 32k`     → `'medium'`  (tiny window: identity + tool prose is a big fraction)
 *   - `< 128k`    → `'light'`   (tight window: GPT-4 base class models)
 *   - `>= 128k`   → `'minimal'` (modern models: GPT-4o, Sonnet, DeepSeek, Qwen 3, Gemini 1M, Qwen 1M)
 *   - unknown window → `'off'` (never guess a lean prompt without evidence)
 *
 * Explicit concrete tiers (a user who set `'medium'`, `'off'`, …) are always
 * respected verbatim — `'auto'` is the only value that consults the window.
 */
export function resolveTokenSavingTier(
  val: TokenSavingTier | boolean | undefined,
  maxContext: number | undefined,
): ConcreteTokenSavingTier {
  if (val === 'auto') {
    if (typeof maxContext !== 'number' || !Number.isFinite(maxContext) || maxContext <= 0) {
      return 'off';
    }
    if (maxContext < 32_000) return 'medium';
    if (maxContext < 128_000) return 'light';
    return 'minimal';
  }
  return normalizeTokenSavingTier(val);
}

// FleetChatVerbosity, FLEET_CHAT_VERBOSITY_VALUES, and resolveFleetChatVerbosity
// were moved to the dependency-free leaf module ./fleet-chat.ts to avoid a
// type-level import cycle with ./autonomy.ts. They are surfaced through the
// config barrel (../config.ts) which re-exports ./config/fleet-chat.js directly.

export const DEFAULT_TUI_THINKING_WORD = 'thinking';
export const MAX_TUI_THINKING_WORD_LENGTH = 16;

/**
 * Hard cap on the WrongProxy / WrongTrace URL draft. URLs don't have a
 * strict length limit, but capping to a sane 2 KiB prevents a runaway
 * paste from bloating the `settingsPicker` slice. The runtime probe
 * accepts any well-formed URL up to whatever the OS / fetch allow.
 */
export const MAX_WRONGPROXY_URL_LENGTH = 2048;

/**
 * Normalize the configurable statusline word shown while the TUI is working.
 * The value must be a single short word; invalid values fall back to the default.
 */
export function normalizeTuiThinkingWord(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TUI_THINKING_WORD;
  const word = value.trim();
  if (word.length === 0 || word.length > MAX_TUI_THINKING_WORD_LENGTH) {
    return DEFAULT_TUI_THINKING_WORD;
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(word)) return DEFAULT_TUI_THINKING_WORD;
  return word;
}
