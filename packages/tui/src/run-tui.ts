import type { Agent } from '@wrongstack/core/agent';
import type { AutonomousCoordinator, CoordinatorEvent, Director } from '@wrongstack/core/coordination';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { QueueStore } from '@wrongstack/core/storage';
import type { AttachmentStore, AutonomyStage, FleetChatVerbosity, Message, TokenCounter, TokenSavingTier } from '@wrongstack/core/types';
import type { EventBus } from '@wrongstack/core/kernel';
import {
  detectTerminal,
  TerminalLifecycle,
  writeErr,
} from '@wrongstack/core/utils';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import type { SddLifecycleResult, SddRunControl } from '@wrongstack/sdd';
import { getProcessRegistry } from '@wrongstack/tools';
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';
import type { AgentTranscriptReader } from './components/agents-monitor.js';
import type { McpPickerItem } from './components/mcp-picker.js';
import type { PluginPickerItem } from './components/plugin-picker.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type { ToolPickerItem } from './components/tools-picker.js';
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, MOUSE_OFF } from './mouse.js';
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON } from './terminal-modes.js';
import { createRunTuiClientRegistration } from './run-tui-client-registration.js';
import { createRunTuiTitleController } from './run-tui-title-controller.js';
import { silenceTerminal, unsilenceTerminal } from './terminal-silence.js';

// Re-export autonomy stage types from core for backward compatibility
export type { AutonomyStage };
export { silenceTerminal, unsilenceTerminal };

export interface RunTuiOptions {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
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
  getEternalEngine?: (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode flips to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from the post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?: (() => import('@wrongstack/core/execution').ParallelEternalEngine | null) | undefined;
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
    | (() => import('@wrongstack/core/types').ReasoningRequest | undefined)
    | undefined;
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

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Ink requires a TTY on both stdin and stdout. Without this guard the
  // render call would fail with a terse internal Ink error; bail with a
  // clear message so a piped invocation (`echo hi | wstack --tui`) tells
  // the user what to do instead.
  if (!stdout.isTTY || !stdin.isTTY) {
    writeErr(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    return 2;
  }

  // Acquire and release raw mode through the lifecycle manager. This guarantees
  // exactly one setRawMode(true) at startup and exactly one setRawMode(false)
  // on any exit path (normal return, signal, uncaught exception, force-exit).
  const lifecycle = new TerminalLifecycle();

  // Probe terminal capabilities once — color depth, mouse protocol, title support.
  // Locked in at startup so the profile is stable throughout the session.
  const capability = detectTerminal({ stdin, stdout });

  // Resolve the full pointer-mode opt-in before taking over the screen. A
  // settings adapter is allowed to throw; doing this first guarantees such an
  // error cannot strand the terminal inside the alternate buffer.
  const mouseEnabled =
    opts.mouse ?? opts.getSettings?.().mouseMode ?? process.env.WRONGSTACK_MOUSE === '1';

  // Silence all console / stderr / process-warning output so external
  // writes don't interleave with Ink's terminal control sequences. See
  // the block comment above `silenceTerminal` for the full rationale.
  silenceTerminal();

  // Resolve the full pointer-mode opt-in. The App component owns the actual
  // lifecycle: managed history always captures wheel reports, while this flag
  // adds drag/clickable UI. cleanup() below sends MOUSE_OFF unconditionally so
  // the terminal is never left reporting mouse events after exit.

  const inkStdin: NodeJS.ReadStream = stdin;

  // Animated window/tab title: a braille spinner + live status (thinking /
  // running a tool) driven by the EventBus, scrolling the app name when idle.
  // Out-of-band OSC sequence, so it never touches Ink's render. Reset on
  // cleanup(). Disabled when WRONGSTACK_NO_TITLE=1 (handled inside
  // startTerminalTitle) or titleAnimation is false.
  //
  // Wrapped in a small start/stop controller (idempotent) so the TUI
  // `/settings` picker can toggle the title animation live without a restart.
  const {
    controller: titleController,
    start: startTitle,
    stop: stopTitle,
  } = createRunTuiTitleController({
    stdout,
    events: opts.events,
    model: opts.model,
    projectRoot: opts.projectRoot,
  });
  if (opts.titleAnimation !== false) startTitle();

  // Take over EVERY keystroke. Raw mode (Ink turns this on when render
  // mounts) already disables ICANON/ECHO/ISIG/IXON on Linux+macOS, so
  // Ctrl+C/Z/\\/S/Q arrive as input bytes instead of generating
  // signals or being eaten by the terminal driver. Belt-and-suspenders:
  // install no-op handlers for the suspend/quit signals just in case
  // some shell or terminal still surfaces them — without these, a
  // stray Ctrl+Z could background the TUI mid-session.
  const swallowSignals: NodeJS.Signals[] = ['SIGTSTP', 'SIGQUIT', 'SIGTTIN', 'SIGTTOU'];
  const swallow = () => {};
  for (const s of swallowSignals) {
    try {
      process.on(s, swallow);
    } catch {
      // Signal not supported on this platform (Windows ignores most of
      // these). Safe to skip — there's nothing for the terminal to
      // deliver in the first place.
    }
  }

  // Track cleanup state so signal handlers don't double-disable.
  let cleaned = false;
  let alternateScreenActive = false;
  const tuiClientRegistration = createRunTuiClientRegistration({
    projectRoot: opts.projectRoot,
    events: opts.events,
    appConfig: opts.appConfig,
    hqTelemetryOwnedExternally: opts.hqTelemetryOwnedExternally,
    getSessionId: opts.getSessionId,
    isCleaned: () => cleaned,
  });

  // Hoisted Ink instance reference — signal handlers (registered before the
  // Promise constructor where `instance` lives) need to call unmount() on
  // external signals. Assigned when render() runs.
  let inkInstance: { unmount: () => void } | null = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    tuiClientRegistration.unregister();
    try {
      stopTitle();
    } catch {
      // title controller already torn down — ignore.
    }
    try {
      stdout.write(BRACKETED_PASTE_OFF);
      // Disabling unset modes is a no-op, so this is safe even when mouse
      // tracking was never enabled — guarantees no leaked mouse reporting.
      stdout.write(MOUSE_OFF);
      // Release raw mode and reset SGR + cursor via the lifecycle manager.
      // release() calls setRawMode(false) and emits the reset sequence; it is
      // idempotent (safe to call even if raw mode was never acquired).
      lifecycle.release();
      if (alternateScreenActive) {
        // Restore the saved normal buffer only after every TUI-owned mode is
        // off. No printable output may follow this write or it would leak into
        // the user's shell screen.
        stdout.write(ALT_SCREEN_OFF);
        alternateScreenActive = false;
      }
      lifecycle.reset(stdout);
    } catch {
      // stdout may already be closed during shutdown — ignore.
    } finally {
      unsilenceTerminal();
    }
  };

  // ── Rapid Ctrl+C force-exit ─────────────────────────────────────────────
  // Tracks consecutive SIGINT signals. When the user presses Ctrl+C twice
  // within RAPID_EXIT_WINDOW_MS, we force-exit immediately instead of going
  // through the normal cleanup + Ink unmount path. This is intentional: the
  // user explicitly wants to kill the app, and waiting for Ink to unmount
  // can take seconds. The counter resets after the window expires so a long
  // pause between presses doesn't count as "rapid".
  const RAPID_EXIT_WINDOW_MS = 2_000;
  const RAPID_EXIT_THRESHOLD = 2;
  let ctrlCPressTimestamps: number[] = [];

  const forceExitViaRapidCtrlC = (): void => {
    // Detach all listeners first so cleanup() doesn't race with process.exit()
    detachListeners();
    tuiClientRegistration.unregister();
    // Tree-kill foreground children before exiting. Explicit background jobs
    // are detached and intentionally preserved across the host shutdown.
    try {
      getProcessRegistry().killAll({ force: true, preserveBackground: true });
    } catch {
      // best-effort — exiting either way
    }
    // Hard exit skips every async teardown path, including the session
    // writer's buffered flush — drain it synchronously so the last events
    // of the aborted run survive on disk.
    try {
      opts.agent.ctx.session.flushSync?.();
    } catch {
      // best-effort — exiting either way
    }
    // Synchronous and idempotent: disables input modes, exits alternate screen,
    // restores raw mode/cursor/style, and unsilences terminal output.
    cleanup();
    process.exit(130);
  };

  // ── Signal / exit handlers ───────────────────────────────────────────────
  // If the process is killed externally (terminal closed, SIGTERM from a
  // supervisor) waitUntilExit's .then/.catch never runs. Register signal +
  // exit listeners so the terminal isn't left in bracketed-paste mode.
  //
  // Node.js default signal behavior is overridden once a listener is
  // registered. We MUST explicitly exit after cleanup — otherwise Ink's
  // event loop keeps running and the process appears to hang. The unmount
  // triggers settle() via waitUntilExit's resolution; the hard-exit timer
  // is a safety net for when Ink's unmount itself hangs.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  const signalHandler = () => {
    inkInstance?.unmount();
    cleanup();
    // If Ink's unmount hangs, force-exit after 5s.
    const sig = setTimeout(() => process.exit(143), 5_000);
    sig.unref();
  };
  const exitHandler = () => cleanup();

  // SIGINT (Ctrl+C) gets special treatment: track rapid presses.
  const sigintHandler = (): void => {
    const now = Date.now();
    // Prune timestamps outside the window
    ctrlCPressTimestamps = ctrlCPressTimestamps.filter((t) => now - t < RAPID_EXIT_WINDOW_MS);
    ctrlCPressTimestamps.push(now);

    if (ctrlCPressTimestamps.length >= RAPID_EXIT_THRESHOLD) {
      // 2+ rapid Ctrl+C — force exit immediately
      ctrlCPressTimestamps = [];
      forceExitViaRapidCtrlC();
      return;
    }
    // First or second press — clean shutdown via Ink unmount. The unmount
    // restores terminal state and resolves waitUntilExit(). If Ink hangs,
    // the 5s deadline in signalHandler's pattern fires — but sigintHandler
    // is separate so we replicate the safety net here.
    inkInstance?.unmount();
    cleanup();
    const sig = setTimeout(() => process.exit(130), 5_000);
    sig.unref();
  };

  process.on('SIGINT', sigintHandler);
  // SIGBREAK = Ctrl+Break on Windows — an escape hatch users reach for when
  // Ctrl+C appears dead. Same clean-shutdown path as SIGTERM/SIGHUP.
  for (const s of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(s as NodeJS.Signals, signalHandler);
    } catch {
      // Platform may not support this signal
    }
  }
  process.on('exit', exitHandler);

  // ── Last-resort raw Ctrl+C watcher ──────────────────────────────────────
  // In raw mode the terminal NEVER raises SIGINT for Ctrl+C — it arrives as
  // a 0x03 byte on stdin. The App's key router handles it (escalation
  // ladder: abort → exit → hard-exit), but that path depends on Ink's input
  // pipeline and a responsive React tree. This listener is independent of
  // both: it only OBSERVES the byte stream and force-exits after 3 rapid
  // presses, sharing the same timestamp window as the SIGINT path so mixed
  // delivery still counts. When the tree is healthy the App ladder also exits
  // on the 2nd press; when the tree is wedged, this independent watcher makes
  // those same two presses an unconditional escape hatch.
  const onRawCtrlC = (data: Buffer | string): void => {
    const hasCtrlC = typeof data === 'string' ? data.includes('\x03') : data.includes(0x03);
    if (!hasCtrlC) return;
    const now = Date.now();
    ctrlCPressTimestamps = ctrlCPressTimestamps.filter((t) => now - t < RAPID_EXIT_WINDOW_MS);
    ctrlCPressTimestamps.push(now);
    if (ctrlCPressTimestamps.length >= RAPID_EXIT_THRESHOLD) {
      ctrlCPressTimestamps = [];
      forceExitViaRapidCtrlC();
    }
  };
  // Attached AFTER Ink renders (see the `inkInstance = instance` site) — a
  // 'data' listener flips stdin into flowing mode, and doing that before Ink
  // mounts would drop keystrokes typed during boot.

  const detachListeners = () => {
    process.off('SIGINT', sigintHandler);
    inkStdin.off('data', onRawCtrlC);
    for (const s of signals) process.off(s, signalHandler);
    try {
      process.off('SIGBREAK' as NodeJS.Signals, signalHandler);
    } catch {
      // ignore — see install site
    }
    for (const s of swallowSignals) {
      try {
        process.off(s, swallow);
      } catch {
        // ignore — see install site
      }
    }
    process.off('exit', exitHandler);
  };

  // Register immediately (fire-and-forget)
  void tuiClientRegistration.register();

  return new Promise<number>((resolve) => {
    let exitCode = 0;
    let hardExitTimer: ReturnType<typeof setTimeout> | null = null;
    const onExit = (code: number) => {
      exitCode = code;
    };
    const settle = (code: number) => {
      // The unmount completed normally — cancel the hang fallback. Leaving it
      // armed used to hard-kill the HOST ~400ms after a project switch,
      // racing the post-TUI respawn logic in execution.ts.
      if (hardExitTimer) {
        clearTimeout(hardExitTimer);
        hardExitTimer = null;
      }
      cleanup();
      detachListeners();
      resolve(code);
    };

    /**
     * Request the TUI to exit with a specific code. This triggers Ink's unmount
     * (restoring terminal state) and resolves the runTui promise with the given code.
     * Used for clean exits when switching projects — the host CLI catches the exit
     * code and spawns a new wstack process in the target directory.
     */
    const requestExit = (code: number) => {
      onExit(code);
      // Trigger Ink's unmount — it restores terminal state (raw mode off,
      // cursor shown) and resolves waitUntilExit(). A bare process.exit()
      // would skip this and leave the terminal in a broken state.
      // Hard-exit ONLY if Ink's unmount hangs (settle() cancels this timer
      // on the normal path).
      inkInstance?.unmount();
      hardExitTimer = setTimeout(() => process.exit(code), 5_000);
      hardExitTimer.unref();
    };

    // Wire requestExit to the options so the App can call it
    opts.requestExit = requestExit;

    let instance: ReturnType<typeof render>;

    // Physically clear the visible screen + scrollback on `/clear`.
    // Notably we do NOT call `instance?.clear()` and do NOT emit `\x1b[H`.
    //
    // Ink's `instance.clear()` calls logUpdate.clear() (which erases Ink's
    // output and resets the line tracker) then logUpdate.sync(oldOutput)
    // (which sets the tracker back to the OLD output dimensions).  Since
    // the terminal is already empty after the clear, logUpdate now thinks
    // N lines of phantom content are on screen.  When the subsequent render
    // produces fresh (short) output, logUpdate tries to `eraseLines(N)` from
    // cursor position (0,0) — the N cursor-up sequences overshoot the top
    // of the terminal and the output lands in the wrong place, producing
    // duplicated input lines and a garbled interface.
    //
    // Instead we only physically clear the screen (\x1b[2J) and scrollback
    // (\x1b[3J) — WITHOUT \x1b[H (cursor home) — and let Ink's natural
    // re-render (triggered by the state changes in onClearHistory) produce
    // the fresh output from the correct cursor position.  Ink and logUpdate
    // keep their pre-clear tracker values so the ANSI diff is calculated
    // relative to a cursor that still matches reality.
    const clearTerminal = () => {
      try {
        stdout.write('\x1b[2J\x1b[3J');
      } catch {
        // stdout may be closed mid-teardown — ignore.
      }
    };
    try {
      // A full-screen TUI must not share the normal buffer's scrollback. DECSET
      // 1049 saves the shell screen and enters a fresh alternate buffer;
      // terminals disable native scrollback/scrollbars for that buffer.
      stdout.write(ALT_SCREEN_ON);
      alternateScreenActive = true;
      stdout.write(BRACKETED_PASTE_ON);
      stdout.write('\x1b[2J\x1b[H');

      // Acquire raw mode through the lifecycle manager. This is the last
      // setRawMode call before Ink takes over stdin, closing the Windows ConPTY
      // readline→Ink handoff race (acquire is idempotent).
      lifecycle.acquire(stdin);
      instance = render(
        React.createElement(App, {
          agent: opts.agent,
          slashRegistry: opts.slashRegistry,
          secretInputController: opts.secretInputController,
          attachments: opts.attachments,
          events: opts.events,
          tokenCounter: opts.tokenCounter,
          visionAdapters: opts.visionAdapters,
          supportsVision: opts.supportsVision,
          model: opts.model,
          banner: opts.banner ?? true,
          queueStore: opts.queueStore,
          onQueueChange: opts.onQueueChange,
          yolo: opts.yolo,
          getYolo: opts.getYolo,
          onYolo: opts.onYolo,
          getAutonomy: opts.getAutonomy,
          getEternalEngine: opts.getEternalEngine,
          getParallelEngine: opts.getParallelEngine,
          getSddRun: opts.getSddRun,
          onSddLifecycle: opts.onSddLifecycle,
          subscribeEternalIteration: opts.subscribeEternalIteration,
          subscribeEternalStage: opts.subscribeEternalStage,
          subscribeGoal: opts.subscribeGoal,
          appVersion: opts.appVersion,
          provider: opts.provider,
          family: opts.family,
          keyTail: opts.keyTail,
          profile: opts.profile,
          profileConfigPath: opts.profileConfigPath,
          autonomyAgents: opts.autonomyAgents,
          latestVersion: opts.latestVersion,
          updateAvailable: opts.updateAvailable,
          getPickableProviders: opts.getPickableProviders,
          switchProviderAndModel: opts.switchProviderAndModel,
          switchAutonomy: opts.switchAutonomy,
          effectiveMaxContext: opts.effectiveMaxContext,
          onExit,
          director: opts.director ?? null,
          getDirector: opts.getDirector,
          fleetRoster: opts.fleetRoster,
          onClearHistory: opts.onClearHistory
            ? (dispatch) => opts.onClearHistory?.(dispatch)
            : undefined,
          clearTerminal,
          fleetStreamController: opts.fleetStreamController,
          agentTranscripts: opts.agentTranscripts,
          interruptController: opts.interruptController,
          enhanceController: opts.enhanceController,
          enhanceEnabled: opts.enhanceController?.enabled ?? true,
          getEnhancerReasoning: opts.getEnhancerReasoning,
          buildEnhancerProvider: opts.buildEnhancerProvider,
          getEnhanceFallbackRef: opts.getEnhanceFallbackRef,
          getConfiguredRefinerRef: opts.getConfiguredRefinerRef,
          midRunSendPicker: opts.getSettings?.().midRunSendPicker ?? true,
          statuslineHiddenItems: opts.statuslineHiddenItems,
          setStatuslineHiddenItems: opts.setStatuslineHiddenItems,
          saveStatuslineHiddenItems: opts.saveStatuslineHiddenItems,
          agentsMonitorController: opts.agentsMonitorController,
          initialGoal: opts.initialGoal,
          initialAsk: opts.initialAsk,
          getSDDContext: opts.getSDDContext,
          onSDDOutput: opts.onSDDOutput,
          sessionsDir: opts.sessionsDir,
          projectRoot: opts.projectRoot,
          getSettings: opts.getSettings,
          saveSettings: opts.saveSettings,
          getPluginItems: opts.getPluginItems,
          onPluginToggle: opts.onPluginToggle,
          getMcpServers: opts.getMcpServers,
          onMcpToggle: opts.onMcpToggle,
          onMcpRestart: opts.onMcpRestart,
          getToolsItems: opts.getToolsItems,
          onToolToggle: opts.onToolToggle,
          getBrainData: opts.getBrainData,
          onBrainRiskLevel: opts.onBrainRiskLevel,
          brainPanelHost: opts.brainPanelHost,
          getShadowData: opts.getShadowData,
          onShadowStart: opts.onShadowStart,
          onShadowStop: opts.onShadowStop,
          authHost: opts.authHost,
          predictNext: opts.predictNext,
          onSuggestionsParsed: opts.onSuggestionsParsed,
          getSuggestions: opts.getSuggestions,
          getAutoSuggestions: opts.getAutoSuggestions,
          autonomyNextPrompt: opts.autonomyNextPrompt,
          setSuggestions: opts.setSuggestions,
          chime: opts.chime,
          confirmExit: opts.confirmExit,
          titleController,
          mouse: mouseEnabled,
          capability,
          modeLabel: opts.modeLabel,
          tokenSavingMode: opts.tokenSavingMode,
          toolCount: opts.toolCount,
          getModeLabel: opts.getModeLabel,
          getModes: opts.getModes,
          switchMode: opts.switchMode,
          registerDebugStreamCallback: opts.registerDebugStreamCallback,
          restoreDebugStreamCallback: opts.restoreDebugStreamCallback,
          restoredMessages: opts.restoredMessages,
          restoredToolCalls: opts.restoredToolCalls,
          restoredEvents: opts.restoredEvents,
          listSessions: opts.listSessions,
          onResumeSession: opts.onResumeSession,
          getProjectPickerItems: opts.getProjectPickerItems,
          onProjectSelect: opts.onProjectSelect,
          requestExit: opts.requestExit,
          getLiveSessions: opts.getLiveSessions,
          onSwitchToSession: opts.onSwitchToSession,
          initialAgentsMonitorOpen: opts.initialAgentsMonitorOpen,
          subscribeCoordinatorEvents: opts.subscribeCoordinatorEvents,
          onPanelOpen: opts.onPanelOpen,
          onCoordinatorStart: opts.onCoordinatorStart,
          onCoordinatorStop: opts.onCoordinatorStop,
          onCoordinatorTasks: opts.onCoordinatorTasks,
          onCoordinatorClaim: opts.onCoordinatorClaim,
          onCoordinatorComplete: opts.onCoordinatorComplete,
          onCoordinatorFail: opts.onCoordinatorFail,
          onCoordinatorStatus: opts.onCoordinatorStatus,
          memoryStore: opts.memoryStore,
        }),
        {
          exitOnCtrlC: false,
          stdin: inkStdin,
          // Bound reconciliation/tokenization work for large live histories
          // while preserving responsive streamed output.
          maxFps: 10,
        },
      );
      // Wire the hoisted reference so signal handlers can unmount Ink.
      inkInstance = instance;
      // Arm the last-resort raw Ctrl+C watcher now that Ink owns stdin —
      // attaching a 'data' listener earlier would flip the stream into
      // flowing mode before Ink mounts and drop boot-time keystrokes.
      inkStdin.on('data', onRawCtrlC);
    } catch (err) {
      writeErr(
        `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      settle(1);
      return;
    }
    // Terminal reflows visible text on resize BEFORE Ink can react, which can
    // leave ghosts below the cursor. Erase from-cursor-to-end on every resize
    // to minimize artifacts. Ink immediately re-renders at the new width.
    let detachResize: (() => void) | null = null;
    const onResize = () => {
      try {
        // \x1b[J = erase from cursor to end of screen. Does NOT touch
        // anything above the cursor, so committed Static history in
        // scrollback is preserved. Ink's useStdout subscriber will
        // immediately re-render the live region at the new width.
        // Do NOT prefix with \x1b[H: homing to (0,0) erases the visible
        // committed output and repositions the live region (input + status
        // bar) at the top of the viewport instead of the bottom.
        stdout.write('\x1b[J');
      } catch {
        // stdout might be detached mid-shutdown — ignore.
      }
    };
    stdout.on('resize', onResize);
    detachResize = () => stdout.off('resize', onResize);

    instance
      .waitUntilExit()
      .then(() => {
        detachResize?.();
        settle(exitCode);
      })
      .catch(() => {
        detachResize?.();
        settle(1);
      });
  });
}
