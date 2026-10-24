import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  AttachmentStore,
  AutonomyStage,
  Message,
  SkillLoader,
  TokenCounter,
  TokenSavingTier,
} from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import type { CoordinatorEvent } from '@wrongstack/core/coordination';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { QueueStore } from '@wrongstack/core/storage';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import type { SddLifecycleResult, SddRunControl } from '@wrongstack/sdd';
import type React from 'react';
import type { TuiCoordinationProps } from './app-coordination-props.js';
import type { TuiEnhancementProps } from './app-enhancement-props.js';
import type { TuiSessionProps } from './app-session-props.js';
import type { TuiSettingsProps } from './app-settings-props.js';
import type { AutonomyAgentStatus } from './history-entry.js';
import type { ProviderOption, ResourceMenuId, ResourceMenuSnapshot } from './ui-contracts.js';
/**
 * Props for the TUI `<App>` shell.
 *
 * Extracted from app.tsx (which is line-capped by the hotspot guardrail) —
 * this is the host↔TUI contract, not app logic, so it reads better on its
 * own. `app.tsx` re-exports `AppProps` for consumers importing it from
 * '@wrongstack/tui' / '../src/app.js'.
 */
/**
 * The TUI's view of core's `LeaderAutoWakeController` (structural, so tests
 * can pass a fake). The TUI binds a port for its foreground session.
 */
export interface TuiLeaderAutoWake {
  attachPort(port: import('@wrongstack/core/coordination').LeaderWakePort): () => void;
  onRunFinished(sessionId: string): unknown;
  onSessionDisplayed(sessionId: string): unknown;
  noteUserInput(sessionId: string): void;
}

export interface AppProps
  extends TuiCoordinationProps,
    TuiSessionProps,
    TuiSettingsProps,
    TuiEnhancementProps {
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
   * The queue store of another session. With it, `/resume` brings that
   * session's queue along (the WebUI keeps its queue in the same file) and
   * leaves the previous session's on disk.
   */
  queueStoreFor?: ((sessionId: string) => QueueStore | undefined) | undefined;
  /**
   * Mirrors the queue's display texts (head first) to the host on every
   * queue change, so a running agent can be told what's waiting (queue
   * awareness — see core's queued-messages.ts). Display state is unaffected.
   */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /** Background-delegation auto-wake controller; see {@link TuiLeaderAutoWake}. */
  leaderAutoWake?: TuiLeaderAutoWake | undefined;
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
        modes: import('@wrongstack/contracts/types').Mode[];
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
    | (() => import('@wrongstack/core/coordination').ParallelEternalEngine | null)
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
    | ((fn: (entry: import('@wrongstack/goal').JournalEntry) => void) => () => void)
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
   * The standalone executable's background update: called with the version
   * once it is downloaded, verified and waiting to be swapped in when this
   * session exits. The status bar's version chip then says so.
   */
  subscribeUpdateReady?: ((listener: (version: string) => void) => () => void) | undefined;
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
  onProjectSelect?:
    | ((
        key: string,
        kind: 'project' | 'action',
      ) => void | string | null | Promise<void | string | null>)
    | undefined;

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
  restoredEvents?: import('@wrongstack/contracts/types').SessionEvent[] | undefined;
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
  memoryStore?: import('@wrongstack/contracts/types').MemoryPort | undefined;
}
