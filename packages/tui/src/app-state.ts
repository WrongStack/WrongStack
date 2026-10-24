// State, Action, and supporting types extracted from app-reducer.ts.
// This file has NO React or Ink dependencies — pure type definitions.
import type { AutonomyStage, FleetChatVerbosity } from '@wrongstack/contracts/types';
import type { WorktreeTimelineEvent } from '@wrongstack/contracts/types/worktree-timeline';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import type { PanelState } from './app-panel-state.js';
import type { GoalSummary, QueueItem } from './app-state-core-types.js';
import type { FleetEntry } from './app-state-fleet.js';
import type { HistoryEntry } from './history-entry.js';
import type { TuiHistoryBudget } from './history-retention.js';
import type { ResumeLoadState } from './resume-load.js';
import type { ToolResultViewMode } from './settings-contracts.js';
import type {
  RefineFailureDecision,
  RefineFailureModel,
  ResourceMenuAction,
  ResourceMenuSnapshot,
  SubagentLaneView,
  SubagentRoleView,
  WorktreeRow,
} from './ui-contracts.js';

export type { Settings } from './app-settings-type.js';
export type {
  DraftEntry,
  GoalSummary,
  QueueItem,
  ResumeSessionEntry,
  SlashCommandMatch,
} from './app-state-core-types.js';
export type { FleetEntry } from './app-state-fleet.js';

export type State = PanelState & {
  entries: HistoryEntry[];
  /**
   * True while the history archive is loading older entries from disk.
   * The UI may show a loading indicator for the scrollback area.
   */
  archiveLoading: boolean;
  /**
   * Monotonic generation counter retained for wholesale history replacement
   * compatibility and the legacy standalone History renderer.
   */
  historyGen: number;
  /**
   * Retention budget applied to `entries` on every history mutation.
   *
   * `undefined` = the live defaults. A session resume widens it (see
   * `TUI_RESUME_HISTORY_BUDGET`) and the widened budget must PERSIST: the very
   * next `addEntry` — the "Resumed session …" line itself — re-runs retention,
   * so a budget that only applied to the `replaceHistory` dispatch would trim
   * the transcript back one tick later and look like the resume never loaded.
   */
  historyBudget: TuiHistoryBudget | undefined;
  /**
   * Auto-proceed is armed only after the user has sent something.
   *
   * A resume restores the session's todo board, and the auto-proceed selector
   * treats any open todo as grounded work — so resuming a session with an
   * unfinished board silently started a turn on a countdown, without the user
   * ever pressing anything. A resume must land in a waiting state: show the
   * conversation, then stop.
   *
   * This holds only the ARMING. Autonomy itself is the user's setting and is
   * never touched here — the hold clears on the next manual submit, exactly
   * like the consecutive-turn cap does.
   */
  autoProceedHold: boolean;
  /**
   * Live `/resume` progress, or null when no resume is in flight.
   *
   * Set for the whole operation: the seconds spent reading the journal (during
   * which the transcript is empty and this is the only thing on screen) and the
   * streaming replay that follows. The block itself is rendered as a normal
   * history entry — this is the model behind it, kept in state so the spinner
   * ticker and the chunk pump have one authority to read.
   */
  resumeLoad: ResumeLoadState | null;
  buffer: string;
  cursor: number;
  /**
   * Bash mode: the composer is dedicated to shell commands. Entered by
   * pressing `!` on an empty draft, exited by Esc / Backspace-on-empty (or a
   * successful run). While on, Enter submits the draft through the `!` shell
   * path (`/dev`) instead of sending it to the model, and the composer rail
   * relabels itself so the mode is unmistakable.
   */
  bashMode: boolean;
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
  hint: string;
  /** Transient clipboard confirmation; separate from competing hint producers. */
  copiedNotice: string;
  /** Card whose copy icon should flash; null means no highlighted card. */
  copiedEntryId: number | null;
  /**
   * Per-card tool-result density overrides, keyed by immutable history id.
   * These are presentation-only: the retained/canonical payload is untouched,
   * so expanding after a compact render never loses data. Changing the global
   * menu setting or clearing the session drops every local override.
   * Group controls write the same override to each member id.
   */
  toolResultViewOverrides: ReadonlyMap<number, ToolResultViewMode>;
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
    options?:
      | Array<{
          id: string;
          label: string;
          risk?: string | undefined;
          consequence?: string | undefined;
          recommended?: boolean | undefined;
        }>
      | undefined;
  } | null;
  nextId: number;
  /** Tool calls currently in-flight, by tool_use id. Surface in the status bar. */
  runningTools: Map<string, { name: string; startedAt: number }>;
  /** FIFO of user messages typed while the agent was running. Drained when idle. */
  queue: QueueItem[];
  nextQueueId: number;
  /** Previous input strings for up/down navigation. */
  inputHistory: string[];
  /** 0 = current buffer (not in history), 1 = most recent, n = nth most recent. */
  historyIndex: number;
  /**
   * Snapshot of the in-progress draft captured the first time the user
   * presses Up to enter history navigation. Restored when they navigate
   * back down to index 0, so peeking at history no longer discards a
   * half-typed prompt. Empty when not navigating. See historyUp/Down in
   * app-reducer.ts.
   */
  historyDraft: string;
  /** Shared two-pane browser for operational resources such as profiles and memory. */
  resourceMenu: {
    open: boolean;
    snapshot: ResourceMenuSnapshot | null;
    selected: number;
    filter: string;
    filtering: boolean;
    hint?: string | undefined;
    pendingAction?: ResourceMenuAction | undefined;
  };
  /**
   * Per-session subagent model lanes — opened by `/subagent-models`. Rows are
   * pre-rendered view strings: the hook owns the mapping from the core plan so
   * the reducer never reaches into coordination types.
   */
  subagentModels: {
    open: boolean;
    lanes: SubagentLaneView[];
    roles: SubagentRoleView[];
    selected: number;
    enabled: boolean;
    lock: boolean;
    followSessionModel: boolean;
    /** The session's own provider/model, shown as that switch's target. */
    sessionTarget: string;
    hint?: string | undefined;
  };
  /**
   * Active warning for the `!<command>` shell shortcut. It resolves before
   * dispatching to `/dev`, so the existing /dev runner stays the single shell
   * execution path.
   */
  shellCommandWarning: {
    command: string;
    resolve: (decision: 'yes' | 'no' | 'dont-show-again') => void;
  } | null;
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
    resolve: (decision: 'refined' | 'english' | 'original' | 'edit' | 'retry' | 'cancel') => void;
  } | null;
  /** When true, free-text submits are run through the prompt refiner first. Toggled by `/enhance`. */
  enhanceEnabled: boolean;
  /** True while the refiner LLM call is in flight (before the panel appears). Drives a "refining…" indicator. */
  enhanceBusy: boolean;
  /** True only while the long-history topic advisor performs a remote ambiguity check. */
  topicCheckBusy: boolean;
  /**
   * Active pre-refine grace countdown. Set after the user submits a prompt
   * that passes the refiner gate but BEFORE the refiner LLM call starts.
   * The user sees a "refining in Ns…" panel and can send as-is (any key),
   * cancel back to the composer with the draft restored (Esc or Backspace),
   * or let the timer expire to proceed into normal refinement. Resolves to proceed / skip / cancel. Null when
   * no countdown is active.
   */
  refineCountdown: {
    /** The user's just-submitted message (shown as preview). */
    original: string;
    /** Grace period in seconds before the refiner call starts. */
    seconds: number;
    resolve: (decision: 'proceed' | 'skip' | 'cancel') => void;
  } | null;
  /**
   * Monotonic id of the active countdown, bumped on every open. The panel is
   * keyed on it so a second countdown mounts a FRESH component instead of
   * inheriting the previous one's expired timer — which wedged the panel at
   * "refining in 0s…" with an orphaned resolve. Mirrors `historyGen`.
   */
  refineCountdownGen: number;
  /**
   * Active refinement-failure recovery panel. Set when a refine attempt (and
   * its automatic timeout retry) failed and the user must choose how to
   * recover: retry with more time, retry on the fallback/another model, send
   * the message as-is, or edit it. Resolves back into `submit()`. Null when no
   * failure is pending.
   */
  refineFailure: {
    original: string;
    error?: string | undefined;
    elapsedMs: number;
    fallbackRef?: string | undefined;
    models: RefineFailureModel[];
    resolve: (decision: RefineFailureDecision) => void;
  } | null;
  /** TUI-only follow-up gate shown after each completed `/bughunt` round. */
  bugHuntContinue: {
    completedRounds: number;
    totalRounds?: number | undefined;
    label?: string | undefined;
    resolve: (decision: 'yes' | 'stop') => void;
  } | null;
  /** Visible, non-blocking progress card for the currently running bug-hunt round. */
  bugHuntRunning: {
    currentRound: number;
    totalRounds?: number | undefined;
    commandName?: string | undefined;
    label?: string | undefined;
  } | null;
  /**
   * Monotonic re-arm key for the context chip: the statusline and `/context`
   * read it so they can re-derive their numbers instead of keeping whatever
   * they last rendered.
   *
   * Bumped by `resetContextChip` (dialogs.ts), by `/clear`, and on BOTH
   * /resume completion branches — with a `contextSnapshot` (reducers/composer.ts)
   * and without one. The no-snapshot branch still bumps so the chip stops
   * showing the previous session's tokens rather than sitting on a value that
   * described a conversation the user already left.
   */
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
    recentTools: Array<{
      name: string;
      ok?: boolean | undefined;
      durationMs?: number | undefined;
      at: number;
    }>;
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
   * How much subagent activity is streamed into the main history with an
   * `AGENT#N` prefix. `full` = every tool call and interim message;
   * `compact` = spawn / one summary per agent turn / completion;
   * `off` = nothing but failures. Toggled with `/agents chat` and
   * `/fleet stream on|off`. The live fleet surfaces (F2/F3) stay
   * fully live in every mode.
   */
  fleetChat: FleetChatVerbosity;
  /** When true, the full graphical fleet monitor overlay is shown (Ctrl+F). */
  monitorOpen: boolean;
  /** When true, the agents monitor overlay is shown (Ctrl+G). */
  agentsMonitorOpen: boolean;
  /** When true, the keys-&-commands help overlay is shown (`?` on an empty prompt). */
  helpOpen: boolean;
  /** When true, the todos monitor overlay is shown (F6). */
  todosMonitorOpen: boolean;
  /** When true, the process list overlay is shown (F8). */
  processListOpen: boolean;
  /** When true, the cron jobs monitor is shown. */
  cronMonitorOpen: boolean;
  /** When true, keyboard focus is on the right sidebar (↑↓ scrolls sidebar content). */
  sidebarFocused: boolean;
  /** Vertical scroll offset for the sidebar content (in rows). */
  sidebarScrollOffset: number;
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
  /** Live iteration-stage of the active autonomy engine. */
  eternalStage: AutonomyStage | null;
  /** Loaded from .wrongstack/goal.json on mount for startup banner. */
  goalSummary: GoalSummary;
  /** Goal orchestrator state — rendered by PhaseMonitor. */
  goalRun: {
    /** Goal graph title. */
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
        activeTasks?:
          | Array<{ taskId: string; title: string; agent?: string | undefined }>
          | undefined;
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
   * Normalised `worktree.*` lifecycle log (bounded) the monitor projects into
   * its timeline. Unlike `worktrees` it is not pruned on release.
   */
  worktreeTimeline: WorktreeTimelineEvent[];
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
   *   viewportRows    — last computed viewport height (rows); drives mouse
   *                     hit-testing and the ScrollableHistory clip box.
   *   historyScrolled — true while the managed viewport is scrolled away from
   *                     the newest output (reported by ScrollableHistory).
   * The scroll POSITION itself lives inside ScrollableHistory as an anchor
   * (entry id + clipped rows); the app drives it through the imperative
   * HistoryScrollController instead of reducer actions.
   */
  viewportRows: number;
  historyScrolled: boolean;
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
