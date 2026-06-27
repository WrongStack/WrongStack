// State, Action, and supporting types extracted from app-reducer.ts.
// This file has NO React or Ink dependencies — pure type definitions.
import type { AutonomyStage, ContentBlock, DesignKitEntry, SddBoardSnapshot, TokenSavingTier } from '@wrongstack/core';
import type { AutonomyOption } from './components/autonomy-picker.js';
import type { HistoryEntry } from './components/history.js';
import type { ProviderOption } from './components/model-picker.js';
import type {
  AuditLevel,
  CacheTtl,
  CompactorStrategy,
  ContextMode,
  LogLevel,
  ReasoningEffort,
  SettingsMode,
  SettingsPickerPatch,
  StatuslineMode,
} from './components/settings-picker.js';
import type { ChipMeta, StatuslineItem } from './components/statusline-picker.js';
import type { ProjectPickerItem } from './components/project-picker.js';
import type { WorktreeRow } from './components/worktree-panel.js';

export interface QueueItem {
  id: number;
  displayText: string;
  blocks: ContentBlock[];
}

/** Per-subagent state tracked live from the FleetBus. */
export interface FleetEntry {
  id: string;
  name: string;
  provider?: string | undefined;
  model?: string | undefined;
  status: 'idle' | 'running' | 'success' | 'failed' | 'timeout' | 'stopped';
  streamingText: string;
  iterations: number;
  toolCalls: number;
  recentTools: Array<{
    name: string;
    ok?: boolean | undefined;
    durationMs?: number | undefined;
    outputBytes?: number | undefined;
    outputLines?: number | undefined;
    at: number;
  }>;
  recentMessages: Array<{ text: string; at: number }>;
  cost: number;
  startedAt: number;
  lastEventAt: number;
  /**
   * Tool the subagent is currently inside, set on `tool.started` and
   * cleared on `tool.executed`. Lets the FleetPanel render "running →
   * bash" instead of an opaque "running". Undefined when no tool is
   * mid-flight (between iterations, before the first tool, or after
   * the last tool of a run).
   */
  currentTool?: { name: string; startedAt: number } | undefined;
  /**
   * Absolute path to the per-subagent JSONL transcript on disk, when
   * one was created. Surfaced so the FleetPanel can render `path:`
   * dim under the entry — users grep / tail the file for full
   * visibility into the subagent's run.
   */
  transcriptPath?: string | undefined;
  /**
   * Most recent budget warning: subagent hit a soft limit and the
   * coordinator is auto-extending. Rendered in FleetPanel as:
   * "⚡ hitting tool_calls limit (350/400) — extending"
   * Cleared on the next fleetDone or fleetStart.
   */
  budgetWarning?: { kind: string; used: number; limit: number; at: number } | undefined;
  /**
   * Cumulative auto-extension grants for this subagent. Surfaced as a
   * persistent "⚡×N" badge in the monitor and 4th status line so the user
   * can see how often never-die kept the agent alive. Survives across tasks
   * within the same subagent entry (unlike `budgetWarning`, which clears).
   */
  extensions?: number | undefined;
  /**
   * Latest displayed context window fill percentage (0–1, capped at 1).
   * Emitted on every `iteration.completed` via `ctx.pct` event.
   * Rendered as a colored progress bar in the AgentsMonitor.
   */
  ctxPct?: number | undefined;
  /** Estimated total tokens in the context window (from ctx.pct event). */
  ctxTokens?: number | undefined;
  /** Provider's max context window in tokens (from ctx.pct event). */
  ctxMaxTokens?: number | undefined;
  /**
   * Estimated USD cost of the current context tokens. Derived from
   * ctxTokens × provider-specific input pricing when available.
   * Shown in the agents monitor as a per-agent cost breakdown.
   */
  ctxCost?: number | undefined;
  /**
   * Human-readable reason for terminal failure, when known.
   * E.g. "provider_auth", "rate_limit", "timeout", "budget_iterations".
   * Shown in the Fleet timeline and the per-agent card in the agents monitor.
   */
  failureReason?: string | undefined;
}

/** A registered slash command matched against the user's current / query. */
export interface SlashCommandMatch {
  name: string;
  description: string;
  argsHint?: string | undefined;
  matchedAlias?: string | undefined;
  isBuiltin: boolean;
  category: 'Run' | 'Session' | 'Inspect' | 'Agent' | 'Config' | 'App';
}

/** Thin view over a SessionSummary for the resume picker. */
export interface ResumeSessionEntry {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string | undefined;
  tokenTotal: number;
  iterationCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
  /** The current session — marked so the picker can disallow resuming into itself. */
  isCurrent?: boolean | undefined;
}

export type DraftEntry = HistoryEntry extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never;

export type GoalSummary = {
  goal: string;
  refinedGoal?: string | undefined;
  goalState: 'active' | 'paused' | 'completed' | 'abandoned';
  iterations: number;
  progress?: number | undefined;
  progressNote?: string | undefined;
  progressTrend?: 'accelerating' | 'steady' | 'stalling' | undefined;
  deliverables?: string[] | undefined;
  lastTask?: string | undefined;
  lastStatus?: string | undefined;
} | null;

export type State = {
  entries: HistoryEntry[];
  /**
   * Monotonic generation counter for WHOLESALE history replacements
   * (session resume). Ink's <Static> tracks how many items it has already
   * written by INDEX — replacing `entries` with a shorter array makes it
   * silently skip the replayed entries. The History component keys <Static>
   * on this so a replacement remounts it and the replayed transcript
   * actually prints.
   */
  historyGen: number;
  buffer: string;
  cursor: number;
  streamingText: string;
  /**
   * Live tail of the currently streaming tool's stdout/progress text. Mirrors
   * the assistant `streamingText` pattern but is keyed by tool_use id so the
   * tail is cleared automatically when that tool finishes. Only one tool's
   * stream is shown at a time — multi-tool streaming is rare and stacking
   * tails fights for the same screen space.
   */
  toolStream: { toolUseId: string; name: string; text: string; startedAt: number } | null;
  status: 'idle' | 'running' | 'streaming' | 'aborting';
  interrupts: number;
  /**
   * Set when the user pressed Esc mid-iteration to interrupt the agent.
   * The NEXT submitted user message gets a STEERING prefix block prepended
   * so the model sees "I interrupted you on purpose — focus on this
   * instead of resuming the prior task". Cleared once that message
   * lands. Distinct from `interrupts` (which is the Ctrl+C exit ladder).
   */
  steeringPending: boolean;
  /**
   * Context snapshot captured at Esc time, replayed into the STEERING
   * preamble so the model sees exactly what it was mid-doing when the
   * user pulled the cord. Cleared together with `steeringPending`.
   * Without this the model has to guess from chat scrollback which
   * tools were live — and it can't see subagent state at all.
   */
  steerSnapshot: {
    runningTools: string[];
    subagents: Array<{ label: string; status: string; tool?: string | undefined }>;
    subagentsTerminated: number;
    partialAssistantText: string;
  } | null;
  hint: string;
  brain: {
    state: 'idle' | 'deciding' | 'answered' | 'ask_human' | 'denied';
    source?: string | undefined;
    risk?: 'low' | 'medium' | 'high' | 'critical' | undefined;
    summary?: string | undefined;
    updatedAt?: number | undefined;
  };
  brainPrompt: {
    requestId: string;
    source: string;
    risk: 'low' | 'medium' | 'high' | 'critical';
    question: string;
    context?: string | undefined;
    options?: Array<{
      id: string;
      label: string;
      risk?: string | undefined;
      consequence?: string | undefined;
      recommended?: boolean | undefined;
    }> | undefined;
  } | null;
  nextId: number;
  picker: { open: boolean; query: string; matches: string[]; selected: number };
  /** Slash command picker — open while typing a / command. */
  slashPicker: { open: boolean; query: string; matches: SlashCommandMatch[]; selected: number };
  /** Tool calls currently in-flight, by tool_use id. Surface in the status bar. */
  runningTools: Map<string, { name: string; startedAt: number }>;
  /** FIFO of user messages typed while the agent was running. Drained when idle. */
  queue: QueueItem[];
  nextQueueId: number;
  /** Previous input strings for up/down navigation. */
  inputHistory: string[];
  /** 0 = current buffer (not in history), 1 = most recent, n = nth most recent. */
  historyIndex: number;
  /** Two-step model picker (provider → model) — opened by `/model`. */
  modelPicker: {
    open: boolean;
    step: 'provider' | 'model';
    providerOptions: ProviderOption[];
    modelOptions: string[];
    /** Filtered list shown in step 2 (same as modelOptions when searchQuery is empty). */
    filteredOptions: string[];
    selected: number;
    pickedProviderId?: string | undefined;
    hint?: string | undefined;
    /** Live search filter in step 2. */
    searchQuery: string;
  };
  /** Single-step autonomy mode picker — opened by `/autonomy`. */
  autonomyPicker: {
    open: boolean;
    options: AutonomyOption[];
    selected: number;
    hint?: string | undefined;
  };
  /** Design Studio kit picker — opened by `/design`. */
  designPicker: {
    open: boolean;
    kits: DesignKitEntry[];
    selected: number;
    /** Target stack applied on selection. */
    stack: string;
  };
  /** Session resume picker — opened by `/resume`. Lists recent sessions with metadata. */
  resumePicker: {
    open: boolean;
    sessions: ResumeSessionEntry[];
    selected: number;
    /** True while the resume operation is in flight (fetching + replaying). */
    busy: boolean;
    hint?: string | undefined;
    /** Error message if the resume operation failed. */
    error?: string | undefined;
  };
  /** Settings editor — opened by `/settings` or Ctrl+S. */
  settingsPicker: {
    open: boolean;
    /** Focused row index. */
    field: number;
    /**
     * Mirror of the persisted `Settings.lastSettingsField` — kept in the
     * runtime slice so the reducer can read it during `settingsOpen`
     * without re-loading the full Settings shape, and so the auto-save
     * effect (see app.tsx) can write it back when the user navigates.
     */
    lastSettingsField: number;
    // Autonomy
    mode: SettingsMode;
    delayMs: number;
    // UX
    titleAnimation: boolean;
    yolo: boolean;
    streamFleet: boolean;
    chime: boolean;
    confirmExit: boolean;
    nextPrediction: boolean;
    // Features
    featureMcp: boolean;
    featurePlugins: boolean;
    featureMemory: boolean;
    featureSkills: boolean;
    featureModelsRegistry: boolean;
    tokenSavingTier: TokenSavingTier;
    allowOutsideProjectRoot: boolean;
    // Context
    contextAutoCompact: boolean;
    contextStrategy: CompactorStrategy;
    contextMode: ContextMode;
    // Fleet
    maxConcurrent: number;
    // Logging
    logLevel: LogLevel;
    // Session
    auditLevel: AuditLevel;
    // Indexing
    indexOnStart: boolean;
    /** Multi-file diff summary footer cutoff. 0 = off; positive = min file count. */
    multiDiffSummaryThreshold: number;
    // Tools
    maxIterations: number;
    /** Maximum auto-proceed iterations (0 = unlimited). */
    autoProceedMaxIterations: number;
    /** Prompt refinement preview countdown (ms). */
    enhanceDelayMs: number;
    /** Master toggle for the prompt refiner (mirrors Settings.enhanceEnabled). */
    enhanceEnabled: boolean;
    /** Refined-prompt language preference (mirrors Settings.enhanceLanguage). */
    enhanceLanguage: 'original' | 'english';
    /** Raw SSE stream debugging toggle. */
    debugStream: boolean;
    /** Statusline density mode. */
    statuslineMode: StatuslineMode;
    /** Reasoning mode: auto | on | off. */
    reasoningMode: 'auto' | 'on' | 'off';
    /** Reasoning effort level. */
    reasoningEffort: ReasoningEffort;
    /** Preserve thinking across turns. */
    reasoningPreserve: boolean;
    /** Single word shown in the TUI rainbow working-state chip. */
    thinkingWord: string;
    /** True while free-text editing the thinking word (Enter on its row). */
    thinkingWordEditing: boolean;
    /** In-progress text buffer while `thinkingWordEditing`. */
    thinkingWordDraft: string;
    /** Prompt cache TTL. */
    cacheTtl: CacheTtl;
    /** Where to persist settings: 'global' or 'project'. */
    configScope: 'global' | 'project';
    /**
     * Live filter for the row-search modal (entered via `/`). Empty
     * string means filter is inactive. Non-empty means the user is
     * typing a search query and only matching rows are visible.
     * Cleared on picker close and on Esc-out-of-filter.
     */
    filter: string;
    hint?: string | undefined;
  };
  /** Statusline editor — opened by `/statusline`. */
  statuslinePicker: {
    open: boolean;
    /** Focused field index. */
    field: number;
    /** Current hidden-items list (user-toggled off chips). */
    hiddenItems: StatuslineItem[];
    /**
     * Chips that are temporarily visible due to data/events, with expiration
     * metadata. When a chip expires it is removed from this list. User-toggled
     * chips stay visible via their data being truthy — they are NOT here.
     */
    visibleChips: ChipMeta[];
    hint?: string | undefined;
  };
  /** Project switcher panel — opened by F1 or `/project`. */
  projectPicker: {
    open: boolean;
    /** Original unfiltered items. Never mutated after open. */
    allItems: ProjectPickerItem[];
    /** Currently displayed items (filtered from allItems). Navigation targets this list. */
    items: ProjectPickerItem[];
    selected: number;
    filter: string;
    hint?: string | undefined;
  };
  /** F-key panel picker — opened by `/f`. Keyboard-navigable list of F1–F12 panels. */
  fKeyPicker: {
    open: boolean;
    selected: number;
  };
  /** Pending tool confirmations — queue to handle multiple tools requesting confirmation. */
  confirmQueue: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
  }[];
  /**
   * Active prompt-refinement ("did you mean this?") panel. Set while the
   * EnhancePanel is shown after the refiner rewrites a user message; the
   * panel resolves to one of refined/original/edit and `submit()` continues.
   * Null when no refinement is pending.
   */
  enhance: {
    original: string;
    /** Refined in the user's original language. */
    refined: string;
    /** Refined in English. */
    english: string;
    resolve: (decision: 'refined' | 'english' | 'original' | 'edit') => void;
  } | null;
  /** When true, free-text submits are run through the prompt refiner first. Toggled by `/enhance`. */
  enhanceEnabled: boolean;
  /** True while the refiner LLM call is in flight (before the panel appears). Drives a "refining…" indicator. */
  enhanceBusy: boolean;
  /**
   * Pending ESC-interrupt confirmation. Null when none is pending.
   * When `confirmExit` is enabled and Esc is pressed mid-iteration, the
   * snapshot is captured and `escConfirm` opens instead of immediately
   * aborting. The prompt shows "Abort work and redirect?"
   * (or similar) and waits for y/n/Esc.
   */
  escConfirm: {
    snapshot: NonNullable<State['steerSnapshot']>;
  } | null;
  /** Incremented on /clear so the context chip re-reads from agent.ctx tokens. */
  contextChipVersion: number;
  /** Live fleet state: per-subagent entries from FleetBus events. Keyed by subagentId. */
  fleet: Record<string, FleetEntry>;
  /**
   * Leader-loop activity, synthesized for the AgentsMonitor overlay so the
   * user can see leader iteration / tool counts alongside subagent rows.
   * Driven by EventBus `iteration.started`/`iteration.completed`/`tool.started`/`tool.executed`.
   * Always present; renders as AGENT#0 LEADER in the monitor regardless of
   * whether any subagents exist.
   */
  leader: {
    iterations: number;
    toolCalls: number;
    recentTools: Array<{ name: string; ok?: boolean | undefined; durationMs?: number | undefined; at: number }>;
    currentTool?: { name: string; startedAt: number } | undefined;
    startedAt: number;
    lastEventAt: number;
    /** True while inside an iteration (between iteration.started and iteration.completed). */
    iterating: boolean;
    /** Latest displayed context window fill fraction (from ctx.pct event, capped at 1). */
    ctxPct?: number | undefined;
    /** Estimated total tokens in context window. */
    ctxTokens?: number | undefined;
    /** Provider max context in tokens. */
    ctxMaxTokens?: number | undefined;
  };
  /** Fleet-wide accumulated cost. */
  fleetCost: number;
  /** Fleet-wide token totals from the usage aggregator, for the monitor gauge. */
  fleetTokens: { input: number; output: number };
  /** Live concurrency ceiling — updated by /fleet concurrency and concurrency.changed event. */
  fleetConcurrency: number;
  /**
   * When true, subagent text activity is
   * streamed into the main history with an `AGENT#N` prefix. Toggled
   * with `/fleet stream on|off`. Tool calls stay in the live fleet
   * surfaces so chat history remains readable during multi-agent runs.
   */
  streamFleet: boolean;
  /** When true, the full graphical fleet monitor overlay is shown (Ctrl+F). */
  monitorOpen: boolean;
  /** When true, the agents monitor overlay is shown (Ctrl+G). */
  agentsMonitorOpen: boolean;
  /** When true, the keys-&-commands help overlay is shown (`?` on an empty prompt). */
  helpOpen: boolean;
  /** When true, the todos monitor overlay is shown (F6). */
  todosMonitorOpen: boolean;
  /** When true, the queue panel is shown (F7). */
  queuePanelOpen: boolean;
  /** When true, the process list overlay is shown (F8). */
  processListOpen: boolean;
  /** When true, the plan panel is shown (F5). */
  planPanelOpen: boolean;
  /** When true, the goal panel is shown (F9). */
  goalPanelOpen: boolean;
  /** When true, the sessions panel is shown (F10). */
  sessionsPanelOpen: boolean;
  /** Live session data for the sessions panel (F10). */
  sessionsPanel: {
    sessions: import('./components/sessions-panel.js').LiveSessionEntry[];
    busy: boolean;
    /** Selected index for arrow-key navigation. -1 when nothing selected. */
    selected: number;
  };
  /**
   * Pending session resume confirmation. When set, the F10 panel shows a
   * "Press Enter to confirm resume, Esc to cancel" prompt. Set by the first
   * Enter on a same-project session; the second Enter triggers the actual
   * onResumeSession call.
   */
  sessionResumeConfirm: {
    sessionId: string;
    sessionName: string;
  } | null;
  /**
   * Active or completed collaborative debugging session state.
   * Null when no collab session has run. Tracks counts + the event timeline
   * so FleetMonitor can render a live "COLLAB SESSION" banner and per-event
   * entries (bug.found / refactor.plan / critic.evaluation) as they arrive.
   */
  collabSession: {
    /** Null until the first collab subagent spawns; set on first bug.found. */
    sessionId: string | null;
    bugCount: number;
    planCount: number;
    evalCount: number;
    /** Most recent overall verdict when the session completes. */
    overallVerdict: 'approve' | 'needs_revision' | 'reject' | null;
    /** Timeline of collab events for the FleetMonitor overlay. */
    timeline: Array<{ at: number; icon: string; color: string; text: string }>;
    startedAt: number | null;
  } | null;
  /** Session checkpoints recorded by SessionWriter.writeCheckpoint() events. */
  checkpoints: Array<{
    promptIndex: number;
    promptPreview: string;
    ts: string;
    fileCount: number;
  }>;
  /** Checkpoint timeline overlay — null when closed. */
  rewindOverlay: {
    checkpoints: Array<{
      promptIndex: number;
      promptPreview: string;
      ts: string;
      fileCount: number;
    }>;
    selected: number;
  } | null;
  /** Live iteration-stage of the active autonomy engine. */
  eternalStage: AutonomyStage | null;
  /** Loaded from .wrongstack/goal.json on mount for startup banner. */
  goalSummary: GoalSummary;
  /** AutoPhase orchestrator state — rendered by PhaseMonitor. */
  autoPhase: {
    /** AutoPhase graph title. */
    title: string;
    /** Per-phase task summary, keyed by phaseId. */
    phases: Record<
      string,
      {
        name: string;
        status: string;
        completedTasks: number;
        totalTasks: number;
        startedAt?: number | undefined;
        /** Tasks currently executing in this phase, with the agent on each. */
        activeTasks?: Array<{ taskId: string; title: string; agent?: string | undefined }> | undefined;
      }
    >;
    /** Active phase IDs (running phases). */
    runningPhaseIds: string[];
    /** Elapsed ms since graph start — drives the elapsed counter. */
    elapsedMs: number;
    /** True while the monitor overlay is open (Ctrl+P). */
    monitorOpen: boolean;
  } | null;
  /** Live multi-agent SDD board — latest snapshot + overlay open state (Ctrl+B). */
  sddBoard: {
    snapshot: SddBoardSnapshot;
    monitorOpen: boolean;
    /** Focused topological column index, or undefined for the all-columns view. */
    focusColumn?: number | undefined;
  } | null;
  /** Git-worktree isolation state — rendered by WorktreePanel/WorktreeMonitor. */
  worktrees: Record<string, WorktreeRow & { baseBranch?: string | undefined }>;
  /** Base branch worktrees fork from (for the monitor header). */
  worktreeBase?: string | undefined;
  /** True while the worktree monitor overlay is open (Ctrl+T). */
  worktreeMonitorOpen: boolean;
  /**
   * AutonomousCoordinator state — live from `subscribeCoordinatorEvents`.
   * Tracks project-level multi-session coordination: goals, tasks, consensus, and knowledge.
   */
  coordinator: {
    /** Active coordination goals. */
    goals: Array<{
      id: string;
      title: string;
      status: 'active' | 'paused' | 'completed' | 'failed';
      progress?: number | undefined;
      /** DEPRECATED — use tasks instead */
      steps?: string[] | undefined;
      tasks: Array<{
        id: string;
        title: string;
        status: 'pending' | 'running' | 'done' | 'failed';
        assignedTo?: string | undefined;
      }>;
      /** Agents/sessions participating in this goal's coordination. */
      participants: string[];
    }>;
    /** Live pending events for the coordinator panel timeline. */
    timeline: Array<{
      at: number;
      kind: 'goal' | 'task' | 'knowledge' | 'consensus' | 'deadlock';
      icon: string;
      text: string;
    }>;
    /** Count of shared knowledge facts across all sessions. */
    knowledgeCount: number;
    /** True while the coordinator monitor overlay is open. */
    monitorOpen: boolean;
    /** Coordinator health: true when connected and processing events. */
    healthy: boolean;
  };
  /**
   * In-app chat scroll state for the scrollable viewport.
   * In the default `<Static>` path these are inert.
   *   scrollOffset    — rows scrolled up from the bottom; 0 = pinned to newest.
   *   totalLines      — last measured content height (rows), from onMeasure.
   *   viewportRows    — last computed viewport height (rows).
   *   pendingNewLines — rows added while scrolled up; drives the "↓ N new" hint.
   */
  scrollOffset: number;
  totalLines: number;
  viewportRows: number;
  pendingNewLines: number;
  /**
   * Live debug-stream telemetry rendered in StatusBar line 3 when
   * stream debugging is active. Updated every ~200 ms by the throttled
   * callback from stream-debug-state.ts. Null when disabled or idle.
   */
  debugStreamStats: {
    chunkCount: number;
    lastChunkSize: number;
    lastDeltaMs: number;
    totalBytes: number;
    lastChunkAt: string;
  } | null;
  /**
   * Auto-proceed countdown state, driven by `countdown.tick` events from
   * the host. null when no countdown is active. A tick of 0 clears it.
   */
  countdown: {
    /** Remaining seconds until auto-proceed fires. */
    remainingSeconds: number;
  } | null;
};

export type Settings = {
  mode: 'off' | 'suggest' | 'auto';
  delayMs: number;
  titleAnimation: boolean;
  yolo: boolean;
  streamFleet: boolean;
  chime: boolean;
  confirmExit: boolean;
  nextPrediction: boolean;
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  /** Token-saving tier: off | minimal | light | medium | aggressive. */
  featureTokenSaving: TokenSavingTier;
  /** Allow tools to access paths outside the project root. Default: true (open). */
  allowOutsideProjectRoot: boolean;
  contextAutoCompact: boolean;
  contextStrategy: 'hybrid' | 'intelligent' | 'selective';
  contextMode: ContextMode;
  maxConcurrent: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  auditLevel: 'minimal' | 'standard' | 'full';
  indexOnStart: boolean;
  /** Multi-file diff summary footer cutoff. 0 = off; positive = min file count. */
  multiDiffSummaryThreshold: number;
  /**
   * Settings-picker row the user last navigated to. Carried in the
   * canonical Settings shape so reopening the picker after a session
   * restart lands on the same row they were last tweaking, rather than
   * always resetting to 0. Updated on every `settingsFieldMove` /
   * `settingsFieldSet`; consumed by the `settingsOpen` action.
   */
  lastSettingsField: number;
  maxIterations: number;
  /** Maximum auto-proceed iterations (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** Prompt refinement preview countdown (ms). */
  enhanceDelayMs: number;
  /** Enable/disable prompt refinement. */
  enhanceEnabled: boolean;
  /** Default language for refinement: original or english. */
  enhanceLanguage: 'original' | 'english';
  /** Raw SSE stream debugging — hex-dump every byte received from providers. */
  debugStream: boolean;
  /** Statusline density mode. Defaults to detailed. */
  statuslineMode: StatuslineMode;
  /** Reasoning mode: auto (provider default) | on | off. */
  reasoningMode: 'auto' | 'on' | 'off';
  /** Reasoning effort level. */
  reasoningEffort: ReasoningEffort;
  /** Preserve thinking across turns. */
  reasoningPreserve: boolean;
  /** Single word shown in the TUI rainbow working-state chip. */
  thinkingWord: string;
  /** Prompt cache TTL. */
  cacheTtl: CacheTtl;
  /** Where to persist settings: 'global' or 'project'. */
  configScope: 'global' | 'project';
  /** Full mouse mode: in-app managed scroll + clickable UI (SGR tracking on). */
  mouseMode?: boolean | undefined;
  /** Whether the process circuit breaker gates bash/exec. Default false (off). */
  breakerEnabled?: boolean | undefined;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs?: number | undefined;
};

export type Action =
  | { type: 'addEntry'; entry: DraftEntry }
  | { type: 'setBuffer'; buffer: string; cursor: number }
  | { type: 'clearInput' }
  | { type: 'clearHistory' }
  | { type: 'streamDelta'; delta: string }
  | { type: 'streamReset' }
  | { type: 'status'; status: State['status'] }
  | { type: 'interrupt' }
  | { type: 'resetInterrupts' }
  /**
   * User pressed Esc mid-iteration — flag the next message for steering
   * AND stash a context snapshot so the preamble can tell the model
   * exactly what it was doing.
   */
  | { type: 'steerStart'; snapshot: State['steerSnapshot'] }
  /** Submit handler consumed the steering flag; reset. */
  | { type: 'steerConsume' }
  | { type: 'hint'; text: string }
  | {
      type: 'brainStatus';
      state: State['brain']['state'];
      source?: string | undefined;
      risk?: State['brain']['risk'] | undefined;
      summary?: string | undefined;
    }
  | { type: 'brainPromptSet'; prompt: NonNullable<State['brainPrompt']> }
  | { type: 'brainPromptClear' }
  | { type: 'pickerOpen'; query: string }
  | { type: 'pickerClose' }
  | { type: 'pickerSetMatches'; query: string; matches: string[] }
  | { type: 'pickerMove'; delta: number }
  | { type: 'toolStarted'; id: string; name: string }
  | { type: 'toolEnded'; id?: string | undefined; name?: string | undefined }
  | { type: 'toolStreamAppend'; toolUseId: string; name: string; text: string; startedAt: number }
  | { type: 'toolStreamClear'; toolUseId?: string | undefined; name?: string | undefined }
  | { type: 'enqueue'; item: Omit<QueueItem, 'id'> }
  | { type: 'dequeueFirst' }
  | { type: 'queueClear' }
  | { type: 'queueDelete'; positions: number[] }
  | { type: 'slashPickerOpen'; query: string; matches: SlashCommandMatch[] }
  | { type: 'slashPickerClose' }
  | { type: 'slashPickerMove'; delta: number }
  | { type: 'modelPickerOpen'; providers: ProviderOption[] }
  | { type: 'modelPickerClose' }
  | { type: 'modelPickerMove'; delta: number }
  | { type: 'modelPickerPickProvider'; providerId: string; models: string[] }
  | { type: 'modelPickerBack' }
  | { type: 'modelPickerHint'; text?: string | undefined }
  /** Update the search filter in step 2. */
  | { type: 'modelPickerSearch'; query: string }
  | { type: 'autonomyPickerOpen'; options: AutonomyOption[] }
  | { type: 'autonomyPickerClose' }
  | { type: 'autonomyPickerMove'; delta: number }
  | { type: 'autonomyPickerHint'; text?: string | undefined }
  | { type: 'designPickerOpen'; kits: DesignKitEntry[] }
  | { type: 'designPickerClose' }
  | { type: 'designPickerMove'; delta: number }
  | { type: 'designPickerStack'; stack: string }
  | { type: 'resumePickerOpen'; sessions: ResumeSessionEntry[] }
  | { type: 'resumePickerClose' }
  | { type: 'resumePickerMove'; delta: number }
  | { type: 'resumePickerBusy'; on: boolean }
  | { type: 'resumePickerHint'; text?: string | undefined }
  | { type: 'resumePickerError'; text: string }
  /** Replace all history entries with the given hydrated entries from a resumed session. */
  | { type: 'replaceHistory'; entries: HistoryEntry[]; nextId: number }
  | {
      type: 'settingsOpen';
      mode: SettingsMode;
      delayMs: number;
      titleAnimation: boolean;
      yolo: boolean;
      streamFleet: boolean;
      chime: boolean;
      confirmExit: boolean;
      nextPrediction: boolean;
      featureMcp: boolean;
      featurePlugins: boolean;
      featureMemory: boolean;
      featureSkills: boolean;
      featureModelsRegistry: boolean;
      tokenSavingTier: TokenSavingTier;
      allowOutsideProjectRoot: boolean;
      contextAutoCompact: boolean;
      contextStrategy: CompactorStrategy;
      contextMode: ContextMode;
      maxConcurrent: number;
      logLevel: LogLevel;
      auditLevel: AuditLevel;
      indexOnStart: boolean;
      multiDiffSummaryThreshold: number;
      /**
       * Persisted row index for where to land when the picker reopens.
       * See `Settings.lastSettingsField`.
       */
      lastSettingsField: number;
      maxIterations: number;
      autoProceedMaxIterations: number;
      enhanceDelayMs: number;
      enhanceEnabled: boolean;
      enhanceLanguage: 'original' | 'english';
      debugStream: boolean;
      statuslineMode: StatuslineMode;
      reasoningMode: 'auto' | 'on' | 'off';
      reasoningEffort: ReasoningEffort;
      reasoningPreserve: boolean;
      thinkingWord: string;
      cacheTtl: CacheTtl;
      configScope: 'global' | 'project';
    }
  | { type: 'settingsClose' }
  | { type: 'settingsFieldMove'; delta: number }
  | { type: 'settingsFieldSet'; field: number }
  | { type: 'settingsValueChange'; delta: number }
  /**
   * Set a settings value directly from a typed patch (used by the
   * `/settings <chord> <value>` slash command). The patch is produced
   * by `resolveSettingsFieldValue` in settings-picker.tsx and validated
   * before dispatch, so the reducer just spreads it.
   */
  | { type: 'settingsValueSet'; patch: SettingsPickerPatch }
  /**
   * Update the live row-search filter. Empty string clears the filter.
   * Setting any non-empty value while the filter is empty also implicitly
   * activates filter mode (the picker renders only matching rows).
   */
  | { type: 'settingsFilterSet'; filter: string }
  | { type: 'settingsHint'; text?: string | undefined }
  /** Begin free-text editing of the thinking word (Enter on its row). */
  | { type: 'settingsThinkingEditStart' }
  /** Replace the in-progress thinking-word draft with the given buffer. */
  | { type: 'settingsThinkingEditChange'; draft: string }
  /** Commit the draft as the new thinking word (validated in the reducer). */
  | { type: 'settingsThinkingEditCommit' }
  /** Discard the draft and leave edit mode without changing the word. */
  | { type: 'settingsThinkingEditCancel' }
  | { type: 'statuslineOpen'; hiddenItems: StatuslineItem[] }
  | { type: 'statuslineClose' }
  | { type: 'statuslineFieldMove'; delta: number }
  | { type: 'statuslineFieldSet'; field: number }
  | { type: 'statuslineToggle'; item: StatuslineItem }
  | { type: 'statuslineHint'; text?: string | undefined }
  /**
   * A chip became visible due to data arriving (e.g., brain decision made,
   * mailbox messages arrived). Adds it to visibleChips with optional expiration.
   * If the chip is already in visibleChips, resets its shownAt timestamp.
   */
  | { type: 'statuslineChipShow'; key: StatuslineItem; expiresIn?: number }
  /**
   * Immediately remove a chip from visibleChips. Used when a stream ends
   * (brain, mailbox, enhance, debug_stream) so it disappears right away
   * even if it hasn't expired yet.
   */
  | { type: 'statuslineChipExpire'; key: StatuslineItem }
  /**
   * Sync visibleChips from the parent (e.g., after /statusline reset).
   * Replaces the entire visibleChips array.
   */
  | { type: 'statuslineVisibleChipsSync'; visibleChips: ChipMeta[] }
  | { type: 'projectPickerOpen'; items: ProjectPickerItem[] }
  | { type: 'projectPickerClose' }
  | { type: 'projectPickerMove'; delta: number }
  | { type: 'projectPickerFilter'; filter: string }
  | { type: 'projectPickerHint'; text?: string | undefined }
  | { type: 'fKeyPickerOpen' }
  | { type: 'fKeyPickerClose' }
  | { type: 'fKeyPickerMove'; delta: number }
  | { type: 'historyPush'; text: string }
  | { type: 'historyUp' }
  | { type: 'historyDown' }
  | { type: 'confirmOpen'; info: State['confirmQueue'][0] }
  | { type: 'confirmClose' }
  | { type: 'enhanceOpen'; info: NonNullable<State['enhance']> }
  | { type: 'enhanceClose' }
  | { type: 'enhanceSet'; enabled: boolean }
  | { type: 'enhanceBusy'; on: boolean }
  /**
   * Open the ESC-interrupt confirmation dialog with a context snapshot.
   * Fired when Esc is pressed mid-iteration and `confirmExit` is enabled.
   * The snapshot is replayed into `steerStart` on confirmation so the
   * STEERING preamble can describe the interrupted state to the LLM.
   */
  | { type: 'escConfirmOpen'; snapshot: NonNullable<State['steerSnapshot']> }
  /** Dismiss the ESC-interrupt confirmation (user cancelled). */
  | { type: 'escConfirmClose' }
  | { type: 'resetContextChip' }
  // Fleet actions
  | { type: 'fleetSeed'; entries: FleetEntry[]; cost: number }
  | {
      type: 'fleetSpawn';
      id: string;
      name?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      transcriptPath?: string | undefined;
    }
  | { type: 'fleetStart'; id: string; taskId?: string | undefined }
  | { type: 'fleetDelta'; id: string; text: string }
  | { type: 'fleetMessage'; id: string; text: string }
  | {
      type: 'fleetTool';
      id: string;
      name?: string | undefined;
      ok?: boolean | undefined;
      durationMs?: number | undefined;
      outputBytes?: number | undefined;
      outputLines?: number | undefined;
    }
  /** tool.started: pin the current tool name for status display. */
  | { type: 'fleetToolStart'; id: string; name: string }
  /** tool.executed: clear the current tool (paired with fleetTool). */
  | { type: 'fleetToolEnd'; id: string }
  | {
      type: 'fleetUsage';
      id: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | {
      type: 'fleetDone';
      id: string;
      status: FleetEntry['status'];
      iterations: number;
      toolCalls: number;
      /** Human-readable failure reason, e.g. "provider_auth", "rate_limit", "timeout". */
      failureReason?: string | undefined;
    }
  | {
      type: 'fleetBudgetWarning';
      id: string;
      kind: string;
      used: number;
      limit: number;
    }
  | {
      type: 'fleetBudgetExtended';
      id: string;
      totalExtensions: number;
    }
  | {
      type: 'fleetCtxPct';
      id: string;
      load: number;
      tokens: number;
      maxContext: number;
      /** Estimated USD cost of the context tokens (optional — computed when pricing known). */
      ctxCost?: number | undefined;
    }
  | {
      type: 'fleetCost';
      cost: number;
      input?: number | undefined;
      output?: number | undefined;
      /** Per-subagent usage keyed by subagent id (from the director snapshot). */
      perAgent?: Record<string, { cost: number }>;
    }
  /** Runtime concurrency ceiling change from CLI /fleet concurrency <n>. */
  | { type: 'fleetConcurrency'; n: number }
  | { type: 'leaderIterStart' }
  | { type: 'leaderIterEnd' }
  | { type: 'leaderToolStart'; name: string }
  | { type: 'leaderToolEnd'; name: string; ok?: boolean | undefined; durationMs?: number | undefined }
  | { type: 'leaderCtxPct'; load: number; tokens: number; maxContext: number }
  | { type: 'setStreamFleet'; enabled: boolean }
  | { type: 'toggleMonitor' }
  | { type: 'toggleAgentsMonitor' }
  | { type: 'toggleHelp' }
  | { type: 'toggleTodosMonitor' }
  | { type: 'toggleQueuePanel' }
  | { type: 'checkpointReceived'; cp: State['checkpoints'][0] }
  | { type: 'rewindOverlayOpen' }
  | { type: 'rewindOverlayClose' }
  | { type: 'rewindOverlayMove'; delta: number }
  | { type: 'sessionRewound'; toPromptIndex: number }
  | {
      type: 'eternalStage';
      stage: AutonomyStage;
    }
  | { type: 'goalSummary'; summary: GoalSummary }
  | { type: 'autoPhaseInit'; title: string }
  | {
      type: 'autoPhasePhaseUpdate';
      phaseId: string;
      name: string;
      status: string;
      completedTasks: number;
      totalTasks: number;
      startedAt?: number | undefined;
    }
  | { type: 'autoPhaseRunningPhases'; phaseIds: string[] }
  | { type: 'autoPhaseElapsed'; ms: number }
  | {
      type: 'autoPhaseTaskActive';
      phaseId: string;
      taskId: string;
      title: string;
      agent?: string | undefined;
      /** True when the task starts, false when it completes/fails. */
      active: boolean;
    }
  | { type: 'autoPhaseMonitorToggle' }
  | { type: 'autoPhaseReset' }
  | { type: 'sddBoardSnapshot'; snapshot: SddBoardSnapshot }
  | { type: 'toggleSddBoardMonitor' }
  | { type: 'sddBoardFocusNext' }
  | { type: 'sddBoardFocusPrev' }
  | {
      type: 'worktreeUpsert';
      handleId: string;
      row: Partial<WorktreeRow & { baseBranch?: string | undefined }>;
      baseBranch?: string | undefined;
    }
  | { type: 'worktreeRemove'; handleId: string }
  | { type: 'worktreeMonitorToggle' }
  // --- In-app chat scroll ---
  /** Scroll by `delta` rows: +up (older), -down (newer). Clamped. */
  | { type: 'scrollBy'; delta: number }
  | { type: 'scrollTo'; offset: number }
  /** Scroll by a viewport page in `dir`. */
  | { type: 'scrollPage'; dir: 'up' | 'down' }
  /** Jump to the newest output (pinned). */
  | { type: 'scrollToBottom' }
  /** Jump to the oldest output. */
  | { type: 'scrollToTop' }
  /** Report the measured content height; re-clamps offset + tracks new lines. */
  | { type: 'setMeasuredLines'; totalLines: number }
  /** Report the computed viewport height; re-clamps offset. */
  | { type: 'setViewportRows'; rows: number }
  /**
   * Fold a batch of fleet/display actions through the reducer in ONE pass so
   * a 150ms burst of subagent events produces a single React render instead
   * of one per event. Order-preserving; only high-frequency display events
   * are batched (correctness-sensitive events stay immediate).
   */
  | { type: 'fleetBatch'; actions: Action[] }
  /** BugHunter emitted a bug.found event on the FleetBus. */
  | {
      type: 'collabBugFound';
      sessionId: string;
      bugId: string;
      severity: string;
      description: string;
    }
  /** RefactorPlanner emitted a refactor.plan event on the FleetBus. */
  | {
      type: 'collabPlanEmitted';
      sessionId: string;
      planId: string;
      riskScore: string;
      phaseCount: number;
    }
  /** Critic emitted a critic.evaluation event on the FleetBus. */
  | {
      type: 'collabEvalComplete';
      sessionId: string;
      evalId: string;
      verdict: string;
      score: number;
    }
  /** Collab session completed — overall verdict is available. */
  | {
      type: 'collabSessionDone';
      sessionId: string;
      verdict: 'approve' | 'needs_revision' | 'reject';
    }
  /** A collab subagent (bug-hunter / refactor-planner / critic) was spawned. */
  | { type: 'collabSubagentSpawned'; subagentId: string; role: string }
  /** Toggle the process list overlay (F8). */
  | { type: 'toggleProcessList' }
  /** Toggle the plan panel (F5). */
  | { type: 'togglePlanPanel' }
  | { type: 'toggleGoalPanel' }
  | { type: 'toggleSessionsPanel' }
  | { type: 'sessionsPanelSet'; sessions: import('./components/sessions-panel.js').LiveSessionEntry[] }
  | { type: 'sessionsPanelMove'; delta: number }
  | { type: 'sessionsPanelBusy'; on: boolean }
  | { type: 'sessionResumeConfirmSet'; sessionId: string; sessionName: string }
  | { type: 'sessionResumeConfirmClear' }
  /** Push throttled debug-stream telemetry from the provider's chunk callback. */
  | {
      type: 'debugStreamStats';
      chunkCount: number;
      lastChunkSize: number;
      lastDeltaMs: number;
      totalBytes: number;
      lastChunkAt: string;
    }
  /** Clear debug-stream stats (fired on stream reset / idle). */
  | { type: 'debugStreamStatsClear' }
  /** Auto-proceed countdown tick. Upserts the countdown; 0 clears it. */
  | { type: 'countdownTick'; remainingSeconds: number }
  /** Auto-proceed countdown ended (completed or aborted). */
  | { type: 'countdownEnded' }
  // --- AutonomousCoordinator ---
  /** Coordinator emitted a live event. */
  | {
      type: 'coordinatorEvent';
      event: {
        type: string;
        goalId?: string | undefined;
        taskId?: string | undefined;
        knowledgeId?: string | undefined;
        title?: string | undefined;
        text?: string | undefined;
        participants?: string[] | undefined;
      };
    }
  /** Toggle the coordinator monitor overlay. */
  | { type: 'toggleCoordinatorMonitor' };
