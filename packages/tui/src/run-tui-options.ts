import type { Agent } from '@wrongstack/core/agent';
import type {
  AutonomousCoordinator,
  CoordinatorEvent,
  Director,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { QueueStore } from '@wrongstack/core/storage';
import type {
  AttachmentStore,
  AutonomyStage,
  ConfigStore,
  ContextSnapshot,
  FleetChatVerbosity,
  Message,
  SkillLoader,
  ThemePresetId,
  TokenCounter,
  TokenSavingTier,
} from '@wrongstack/core/types';
import type { StatuslineLines } from '@wrongstack/core/statusline';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import type { SddLifecycleResult, SddRunControl } from '@wrongstack/sdd';
import type { AgentTranscriptReader } from './components/agents-monitor.js';
import type { McpPickerItem } from './components/mcp-picker.js';
import type { PluginPickerItem } from './components/plugin-picker.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type { ToolPickerItem } from './components/tools-picker.js';
import type { ResourceMenuId, ResourceMenuSnapshot } from './ui-contracts.js';

export interface RunTuiOptions {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  /** Shared loader used by the interactive `/skill` browser. */
  skillLoader?: SkillLoader | undefined;
  getResourceMenu?: ((id: ResourceMenuId) => Promise<ResourceMenuSnapshot>) | undefined;
  /** Host-owned mutable bridge for slash commands that need masked input. */
  secretInputController?:
    | {
        readSecret(prompt: string): Promise<string>;
        readText?(prompt: string): Promise<string>;
      }
    | undefined;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter | undefined;
  visionAdapters?: VisionAdapters | undefined;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: (() => boolean | Promise<boolean>) | undefined;
  model: string;
  banner?: boolean | undefined;
  /** Persists the input queue across crashes; if omitted, the queue is in-memory only. */
  queueStore?: QueueStore | undefined;
  /**
   * Called with the queue's display texts (head first) on EVERY queue change
   * — enqueue, /queue delete, /queue clear, dequeue-for-delivery. The CLI
   * mirrors the snapshot onto the live agent Context (core's
   * setQueuedMessagesSnapshot) so a running agent learns what's waiting at
   * its next iteration boundary without the queue being delivered early.
   */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /** Surfaces the "⚠ YOLO" chip in the status bar. */
  yolo?: boolean | undefined;
  /** Query live YOLO state from the permission policy. */
  getYolo?: (() => boolean) | undefined;
  /** Set live YOLO state from TUI-owned controls such as ConfirmPrompt. */
  onYolo?: ((enabled: boolean) => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /**
   * Access the eternal-autonomy engine. When autonomy mode flips to
   * 'eternal' the TUI drives `runOneIteration()` from the post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?:
    | (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null)
    | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode flips to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from the post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?:
    | (() => import('@wrongstack/core/execution').ParallelEternalEngine | null)
    | undefined;
  /**
   * Access the active SDD parallel run's control surface (or null). The TUI's
   * SIGINT handler uses it to stop a running `/sdd parallel` on the first Ctrl+C.
   */
  getSddRun?: (() => SddRunControl | null) | undefined;
  /**
   * Apply a post-run SDD lifecycle op (clean / rollback / destroy) from the host.
   * Drives the board overlay keys c / z / x so they work after the run ends.
   */
  onSddLifecycle?:
    | ((
        op: 'cleanup_worktrees' | 'rollback' | 'destroy',
        opts?: { revertMerged?: boolean },
      ) => Promise<SddLifecycleResult>)
    | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine.
   * Returns an unsubscribe function. TUI uses this to render each
   * iteration as a live timeline entry as it lands.
   */
  subscribeEternalIteration?:
    | ((fn: (entry: import('@wrongstack/core/goal').JournalEntry) => void) => () => void)
    | undefined;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * TUI uses this to render live status in the status bar.
   */
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
  /** Renders in the startup banner. Read from the CLI's package.json. */
  appVersion?: string | undefined;
  /** Provider id for the startup banner ("openai", "anthropic", ...). */
  provider?: string | undefined;
  /** Wire family — shown beneath provider in the banner. */
  family?: string | undefined;
  /** Last 3 chars of the active API key — shown in the banner for visual key-pick verification. */
  keyTail?: string | undefined;
  /** Active fallback profile name, shown in the banner (e.g. "default"). */
  profile?: string | undefined;
  /** Absolute path to the active profile's config.json
   *  (e.g. "~/.wrongstack/profiles/default/config.json"). When present,
   *  the banner shows the full path with the profile name highlighted,
   *  instead of the bare {@link profile} string. */
  profileConfigPath?: string | undefined;
  /** Background autonomy agents to display in the banner (Brain, Shadow,
   *  Kanban, Mailbox, Memory, etc.). Read from the mailbox at boot. */
  autonomyAgents?: import('./components/history/types.js').AutonomyAgentStatus[] | undefined;
  /** Latest version published to the npm registry (drives the
   *  "update available" indicator next to the banner version chip).
   *  Sourced from the CLI's preflight update-check. */
  latestVersion?: string | undefined;
  /** True when the preflight update-check found a newer version than
   *  {@link appVersion}. The banner renders `(update available)` next to
   *  the version chip when this is true, so users notice without having
   *  to read the stderr notice. */
  updateAvailable?: boolean | undefined;
  /** Snapshot of keyed providers + their model lists for the `/model` picker. Async — the catalog fetch may need to hit disk/network. */
  getPickableProviders?:
    | (() => Promise<import('./components/model-picker.js').ProviderOption[]>)
    | undefined;
  /** Apply a (provider, model) pair after the picker confirms. Returns an error string on failure. */
  switchProviderAndModel?:
    | ((providerId: string, modelId: string) => string | null | Promise<string | null>)
    | undefined;
  /** Apply an autonomy mode after the picker confirms. Returns an error string on failure. */
  switchAutonomy?:
    | ((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => string | null)
    | undefined;
  /**
   * Model-specific maxContext (tokens), resolved by the CLI via the
   * ModelsRegistry. When omitted, the TUI falls back to the provider
   * family's baseline (e.g. anthropic = 200_000), which can be wrong
   * for variants like the 1M-context Opus build. The status bar's
   * context chip uses this for its progress denominator.
   */
  effectiveMaxContext?: number | undefined;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig?: import('@wrongstack/core/types').Config | undefined;
  /**
   * The embedding host already owns the HQ publisher and telemetry bridges.
   * Prevents this UI surface from opening a duplicate heartbeat-only client.
   */
  hqTelemetryOwnedExternally?: boolean | undefined;

  /**
   * Terminal title animation on/off. Defaults to true. When false, the
   * OSC-0 window/tab title stays static (the app name only, no spinner).
   * Controlled via /settings → Terminal title animation.
   */
  titleAnimation?: boolean | undefined;
  /** Play terminal bell (\\x07) when agent run completes. */
  chime?: boolean | undefined;
  /**
   * Enable full terminal mouse interaction (SGR drag + clickable UI). The TUI
   * runs in the alternate screen and always owns plain wheel reports for its
   * bounded chat viewport; this option additionally enables pointer dragging
   * and app chrome clicks. Off by default; opt in here or via
   * WRONGSTACK_MOUSE=1. See mouse.ts for the trade-off rationale.
   */
  mouse?: boolean | undefined;
  /** Show "confirm exit" message on first Ctrl+C instead of "exit". */
  confirmExit?: boolean | undefined;
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
  /** Token-saving tier — shown as a `💾 <tier>` chip in the TUI status bar (hidden when `'off'`). */
  tokenSavingMode?: TokenSavingTier | undefined;
  /** Number of registered tools — shown on the status bar line 2. */
  toolCount?: number | undefined;
  /** Live getter for the agent mode label so the status bar updates after /mode. */
  getModeLabel?: (() => string) | undefined;
  /**
   * Get all available agent modes with their names, descriptions, and the
   * currently active mode id. Used by the `/mode` picker in the TUI.
   */
  getModes?:
    | (() => Promise<{
        modes: import('@wrongstack/core/types').Mode[];
        activeId: string | null;
      }>)
    | undefined;
  /** Switch to a different agent mode by id (e.g. "teach", "brief"). */
  switchMode?: ((modeId: string) => Promise<string | null>) | undefined;
  /**
   * Called ONCE on mount by the App to install its debug-stream telemetry
   * callback. The CLI wires this to setDebugStreamCallback() from
   * @wrongstack/providers. On App unmount, the default stderr callback
   * is restored.
   */
  registerDebugStreamCallback?:
    | ((
        cb: (stats: {
          chunkCount: number;
          lastChunkSize: number;
          lastDeltaMs: number;
          totalBytes: number;
          lastChunkAt: string;
        }) => void,
      ) => void)
    | undefined;
  /** Called on App unmount — restores the default stderr debug-stream callback. */
  restoreDebugStreamCallback?: (() => void) | undefined;
  /** Called from /clear so the TUI can wipe its history entries while agent.ctx + memory are cleared separately. */
  onClearHistory?:
    | ((
        dispatch: React.Dispatch<
          | { type: 'clearHistory'; model?: string | undefined; provider?: string | undefined }
          | { type: 'resetContextChip' }
          | { type: 'streamReset' }
          | { type: 'toolStreamClear' }
        >,
      ) => void)
    | undefined;

  // --- Fleet surface (director mode) ---

  /**
   * Live director instance. When set, the TUI renders a fleet panel
   * showing every spawned subagent, its current task, streaming output,
   * and runtime cost — updated live from the FleetBus. Pass null or omit
   * when multi-agent / director mode is disabled.
   */
  director?: Director | null | undefined;
  /**
   * Read the CURRENT director. Unlike the static `director` option (captured
   * at boot, null in non---director sessions), this sees a director the fleet
   * host built lazily on the first delegate/spawn — the TUI's fleet-teardown
   * paths (Ctrl+C, Esc, /steer) resolve through it.
   */
  getDirector?: (() => Director | null) | undefined;
  /**
   * Optional roster reference for resolving subagent role ids to
   * human-readable names. Same value passed to director.tools().
   */
  fleetRoster?: Record<string, { name: string }> | undefined;
  /**
   * Shared controller for the `/fleet stream on|off` toggle. The slash
   * command runs in the CLI process and needs to flip TUI reducer state;
   * the App installs a dispatch-backed `setEnabled` here on mount so
   * both sides stay synchronized.
   */
  /**
   * Shared controller for the `/fleet stream on|off` toggle. The slash
   * command runs in the CLI process and needs to flip TUI reducer state;
   * the App installs a dispatch-backed `setEnabled` here on mount so
   * both sides stay synchronized.
   */
  fleetStreamController?:
    | {
        mode: FleetChatVerbosity;
        setMode: (mode: FleetChatVerbosity) => void;
      }
    | undefined;
  /**
   * Read-only per-subagent transcript access for the F3 agents monitor
   * (AgentMonitorService satisfies this structurally).
   */
  agentTranscripts?: AgentTranscriptReader | undefined;
  /**
   * Controller for the `/interrupt` slash command. The App installs the real
   * `abortLeader` on mount so the command can abort the in-flight leader run.
   */
  interruptController?:
    | {
        abortLeader: () => boolean;
        isRunning?: (() => boolean) | undefined;
        confirmClear?:
          | ((info: { leaderActive: boolean; subagentCount: number }) => Promise<boolean>)
          | undefined;
        confirmSlash?:
          | ((question: string, defaultYes: boolean) => Promise<boolean | null>)
          | undefined;
        resetSession?: (() => void) | undefined;
        waitForIdle?: (() => Promise<void>) | undefined;
      }
    | undefined;
  /**
   * Controller for the `/enhance on|off` prompt-refinement toggle. The App
   * installs a dispatch-backed `setEnabled` here on mount so the slash command
   * (run in the CLI process) flips the TUI's reducer flag. Mirrors
   * `fleetStreamController`.
   */
  enhanceController?:
    | {
        enabled: boolean;
        setEnabled: (enabled: boolean) => void;
      }
    | undefined;
  /** Capability-gated low-effort reasoning hint for the prompt refiner. */
  getEnhancerReasoning?:
    | ((
        providerId?: string,
        modelId?: string,
      ) =>
        | import('@wrongstack/core/types').ReasoningRequest
        | undefined
        | Promise<import('@wrongstack/core/types').ReasoningRequest | undefined>)
    | undefined;
  /**
   * Effort levels the ACTIVE model documents (models.dev reasoningConfig),
   * for the model-aware /settings reasoning-effort cycle. Undefined =
   * vocabulary undocumented; the picker cycles the full canonical set.
   */
  getActiveModelReasoningEffortLevels?: (() => string[] | undefined) | undefined;
  /** Build an ephemeral Provider for retrying a failed refinement on another model (no session switch). */
  buildEnhancerProvider?:
    | ((
        providerId: string,
        modelId: string,
      ) => Promise<import('@wrongstack/core/types').Provider | undefined>)
    | undefined;
  /** Resolve the one-key "retry with another model" fallback ref on a refine failure. */
  getEnhanceFallbackRef?: (() => string | undefined) | undefined;
  /** Resolve the dedicated refiner target for the initial refinement attempt. */
  getConfiguredRefinerRef?: (() => string | undefined) | undefined;
  /**
   * Controller for status bar hidden items. App installs a dispatch-backed
   * setter on mount so the /statusline slash command can update the TUI's
   * visible bar without a round-trip. The initial value is loaded from
   * the config file before App mounts.
   */
  statuslineHiddenItems: StatuslineItem[];
  setStatuslineHiddenItems: (items: StatuslineItem[]) => void;
  /**
   * Atomically updates in-memory state AND persists to
   * Active profile/statusline.json. Used by the statusline picker to
   * make each toggle immediately durable.
   */
  saveStatuslineHiddenItems: (items: StatuslineItem[]) => Promise<void>;
  /**
   * Per-chip statusline line assignment (statusline.json schema v2).
   * Optional: hosts that don't load it keep the core contract defaults.
   */
  statuslineLines?: StatuslineLines | undefined;
  setStatuslineLines?: (lines: StatuslineLines) => void;
  saveStatuslineLines?: (lines: StatuslineLines) => Promise<void>;
  /**
   * Controller for the agents monitor overlay. App installs a dispatch-backed
   * setter on mount so the `/agents on|off` slash command can toggle the
   * overlay without a round-trip.
   */
  agentsMonitorController?:
    | {
        visible: boolean;
        setVisible: (visible: boolean) => void;
      }
    | undefined;
  /**
   * Mutable ref for opening TUI panels from slash commands. The slash commands
   * call `onPanelOpen.current(action)` to open panels. The App sets
   * `onPanelOpen.current` to its actual dispatch function on mount.
   */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;

  /**
   * If set, the App boots straight into goal mode — the text is wrapped
   * in the GOAL preamble and submitted as the first turn. Lets users
   * launch directly from the shell:
   *   wstack --tui --director --goal "audit packages/core for races"
   * The chat shows a one-line "🎯 Goal locked: …" hint; the actual
   * preamble is hidden from the visible history (same as `/goal`).
   */
  initialGoal?: string | undefined;
  /**
   * If set, submitted as the first turn verbatim (no preamble). Mainly
   * for scripted shell aliases — `wstack --tui --ask "summarize foo.md"`
   * — that want one turn pre-populated without the goal-mode framing.
   * Ignored when `initialGoal` is also set.
   */
  initialAsk?: string | undefined;
  /**
   * Directory containing session JSONL files. Required for rewind
   * functionality. When provided the TUI can list checkpoints and
   * trigger a rewind via `/rewind` or Ctrl+R.
   */
  sessionsDir?: string | undefined;
  /** Live active session id for cross-surface client registration. */
  getSessionId?: (() => string | undefined) | undefined;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages.
   */
  getSDDContext?: (() => Promise<string | null>) | undefined;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Returns displayable status messages.
   */
  onSDDOutput?: ((output: string) => Promise<string[]>) | undefined;
  /**
   * Subscribe to Goal phase/graph events from the PhaseOrchestrator.
   * Returns an unsubscribe function. The TUI uses this to drive the
   * PhaseMonitor and PhasePanel live views via dispatch actions.
   */
  subscribeGoal?: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined;
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  getSettings?: (() => import('./app-state.js').Settings) | undefined;
  /**
   * Persist settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?:
    | ((s: import('./app-state.js').Settings) => string | null | Promise<string | null>)
    | undefined;
  /** Persist the active theme preset to disk so the next boot starts with it. */
  saveThemePreset?: ((preset: ThemePresetId) => Promise<void>) | undefined;
  /**
   * Live ConfigStore — passed through to the TUI so the `/theme` slash
   * command can read the current `themePreset`, apply it via
   * `setActiveTheme()`, and persist the user's pick back to disk.
   * Subscribes via `ConfigStore.watch` so any external write (CLI REPL,
   * WebUI, profile migration) is reflected immediately.
   */
  configStore?: ConfigStore | undefined;
  /** Load toggleable plugin rows for the interactive plugin picker. */
  getPluginItems?: (() => PluginPickerItem[]) | undefined;
  /** Toggle one plugin from the interactive picker and return refreshed rows. */
  onPluginToggle?:
    | ((name: string) => Promise<{
        items: PluginPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Load MCP server rows for the interactive MCP picker. */
  getMcpServers?: (() => McpPickerItem[]) | undefined;
  /** Toggle one MCP server (enable/disable) from the interactive picker. */
  onMcpToggle?:
    | ((name: string) => Promise<{
        items: McpPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Restart one MCP server from the interactive picker. */
  onMcpRestart?:
    | ((name: string) => Promise<{
        items: McpPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Load tool rows for the interactive tool picker. */
  getToolsItems?: (() => ToolPickerItem[]) | undefined;
  /** Toggle one tool (enable/disable) from the interactive tool picker. */
  onToolToggle?:
    | ((name: string) => Promise<{
        items: ToolPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Get current brain risk level and decision log for the Brain panel. */
  getBrainData?:
    | (() => {
        riskLevel: 'off' | 'low' | 'medium' | 'high' | 'all';
        log: Array<{ kind: string; question: string; outcome: string; age: string }>;
      })
    | undefined;
  /** Set brain risk ceiling from the Brain panel. */
  onBrainRiskLevel?:
    | ((level: 'off' | 'low' | 'medium' | 'high' | 'all') => string | undefined)
    | undefined;
  /** Full Brain settings editor bridge (live apply + persist to global config). */
  brainPanelHost?: import('./brain-panel-model.js').BrainPanelHost | undefined;
  /** Get current Shadow Agent state. */
  getShadowData?:
    | (() => { activeId: string | null; running: boolean; model: string; intervalMs: number })
    | undefined;
  /** Start Shadow Agent. Returns message or error. */
  onShadowStart?: (() => Promise<string | undefined>) | undefined;
  /** Stop Shadow Agent. Returns message or error. */
  onShadowStop?: (() => Promise<string | undefined>) | undefined;
  /**
   * Host for the interactive `/auth` panel (provider/key management, OAuth
   * sign-in, local-server add). The CLI builds this from its vault +
   * models registry; when absent, `/auth` falls back to plain text.
   */
  authHost?: import('./auth-panel-model.js').AuthPanelHost | undefined;
  /**
   * Predict likely next steps after a completed turn. The CLI wires this from
   * the session provider and the `/next` toggle; it returns [] when prediction
   * is disabled or autonomy isn't 'off'. Display-only — never executed.
   */
  predictNext?:
    | ((input: { userRequest: string; assistantSummary: string }) => Promise<string[]>)
    | undefined;
  /**
   * Called after each agent turn with the assistant's final output text.
   * The host parses "💡 Next steps" suggestions from the text and stores
   * them in the shared suggestion store so `/next 1`, `/next 1 2 3` work.
   */
  onSuggestionsParsed?: ((finalText: string) => void) | undefined;
  /**
   * Retrieve current suggestions from the shared suggestion store.
   * Used by the TUI to display and auto-submit next steps in 'auto' mode.
   */
  getSuggestions?: (() => string[]) | undefined;
  /**
   * Retrieve current auto suggestions (items with auto="true" attribute).
   * Used by YOLO+auto mode for automatic next-step submission.
   */
  getAutoSuggestions?: (() => string[]) | undefined;
  /**
   * Autonomy next prompt template for YOLO+auto mode. Contains {{suggestion}} placeholder.
   */
  autonomyNextPrompt?: string | undefined;
  /**
   * Write parsed next steps into the shared suggestion store.
   * Called by the Entry component after parsing each assistant message
   * so /next 1 and the auto-submit countdown can access them.
   */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /**
   * Messages restored from a previous session. When provided (non-empty),
   * the TUI renders the prior conversation as history entries so a resumed
   * session shows its full chat context, not just the LLM's internal state.
   */
  restoredMessages?: Message[] | undefined;
  /**
   * Tool execution records from a previous session, keyed by tool_use id.
   * Used to render tool entries (name, duration, ok/error) in the TUI on
   * resume. Events are `tool_call_end` records from the session JSONL.
   */
  restoredToolCalls?:
    | Array<{
        name: string;
        id: string;
        durationMs: number;
        ok: boolean;
        outputBytes?: number | undefined;
        outputTokens?: number | undefined;
        outputLines?: number | undefined;
      }>
    | undefined;
  /**
   * Raw prior-session JSONL events. When provided, the boot `--resume` history
   * is rebuilt with the canonical renderer (tool I/O + interleaved audit
   * markers) instead of meta-only tool chips. Omitted → legacy fallback.
   */
  restoredEvents?: import('@wrongstack/core/types').SessionEvent[] | undefined;

  /**
   * List recent session summaries for the /resume picker. The CLI reads
   * from the session store and returns ResumeSessionEntry-shaped data.
   */
  listSessions?:
    | ((limit?: number) => Promise<import('./app-state.js').ResumeSessionEntry[]>)
    | undefined;

  /**
   * Resume a session by id: load JSONL events, replay history entries,
   * rebuild agent context, and return hydrated entries for the TUI to
   * display. Returns null when resume fails.
   */
  onResumeSession?:
    | ((sessionId: string) => Promise<{
        entries: import('./components/history/types.js').HistoryEntry[];
        nextId: number;
        sessionId: string;
        /**
         * Optional context-window snapshot computed from the resumed
         * session's tokenCounter after accounting the persisted usage.
         * When present, the reducer writes `tokens` to `state.leader.ctxTokens`
         * and bumps `state.contextChipVersion` so the chip refreshes
         * immediately. When absent, the chip stays at its previous value
         * until the next ctx.pct event lands.
         */
        contextSnapshot?: ContextSnapshot | undefined;
      } | null>)
    | undefined;

  // --- Project / Session switching ---
  getProjectPickerItems?:
    | (() => Promise<import('./components/project-picker.js').ProjectPickerItem[]>)
    | undefined;
  onProjectSelect?: ((key: string, kind: 'project' | 'action') => void) | undefined;
  /**
   * Request the TUI to exit with a specific code. Used by the project picker
   * to trigger a clean exit before spawning a new wstack process in a different
   * project directory. The host CLI catches this exit code and performs the
   * actual project switch.
   */
  requestExit?: (code: number) => void;
  getLiveSessions?:
    | (() => Promise<import('./components/sessions-panel.js').LiveSessionEntry[]>)
    | undefined;
  onSwitchToSession?:
    | ((sessionId: string, projectRoot: string, projectName: string) => void)
    | undefined;
  /**
   * When true, the agents monitor (F3) is open by default at TUI startup.
   * Used by the `wrongstack quick` command to show agents panel immediately.
   */
  initialAgentsMonitorOpen?: boolean | undefined;

  // --- AutonomousCoordinator (project-level multi-session coordination) ---

  /**
   * Access the project-level AutonomousCoordinator instance. When set, the TUI
   * renders a coordination panel showing live goals, pending tasks, consensus
   * decisions, and shared knowledge from all active sessions. The coordinator
   * runs independently of the session — it coordinates multiple sessions.
   */
  getAutonomousCoordinator?: () => AutonomousCoordinator | null | undefined;
  /**
   * Subscribe to live events from the AutonomousCoordinator:
   * - `goal:added` — new coordination goal received
   * - `goal:completed` — goal finished successfully
   * - `goal:failed` — goal failed after max attempts
   * - `task:ready` — task's dependencies are satisfied, ready to execute
   * - `task:completed` — task finished
   * - `knowledge:added` — new shared fact published
   * - `consensus:reached` — multi-session agreement reached
   * Returns an unsubscribe function.
   */
  subscribeCoordinatorEvents?: (fn: (event: CoordinatorEvent) => void) => () => void;
  /**
   * Start the AutonomousCoordinator loop. Fire-and-forget — run() loops
   * asynchronously. Pass a goal string to begin decomposition and task
   * auction immediately.
   */
  onCoordinatorStart?: ((goal?: string) => void) | undefined;
  /** Stop the AutonomousCoordinator loop. */
  onCoordinatorStop?: (() => void) | undefined;
  /** List pending coordinator tasks claimable by this terminal. */
  onCoordinatorTasks?:
    | (() => Promise<Array<{ id: string; title: string; priority: string; tags: string[] }> | null>)
    | undefined;
  /** Claim a coordinator task. Returns description on success. */
  onCoordinatorClaim?:
    | ((taskId: string) => Promise<string | null | { description: string }>)
    | undefined;
  /** Mark a claimed task as completed. */
  onCoordinatorComplete?: ((taskId: string, result?: string) => Promise<string | null>) | undefined;
  /** Mark a claimed task as failed. */
  onCoordinatorFail?: ((taskId: string, error: string) => Promise<string | null>) | undefined;
  /** Get coordinator stats for status display. */
  onCoordinatorStatus?:
    | (() => Promise<{
        goals: { total: number; done: number; pending: number; failed: number };
        dag: { running: number; ready: number; done: number; failed: number };
        auction: { pending: number; inProgress: number };
      } | null>)
    | undefined;
  /** Access the persistent memory store for listing and inspecting memories. */
  memoryStore?: import('@wrongstack/core/types').MemoryPort | undefined;
}
