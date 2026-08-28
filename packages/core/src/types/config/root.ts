import type { ConfiguredHook, HookEvent } from '../hooks.js';
import type {
  AutonomyConfig,
  ChronicleConfig,
  IndexingConfig,
  LaunchConfig,
  SessionLoggingConfig,
  SyncConfig,
} from './autonomy.js';
import type {
  AdaptiveConcurrencyConfig,
  CircuitBreakerRuntimeConfig,
  ContextConfig,
} from './context.js';
import type {
  FeaturesConfig,
  LogConfig,
  MCPServerConfig,
  PluginConfig,
  PluginManagerConfig,
  SageConfig,
} from './mcp-features.js';
import type { ModelTiersConfig } from './model-tiers.js';
import type { CustomModelDefinition, ModelMatrixEntry, ProviderConfig } from './providers.js';
import type {
  CloudSyncConfig,
  HqClientConfig,
  ModelRuntimeConfig,
  SystemPromptConfig,
} from './runtime.js';
import type { BrainConfig, FleetConfig, SkillsConfig } from './skills-fleet-brain.js';
import type { ToolsConfig } from './tools.js';
import type { ThemePresetId } from './ui.js';

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
    | import('../../core/model-availability-calendar.js').ModelBlackoutRule[]
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
  /**
   * TUI color theme preset — read by the TUI on boot to apply the matching
   * palette, and written by the `/theme` slash command (CLI REPL and TUI) so
   * the choice persists across restarts. Unconstrained string at the config
   * layer: the TUI owns the canonical preset list and applies a fallback
   * (`catppuccin`) when the stored value is unknown, so a forward-compat
   * drift on the TUI side never breaks the config round-trip.
   */
  themePreset?: ThemePresetId | undefined;
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
   * A single emergency continuity route tried before the normal fallback
   * chain. Must be a full `provider/model` reference so it can escape the
   * active provider's failure domain.
   */
  fallbackBridge?: string | undefined;
  /**
   * Named fallback chains. A profile's first entry can be used as a primary
   * model by `/setmodel`, while the whole ordered list is used for failover.
   */
  fallbackProfiles?: Record<string, string[]> | undefined;
  /**
   * The named profile from {@link Config.fallbackProfiles} currently selected
   * for failover, set by `/fallback profile use <name>` and cleared by
   * `/fallback profile none`.
   *
   * Resolution order is `fallbackModels` → this profile → smart default, so an
   * explicit chain still wins. Selecting a profile does NOT overwrite
   * `fallbackModels`: before this field existed, `profile use` was implemented
   * by copying the profile's entries over the explicit chain, which destroyed
   * whatever the user had configured and left no way back.
   *
   * A name that no longer matches a defined profile is ignored.
   */
  fallbackProfile?: string | undefined;
  /**
   * When `true` (the default) and `fallbackModels` is empty, a fallback chain
   * is derived automatically from the other keyed providers/models so 429s
   * recover out of the box. Set `false` to disable the smart default and only
   * use an explicit `fallbackModels` list. Toggle via `/fallback auto on|off`.
   */
  fallbackAuto?: boolean | undefined;
  /**
   * Fallback stickiness controls that govern how the extension transitions
   * between the primary and fallback models. These make the system stay on
   * a working fallback longer instead of bouncing back to the primary at
   * every opportunity.
   *
   * - `primaryProbeInterval` overrides the base cooldown (ms) applied after
   *   the configured primary fails with a fallback-worthy error. While
   *   active, `beforeRun` leaves the context on the working fallback
   *   instead of re-probing the primary every turn. Default: 60_000 (60s).
   *   Set 0 to probe the primary at every turn (legacy behavior).
   *
   * - `stickyFallbackTurns` sets the minimum number of turns the system
   *   dwells on a working fallback before it even attempts a primary probe.
   *   Default: 0 (no mandatory dwell — the cooldown timer alone governs).
   *   Set to e.g. 3 to require three full turns on the fallback before the
   *   primary is eligible for a half-open probe, regardless of cooldown.
   */
  fallbackStickiness?:
    | {
        primaryProbeInterval?: number | undefined;
        stickyFallbackTurns?: number | undefined;
      }
    | undefined;
  /**
   * Maximum number of candidates appended by the last-resort fallback sweep
   * (`resolveAllConfigured`). When the smart default, bridge, and named/default
   * profiles have all failed, every other configured provider is appended —
   * this cap bounds the chain so a config with many providers does not produce
   * a degenerate sequence of doomed requests during a systemic outage.
   *
   * Set to a higher value for rich multi-provider configs that want maximum
   * diversity; set to 0 to disable the last-resort append entirely. The
   * compiled-in default is exposed as `MAX_LAST_RESORT_CANDIDATES` (12).
   */
  fallbackMaxLastResortCandidates?: number | undefined;
  /**
   * Seconds the UI modal counts down before automatically switching to the
   * next fallback candidate model. Default: 7 seconds. Set via `/fallback gate <seconds>`.
   */
  fallbackGateSeconds?: number | undefined;
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
  /**
   * Deterministic model-tier layer: named levels (budget / standard /
   * premium) that bind a fallback profile, a budget, and runtime overrides
   * under one name, plus a role/phase routing table. Used by the subagent
   * spawn path, `delegate`/`spawn_subagent`, Kanban dispatch, and the
   * leader's own self-switch policy. Opt-in via `modelTiers.enabled`.
   */
  modelTiers?: ModelTiersConfig | undefined;
  modelRuntime?: ModelRuntimeConfig | undefined;
  /** System identity prompt selection, used by CLI/REPL/TUI/WebUI consistently. */
  systemPrompt?: SystemPromptConfig | undefined;
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
   * my.wrongstack.com config synchronization (namespaced sync API v1).
   * SECURITY: in the in-project config DENY list — carries the machine
   * bearer token credential and the portal endpoint URL. Only honoured
   * from the user's active-profile config.
   */
  cloudSync?: CloudSyncConfig | undefined;
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
