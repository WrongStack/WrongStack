import type { FleetChatVerbosity } from './fleet-chat.js';

export interface AutonomyConfig {
  /** Default autonomy mode at startup. Default: "auto".
   *
   * The 'eternal' / 'eternal-parallel' modes drive the long-running
   * autonomy engines (see `EternalAutonomyEngine` /
   * `ParallelEternalEngine`) once the session transitions through a
   * `/autonomy eternal` (or equivalent) command or `prefs.update`
   * with `autonomy: 'eternal'`. They are accepted here so the value
   * round-trips through the persist layer without reverting on
   * restart, and so the standalone server matches the embedded
   * server's autocomplete parity (TUI settings picker). */
  defaultMode?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
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
  /** TUI statusline density. Default: "minimum". */
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
   * Agent swarm panel placement: 'bottom' (lower region), 'sidebar' (right sidebar), or 'off' (hidden).
   * Backward-compat: legacy boolean values are coerced — true→'bottom', false→'off'. Default: 'bottom'.
   */
  showAgentSwarmPanel?: 'bottom' | 'sidebar' | 'off' | boolean | undefined;
  /**
   * Right sidebar visibility: when false, the right sidebar is completely hidden
   * and chat history takes the full terminal width. Default: true.
   */
  showSidebar?: boolean | undefined;
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
   * the same 1-of-5 question. Distinct from `mode` (tui/repl) — that
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
  mode: 'tui-repl' | 'webui' | 'simpleui' | 'hq' | 'desktop';
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

  /**
   * On-disk transcript lifecycle. JSONL stays the append/resume authority;
   * closed sessions outside keep-N and older than `archiveAfterDays` are
   * lossless-gzipped. `/prune` still deletes. Default: keep 20 hot, archive
   * after 7 days, never auto-delete.
   */
  storage?: {
    hotKeepSessions?: number | undefined;
    archiveAfterDays?: number | undefined;
    /** Fire archiveIdle after a writer closes. */
    autoArchive?: boolean | undefined;
    includeSubagents?: boolean | undefined;
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
