import type { BrainHeuristicsConfig } from '../coordination/brain-heuristics.js';
import type { BrainRule } from '../coordination/brain-rules.js';
import type { ContextWindowModeId } from './context-window.js';
import type { ConfiguredHook, HookEvent } from './hooks.js';
import type { WireFamily } from './models-registry.js';
import type { CacheTtl, Capabilities, ReasoningEffort } from './provider.js';
import type { Permission } from './tool.js';

/**
 * Runtime reasoning controls the user can set per-session/project. Mapped into
 * the provider `Request.reasoning` field by the model-runtime request
 * middleware, gated by the active model's `reasoningConfig` capabilities so
 * unsupported values are omitted (and warned) instead of triggering provider
 * 400s. See `resolveReasoningForRequest()` in packages/core.
 */
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
 * - `'auto'` → `'off'` — the `'auto'` sentinel is window-dependent, so EVERY
 *   consumer that isn't the prompt builder (tool selection, lazy-load gate, TUI
 *   display) must treat it as the safe no-op `'off'`: it must NOT reduce the
 *   registered tool set or enable lazy loading on its own. Only the prompt
 *   builder expands `'auto'` — via {@link resolveTokenSavingTier} — and only for
 *   the (cache-stable) prompt prose. This keeps auto-tiering capability-neutral.
 * - other valid strings are returned as-is; `undefined`/invalid → 'off'
 */
export function normalizeTokenSavingTier(val?: TokenSavingTier | boolean): ConcreteTokenSavingTier {
  if (val === undefined) return 'off';
  if (typeof val === 'boolean') return val ? 'medium' : 'off';
  const validTiers = new Set<ConcreteTokenSavingTier>([
    'off',
    'minimal',
    'light',
    'medium',
    'aggressive',
  ]);
  // 'auto' is deliberately absent → collapses to 'off' for non-prompt consumers.
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

/**
 * Verbosity of fleet/subagent activity streamed into the main TUI chat.
 * See {@link AutonomyConfig.fleetChatVerbosity}.
 */
export type FleetChatVerbosity = 'off' | 'full';

export const FLEET_CHAT_VERBOSITY_VALUES: readonly FleetChatVerbosity[] = ['off', 'full'];

/**
 * Resolve the effective fleet-chat verbosity from autonomy config.
 * An explicit `fleetChatVerbosity` wins; absence means 'off'.
 */
export function resolveFleetChatVerbosity(
  autonomy?: Pick<AutonomyConfig, 'fleetChatVerbosity'>,
): FleetChatVerbosity {
  const explicit = autonomy?.fleetChatVerbosity;
  if (explicit && (FLEET_CHAT_VERBOSITY_VALUES as readonly string[]).includes(explicit)) {
    return explicit;
  }
  return 'off';
}

export const DEFAULT_TUI_THINKING_WORD = 'thinking';
export const MAX_TUI_THINKING_WORD_LENGTH = 16;

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

export interface ContextConfig {
  /** Context-window policy mode. Controls compaction thresholds and preservation depth. */
  mode?: ContextWindowModeId | undefined;
  warnThreshold: number;
  softThreshold: number;
  hardThreshold: number;
  /** Enable automatic compaction when thresholds are crossed (default: true). */
  autoCompact?: boolean | undefined;
  /**
   * Model used for LLM-assisted summarization in IntelligentCompactor.
   * Falls back to the main model when omitted.
   */
  summarizerModel?: string | undefined;
  /**
   * Override the effective context window size (in tokens). Use this when
   * you want the compactor to trigger earlier than the provider's actual
   * maxContext. Defaults to the provider's reported maxContext.
   */
  effectiveMaxContext?: number | undefined;
  maxSessionTokens?: number | undefined;
  maxDailyTokens?: number | undefined;
  preserveK: number;
  eliseThreshold: number;
  /** Compactor strategy: 'hybrid' (default, fast rules), 'intelligent' (LLM summarization), 'selective' (LLM-driven selection). */
  strategy?: 'hybrid' | 'intelligent' | 'selective' | undefined;
  /** Enable LLM-driven selective compaction (default: false for backward compat). */
  llmSelector?: boolean | undefined;
}

/**
 * Runtime configuration for the process circuit breaker (the one owned by the
 * ProcessRegistry that gates `bash`/`exec`). Toggle via `/settings breaker`.
 *
 * The breaker itself is a low-level primitive (`packages/tools/.../circuit-breaker.ts`)
 * that is on by default; this section controls whether the registry actually
 * participates in it and how it auto-recovers.
 */
export interface CircuitBreakerRuntimeConfig {
  /**
   * Enable circuit-breaker protection. When false (the default), the breaker
   * is bypassed — `bash`/`exec` calls always proceed regardless of failure
   * history. When true, the breaker trips on repeated failures / slow calls /
   * bursts and blocks further calls until it recovers.
   */
  enabled?: boolean | undefined;
  /**
   * When the breaker trips, automatically kill all tracked processes AND
   * reset the breaker to closed after this delay (ms). 0 = disabled (manual
   * recovery only via `/kill reset`). Only effective when `enabled` is true.
   * While armed, the statusline shows a live countdown to the kill/reset.
   */
  autoKillResetMs?: number | undefined;
}

/**
 * Adaptive concurrency controller configuration. When enabled, the controller
 * automatically adjusts `maxConcurrent` based on rate-limit (429) errors:
 * - On 429: halves `maxConcurrent` (floor at 1)
 * - On sustained success (no 429 for `recoveryIntervalMs`): increases `maxConcurrent` by 1
 */
export interface AdaptiveConcurrencyConfig {
  /** Enable adaptive concurrency. Default: false (disabled). */
  enabled?: boolean | undefined;
  /**
   * Minimum concurrency floor. The controller never drops below this.
   * Default: 1.
   */
  minConcurrent?: number | undefined;
  /**
   * Maximum concurrency ceiling. The controller never exceeds this.
   * Default: 16 (matches MultiAgentCoordinator default).
   */
  maxConcurrent?: number | undefined;
  /**
   * Multiplicative decrease factor when a 429 is hit.
   * `newConcurrency = floor(currentConcurrency * decreaseFactor)`.
   * Default: 0.5 (halves concurrency).
   */
  decreaseFactor?: number | undefined;
  /**
   * Number of consecutive successful requests before increasing concurrency by 1.
   * Default: 10.
   */
  successThreshold?: number | undefined;
  /**
   * How often (ms) to check for recovery and bump concurrency.
   * Default: 30_000 (30 seconds).
   */
  recoveryIntervalMs?: number | undefined;
}

export interface ToolsConfig {
  defaultExecutionStrategy: 'parallel' | 'sequential' | 'smart';
  maxIterations: number;
  iterationTimeoutMs: number;
  /** Hard upper bound for a single tool call timeout. Defaults to 5 minutes. */
  maxToolTimeoutMs?: number | undefined;
  sessionTimeoutMs: number;
  perIterationOutputCapBytes: number;
  /**
   * Per-tool prose budget for the tool's top-level description and usage hint.
   * Missing entries default to "extend".
   */
  descriptionMode?: ToolDescriptionModeConfig | undefined;
  /**
   * Per-tool on-screen result rendering mode (terminal / WebUI / TUI).
   * Missing entries default to "extend". Independent of `descriptionMode`:
   * `/tool <name> result simple` toggles this without touching the
   * LLM-side description length.
   */
  resultRenderMode?: ToolResultRenderModeConfig | undefined;
  /**
   * Tool names to disable. Disabled tools are excluded from the tool registry
   * (`ToolRegistry.list()` / `get()`), so they do NOT appear in the system
   * prompt's "## Tool usage" block — reducing per-request token consumption.
   * Override per-session with `/tool enable <name>` or re-enable all via
   * `/tool enable-all`.
   */
  disabledTools?: string[] | undefined;
  /**
   * When true (default), the agent automatically extends its iteration
   * limit by 100 when hit. Set to false to require user confirmation.
   */
  autoExtendLimit?: boolean | undefined;
  /**
   * When true, file tools (read/write/edit/grep/glob/install) are confined to
   * the project root and `set_working_dir` may not leave it. Default: false —
   * tools may access paths outside the project root, still subject to each
   * tool's permission tier (writes/edits prompt for confirmation). Toggle via
   * `/settings` ("Filesystem access").
   */
  restrictToProjectRoot?: boolean | undefined;
  /**
   * Per-command policy for the `exec` tool's allowlist. The tool ships a
   * curated default allowlist of dev/build commands; this extends or trims it.
   *
   * SECURITY: `allow` EXPANDS what the agent may execute, so it is honored only
   * from the trusted active-profile config — the config loader
   * strips `tools.exec.allow` from the untrusted, repo-committed
   * `<project>/.wrongstack/config.json`. `deny` only ever REMOVES commands, so
   * it is honored from any source.
   */
  exec?: ExecToolConfig | undefined;
  /**
   * Agent-loop repetition detector tuning. The detector watches two signals:
   * consecutive effectively-identical iterations (same tool-name set + inputs
   * + text) and per-call repeats (the same tool invoked with identical
   * arguments N times within a sliding window, even when interleaved with
   * other calls). In the default `steer-then-cut` mode the first detection
   * folds a corrective note into the conversation and lets the run continue;
   * only persistent repetition cuts the turn. Omitted fields use built-in
   * defaults (see DEFAULT_TOOLS_CONFIG.loopDetection).
   */
  loopDetection?: LoopDetectionConfig | undefined;
}

/** Tuning for the agent-loop repetition detector (`tools.loopDetection`). */
export interface LoopDetectionConfig {
  /**
   * `steer-then-cut` (default): inject a corrective note at the steer
   * threshold, cut the turn only if repetition persists to the cut threshold.
   * `cut`: legacy behavior — hard-stop at the steer threshold, per-call
   * detector disabled. `off`: disable loop detection entirely.
   */
  mode?: 'steer-then-cut' | 'cut' | 'off' | undefined;
  /** Consecutive identical iterations before the detector acts (default 3, min 2). */
  steerThreshold?: number | undefined;
  /**
   * Consecutive identical iterations at which the turn is cut in
   * `steer-then-cut` mode (default steerThreshold + 2, min steerThreshold + 1).
   */
  cutThreshold?: number | undefined;
  /** Sliding window of recent tool calls for per-call repeat detection (default 12, min 4). */
  windowSize?: number | undefined;
  /**
   * Identical (name + canonicalized args) calls within the window that
   * trigger a steer note (default 4, min 2).
   */
  callRepeatThreshold?: number | undefined;
}

/** Allow/deny extension of the `exec` tool's built-in command allowlist. */
export interface ExecToolConfig {
  /**
   * Extra command names to add to the allowlist (e.g. `["make", "dotnet"]`).
   * Trusted sources only — stripped from in-project repo config.
   */
  allow?: string[] | undefined;
  /**
   * Command names to remove from the allowlist. Honored from any source —
   * removing a command can only narrow what runs, so it is always safe.
   */
  deny?: string[] | undefined;
  /**
   * Per-rule bypass for the heuristic danger detector. Each entry is a
   * stable `matchedRule` id (e.g. `rm-recursive`, `git-push-force`); a
   * matched rule whose id is in this list is suppressed.
   *
   * Use case: a project that legitimately runs `rm -rf ./build` on every
   * CI run can add `"rm-recursive"` to bypass so the detector stops
   * emitting banners for that one rule — without disabling it for every
   * other `rm -rf` invocation.
   *
   * **Trusted sources only.** Bypassing a danger rule means the user
   * agreed to a specific destructive pattern; in-project repo config
   * could otherwise be used to silently opt everyone in. The boot path
   * strips this field from `<project>/.wrongstack/config.json` the
   * same way it strips `allow`.
   */
  danger?: ExecDangerConfig | undefined;
}

export interface ExecDangerConfig {
  /**
   * List of danger rule ids to skip. Each id corresponds to a rule in
   * `@wrongstack/tools/src/_danger-detect.ts` (e.g. `rm-recursive`,
   * `git-push-force`, `inline-eval`, `sudo`). Unknown ids are ignored
   * (forward-compat: a rule added in a future version can be referenced
   * before the user upgrades).
   */
  bypass?: string[] | undefined;
}

export type ToolDescriptionMode = 'extend' | 'simple';
export type ToolDescriptionModeConfig = Record<string, ToolDescriptionMode | undefined>;

/**
 * Per-tool on-screen result rendering mode. Independent of
 * {@link ToolDescriptionMode}: `descriptionMode` controls the prose the
 * model sees in the system prompt, `resultRenderMode` controls how the
 * tool's RESULT is printed to the user (terminal / WebUI / TUI).
 *
 * - `simple` — meta only (filename, line count, exit code). Body is hidden
 *   by default; the user can still expand on demand where the renderer
 *   supports it.
 * - `extend` — full preview, up to 10 lines for read-like tools.
 *
 * The two modes are toggled independently via `/tool <name> desc simple`
 * and `/tool <name> result simple`. The legacy `/tool <name> simple`
 * command sets BOTH at once for backward compatibility.
 */
export type ToolResultRenderMode = 'extend' | 'simple';
export type ToolResultRenderModeConfig = Record<string, ToolResultRenderMode | undefined>;

export interface ProviderApiKey {
  /** Short human-readable label (e.g. "personal", "work", "rate-limit-backup"). */
  label: string;
  /**
   * The key itself. The field name contains `apiKey` so the secret-vault
   * walker will encrypt it on write and decrypt it on read.
   */
  apiKey: string;
  /** ISO-8601 timestamp the key was added. */
  createdAt: string;
  /**
   * How this credential was obtained.
   * - `api_key`       — manually pasted API key (default)
   * - `oauth`         — OAuth 2.0 device-code / authorization-code flow
   * - `session_token` — extracted from browser session (ChatGPT web, etc.)
   */
  authMethod?: 'api_key' | 'oauth' | 'session_token' | undefined;
  /** ISO-8601 expiry. When set, the token manager will refresh before this time. */
  expiresAt?: string | undefined;
  /**
   * OAuth refresh token. Stored encrypted by the secret-vault walker because
   * the field name contains `Token` (case-insensitive match by vault).
   */
  refreshToken?: string | undefined;
  /** Token type as returned by the OAuth endpoint (e.g. "bearer"). */
  tokenType?: string | undefined;
  /** OAuth scope string (e.g. "openai.models.read openai.models.use"). */
  scope?: string | undefined;
  /**
   * ChatGPT account id, extracted from the OAuth access-token JWT
   * (`https://api.openai.com/auth`.chatgpt_account_id). Sent as the
   * `chatgpt-account-id` header by the `openai-codex` wire family. Cached
   * here for display/diagnostics; the provider re-derives it from the live
   * token at request time so it can never go stale after a refresh.
   */
  accountId?: string | undefined;
}

export interface ProviderConfig {
  type: string;
  /**
   * Legacy single-key field. Still honored as a read fallback when `apiKeys`
   * is empty (for configs not yet migrated to multi-key format). After key
   * management operations (`writeKeysBack`), this field is **cleared** to
   * prevent accidental serialization of the plaintext key. Consumers that
   * need the active API key should use `resolveActiveApiKey()` (cli) or
   * resolve from `apiKeys[]` directly — never read `cfg.apiKey` in new code.
   */
  apiKey?: string | undefined;
  /** Multiple keys for the same provider — pick one with `activeKey`. */
  apiKeys?: ProviderApiKey[] | undefined;
  /** Label of the entry in `apiKeys` to use. Defaults to the first one. */
  activeKey?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string>;
  model?: string | undefined;
  quirks?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /**
   * Optional wire-family override. When present, the provider can be
   * constructed without consulting the models.dev catalog — useful for
   * self-hosted endpoints, internal proxies, or for working offline.
   */
  family?: WireFamily | undefined;
  /** Custom env var names to probe when `apiKey` is missing. */
  envVars?: string[] | undefined;
  /** Optional list of models the user wants visible for this provider. */
  models?: string[] | undefined;
  /**
   * Fetch this provider's model list + per-model capabilities from its
   * `{baseUrl}/models` endpoint at startup and inject them into the catalog.
   * For openai-compatible gateways/proxies (omniroute, LiteLLM, vLLM, …) that
   * expose rich metadata there. Defaults on for presets that set it (omniroute).
   * Discovery is best-effort: a down server or missing key is a no-op.
   */
  autoDiscoverModels?: boolean | undefined;
  /**
   * Provider-relative custom model definitions (maps modelId → definition).
   * Each entry adds/overrides a model for this provider with optional
   * capability overrides. The model id is the key, not a fully qualified id.
   */
  customModels?: Record<string, CustomModelDefinition>;
  /**
   * Per-provider OAuth configuration. When present, `wstack auth login <id>`
   * uses this instead of prompting for a raw API key. Set by the catalog or
   * by the user via `/settings`.
   */
  oauthConfig?:
    | {
        /** OAuth client id registered with the provider. */
        clientId?: string | undefined;
        /** Device authorization endpoint (RFC 8628). */
        deviceCodeEndpoint?: string | undefined;
        /** Token endpoint for code exchange and refresh. */
        tokenEndpoint?: string | undefined;
        /** Authorization server URL shown to the user for opening in browser. */
        authorizationEndpoint?: string | undefined;
        /** Default OAuth scopes to request. */
        scopes?: string[] | undefined;
      }
    | undefined;
}

/**
 * One entry in the per-task model matrix. Pins a catalog role, a phase, or
 * the `*` default to a specific model (and, optionally, a specific provider).
 * Resolved at subagent-spawn time so e.g. `security-scanner` can run a
 * different model than `documentation` while the leader stays on its own.
 */
export interface ModelMatrixEntry {
  /** Provider registry id (e.g. "anthropic", "minimax", "zai"). When omitted,
   *  the leader's provider is used with this entry's model. */
  provider?: string | undefined;
  /** Model id to run for the matched role/phase/default. */
  model?: string | undefined;
  /**
   * Runtime request overrides for subagents matched by this entry. This is
   * intentionally scoped to subagents: leader requests keep using top-level
   * `Config.modelRuntime`, while a role/phase can opt into its own reasoning
   * effort, cache TTL, or gated generation parameters.
   */
  modelRuntime?: ModelRuntimeConfig | undefined;
  /**
   * Named fallback profile to use for the matched role/phase/default. When
   * `model` is omitted, the first model in the profile becomes the primary and
   * the remaining entries become that subagent's fallback chain.
   */
  fallbackProfile?: string | undefined;
}

export interface MCPServerConfig {
  /** Human-readable description shown in `wstack mcp list`. */
  description?: string | undefined;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string>;
  url?: string | undefined;
  headers?: Record<string, string>;
  enabled?: boolean | undefined;
  allowedTools?: string[] | undefined;
  permission?: Permission | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  /**
   * Lazy connect: when true, the server process is NOT spawned at boot. Its
   * tools are registered from a cached manifest (discovered on the first ever
   * connect) and the server only spawns when one of its tools is actually
   * called, then auto-sleeps after an idle period. Default (false/undefined) =
   * eager connect at boot.
   */
  lazy?: boolean | undefined;
  /**
   * Allowlist of environment variable names to forward from the parent process
   * to this MCP server's child process. The values are resolved from
   * `process.env` at spawn time, NOT stored in the config file.
   *
   * Why this exists: WrongStack's `buildChildEnv()` security filter scrubs
   * env vars whose names look like secrets (TOKEN, SECRET, AUTH, KEY, ...)
   * from all child processes — this prevents a compromised MCP server from
   * exfiltrating provider API keys. But most MCP servers (GitHub, Slack,
   * Brave Search, ...) need their own API tokens from the environment.
   * `passthroughEnv` is the explicit bypass: only vars listed here survive
   * the filter, and they go through the `extra` path (unfiltered merge).
   *
   * Built-in presets declare their required env vars here so they work
   * out of the box when the user has the corresponding env vars exported
   * in their shell. Users can also add entries for custom servers.
   *
   * Example: passthroughEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN']
   */
  passthroughEnv?: string[] | undefined;
  /**
   * Operational-health settings for this MCP server. Thresholds are optional;
   * when omitted the server is considered healthy as long as its connection
   * lifecycle succeeds. Latency thresholds compare against the rolling p95 of
   * the bounded sample buffer; the in-flight threshold compares against the
   * observed peak in-flight call count.
   */
  health?: MCPHealthConfig | undefined;
}

/** Per-server operational-health knobs. */
export interface MCPHealthConfig {
  thresholds?: MCPHealthThresholds | undefined;
}

/**
 * Configurable thresholds that can push an otherwise-healthy MCP server into
 * the `degraded` health state. All thresholds are optional and disabled when
 * omitted so existing behaviour is preserved.
 */
export interface MCPHealthThresholds {
  /** Connection latency p95 above this value marks the server degraded. */
  connectionLatencyP95Ms?: number | undefined;
  /** Discovery (capability listing) latency p95 above this marks degraded. */
  discoveryLatencyP95Ms?: number | undefined;
  /** Tool-call latency p95 above this marks degraded. */
  callLatencyP95Ms?: number | undefined;
  /** Peak in-flight calls above this marks the server saturated/degraded. */
  inFlightCalls?: number | undefined;
}

export interface LogConfig {
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  file?: string | undefined;
}

export interface PluginConfig {
  name: string;
  enabled?: boolean | undefined;
  options?: Record<string, unknown>;
}

/**
 * Human-owned policy for the LLM-facing `plugin_manager` tool.
 * This is deliberately separate from `PluginConfig.enabled`: ordinary
 * `/plugin` commands remain available to the user even when the LLM is not
 * allowed to change a plugin's boot state.
 */
export interface PluginManagerConfig {
  /**
   * Plugin names/aliases that `plugin_manager` may discover and use but may
   * not enable or disable. Use `"*"` to block all LLM plugin-state changes.
   */
  locked?: string[] | undefined;
}

/**
 * Optional subsystems that the CLI can boot without. The core flow
 * (provider + agent loop + bundled tools + session) always works; these
 * just add capabilities. `--no-features` flips all of these off, which
 * is the minimum viable WrongStack: a single provider, a fixed config,
 * no network calls at startup.
 */
export interface FeaturesConfig {
  /** Load MCP servers declared in `mcpServers`. */
  mcp: boolean;
  /** Load + initialise npm plugins declared in `plugins`. */
  plugins: boolean;
  /** Register `remember` / `forget` tools backed by memory store. */
  memory: boolean;
  /**
   * Automatically consolidate session learnings into long-term memory
   * after each completed run. The agent extracts key facts, conventions,
   * and decisions via a lightweight LLM call and persists them.
   * Enabled by default when `memory` is on; set to false to opt out.
   */
  memoryConsolidation?: boolean | undefined;
  /** Fetch the models.dev catalog at startup. When false, the provider
   *  must declare its `family` explicitly in `providers[<id>]`. */
  modelsRegistry: boolean;
  /** Discover + load skills from disk. */
  skills: boolean;
  /**
   * Enable the prompt library (`/prompt`, `/prompts`, `/prompt-gen`, the WebUI
   * modal and the bundled 168-prompt dataset). Defaults to on; set to false to
   * disable the subsystem entirely (the loader is withheld so every surface
   * reports it unavailable).
   */
  prompts?: boolean | undefined;
  /**
   * Token-saving mode tier. Controls how aggressively the system prompt
   * is compacted to reduce per-request token consumption.
   *
   * - 'off'        — Full prompt, all tools, complete guidance
   * - 'minimal'    — TIER1 tools only, stripped guidance (~3-4k tokens saved)
   * - 'light'     — Core + memory tools, common patterns, minimal guidance
   * - 'medium'    — Most development tools, some guidance
   * - 'aggressive' — Maximum savings before tools become unusable (~4-5k tokens)
   *
   * Boolean values are accepted for backward compatibility:
   * - `true`  → 'medium'
   * - `false` → 'off'
   *
   * Enable via CLI: `--token-saving-tier <level>` or `--token-saving-mode` (maps to 'medium').
   * Configure via: `features.tokenSavingMode: "minimal"` in config.
   */
  tokenSavingMode?: TokenSavingTier | boolean | undefined;
  /**
   * Enable the autonomous-coordination toolkit (AutonomousCoordinator +
   * KnowledgeGraph + ConsensusProtocol + TaskAuctioneer + ChangeManager +
   * TaskDAG). When true (the default), the TUI boot wires the coordinator
   * lazily on the first Director spawn. When false, the coordinator is
   * never constructed and the `/coordinator` slash command reports it
   * unavailable — reducing the coordination domain's runtime surface for
   * users who only use the simpler Director/Fleet path.
   */
  autonomousCoordination?: boolean | undefined;
  /**
   * Allow tools to read/write paths outside the project root directory.
   * When true (default), tools can access any path on the filesystem.
   * When false, tools are restricted to the project root directory.
   */
  allowOutsideProjectRoot?: boolean | undefined;
  /**
   * Auto-bootstrap the mailbox HTTP bridge from any WrongStack surface
   * (REPL/TUI/WebUI/eternal). When 'auto' (the default), the first
   * surface to come up for a given project joins or spawns the bridge
   * so external agents can connect without the user running
   * `wstack mailbox serve` themselves. 'off' disables this — operators
   * must start the bridge explicitly (e.g. via the `/mailbox-serve`
   * slash command or the standalone `wstack mailbox serve` subcommand).
   * The per-project lock + token-persistence model means a second
   * surface on the same project joins the first's bridge rather than
   * spawning a duplicate.
   */
  mailboxBridge?: 'auto' | 'off' | undefined;
}

export interface SageConfig {
  /**
   * Default: true. SAGE is the ONLY memory backend — this flag no longer
   * swaps the store. When `false`, the backend is still SAGE (explicit
   * `/memory`, agent memory tools, and WebUI all keep working); only automatic
   * context injection and session-end hygiene are turned off.
   */
  enabled?: boolean | undefined;
  storage?:
    | {
        /** Store memory inside the project under a gitignored directory. Default: true. */
        projectLocal?: boolean | undefined;
        /** Project-relative directory. Default: ".wrongstack/memories". */
        directory?: string | undefined;
      }
    | undefined;
  inject?:
    | {
        /** Add relevant memory to ordinary turn-level context. Default: false (opt-in). */
        turnContext?: boolean | undefined;
        /** Add relevant memory to read/tree/grep/bash/edit tool results. Default: true. */
        toolResults?: boolean | undefined;
        /** Enrich tool retrieval with live todo/Kanban task state and context-pressure budgeting. Default: true. */
        taskAware?: boolean | undefined;
        /** Maximum diverse, structurally related hints appended to a single tool result. Default: 8. */
        maxHintsPerTool?: number | undefined;
        /** Maximum characters appended to a single tool result. Default: 2800. */
        maxCharsPerTool?: number | undefined;
        /** Maximum memories appended to ordinary turn context. Default: 8. */
        maxTurnMemories?: number | undefined;
        /** Maximum characters appended to ordinary turn context. Default: 2400. */
        maxCharsPerTurn?: number | undefined;
        /** Minimum retrieval score for ordinary hints. Default: 0.65. */
        minScore?: number | undefined;
        /** Cooldown before the same memory can be injected again. Default: 30 minutes. */
        repeatCooldownMs?: number | undefined;
        triggers?:
          | Partial<
              Record<
                | 'read'
                | 'tree'
                | 'grep'
                | 'glob'
                | 'codebase_search'
                | 'bash'
                | 'write'
                | 'edit'
                | 'patch',
                boolean
              >
            >
          | undefined;
      }
    | undefined;
  retrieval?:
    | {
        /**
         * Weight given to the metadata score floor (0–1) in the relevance-blended
         * scoring formula: `metadataScore * (metadataWeight + relevance * (1 - metadataWeight))`.
         * At 0.0, relevance fully gates injection. At 1.0, metadata alone decides.
         * Default: 0.3 — validated against 148 real query-memory pairs.
         */
        metadataWeight?: number | undefined;
      }
    | undefined;
  hygiene?:
    | {
        /** Run hygiene after successful sessions. Default: true. */
        autoAfterSession?: boolean | undefined;
        /** Re-check anchored memories when files are edited. Default: true. */
        autoOnFileChange?: boolean | undefined;
        /** Archive stale/low-value memories after this many days. Default: 90. */
        retentionDays?: number | undefined;
        /** Archive low-confidence memories after this many days. Default: 30. */
        archiveLowConfidenceAfterDays?: number | undefined;
        /**
         * Archive active memories that were injected at least `unusedMinInjections`
         * times but never referenced by the assistant, this many days after their
         * last content update. Default: 30.
         */
        archiveUnusedAfterDays?: number | undefined;
        /** Minimum injection count before a never-used memory is archived. Default: 10. */
        unusedMinInjections?: number | undefined;
      }
    | undefined;
  embeddings?:
    | {
        /** Optional future semantic layer. Disabled by default and never required. */
        enabled?: boolean | undefined;
      }
    | undefined;
}

export interface AutonomyConfig {
  /** Default autonomy mode at startup. Default: "auto". */
  defaultMode?: 'off' | 'suggest' | 'auto' | undefined;
  /** ms to wait before auto-proceeding in 'auto' mode. Default: 45000. */
  autoProceedDelayMs?: number | undefined;
  /** Maximum consecutive auto-proceed turns before pausing. 0 = unlimited. Default: 50. */
  autoProceedMaxIterations?: number | undefined;
  /** Template used for YOLO+auto suggestions. Must include {{suggestion}}. */
  autonomyNextPrompt?: string | undefined;
  /** Animate the terminal/window title while the agent is active. Default: true. */
  terminalTitleAnimation?: boolean | undefined;
  /** Persisted YOLO preference mirrored into top-level config.yolo at runtime. Default: false. */
  yolo?: boolean | undefined;
  /**
   * How much fleet/subagent activity is streamed into the main TUI chat.
   * - 'off': no subagent lines (failures/errors still surface); F2/F3 stay live.
   * - 'full': every subagent tool call and interim message (legacy behavior).
   * Resolved via {@link resolveFleetChatVerbosity}. Default: 'off'.
   */
  fleetChatVerbosity?: FleetChatVerbosity | undefined;
  /** Ring terminal bell when an agent run completes. Default: false. */
  chime?: boolean | undefined;
  /** Ask for confirmation before interrupt/exit. Default: true. */
  confirmExit?: boolean | undefined;
  /** Terminal mouse tracking preference. Default: false. */
  mouseMode?: boolean | undefined;
  /** Enable prompt refinement before sending. Default: true. */
  enhance?: boolean | undefined;
  /**
   * Provider id to use for goal refinement (`/goal set`). When set,
   * the refiner uses this provider's model (see `refinerModel`)
   * instead of the session's main provider/model. Falls back to the
   * main session provider when unset or when the provider is unavailable.
   * Default: unset (uses the main session provider).
   */
  refinerProvider?: string | undefined;
  /**
   * Model id to use for goal refinement. When `refinerProvider` is
   * also set, the refiner uses this specific model on that provider.
   * When only `refinerModel` is set (without a provider), the model
   * is used on the session's main provider. When both are unset, the
   * session's main model is used. Falls back to heuristic on failure.
   * Default: unset (uses the main session model).
   */
  refinerModel?: string | undefined;
  /**
   * Named fallback profile to use for goal refinement. When set, the
   * refiner uses the first valid entry from the named chain (stored in
   * top-level `fallbackProfiles`) instead of `refinerProvider`+`refinerModel`.
   * Falls back to the session model when the profile is empty or missing.
   * Default: unset (uses refinerProvider+refinerModel, or session defaults).
   */
  refinerFallbackProfile?: string | undefined;
  /** Prompt-refinement preview countdown in ms. Default: 60000. */
  enhanceDelayMs?: number | undefined;
  /** Prompt-refinement language mode. Default: "original". */
  enhanceLanguage?: 'original' | 'english' | undefined;
  /**
   * `provider/model` ref used for the one-key "retry with another model" action
   * offered when a refinement fails. When unset, the recovery UI falls back to
   * the first entry of the effective fallback chain (see
   * `resolveEnhanceFallbackRef`). Default: unset.
   */
  enhanceFallbackModel?: string | undefined;
  /**
   * Timeout (ms) used when RETRYING a refinement after the first attempt timed
   * out — the "extra time" retry. When unset, the retry uses
   * `max(baseTimeout * 2, 180000)`. Default: unset.
   */
  enhanceRetryTimeoutMs?: number | undefined;
  /** TUI statusline density. Default: "detailed". */
  statuslineMode?: 'minimum' | 'detailed' | 'no-color' | undefined;
  /** Single short word shown in the TUI rainbow working-state chip. Default: "thinking". */
  thinkingWord?: string | undefined;
  /**
   * Show the "Model Reasoning" collapsible blocks in chat history that display
   * the LLM's structured reasoning / COT output. Separate from the `thinkingWord`
   * status-bar chip and from model-provisioning `reasoning` settings.
   * Default: true.
   */
  showModelReasoning?: boolean | undefined;
  /**
   * Show the always-visible AGENT SWARM and todo mission queue panel below
   * the TUI statusline. The detailed F2 Fleet, F3 Agents, and F6 Todos
   * monitor overlays remain available independently. Default: true.
   */
  showAgentSwarmPanel?: boolean | undefined;
  /**
   * Persist the TUI prompt input history to disk per project so Up/Down
   * navigation recalls prompts across sessions. Secrets are scrubbed before
   * they reach disk. Default: enabled, 100 entries.
   */
  inputHistory?: InputHistoryConfig | undefined;
}

/**
 * Per-project TUI input history persistence options. Lives under
 * `config.autonomy.inputHistory` because the TUI-specific knobs on Config
 * are grouped there.
 */
export interface InputHistoryConfig {
  /** Persist history to ~/.wrongstack/projects/<slug>/input-history.json. Default: true. */
  enabled?: boolean | undefined;
  /** Max entries kept on disk (and in memory). Default: 100. */
  maxEntries?: number | undefined;
}

/**
 * Automatic codebase symbol-index maintenance. Keeps the `codebase-search`
 * index (SQLite, `~/.wrongstack/projects/<hash>/codebase-index/index.db`) fresh
 * without the user having to call `codebase-index` by hand.
 */
export interface IndexingConfig {
  /** Run a blocking incremental index at session start (with a visible summary). Default: true. */
  onSessionStart: boolean;
  /** Reindex files the agent writes/edits via tools, in the background. Default: true. */
  onEdit: boolean;
  /** Watch the project root for external editor changes and reindex them. Default: true. */
  watchExternal: boolean;
  /** Debounce window (ms) coalescing rapid edits to the same file. Default: 400. */
  debounceMs: number;
  /**
   * Watchdog timeout (ms) for a full index run. A run exceeding this is
   * aborted (so it can never wedge the indexing mutex or freeze the terminal)
   * and counts toward the indexing circuit breaker. Default: 240000.
   */
  indexTimeoutMs?: number | undefined;
}

/**
 * Saved launch preferences — restored on next boot so the pre-launch prompt
 * can offer a one-line "Continue with last settings? [Y/n]" instead of
 * re-asking every question from scratch.
 */
export interface LaunchConfig {
  /** Interactive mode: 'tui' (Ink TUI) or 'repl' (readline REPL). */
  mode?: 'tui' | 'repl' | undefined;
  // (removed: director — Director Mode is permanently on)
  /**
   * Launch-time autonomy mode (binary choice from pre-launch prompt).
   * 'off' = stops after each turn; 'auto' = self-driving.
   * Distinct from `AutonomyConfig.defaultMode` which also supports 'suggest'.
   */
  autonomy?: 'off' | 'auto' | undefined;
  /**
   * Last mode chosen from the interactive launch menu
   * (`packages/cli/src/boot/launch-menu.ts`).
   *
   * Stored so the menu can offer a one-line "Continue with last
   * settings? [Y/n/q]" summary on the next boot instead of re-asking
   * the same 1-of-4 question. Distinct from `mode` (tui/repl) — that
   * field is set by the inner pre-launch prompts that run AFTER the
   * user has chosen "TUI/REPL" here.
   *
   * Default port per mode is owned by the launcher (HQ=3499, WebUI=3456,
   * SimpleUI=3466). Storing an explicit override here makes
   * `wstack --no-menu` keep the user's last port too.
   */
  menuChoice?: LaunchMenuChoice | undefined;
}

/**
 * Persisted record of the user's last interactive launch-menu choice.
 * Distinct from {@link LaunchConfig} above because it survives a
 * `wstack --webui` → `wstack` round-trip without overwriting the
 * inner pre-launch `mode` (tui/repl) preference.
 */
export interface LaunchMenuChoice {
  /** Which top-level surface the user picked from the menu. */
  mode: 'tui-repl' | 'webui' | 'simpleui' | 'hq';
  /** Port override the user typed (defaults to the surface's default). */
  port?: number | undefined;
  /** Host override the user typed (defaults to 127.0.0.1). */
  host?: string | undefined;
}

/**
 * Controls how much detail is persisted to the per-session JSONL log
 * (`~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.jsonl`).
 */
export interface SessionLoggingConfig {
  /**
   * How much detail to write to the persistent session log.
   *
   * - "minimal"  → Only events required for resume/rewind/recovery
   * - "standard" → (default) + high-value lightweight audit events
   *                (compaction, tool timing, retries, errors, etc.)
   * - "full"     → Also persist full request payloads (very large).
   *                Consider enabling a separate replay log instead.
   */
  auditLevel?: 'minimal' | 'standard' | 'full' | undefined;

  /**
   * Sampling configuration for high-volume events (especially relevant at
   * `auditLevel: "full"`).
   */
  sampling?: {
    /** Controls sampling of `tool_progress` events. */
    toolProgress?: {
      /**
       * Sample rate for noisy progress events (`log`, `partial_output`).
       * - 1 = no sampling (every message is logged)
       * - 8 = default (first message + every 8th)
       */
      sampleRate?: number | undefined;
    };
  };
}

/**
 * Chronicle durable-journal options. The journal itself is always on when a
 * project dir exists; this only governs how long rotated partitions are kept.
 */
export interface ChronicleConfig {
  /**
   * Delete rotated Chronicle journal partitions older than this many days.
   * Auto-purge runs opportunistically after append batches and is
   * verify()-safe via the retention checkpoint sidecar. `0` disables
   * auto-purge entirely; positive values below 7 are clamped to 7 so a
   * repo-committed config cannot flush recent evidence. Default: 30.
   */
  retentionDays?: number | undefined;
}

export type SyncCategory = 'settings' | 'skills' | 'prompts' | 'memory' | 'history';

export interface SyncConfig {
  enabled: boolean;
  repo: string;
  /** GitHub token (fine-grained PAT). Encrypted at rest via SecretVault. */
  githubToken: string;
  categories: SyncCategory[];
  lastSyncedAt?: string | undefined;
}

/**
 * Per-model capability overrides the user can define in their config.
 * Used to add models not in the models.dev catalog, or override catalog
 * facts when the real backend differs (e.g. local Ollama models, proxies).
 */
export interface CustomModelDefinition {
  /** Provider this model belongs to. Defaults to the owning ProviderConfig. */
  provider?: string | undefined;
  /** Optional display name. */
  name?: string | undefined;
  /** Capability overrides — only specified fields are overlaid. */
  capabilities?: Partial<Capabilities> | undefined;
  /**
   * Max output tokens. If not specified, the provider family default
   * or catalog entry is used.
   */
  maxOutput?: number | undefined;
}

/**
 * Skill subsystem configuration. All fields optional; the subsystem itself is
 * gated by `features.skills`. Honored from the user's active-profile config;
 * in the repo-committed in-project config the `extraDirs` field is stripped
 * (arbitrary directories are a prompt-injection vector) — only `readClaudeSkills`
 * and `mode` survive there.
 */
export interface SkillsConfig {
  /**
   * Read skills from foreign coding-agent directories (`<project>/.claude/skills`
   * and `~/.claude/skills`). Default `true`. Lets Claude Code / Codex / Gemini /
   * `asm` / `gh skill` skills be used without copying them.
   */
  readClaudeSkills?: boolean | undefined;
  /**
   * Scan OTHER coding agents' skill directories (`~/.codex/skills`,
   * `~/.cursor/skills`, `~/.agents/skills`, `~/.qwen/skills`,
   * `~/.trae/skills`, … + their `<project>/.<tool>/…` equivalents). Default
   * `true` (all known tools); pass a tool-id list to restrict, or `false` to
   * disable. Non-existent dirs are skipped. Unknown ids in the list (likely
   * typos) are dropped and surfaced via a config warning.
   */
  foreignSources?: boolean | string[] | undefined;
  /**
   * How skill bodies reach the system prompt.
   * - `'eager'` (default): inject every discovered skill body into the prompt.
   * - `'progressive'`: inject only the metadata manifest; the agent loads a
   *   skill body on demand via the `skill` tool (the agentskills.io model).
   */
  mode?: 'eager' | 'progressive' | undefined;
  /**
   * Extra skill directories to scan (lowest priority, after the `.claude`
   * layers). Honored only from the user config; stripped from in-project config.
   */
  extraDirs?: string[] | undefined;
  /**
   * In eager mode, the maximum total chars of skill bodies injected into the
   * prompt (highest-priority skills first; the rest are listed as a manifest the
   * agent loads via the `skill` tool). Bounds prompt cost when many skills are
   * discovered. Default 24000 (~6k tokens). Set very high to disable. Ignored in
   * progressive mode (which injects only the manifest anyway).
   */
  eagerMaxChars?: number | undefined;
  /**
   * Base URL of the skill registry used by `/skill-search` and
   * `/skill-install <registry>:<id>`. Default `https://skills.sh` (the open
   * marketplace backed by mastra-ai/skills-api). Honored only from the user
   * config; stripped from in-project config (a repo-committed override would be
   * an SSRF / prompt-injection vector — the registry response is parsed into the
   * prompt). Set to a self-hosted skills-api instance to use a private catalog.
   */
  registryUrl?: string | undefined;
}

/**
 * Fleet peer-awareness + supervision settings. All sub-features are
 * enabled-by-default with conservative throttles; each has its own kill
 * switch. See `FleetSupervisor` (coordination/fleet-supervisor.ts) for the
 * supervisor semantics.
 */
export interface FleetConfig {
  /** Subagent process/registry lifecycle after it is no longer doing work. */
  lifecycle?:
    | {
        /**
         * Remove a spawned or between-task subagent after this much idle time.
         * This is separate from the in-task activity watchdog. Default 30000.
         */
        idleTimeoutMs?: number | undefined;
        /**
         * Retire a subagent as soon as its final task result is delivered and
         * no queued task reused it in the same dispatch cycle. Default true.
         */
        retireOnTaskComplete?: boolean | undefined;
      }
    | undefined;
  /** Fleet-wide hard ceilings. In-flight work may finish; new spawns are refused at the cap. */
  budget?:
    | {
        /** Maximum subagents spawned during one Director lifetime. Default 64 in CLI. */
        maxSpawns?: number | undefined;
        /** Maximum cumulative input+output tokens across all fleet subagents. */
        maxTokens?: number | undefined;
        /** Maximum cumulative estimated USD cost across all fleet subagents. */
        maxCostUsd?: number | undefined;
      }
    | undefined;
  /** Periodic "[FLEET PULSE]" peer-status digest folded into each agent's context. */
  pulse?:
    | {
        /** Default true. */
        enabled?: boolean | undefined;
        /** Inject at most every N agent iterations. Default 5. */
        everyNIterations?: number | undefined;
        /** Hard cap on digest characters. Default 900. */
        maxChars?: number | undefined;
        /** Max peers listed per digest. Default 15. */
        maxAgents?: number | undefined;
      }
    | undefined;
  /** Broadcast `type:'status'` mails on meaningful subagent transitions. */
  statusBroadcasts?:
    | {
        /** Default true. */
        enabled?: boolean | undefined;
        /** Min interval between broadcasts about the same subagent. Default 15000. */
        minIntervalMsPerAgent?: number | undefined;
        /** Global cap on broadcasts per minute (excess dropped + counted). Default 20. */
        globalPerMinuteCap?: number | undefined;
        /**
         * Broadcast recoverable soft-budget warnings to every project agent.
         * Default false: the local fleet UI still tracks warnings/extensions,
         * but routine preemption and auto-extension do not flood peer mailboxes.
         */
        budgetWarnings?: boolean | undefined;
      }
    | undefined;
  /**
   * Per-subagent git-worktree isolation for Director fleets. The default is
   * `auto`: mutating/build-capable subagents run in isolated checkouts and are
   * squash-merged back on success; read-only review agents usually stay on the
   * shared checkout. Set `enabled:false` or `mode:'off'` when a workflow cannot
   * use worktrees.
   */
  worktrees?:
    | {
        /** Kill switch. Default true. */
        enabled?: boolean | undefined;
        /**
         * `auto` (default): isolate only side-effectful subagents.
         * `required`: side-effectful subagents must get a worktree or fail.
         * `off`: never allocate worktrees.
         */
        mode?: 'auto' | 'required' | 'off' | undefined;
        /**
         * Merge successful task branches back into the base checkout. Default
         * true. When false, successful worktrees are committed and kept for
         * manual `/worktree merge`.
         */
        autoMerge?: boolean | undefined;
        /** Keep failed/timeout worktrees when they contain changes. Default true. */
        keepFailed?: boolean | undefined;
      }
    | undefined;
  /** Brain-gated fleet supervisor (rebalance/steer/spawn-helper). */
  supervisor?: FleetSupervisorConfig | undefined;
}

/** Config surface for the brain-gated FleetSupervisor. */
export interface FleetSupervisorConfig {
  /** Kill switch. Default true (active whenever a Director is running). */
  enabled?: boolean | undefined;
  /** Evaluation tick. Default 20000. */
  intervalMs?: number | undefined;
  /** Per-(signal,subject) re-engagement cooldown. Default 120000. */
  cooldownMs?: number | undefined;
  /** Hard cap on interventions touching one subagent per run. Default 3. */
  maxInterventionsPerSubagent?: number | undefined;
  /** Pending task pinned to a busy worker longer than this → starvation signal. Default 60000. */
  pinnedWaitMs?: number | undefined;
  /** ≥ this many pending tasks pinned to one worker (with an idle sibling) → overload signal. Default 2. */
  overloadPinnedThreshold?: number | undefined;
  /** pending > backlogFactor × live workers (sustained) → spawn-helper signal. Default 2. */
  backlogFactor?: number | undefined;
  /** Running subagent with no observable fleet activity for this long → stuck signal. Default 180000. */
  stuckMs?: number | undefined;
  /** Consecutive failed/timeout results from one subagent → failure-streak signal. Default 2. */
  failureStreak?: number | undefined;
  /** Allow the supervisor to spawn helper subagents. Default true. */
  allowSpawn?: boolean | undefined;
  /** Allow the supervisor to terminate subagents (highest risk). Default false. */
  allowTerminate?: boolean | undefined;
}

/**
 * One member of the Brain's LLM pool or council. String entries elsewhere
 * (`Config.brain.models`, council voters) parse with the same `parseModelRef`
 * grammar as `fallbackModels`: bare `model`, `provider/model`, or
 * `provider model`.
 */
export interface BrainModelEntry {
  /** Provider id (a key of `Config.providers` or a catalog id). Defaults to the session provider. */
  provider?: string | undefined;
  /** Model id, required. */
  model: string;
}

/** One voting seat on the Brain council. */
export interface BrainCouncilVoterConfig extends BrainModelEntry {
  /**
   * Decision lens for this seat. Built-ins: 'executor' (progress-biased),
   * 'skeptic' (risk-hunting), 'auditor' (cost/waste-focused). Any other
   * string is injected verbatim as the persona description.
   */
  persona?: string | undefined;
  /** Vote weight in the tally. Default 1. */
  weight?: number | undefined;
  /** When true, this seat's explicit refusal denies the request outright. */
  veto?: boolean | undefined;
}

/** Multi-LLM council configuration for high-stakes Brain decisions. */
export interface BrainCouncilConfig {
  /** Kill switch. Default: enabled when `voters` is non-empty or ≥2 pool models exist. */
  enabled?: boolean | undefined;
  /**
   * Minimum request risk that convenes the council instead of the single-LLM
   * tier. Default 'high'. 'critical' = council only for critical questions;
   * 'medium' = council for most non-trivial questions (slow + expensive).
   */
  minRisk?: 'medium' | 'high' | 'critical' | undefined;
  /**
   * Voting seats. String entries use the `parseModelRef` grammar and get
   * default personas (executor, skeptic w/ veto, auditor) assigned in order.
   * When omitted, seats are derived from `brain.models` (up to 3).
   */
  voters?: Array<string | BrainCouncilVoterConfig> | undefined;
  /** Fraction of seats that must return a valid vote. Default 0.5. */
  quorum?: number | undefined;
  /** Fraction of cast vote weight the winning option must exceed. Default 0.5. */
  approval?: number | undefined;
  /**
   * Per-seat completion timeout (ms). Defaults to `brain.decisionTimeoutMs`,
   * then 15000 — set it when council seats need a longer budget than the
   * single-LLM tier.
   */
  perCallTimeoutMs?: number | undefined;
  /** Seats polled concurrently, 1..8. Default 3. */
  maxConcurrency?: number | undefined;
  /**
   * Warn when the panel is not diverse enough: 'none' (default), 'model'
   * (seats must use distinct models) or 'provider' (distinct providers).
   * A same-model "council" agrees with itself and adds cost without adding
   * independence.
   */
  distinctness?: 'none' | 'model' | 'provider' | undefined;
  /** Output budget for the judge call. Default follows the seat budget. */
  judgeMaxTokens?: number | undefined;
  /**
   * Persona rotation for seats without an explicit one. Replaces the built-in
   * executor / skeptic(veto) / auditor cycle.
   */
  seats?: Array<{ persona: string; veto?: boolean | undefined }> | undefined;
  /**
   * Tie-breaker / synthesizer model (`parseModelRef` grammar or entry).
   * Sees every vote's rationale and issues the final structured decision.
   * Default: the first pool/voter model.
   */
  judge?: string | BrainModelEntry | undefined;
}

/**
 * Brain decision-layer configuration. SECURITY: in the in-project config
 * DENY list — a repo-committed config must not be able to raise the
 * autonomy ceiling, remove the human tier, or point Brain decisions at an
 * attacker-chosen provider. Only honoured from the active-profile config.
 */
export interface BrainConfig {
  /**
   * 'headless'    — the Brain NEVER blocks on a human. Escalations resolve
   *                 via the terminal policy (recommended option for low/medium
   *                 risk, request fallback semantics, otherwise deny).
   * 'interactive' — escalations prompt the human in the TUI/WebUI.
   * Default (resolved at boot by `resolveBrainConfigDefaults`): 'headless' —
   * minimum-human out of the box. Switch live with `/brain mode <m>`.
   */
  mode?: 'headless' | 'interactive' | undefined;
  /**
   * Initial autonomy ceiling for the LLM tier. Default (resolved at boot):
   * adaptive — 'all' when a council can convene (≥2 voters/pool models),
   * otherwise 'high'. Live-set via `/brain risk`.
   */
  maxAutoRisk?: 'off' | 'low' | 'medium' | 'high' | 'all' | undefined;
  /**
   * Ordered LLM pool for Brain decisions (`parseModelRef` grammar or
   * entries). With `strategy: 'fallback'` the first entry is primary and the
   * rest are tried in order when it fails; with 'round-robin' calls rotate
   * across the pool. Default (resolved at boot): the user's `fallbackModels`
   * chain; with none configured, the session provider/model is used.
   */
  models?: Array<string | BrainModelEntry> | undefined;
  /** Pool selection strategy. Default 'fallback'. */
  strategy?: 'fallback' | 'round-robin' | undefined;
  /** Per-LLM-call decision timeout (ms). Default 15000. */
  decisionTimeoutMs?: number | undefined;
  /**
   * Quality gate for the single-LLM tier — what counts as a usable answer.
   * The tier used to wrap ANY returned text in an `answer`, so an empty
   * response or an "I don't know" became a decision the caller acted on.
   */
  llm?:
    | {
        /**
         * Output budget per decision call. Default 200. A Brain response is
         * one decision plus a one-sentence rationale; raise this only if the
         * trace shows responses truncated at `maxTokens`.
         */
        maxTokens?: number | undefined;
        /**
         * Treat a declined/empty response as "this tier could not decide"
         * rather than as an answer. Default true.
         */
        rejectUncertain?: boolean | undefined;
        /**
         * Reject answers whose self-reported confidence is below this (0..1).
         * Default 0 = off. Responses reporting no confidence always pass.
         */
        minConfidence?: number | undefined;
        /**
         * Whether a `deny` from the single-LLM tier ends the decision.
         *
         * The tier reports three very different things as `deny`: a dead
         * provider pool, an unparseable response, and a model that actually
         * refused. Historically all three fell through to the escalation
         * tier, so a genuine refusal could never be terminal.
         *
         * - 'never'        — always fall through (legacy behaviour; the LLM
         *                    tier can then agree but never disagree)
         * - 'when-decided' — DEFAULT. A real refusal is terminal;
         *                    infrastructure failures (dead pool, unparseable
         *                    response) still fall through to the next tier.
         * - 'always'       — any deny is terminal (strict; a dead pool then
         *                    denies the request instead of escalating)
         *
         * NOTE the default is resolved in `createBrainRuntime`, not in
         * `createTieredBrainArbiter` — the raw arbiter stays at 'never' for
         * callers that wire it directly, exactly as it stays at 'medium' for
         * `maxAutoRisk` while the product resolves that adaptively.
         */
        denyIsTerminal?: 'never' | 'when-decided' | 'always' | undefined;
        /**
         * Failure memory for the pool. A dead pool otherwise costs
         * `models.length × decisionTimeoutMs` on EVERY decision.
         */
        circuitBreaker?:
          | {
              /** Consecutive failures before the tier is skipped. Default 3. 0 disables. */
              failureThreshold?: number | undefined;
              /** How long the tier stays skipped before one probe is allowed (ms). Default 60000. */
              cooldownMs?: number | undefined;
            }
          | undefined;
      }
    | undefined;
  /**
   * Interactive mode only: how long an ask-human prompt may stay unanswered
   * before it resolves through the terminal policy instead of blocking
   * forever. Default (resolved at boot): 120000. Set 0 to wait indefinitely
   * (legacy behavior).
   */
  humanTimeoutMs?: number | undefined;
  /**
   * Deterministic rule table, evaluated BEFORE the policy tier and therefore
   * before anything that costs a provider call. First match wins; a rule
   * whose action is `defer` explicitly hands the request to the next tier.
   *
   * This is the intended place to make the Brain cheaper and more
   * predictable: any question the operator can characterise up front
   * (question/context patterns, source, risk band, offered options) can be
   * settled here for free instead of being sent to a model.
   *
   * Invalid rules are dropped with a reported error rather than taking the
   * Brain down. Like the rest of `brain`, this is honoured only from the
   * active-profile config — never from a repo-committed one.
   */
  rules?: BrainRule[] | undefined;
  /**
   * Toggles for the built-in pattern heuristics (low-risk fast path,
   * blocked-resolved, deadlock-skip, retry-exhausted, continue-ping). Every
   * flag defaults to enabled, so omitting this block preserves the historical
   * behaviour. Turn one off when its guess is wrong for your workload, or
   * replace `blockedResolvedMarkers` to match your own vocabulary.
   */
  heuristics?: BrainHeuristicsConfig | undefined;
  /**
   * How a headless escalation resolves when no human is available.
   * - 'conservative' (default) — accept a caller-recommended option at
   *   low/medium risk, honour `fallback: 'continue'`, otherwise deny.
   * - 'deny-all' — never auto-accept; every escalation denies.
   * - 'continue-on-recommended' — accept a recommended option at ANY risk.
   */
  terminalPolicy?: 'conservative' | 'deny-all' | 'continue-on-recommended' | undefined;
  /** Rolling in-memory decision log size for `/brain status`. Default 20. */
  decisionLogMaxEntries?: number | undefined;
  /**
   * Replay a previous COUNCIL/LLM verdict for an identical repeated question
   * instead of paying for it again. Deterministic tiers are never cached
   * (they are already free) and `ask_human` is never cached. A decision the
   * ledger later observes to have FAILED is evicted, so the cache cannot
   * cement a bad call. Disabled by default — caching a judgement is opt-in.
   */
  cache?:
    | {
        enabled?: boolean | undefined;
        /** Entry lifetime (ms). Default 300000. */
        ttlMs?: number | undefined;
        /** Maximum live entries. Default 200. */
        maxEntries?: number | undefined;
      }
    | undefined;
  /** Multi-LLM council for high-stakes decisions. */
  council?: BrainCouncilConfig | undefined;
  /**
   * Persistent decision ledger (`<project>/.wrongstack/brain-ledger.jsonl`):
   * every decision + observed outcome is appended, and outcome stats for
   * similar past decisions are fed back into the LLM/council prompts.
   * Default: enabled.
   */
  ledger?:
    | {
        enabled?: boolean | undefined;
        /**
         * Deterministic guard: once this many consecutive approvals of a
         * decision group ended in observed failures, deny outright without
         * consulting any LLM (a later success lifts the guard). Default 3.
         * 0 disables.
         */
        autoDenyAfterFailures?: number | undefined;
        /** In-memory ring size, also the seed size read from disk. Default 500. */
        maxMemoryEntries?: number | undefined;
        /**
         * A same-kind monitor intervention re-firing within this window marks
         * the previous steer as a failure. Default 600000 (10 min).
         */
        interventionRetryWindowMs?: number | undefined;
      }
    | undefined;
  /**
   * Replay trace: a per-decision JSONL record of HOW the ladder decided —
   * every tier it ran, every pool target it called (including the failures
   * the fallback loop swallows), and every council seat's vote, with timings
   * and token usage. Rows convert to `BrainEvaluationCaseV1` fixtures for
   * offline replay via `runBrainEvaluation`.
   *
   * DISABLED by default: enabling it is the opt-in that permits production
   * decision content to be written to disk. Kept in its own file rather than
   * the ledger, whose bounded ring powers the learning loop.
   */
  trace?:
    | {
        /** Default false. */
        enabled?: boolean | undefined;
        /** JSONL path. Default `<project>/.wrongstack/brain-trace.jsonl`. */
        path?: string | undefined;
        /**
         * Free-text policy once enabled. Default 'full' — a fixture without
         * the question and context cannot reproduce the original decision.
         * 'redacted' truncates free text; 'none' records metadata only
         * (models, timings, tokens, vote ids, quorum/veto), which still
         * answers "what is the LLM doing" without storing content.
         */
        content?: 'none' | 'redacted' | 'full' | undefined;
        /** Cap on concurrently open (undecided) records. Default 200. */
        maxOpenRecords?: number | undefined;
      }
    | undefined;
  /**
   * BrainMonitor distress-signal thresholds (self-activation). All optional;
   * defaults match `BrainMonitorOptions`.
   */
  monitor?:
    | {
        /** Master kill switch. Default true. */
        enabled?: boolean | undefined;
        /**
         * How a detected signal is resolved. Default 'llm' (consult the
         * Brain). 'steer' always intervenes and 'observe' never does — both
         * without any provider call. Note that monitor engagements can also
         * be made deterministic while staying on 'llm' by adding a
         * `brain.rules` entry matching `source: 'system'`.
         */
        policy?: 'llm' | 'steer' | 'observe' | undefined;
        /** Per-signal kill switches. Omitted signals stay enabled. */
        signals?:
          | {
              toolFailureStreak?: boolean | undefined;
              errorStorm?: boolean | undefined;
              agentStall?: boolean | undefined;
              fileChurn?: boolean | undefined;
            }
          | undefined;
        /** Consecutive failures of the same tool before engaging. Default 3. */
        toolFailureStreak?: number | undefined;
        /** Errors within the storm window before engaging. Default 4. */
        errorStormCount?: number | undefined;
        /** Sliding window for the error-storm signal (ms). Default 60000. */
        errorStormWindowMs?: number | undefined;
        /** Active run with no progress for this long → stall signal (ms). Default 300000. 0 disables. */
        stallMs?: number | undefined;
        /** How often the stall watchdog ticks (ms). Default 30000. */
        stallCheckIntervalMs?: number | undefined;
        /** Edits to the same file within the churn window before engaging. Default 5. */
        fileChurnThreshold?: number | undefined;
        /** Sliding window for the file-churn signal (ms). Default 600000. */
        fileChurnWindowMs?: number | undefined;
        /**
         * Tool names that count as file edits for the churn signal. REPLACES
         * the built-in list (edit, write, patch, multi_edit, multiedit,
         * str_replace); set it when your edit tools are named differently, or
         * the churn signal will never fire for them.
         */
        fileEditTools?: string[] | undefined;
        /** Per-signal re-engagement cooldown (ms). Default 120000. */
        cooldownMs?: number | undefined;
      }
    | undefined;
}

/** Git behavior overrides for agent-run git commands. See `Config.git`. */
export interface GitBehaviorConfig {
  /**
   * Commit identity injected as `GIT_AUTHOR_NAME/EMAIL` +
   * `GIT_COMMITTER_NAME/EMAIL` into every child process. Either field may be
   * set alone; the missing one falls back to git's own config.
   */
  identity?:
    | {
        name?: string | undefined;
        email?: string | undefined;
      }
    | undefined;
}

export interface Config {
  /** Recurring provider/model blackout windows used by autonomous routing. */
  modelAvailabilitySchedule?:
    | import('../core/model-availability-calendar.js').ModelBlackoutRule[]
    | undefined;
  version: 1;
  provider: string;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  /**
   * Maximum number of subagent tasks the fleet coordinator dispatches
   * simultaneously. Extra tasks queue until a slot frees. Default: 4.
   * Overridden by WRONGSTACK_MAX_CONCURRENT env var and --max-concurrent
   * CLI flag. Change at runtime with /fleet concurrency <n>.
   */
  maxConcurrent?: number | undefined;
  /**
   * Display language for the UI chrome (WebUI + desktop shell). A BCP-47-ish
   * code from SUPPORTED_LOCALES (en/tr/de/fr/it/es/pt-BR). Persisted here so a
   * change in one surface propagates to all others via the shared machine
   * config; each surface may keep a local cache for instant reactivity. When
   * unset, surfaces fall back to their own browser/system detection.
   */
  uiLocale?: string | undefined;
  providers?: Record<string, ProviderConfig>;
  /**
   * Top-level custom models (maps modelId → definition). Merged with
   * per-provider `customModels` at resolution time. The key is the
   * model id — not a fully qualified name. When the same model id
   * appears in both places, the top-level one wins.
   */
  models?: Record<string, CustomModelDefinition>;
  /**
   * Per-task model matrix. Keys are catalog roles (e.g. "security-scanner"),
   * phase names (e.g. "review"), or the `*` default. Resolution precedence at
   * subagent spawn: exact role → the role's phase → `*` → leader model. Set via
   * the `/setmodel` slash command; persisted to the active-profile config.
   */
  modelMatrix?: Record<string, ModelMatrixEntry>;
  /**
   * User-curated model references shown/prioritized by model commands and used
   * by smart fallback derivation. Entries are `model`, `provider/model`, or
   * `provider model`.
   */
  favoriteModels?: string[] | undefined;
  /**
   * When true, auto-derived fallback chains are restricted to `favoriteModels`.
   * Explicit fallback profiles/chains are always honored as written.
   */
  favoriteModelsOnly?: boolean | undefined;
  context: ContextConfig;
  tools: ToolsConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  /**
   * Per-agent ACP invocation overrides, keyed by catalog agent id
   * (`claude-code`, `codex-cli`, `gemini-cli`, …). Lets a user correct an
   * agent's ACP entry command — e.g. point `claude-code` at the right
   * adapter — without a code change. Consumed by `/acp`, `/ensemble`, and
   * `wstack acp`. SECURITY: this is an arbitrary-command exec surface, so it
   * is in the in-project config DENY list — only honoured from the user's
   * active-profile config, never from a repo-committed config.
   */
  acp?: {
    agents?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  };
  /**
   * Ordered list of fallback model references tried, in order, when the
   * primary model is overloaded (HTTP 429/529/5xx) and its own retries are
   * exhausted. Each entry is a model reference: a bare model id (same
   * provider), `provider/model`, or `provider model`. After a fallback hop,
   * the primary is retried only after its cooldown expires. See
   * `createFallbackModelExtension`.
   */
  fallbackModels?: string[] | undefined;
  /**
   * Named fallback chains. A profile's first entry can be used as a primary
   * model by `/setmodel`, while the whole ordered list is used for failover.
   */
  fallbackProfiles?: Record<string, string[]> | undefined;
  /**
   * When `true` (the default) and `fallbackModels` is empty, a fallback chain
   * is derived automatically from the other keyed providers/models so 429s
   * recover out of the box. Set `false` to disable the smart default and only
   * use an explicit `fallbackModels` list. Toggle via `/fallback auto on|off`.
   */
  fallbackAuto?: boolean | undefined;
  /**
   * Lifecycle command/HTTP hooks, keyed by event. Commands receive HookInput
   * JSON on stdin; HTTP hooks receive the same object as a POST body. A typed
   * outcome can allow, deny, or mutate. `policy: true` enforcement hooks remain
   * active under `--no-hooks`; ordinary automation is disabled.
   */
  hooks?: Partial<Record<HookEvent, ConfiguredHook[]>>;
  plugins?: (string | PluginConfig)[] | undefined;
  /** Human-owned enable/disable guard for the LLM-facing plugin manager. */
  pluginManager?: PluginManagerConfig | undefined;
  log: LogConfig;
  features: FeaturesConfig;
  /** Project-local structured memory, graph-ready anchors, retrieval, and hygiene. */
  Sage?: SageConfig | undefined;
  /** Skill subsystem options (readClaudeSkills / mode / extraDirs). */
  skills?: SkillsConfig | undefined;
  yolo?: boolean | undefined;
  /** When true, show lightweight LLM-predicted next steps after each turn (/next). */
  nextPrediction?: boolean | undefined;
  cwd?: string | undefined;
  /**
   * Active profile name selected by the root bootstrap config. Settings load
   * from ~/.wrongstack/profiles/<name>/config.json. Default: 'default'.
   */
  activeProfile?: string | undefined;
  /** Autonomy mode configuration (auto-proceed delay, etc.). */
  autonomy?: AutonomyConfig | undefined;
  /** Show rotating launch hints on startup. Default: true. Set to false to suppress. */
  hints?: boolean | undefined;
  /** Raw SSE stream debugging — hex-dump every byte received from providers to stderr. */
  debugStream?: boolean | undefined;
  /**
   * Where settings are persisted. 'global' → the active profile config
   * (default). 'project' → <project>/.wrongstack/config.json.
   * When 'project', safe settings are saved per-project.
   */
  configScope?: 'global' | 'project' | undefined;
  /** Automatic codebase symbol-index maintenance (session-start + live updates). */
  indexing?: IndexingConfig | undefined;
  /**
   * Process circuit-breaker protection (gates `bash`/`exec` on repeated
   * failures). Default off — toggle with `/settings breaker on|off`.
   */
  circuitBreaker?: CircuitBreakerRuntimeConfig | undefined;
  /**
   * Adaptive concurrency controller — automatically adjusts `maxConcurrent` based on
   * rate-limit (429) errors. On 429: decreases concurrency. On sustained success:
   * gradually increases concurrency back up. Default off.
   */
  adaptiveConcurrency?: AdaptiveConcurrencyConfig | undefined;
  /** Saved launch preferences — restored on next boot for one-line confirmation. */
  launch?: LaunchConfig | undefined;

  /**
   * Session logging & audit configuration.
   * Controls what gets written to the persistent JSONL transcript.
   */
  session?: SessionLoggingConfig | undefined;
  /** Chronicle durable-journal options (partition retention / auto-purge). */
  chronicle?: ChronicleConfig | undefined;
  /**
   * Runtime reasoning / cache controls applied to every provider request
   * (REPL/TUI/WebUI). Mapped into `Request.reasoning` and `Request.cache` by a
   * single request-pipeline middleware, gated by the active model's
   * capabilities. See `ModelRuntimeConfig`.
   */
  modelRuntime?: ModelRuntimeConfig | undefined;
  /** HQ client publishing settings, used by CLI/REPL/TUI/WebUI consistently. */
  hq?: HqClientConfig | undefined;
  /**
   * Fleet awareness + supervision settings (peer-status pulse digests,
   * status-broadcast mails, and the brain-gated FleetSupervisor). SECURITY:
   * in the in-project config DENY list — a repo-committed config must not be
   * able to enable autonomous spawning/steering or mailbox traffic. Only
   * honoured from the user's active-profile config.
   */
  fleet?: FleetConfig | undefined;
  /**
   * Brain decision-layer settings: escalation mode (headless = never block
   * on a human), LLM pool with fallback/round-robin, autonomy ceiling, and
   * the multi-LLM council. SECURITY: in the in-project config DENY list —
   * a repo-committed config must not be able to raise the autonomy ceiling
   * or reroute Brain decisions. Only honoured from the active-profile config.
   */
  brain?: BrainConfig | undefined;
  /**
   * Cloud sync configuration. Stored separately in sync.json to avoid
   * accidentally committing the GitHub token to project configs.
   */
  sync?: SyncConfig | undefined;
  /**
   * Git behavior overrides for agent-run git commands.
   *
   * `identity` sets the commit author/committer used by every git process
   * WrongStack spawns (git tool, bash/exec shells, worktree manager,
   * plugins) via the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars. It never
   * touches the repo's or the user's `git config`, so commits made outside
   * WrongStack keep their normal identity. Unset → git's own config applies
   * (today's behavior). Manage at runtime with `/gitid`.
   *
   * SECURITY: in the in-project config DENY list — a repo-committed config
   * must not be able to spoof the identity written into the user's commit
   * history. Only honoured from the user's active-profile config.
   */
  git?: GitBehaviorConfig | undefined;
  /**
   * Per-plugin namespaced config sections. Each plugin reads its own
   * subtree via `ConfigStore.getExtension(pluginName)`. Plugins should
   * declare a `configSchema` so the loader validates this section
   * automatically before `setup()` runs.
   *
   * Example:
   *   extensions: {
   *     'wstack-auth': { tokenUrl: 'https://...', refreshBefore: 300 },
   *     'wstack-metrics': { sink: 'prometheus', port: 9090 },
   *   }
   */
  extensions?: Record<string, Record<string, unknown>>;
}

export interface ConfigLoader {
  load(opts?: {
    cliFlags?: Partial<Config> | undefined;
    cwd?: string | undefined;
  }): Promise<Config>;
  /** Load and decrypt sync config from the active profile's sync.json. */
  loadSyncConfig(): Promise<SyncConfig | null>;
  /** Persist sync config to the active profile's sync.json with encrypted token. */
  persistSyncConfig(cfg: SyncConfig): Promise<void>;
}

/**
 * Subscribable view over Config. Plugins and CLI subsystems use this instead
 * of holding a frozen Config reference, so they can react to runtime updates
 * (e.g. `/model` switching the active provider, secrets rotation, dynamic
 * extension reload).
 *
 * The store enforces immutability — `get()` always returns a frozen object.
 * Updates happen through `update(partial)`, which produces a new Config
 * (structurally cloned, then frozen) and notifies watchers.
 */
export interface ConfigStore {
  get(): Readonly<Config>;
  /**
   * Get a typed top-level section. Convenience for consumers that only
   * care about one slice (e.g. `tools` or `context`).
   */
  getSection<K extends keyof Config>(key: K): Readonly<Config[K]>;
  /**
   * Return the extension namespace for `pluginName`, or an empty record
   * when none is configured. The returned object is frozen.
   */
  getExtension(pluginName: string): Readonly<Record<string, unknown>>;
  /**
   * Apply a partial update. Returns the new Config. Watchers are notified
   * synchronously after the update completes. Throws if the result fails
   * any registered invariants (currently: version must stay 1).
   */
  update(partial: Partial<Config>): Readonly<Config>;
  /** Subscribe to changes. Returns an unsubscribe function. */
  watch(cb: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void;
}
