import type { ContextWindowModeId } from './context-window.js';
import type { HookEvent, ShellHook } from './hooks.js';
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
 * - 'minimal'    — TIER1 tools only (~10), stripped guidance (~3-4k tokens saved)
 * - 'light'     — Core + memory tools (~14), common patterns, minimal guidance
 * - 'medium'    — Most development tools (~24), some guidance (default when `true`)
 * - 'aggressive' — Maximum savings before tools become unusable (~4-5k tokens saved)
 */
export type TokenSavingTier = 'off' | 'minimal' | 'light' | 'medium' | 'aggressive';

/**
 * Normalize a TokenSavingTier value, handling backward-compatible boolean inputs.
 * - `true`  → 'medium' (existing behavior)
 * - `false` → 'off'
 * - string values are returned as-is after validation
 * - `undefined` → 'off'
 */
export function normalizeTokenSavingTier(
  val?: TokenSavingTier | boolean,
): TokenSavingTier {
  if (val === undefined) return 'off';
  if (typeof val === 'boolean') return val ? 'medium' : 'off';
  const validTiers = new Set<TokenSavingTier>([
    'off',
    'minimal',
    'light',
    'medium',
    'aggressive',
  ]);
  return validTiers.has(val) ? val : 'off';
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
   * from TRUSTED config (`~/.wrongstack/config.json`) — the config loader
   * strips `tools.exec.allow` from the untrusted, repo-committed
   * `<project>/.wrongstack/config.json`. `deny` only ever REMOVES commands, so
   * it is honored from any source.
   */
  exec?: ExecToolConfig | undefined;
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
  oauthConfig?: {
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
  } | undefined;
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

export interface AutonomyConfig {
  /** Default autonomy mode at startup. Default: "off". */
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
  /** Stream fleet/subagent output into the main TUI chat. Default: true. */
  streamFleet?: boolean | undefined;
  /** Ring terminal bell when an agent run completes. Default: false. */
  chime?: boolean | undefined;
  /** Ask for confirmation before interrupt/exit. Default: true. */
  confirmExit?: boolean | undefined;
  /** Terminal mouse tracking preference. Default: false. */
  mouseMode?: boolean | undefined;
  /** Enable prompt refinement before sending. Default: true. */
  enhance?: boolean | undefined;
  /** Prompt-refinement preview countdown in ms. Default: 60000. */
  enhanceDelayMs?: number | undefined;
  /** Prompt-refinement language mode. Default: "original". */
  enhanceLanguage?: 'original' | 'english' | undefined;
  /** TUI statusline density. Default: "detailed". */
  statuslineMode?: 'minimum' | 'detailed' | undefined;
  /** Single short word shown in the TUI rainbow working-state chip. Default: "thinking". */
  thinkingWord?: string | undefined;
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
   * and counts toward the indexing circuit breaker. Default: 120000.
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
  /** Start with Director mode on (fleet manifest + multi-agent orchestration). */
  director?: boolean | undefined;
  /**
   * Launch-time autonomy mode (binary choice from pre-launch prompt).
   * 'off' = stops after each turn; 'auto' = self-driving.
   * Distinct from `AutonomyConfig.defaultMode` which also supports 'suggest'.
   */
  autonomy?: 'off' | 'auto' | undefined;
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
 * gated by `features.skills`. Honored from the user's `~/.wrongstack/config.json`;
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
   * `~/.cursor/skills-cursor`, `~/.agents/skills`, `~/.qwen/skills`,
   * `~/.trae/skills`, … + their `<project>/.<tool>/…` equivalents). Default
   * `true` (all known tools); pass a tool-id list to restrict, or `false` to
   * disable. Non-existent dirs are skipped.
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
}

export interface Config {
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
   * the `/setmodel` slash command; persisted to ~/.wrongstack/config.json.
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
   * `~/.wrongstack/config.json`, never from a repo-committed config.
   */
  acp?: {
    agents?: Record<
      string,
      { command: string; args?: string[]; env?: Record<string, string> }
    >;
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
   * Lifecycle shell hooks, keyed by event. Each command receives the hook
   * `HookInput` JSON on stdin; a JSON `HookOutcome` on stdout (and exit code 2
   * = block) steers the agent. In-process hooks are registered separately via
   * the plugin API. Disabled entirely under `--bare` / `--no-hooks`.
   */
  hooks?: Partial<Record<HookEvent, ShellHook[]>>;
  plugins?: (string | PluginConfig)[] | undefined;
  log: LogConfig;
  features: FeaturesConfig;
  /** Skill subsystem options (readClaudeSkills / mode / extraDirs). */
  skills?: SkillsConfig | undefined;
  yolo?: boolean | undefined;
  /** When true, show lightweight LLM-predicted next steps after each turn (/next). */
  nextPrediction?: boolean | undefined;
  cwd?: string | undefined;
  /** Autonomy mode configuration (auto-proceed delay, etc.). */
  autonomy?: AutonomyConfig | undefined;
  /** Show rotating launch hints on startup. Default: true. Set to false to suppress. */
  hints?: boolean | undefined;
  /** Raw SSE stream debugging — hex-dump every byte received from providers to stderr. */
  debugStream?: boolean | undefined;
  /**
   * Where settings are persisted. 'global' → ~/.wrongstack/config.json
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
   * Cloud sync configuration. Stored separately in sync.json to avoid
   * accidentally committing the GitHub token to project configs.
   */
  sync?: SyncConfig | undefined;
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
  load(opts?: { cliFlags?: Partial<Config> | undefined; cwd?: string | undefined }): Promise<Config>;
  /** Load and decrypt the sync config from ~/.wrongstack/sync.json. */
  loadSyncConfig(): Promise<SyncConfig | null>;
  /** Persist sync config to ~/.wrongstack/sync.json with encrypted token. */
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
