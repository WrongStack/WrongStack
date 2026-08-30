import type { Agent } from '@wrongstack/core/agent';
import type { CoordinatorEvent, Director } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { StatuslineLines } from '@wrongstack/core/statusline';
import type { QueueStore } from '@wrongstack/core/storage';
import type {
  AttachmentStore,
  AutonomyStage,
  ConfigStore,
  ContextSnapshot,
  FleetChatVerbosity,
  Message,
  SessionLoadProgress,
  SkillLoader,
  TokenCounter,
  TokenSavingTier,
} from '@wrongstack/core/types';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import type { SddLifecycleResult, SddRunControl } from '@wrongstack/sdd';
import type React from 'react';
import type { ResumeSessionEntry, Settings } from './app-reducer.js';
import type { AuthPanelHost } from './auth-panel-model.js';
import type { BrainRiskLevel } from './brain-contracts.js';
import type { AutonomyAgentStatus, HistoryEntry } from './history-entry.js';
import type { SessionInterruptController } from './hooks/use-session-interrupt-controller.js';
import type {
  AgentTranscriptReader,
  McpPickerItem,
  PluginPickerItem,
  ProviderOption,
  ResourceMenuId,
  ResourceMenuSnapshot,
  StatuslineItem,
  ToolPickerItem,
} from './ui-contracts.js';

/**
 * Props for the TUI `<App>` shell.
 *
 * Extracted from app.tsx (which is line-capped by the hotspot guardrail) —
 * this is the host↔TUI contract, not app logic, so it reads better on its
 * own. `app.tsx` re-exports `AppProps` for consumers importing it from
 * '@wrongstack/tui' / '../src/app.js'.
 */
export interface AppProps {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  /** Shared loader used by the interactive `/skill` browser. */
  skillLoader?: SkillLoader | undefined;
  /** Host-backed snapshots for the shared operational resource browser. */
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
  /** Persists the queue across crashes; rehydrated on mount, written on every mutation. */
  queueStore?: QueueStore | undefined;
  /**
   * Mirrors the queue's display texts (head first) to the host on every
   * queue change, so a running agent can be told what's waiting (queue
   * awareness — see core's queued-messages.ts). Display state is unaffected.
   */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /** Reflects the policy's --yolo flag for the status bar's "⚠ YOLO" chip. */
  yolo?: boolean | undefined;
  /** Play terminal bell when an agent run completes. */
  chime?: boolean | undefined;
  /** When true, the first Ctrl+C aborts work and shows "confirm exit" rather than "exit". */
  confirmExit?: boolean | undefined;
  /** Live on/off control for the animated terminal title. Lets `/settings`
   *  toggle the title animation within the running session, and `setModel`
   *  pushes model changes to the title without a restart. */
  titleController?:
    | { setEnabled: (on: boolean) => void; setModel: (model: string) => void }
    | undefined;
  /**
   * Token-saving mode tier. Rendered as a `💾 <tier>` chip on the status bar
   * line 2 (hidden when tier is `'off'`) so the user knows which system-prompt
   * compactness level is active. The tool count chip next to it always
   * reflects the tier's registered (non-omitted) tool count.
   */
  tokenSavingMode?: TokenSavingTier | undefined;
  /** Number of registered tools, displayed on the status bar line 2. */
  toolCount?: number | undefined;
  /**
   * Global mouse tracking. When true, SGR mouse reporting stays on for the
   * whole session. When false (default), the App still enables it *only* while
   * a selectable overlay (model/autonomy/settings/slash/@ picker) is open, so
   * the wheel scrolls the picker selection. Chat history stays in its bounded
   * managed viewport in either mode. See mouse.ts for the trade-off.
   */
  mouse?: boolean | undefined;
  /**
   * Startup terminal capability profile — color depth, mouse protocol level,
   * and title-set support. Probe results are stable throughout the session
   * (locked in at boot). Drives feature-gates so the TUI degrades gracefully
   * on legacy, non-TTY, or restricted-terminal environments.
   */
  capability?: import('@wrongstack/core/utils').TerminalCapability | undefined;
  /**
   * When true, free-text prompts are run through the prompt refiner
   * ("did you mean this?") before reaching the main agent. Default on;
   * toggled live via the `/enhance` slash command + `enhanceController`.
   */
  enhanceEnabled?: boolean | undefined;
  /**
   * Shared controller for the `/enhance on|off` toggle. The TUI rebinds
   * `setEnabled` on mount to a dispatch-backed setter so the slash command
   * (handled in the CLI) flips the reducer flag. Mirrors `fleetStreamController`.
   */
  enhanceController?:
    | {
        enabled: boolean;
        setEnabled: (enabled: boolean) => void;
      }
    | undefined;
  /**
   * When true (default), submitting a plain message while the agent is busy
   * pops the send-mode picker (queue / by-the-way / steer) instead of silently
   * queueing. Toggled live via `/queue picker on|off`; persisted to
   * `autonomy.midRunSendPicker`.
   */
  midRunSendPicker?: boolean | undefined;
  /** Auto-send countdown (ms) for the refinement preview panel. Default 4000. */
  enhanceDelayMs?: number | undefined;
  /**
   * Returns a capability-gated low-effort reasoning hint for the prompt
   * refiner (or undefined when nothing can be safely reduced). Forwarded to
   * `enhanceUserPrompt` so a slow reasoning model does not burn thinking
   * tokens on this shallow rewrite. Absent → the refiner sends no reasoning
   * field, exactly as before.
   */
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
   * for the model-aware /settings reasoning-effort cycle (WebUI parity).
   * Undefined = vocabulary undocumented; the picker cycles the full set.
   */
  getActiveModelReasoningEffortLevels?: (() => string[] | undefined) | undefined;
  /**
   * Build a Provider for a (providerId, modelId) pair WITHOUT switching the
   * session — used to retry a failed refinement on the fallback/another model
   * ephemerally. Returns undefined when the host can't build the provider
   * (missing key, unknown id), in which case that recovery option is skipped.
   */
  buildEnhancerProvider?:
    | ((
        providerId: string,
        modelId: string,
      ) => Promise<import('@wrongstack/core/types').Provider | undefined>)
    | undefined;
  /**
   * Resolve the one-key "retry with another model" fallback ref
   * (`provider/model`) offered on a refine failure, or undefined when none is
   * configured/derivable. Recomputed per call so `/fallback` and `/model`
   * changes are reflected.
   */
  getEnhanceFallbackRef?: (() => string | undefined) | undefined;
  /** Resolve the dedicated refiner target (`provider/model`) for the initial attempt. */
  getConfiguredRefinerRef?: (() => string | undefined) | undefined;
  /**
   * Query the live YOLO state from the permission policy. Called after
   * every slash-command dispatch so `/yolo off` (which mutates the
   * policy inside the CLI) is immediately reflected in the status bar.
   * Mirrors the `agent.ctx.model` → `setLiveModel` pattern used for
   * provider/model sync.
   */
  getYolo?: (() => boolean) | undefined;
  /** Set the live YOLO state from TUI-owned controls such as ConfirmPrompt. */
  onYolo?: ((enabled: boolean) => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /** Query the live agent mode label for the status bar (e.g. "teach"). */
  getModeLabel?: (() => string) | undefined;
  /**
   * Get all available agent modes (teach/brief/code-reviewer/etc.) with
   * their names, descriptions, and the currently active one. Used by the
   * `/mode` picker to populate the interactive selection list.
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
   * Access the eternal-autonomy engine. When autonomy mode goes to
   * 'eternal' the TUI drives `runOneIteration()` from a post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?:
    | (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null)
    | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode goes to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from a post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?:
    | (() => import('@wrongstack/core/execution').ParallelEternalEngine | null)
    | undefined;
  /**
   * Access the active SDD parallel run's control surface (or null). The SIGINT
   * handler uses it to stop a running `/sdd parallel` on the first Ctrl+C — the
   * run has its own coordinator, so it is otherwise unreachable from there.
   */
  getSddRun?: (() => SddRunControl | null) | undefined;
  /**
   * Apply a post-run SDD lifecycle op (clean / rollback / destroy) from the host.
   * Drives board overlay keys c / z / x so they work after the run finished.
   */
  onSddLifecycle?:
    | ((
        op: 'cleanup_worktrees' | 'rollback' | 'destroy',
        opts?: { revertMerged?: boolean },
      ) => Promise<SddLifecycleResult>)
    | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine. The
   * TUI installs this on mount to render each iteration as a timeline
   * entry the moment it lands — strictly more responsive than reading
   * goal.json after the fact.
   */
  subscribeEternalIteration?:
    | ((fn: (entry: import('@wrongstack/core/goal').JournalEntry) => void) => () => void)
    | undefined;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * Drives `state.eternalStage` used by the status bar to show the
   * engine's current location.
   */
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
  /**
   * Subscribe to Goal phase/task events from the PhaseOrchestrator.
   * Drives `state.goalRun` used by the PhaseMonitor component.
   * Handlers receive the event name and payload from PhaseEventMap.
   */
  subscribeGoal?: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined;
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  /** Settings shape — shared between getSettings and saveSettings. */
  getSettings?: (() => Settings) | undefined;
  /**
   * Live view over the persisted user config. The TUI uses this to:
   * - apply `themePreset` on boot (so `/theme` choices persist across
   *   restarts), and
   * - write `themePreset` back when the picker Enter handler fires
   *   (so the picker shows `[active]` on the right row next session).
   *
   * Optional for hosts that don't expose a config store (e.g. tests);
   * when omitted the TUI stays on the default catppuccin palette and
   * picker changes are ephemeral.
   */
  configStore?: ConfigStore | undefined;
  /**
   * Persist settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?: ((s: Settings) => string | null | Promise<string | null>) | undefined;
  /** Persist the active theme preset to disk so the next boot starts with it. */
  saveThemePreset?:
    | ((preset: import('@wrongstack/core/types').ThemePresetId) => Promise<void>)
    | undefined;
  /** Load toggleable plugin rows for the interactive plugin picker. */
  getPluginItems?: (() => PluginPickerItem[]) | undefined;
  /** Toggle one plugin from the interactive picker and return the refreshed rows. */
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
  /** Get current brain risk level and decision log. */
  getBrainData?:
    | (() => {
        riskLevel: BrainRiskLevel;
        log: Array<{ kind: string; question: string; outcome: string; age: string }>;
      })
    | undefined;
  /** Set brain risk ceiling. */
  onBrainRiskLevel?: ((level: BrainRiskLevel) => string | undefined) | undefined;
  /** Full Brain settings editor bridge (live apply + persist). */
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
   * sign-in, local-server add). Provided by the CLI; when absent, `/auth`
   * falls back to its plain-text output.
   */
  authHost?: AuthPanelHost | undefined;
  /**
   * Predict likely next steps after a completed turn (/next). The CLI owns the
   * gating (toggle + autonomy off) and returns [] when disabled, so the App can
   * call it unconditionally on a done turn. Display-only — never executed.
   */
  predictNext?:
    | ((input: { userRequest: string; assistantSummary: string }) => Promise<string[]>)
    | undefined;
  /**
   * Called after each agent turn with the assistant's final output text.
   * The host parses "<nextsteps>" or "💡 Next steps" suggestions from the text and stores
   * them in the shared suggestion store so `/next 1`, `/next 1 2 3` work.
   */
  onSuggestionsParsed?: ((finalText: string) => void) | undefined;
  /**
   * Retrieve current suggestions from the shared suggestion store.
   * Used by the TUI for next-steps auto-submit countdown in 'auto' mode.
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
   * Store suggestions in the shared suggestion store. Used by the Entry
   * component after parsing "<nextsteps>" or "💡 Next steps" from assistant output so the
   * /next command and auto-submit countdown can access them.
   */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages so the model
   * knows it's in a spec-building conversation.
   */
  getSDDContext?: (() => Promise<string | null>) | undefined;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Called after every agent.run() completes. Returns displayable
   * status messages (e.g. "✓ Spec detected and saved!").
   */
  onSDDOutput?: ((output: string) => Promise<string[]>) | undefined;
  /** Surfaced in the startup banner. Falls back to "dev" when omitted. */
  appVersion?: string | undefined;
  /** Provider id shown in the banner ("openai", "anthropic", …). Defaults to "agent". */
  provider?: string | undefined;
  /** Wire family for the configured provider — rendered under provider in the banner. */
  family?: string | undefined;
  /** Last 3 chars of the active API key, shown in the banner for "did I pick the right key?" verification. */
  keyTail?: string | undefined;
  /** Active fallback profile name, shown in the banner (e.g. "default"). */
  profile?: string | undefined;
  /** Absolute path to the active profile's config.json
   *  (e.g. "~/.wrongstack/profiles/default/config.json"). When present,
   *  the banner renders this full path with the profile name highlighted,
   *  instead of the bare {@link profile} string. */
  profileConfigPath?: string | undefined;
  /** Background autonomy agents to display in the banner (Brain, Shadow,
   *  Kanban, Mailbox, Memory, etc.). */
  autonomyAgents?: AutonomyAgentStatus[] | undefined;
  /** Latest version published to the npm registry, when known. Drives
   *  the "update available" indicator next to the banner version chip
   *  when paired with {@link updateAvailable}. Sourced from the CLI's
   *  preflight update-check. */
  latestVersion?: string | undefined;
  /** True when the preflight update-check found a newer published
   *  version than {@link appVersion}. The banner renders
   *  `(update available)` next to the version chip when this is set, so
   *  users notice without having to read the stderr notice. */
  updateAvailable?: boolean | undefined;
  /**
   * Snapshot the keyed providers (and their model lists) for the
   * `/model` picker. Called every time the picker opens, so the result
   * stays in sync with config edits / new aliases. Async because the
   * host may need to load the models.dev catalog.
   */
  getPickableProviders?: (() => Promise<ProviderOption[]>) | undefined;
  /**
   * Apply a (provider, model) pair after the picker confirms. Returns
   * an error message on failure; null on success. The host owns the
   * actual Provider construction + Context mutation.
   */
  switchProviderAndModel?:
    | ((providerId: string, modelId: string) => string | null | Promise<string | null>)
    | undefined;
  /**
   * Apply an autonomy mode after the picker confirms. Returns
   * an error string on failure; null on success.
   */
  switchAutonomy?:
    | ((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => string | null)
    | undefined;
  /**
   * Real max-context token budget for the *active model*, resolved by the
   * CLI via the ModelsRegistry. The provider object only knows its family
   * default (e.g. anthropic = 200k) which is wrong for variants like the
   * 1M-context Opus model. The status bar's context chip uses this when
   * provided and falls back to the provider baseline otherwise.
   */
  effectiveMaxContext?: number | undefined;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string | undefined;
  onExit: (code: number) => void;
  /** Called when /clear is dispatched — the TUI should wipe its history entries (but keep the banner). */
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
  /**
   * Called on `/clear` to physically wipe the terminal (visible screen +
   * native scrollback) before the chat history is reset. Without this, the
   * `clearHistory` remount only reprints the banner *below* the old chat,
   * which stays reachable in scrollback. Owned by `run-tui` because it needs
   * the live Ink instance to reset frame tracking and avoid a smeared status
   * bar. No-op outside the TUI.
   */
  clearTerminal?: (() => void) | undefined;

  /**
   * Called when the user selects a session in the /resume picker. The host
   * loads the session JSONL, replays history entries, rebuilds the agent
   * context, and returns the hydrated history entries + nextId for display.
   * Returns null when resume fails (session not found, corrupt JSONL, etc.).
   *
   * The returned entries replace the TUI's current entries in a single
   * `replaceHistory` dispatch, so the user sees the prior conversation
   * exactly as it appeared during live interaction.
   */
  onResumeSession?:
    | ((
        sessionId: string,
        onLoadProgress?: (progress: SessionLoadProgress) => void,
        /**
         * Live stage names as each step of the resume begins (`resolve_id`,
         * `open_journal`, `swap_writer`, …). Drives the rolling rows of the
         * resume loading block, so the screen reports what is actually
         * happening instead of a spinner over an unexplained multi-second wait.
         */
        onStage?: (stage: string) => void,
      ) => Promise<{
        entries: HistoryEntry[];
        nextId: number;
        sessionId: string;
        /**
         * Optional context-window snapshot computed from the resumed
         * session's tokenCounter after accounting the persisted usage.
         * When present, the reducer writes `tokens` to `state.leader.ctxTokens`,
         * `maxContext` to `state.leader.ctxMaxTokens`, and bumps
         * `state.contextChipVersion` so the chip refreshes immediately. When
         * absent, the chip stays at its previous value until the next ctx.pct
         * event lands.
         */
        contextSnapshot?: ContextSnapshot | undefined;
        /**
         * `false` when the transcript loaded but the session was NOT claimed
         * for writing — another process owns it, or the claim lapsed. The
         * conversation is still shown (read-only); the agent keeps writing to
         * the session it was already in. Treated as present-but-true by hosts
         * that predate the field.
         */
        attached?: boolean | undefined;
        /**
         * Non-fatal problems to print alongside the replayed transcript
         * (sidecars that did not re-point, a provider that is gone). These no
         * longer abort a resume, so they have to be visible somewhere.
         */
        warnings?: string[] | undefined;
        /**
         * `<nextsteps>` parsed from the resumed session's final assistant turn.
         *
         * OFFERED, never executed: the resume lists them and stops. Empty when
         * the session did not end on a next-steps block, when it has open todos
         * (the board keeps precedence), or when the transcript is read-only.
         */
        nextSteps?: string[] | undefined;
      } | null>)
    | undefined;

  /**
   * List recent session summaries for the /resume picker. The host reads
   * from the session store and returns ResumeSessionEntry-shaped data.
   * Used both by the /resume slash command (to populate the picker) and
   * optionally by the startup rehydration path.
   */
  listSessions?: ((limit?: number) => Promise<ResumeSessionEntry[]>) | undefined;

  /**
   * Goal text passed from `--goal "..."` on the command line. When set,
   * the App mounts, renders the banner, then automatically dispatches
   * a synthetic `/goal <text>` so the user lands in goal mode without
   * having to type the slash command. Mutually advisory with `initialSteer`
   * — `initialGoal` wins if both are present.
   */
  initialGoal?: string | undefined;
  /**
   * Initial user message passed from `--ask "..."` on the command line.
   * Submitted verbatim as the first turn (no preamble) so users can
   * launch the TUI and pre-populate one turn from a shell alias / script.
   */
  initialAsk?: string | undefined;
  /** Directory for session JSONL files. Passed to App for /rewind. */
  sessionsDir?: string | undefined;

  /**
   * Load project picker items from the global manifest.
   * Called each time the project picker panel opens (F1).
   */
  getProjectPickerItems?:
    | (() => Promise<import('./ui-contracts.js').ProjectPickerItem[]>)
    | undefined;

  /**
   * Called when the user selects a project or action in the project picker.
   * The host CLI handles project switching (stopping agents, spawning new session).
   */
  onProjectSelect?: ((key: string, kind: 'project' | 'action') => void) | undefined;

  /**
   * Request the TUI to exit with a specific code. When a project is selected in
   * the F1 picker, this is called to trigger a clean exit before the host CLI
   * spawns a new wstack process in the target project directory.
   */
  requestExit?: ((code: number) => void) | undefined;

  /**
   * Load live session data from the cross-process SessionRegistry.
   * Called when the sessions panel opens (F10).
   */
  getLiveSessions?: (() => Promise<import('./ui-contracts.js').LiveSessionEntry[]>) | undefined;

  /**
   * Called when the user selects a session from a DIFFERENT project
   * in the F10 sessions panel. Spawns a new wstack terminal in the
   * target project directory. Same-project sessions use onResumeSession.
   */
  onSwitchToSession?:
    | ((sessionId: string, projectRoot: string, projectName: string) => void)
    | undefined;

  // --- Fleet ---
  /** Live director for fleet panel rendering. Null when director mode is off. */
  director: Director | null;
  /**
   * Read the CURRENT director. Unlike the static `director` prop (captured at
   * boot, null in non---director sessions), this sees a director the fleet
   * host built lazily on the first delegate/spawn. Fleet teardown paths
   * (Ctrl+C, Esc, /steer) resolve through this.
   */
  getDirector?: (() => Director | null) | undefined;
  /** Optional roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }> | undefined;
  /**
   * Shared controller for the `/fleet stream on|off` and `/agents chat`
   * slash commands. The App installs dispatch-backed setters on mount so
   * the commands can flip the reducer's `fleetChat` mode from the CLI
   * surface. Also seeds the boot value of `state.fleetChat` (cli-main
   * creates it from the persisted config).
   */
  fleetStreamController?:
    | {
        mode: FleetChatVerbosity;
        setMode: (mode: FleetChatVerbosity) => void;
      }
    | undefined;
  /**
   * Read-only per-subagent transcript access for the F3 agents monitor.
   * The CLI passes AgentMonitorService (structurally compatible); absent
   * in embedded/test surfaces, where the detail card falls back to the
   * streaming-tail snippet.
   */
  agentTranscripts?: AgentTranscriptReader | undefined;
  /**
   * Shared controller for the `/interrupt` slash command. The App installs the
   * real `abortLeader` on mount so the command can abort the in-flight leader
   * run (slash commands don't get the RunController). The fleet teardown is the
   * command's own `onFleetKill`.
   */
  interruptController?: SessionInterruptController | undefined;
  /**
   * Controller for status bar hidden items. App installs a dispatch-backed
   * setter on mount so the /statusline slash command can update the TUI's
   * visible bar without a round-trip. The initial value is loaded from
   * the config file before App mounts.
   */
  statuslineHiddenItems: StatuslineItem[];
  setStatuslineHiddenItems: (items: StatuslineItem[]) => void;
  /**
   * Atomically persists statusline hidden items to disk. Used by the
   * statusline picker so each toggle is immediately durable.
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
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
  /**
   * Called ONCE on mount by the App to install its debug-stream telemetry
   * callback. The callback receives throttled DebugStreamStats every ~200 ms
   * while the stream debug feature is active. The App dispatches to its
   * reducer; the StatusBar renders the stats on line 3. When omitted (headless
   * CLI/no TTY), debug stats go to stderr via the default callback.
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
  /**
   * Called on App unmount (via useEffect cleanup). Restores the debug-stream
   * callback to the default stderr writer so non-TUI invocations continue to
   * print debug lines.
   */
  restoreDebugStreamCallback?: (() => void) | undefined;
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
   * Raw prior-session JSONL events. When provided, the resumed history is
   * rebuilt with the canonical renderer (tool I/O + interleaved audit markers)
   * instead of meta-only tool chips. Omitted → legacy fallback.
   */
  restoredEvents?: import('@wrongstack/core/types').SessionEvent[] | undefined;
  /**
   * When true, the agents monitor (F3) is open by default at TUI startup.
   * Used by the `wrongstack quick` command to show agents panel immediately.
   */
  initialAgentsMonitorOpen?: boolean | undefined;

  // --- AutonomousCoordinator (project-level multi-session coordination) ---

  /**
   * Subscribe to live events from the AutonomousCoordinator. Returns an unsubscribe
   * function. TUI uses this to drive the coordinator panel live view.
   */
  subscribeCoordinatorEvents?: ((fn: (event: CoordinatorEvent) => void) => () => void) | undefined;

  /** Start the AutonomousCoordinator with the given goal text. */
  onCoordinatorStart?: ((goal: string) => void) | undefined;
  /** Stop the AutonomousCoordinator. */
  onCoordinatorStop?: (() => void) | undefined;
  /** Whether the AutonomousCoordinator is currently running. */
  coordinatorRunning?: boolean | undefined;
  /** List available coordinator tasks the current terminal can claim. */
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
  /**
   * Unique client identifier (e.g. `tui@<uuid>`) used to tag `client.status`
   * events emitted to the EventBus for the WebUI FleetHQ map HUD. When omitted,
   * the App skips status emission.
   */
  clientId?: string | undefined;
  /** Access the persistent memory store for listing and inspecting memories. */
  memoryStore?: import('@wrongstack/core/types').MemoryPort | undefined;
}
