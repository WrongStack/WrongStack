import type { AutonomyStage, TokenCounter, TokenSavingTier } from '@wrongstack/core/types';
import type { EventBus } from '@wrongstack/core/kernel';
import type { GitInfo } from '../git-info.js';
import type { HeapSample } from '../heap-watchdog.js';
import type { AnimationStyle } from './animation-style.js';
import type { StatuslineMode } from './settings-picker.js';
import type { ChipMeta, StatuslineItem } from './statusline-picker.js';
import type { MemoryContextMonitorState } from '../memory-context-monitor.js';
export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

export interface PlanCounts {
  open: number;
  inProgress: number;
  done: number;
  /** Active storage scope. Shown as a suffix in the plan chip. */
  scope?: 'session' | 'project';
}

export interface TaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  failed: number;
  /** Active storage scope. Shown as a suffix in the task chip. */
  scope?: 'session' | 'project';
}

/**
 * Fleet activity breakdown surfaced on the work-in-flight line. Derived
 * from `director.status()` in the host app and refreshed alongside the
 * other dynamic chips. Kept optional (and the chip is only rendered
 * when any field is non-zero) so single-agent sessions stay quiet.
 */
export interface FleetCounts {
  /** Subagents currently mid-task. */
  running: number;
  /** Subagents spawned but idle (no current task). */
  idle: number;
  /** Tasks queued but not yet picked up by a worker. */
  pending: number;
  /** Tasks resolved (success/failure/timeout/stopped). */
  completed: number;
}

/**
 * Per-agent detail surfaced on the optional 4th line — one chip per
 * currently-running subagent so the user can see at a glance which
 * agent is doing what, for how long, and how many tools it has called.
 * Truncated to the top N by the host (typically 3-4) to keep the bar
 * from wrapping.
 */
export interface FleetAgentDetail {
  /** Stable label used by the streaming history (e.g. "AGENT#1 bug-hunter"). */
  label: string;
  /** Ink color name — same palette as the per-agent history prefix. */
  color: string;
  /** Ms since the subagent's first iteration. */
  elapsedMs: number;
  /** Tool calls observed via tool.executed. */
  toolCalls: number;
  /** True when the subagent is actively iterating. */
  running: boolean;
  /** Current/last tool the subagent invoked, shown as its live action. */
  tool?: string | undefined;
  /** Cumulative budget auto-extensions granted — rendered as "⚡×N". */
  extensions?: number | undefined;
}

export interface BrainStatusChip {
  state: 'idle' | 'deciding' | 'answered' | 'ask_human' | 'denied';
  source?: string | undefined;
  risk?: 'low' | 'medium' | 'high' | 'critical' | undefined;
  summary?: string | undefined;
}

export interface ContextWindow {
  /** Input tokens of the most recent provider request — the de-facto live context size. */
  used: number;
  /** Provider's declared maxContext capability. */
  max: number;
}

export interface MailboxStatus {
  /** Number of unread messages for this agent. */
  unread: number;
  /** Number of online agents in the project. */
  onlineAgents: number;
  /** Per-source count of online clients. */
  onlineClients: { tui: number; webui: number; repl: number };
  /** Latest received message subject (if any). Null = no messages yet. */
  lastSubject?: string | null | undefined;
  /** Latest received message sender (if any). */
  lastFrom?: string | null | undefined;
}

export interface StatusBarProps {
  model: string;
  /**
   * Provider identifier shown alongside `model` as `provider/model` in the
   * status line. When omitted, only `model` is displayed (backward compat
   * for callers that pass a combined string).
   */
  provider?: string | undefined;
  /**
   * App version string (e.g. "0.7.0"). Previously rendered a `WS v{version}`
   * chip at the head of line 1. Now shown in the composer top rail instead
   * (`WRONGSTACK v{version}`). Kept in the interface for callers that may
   * use `version` in derived props — no longer rendered by StatusBar itself.
   */
  version?: string | undefined;
  state: 'idle' | 'running' | 'streaming' | 'aborting';
  /** Single word rendered in the rainbow working-state chip. */
  thinkingWord?: string | undefined;
  /**
   * Animation style for the working/thinking chip. Defaults to `'rainbow'`
   * when omitted so legacy callers stay visually consistent. The special
   * `'cycle'` value rotates through the variant styles every
   * `CYCLE_INTERVAL_SECONDS`. Live-mirrored from the configStore so
   * `/settings → Animation` updates the chip in the active chat.
   */
  thinkingAnimationStyle?: AnimationStyle | 'cycle' | undefined;
  tokenCounter?: TokenCounter | undefined;
  hint?: string | undefined;
  queueCount?: number | undefined;
  yolo?: boolean | undefined;
  /**
   * Session start timestamp (ms). Used by StatuslineDetailPanel for its
   * elapsed-time display. StatusBar itself no longer renders this chip
   * (working time and fleet time are tracked separately).
   */
  startedAt?: number | undefined;
  /**
   * Fleet working time in ms — the total time background subagents have been
   * active. Only ticks up while fleet.running > 0. Rendered as a chip on the
   * status bar so the user can see how long background work has been running.
   */
  fleetWorkingTime?: number | undefined;
  todos?: TodoCounts | undefined;
  /**
   * Plan board counts surfaced as a chip on line 2. Distinct from
   * `todos` — plans are higher-level and persist across resume; the
   * chip uses a different glyph (📋) so the user can tell them apart
   * at a glance.
   */
  plan?: PlanCounts | undefined;
  /**
   * Task board counts surfaced as a chip on line 3. Shows structured
   * work items (from the `task` tool) with type/priority/deps.
   * Distinct from `plan` (strategic) and `todos` (tactical).
   */
  tasks?: TaskCounts | undefined;
  /**
   * Per-status fleet breakdown. When provided, takes precedence over
   * `subagentCount` for chip rendering. `subagentCount` is kept for
   * backwards compatibility when callers haven't wired the richer
   * breakdown yet.
   */
  fleet?: FleetCounts | undefined;
  /**
   * Optional per-agent detail row (up to ~4 agents). Renders below the
   * aggregate fleet chip on a dedicated 4th line so the user can see
   * which specific agent is burning time/tools right now without
   * scrolling history.
   */
  fleetAgents?: FleetAgentDetail[] | undefined;
  git?: GitInfo | null | undefined;
  subagentCount?: number | undefined;
  /** Renders the "ctx ████░░ 42%" chip on line 1 when present. */
  context?: ContextWindow | undefined;
  /**
   * Local estimate of the assembled request size, used as the last-resort
   * fallback for the "↑" sent-token counter when the provider reports no
   * prompt usage. Passed straight to {@link tokenDisplayTotals}.
   */
  estimatedContextTokens?: number | undefined;
  /** All SAGE records plus the exact count present in the latest provider request. */
  Sage?: { total: number; activeInContext: number } | undefined;
  /** Memory context monitor state — renders a compact 4th line with matched/injected/filtered/ctx counts (gated by `memory_context` chip key). */
  memoryContextMonitor?: MemoryContextMonitorState | undefined;
  /**
   * Context compaction strategy. When provided alongside `context`, renders
   * the strategy label (e.g. "hybrid", "intelligent", "selective") next to
   * the context chip on line 1.
   */
  contextStrategy?: 'hybrid' | 'intelligent' | 'selective' | undefined;
  /** Live Brain arbiter state, shown as a compact work chip when active/recent. */
  brain?: BrainStatusChip | undefined;
  /**
   * Project / working-folder name. Rendered on line 2 just before the git
   * branch so users running multiple WrongStack windows can tell at a
   * glance which repo each one is pinned to. Usually the basename of
   * `agent.ctx.projectRoot`.
   */
  projectName?: string | undefined;
  /**
   * Working directory relative to the project root. Rendered on line 2
   * as a 📂 chip so the user knows which subdirectory tools will resolve
   * against. Updated live via `ctx.onWorkingDirChanged()`.
   */
  workingDir?: string | undefined;
  /** Autonomy mode chip: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel'. */
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
  /** Number of tracked bash/exec processes from the process registry. */
  processCount?: number | undefined;
  /** Current RSS/heap sample for this CLI process. */
  processMemory?: HeapSample | undefined;
  /** CPU usage percentage (0-100). Derived from process.cpuUsage delta. */
  cpuPercent?: number | undefined;
  /** Items to hide from the status bar. Canonical set: {@link StatuslineItem}. */
  hiddenItems?: StatuslineItem[] | undefined;
  /** Statusline density. Detailed is the default to preserve the full multi-line display. */
  mode?: StatuslineMode | undefined;
  /** EventBus for subscribing to token.accounted events for real-time cost/token updates. */
  events?: EventBus | undefined;
  /** Active session id used to ignore token events from other same-process sessions. */
  sessionId?: string | undefined;
  /**
   * Live iteration stage from the active autonomy engine. When set, renders
   * a chip like `⏸ decide` or `▶ execute(todo:fix-auth)` next to the
   * autonomy chip on line 2.
   */
  eternalStage?: AutonomyStage | null | undefined;
  /** Active goal summary for startup banner display. */
  goalSummary?: {
    goal: string;
    goalState: 'active' | 'paused' | 'completed' | 'abandoned';
    iterations: number;
    lastTask?: string | undefined;
    lastStatus?: string | undefined;
  } | null;
  /**
   * Seconds remaining in the auto-proceed countdown. null = not counting.
   * Rendered as a chip on line 2 when non-null.
   */
  autoProceedCountdown?: number | null | undefined;
  /** Codebase indexing state — rendered as a chip on line 1 when indexing. */
  indexState?: {
    ready: boolean;
    indexing: boolean;
    currentFile: number;
    totalFiles: number;
    /** Circuit-breaker snapshot — 'open' means indexing is paused after repeated failures. */
    circuit?: { state: 'closed' | 'open' | 'half-open'; cooldownRemainingMs: number };
  };
  /**
   * Live countdown to the process circuit breaker's automatic kill/reset.
   * Rendered as an urgent chip on line 1 ("⚡ kill/reset in Ns") while armed;
   * null/undefined hides it. The host ticks this every second.
   */
  breakerCountdown?: { remainingMs: number; totalMs: number } | null | undefined;
  /** Active agent mode label with icon (e.g. "🧑‍🏫 teach", "⚡ brief"). Rendered on line 2. */
  modeLabel?: string | undefined;
  /**
   * Live debug-stream telemetry — pushed into the TUI reducer by the
   * throttled callback from stream-debug-state.ts. When non-null, renders
   * a "🐛 stream" chip on line 3 with chunk count, size, delta, and total
   * bytes. Cleared on provider.response (per-iteration stream reset).
   */
  debugStreamStats?:
    | {
        chunkCount: number;
        lastChunkSize: number;
        lastDeltaMs: number;
        totalBytes: number;
        lastChunkAt: string;
      }
    | null
    | undefined;
  /**
   * Seconds remaining in the prompt-refinement auto-send countdown.
   * When non-null, replaces the old in-panel timer display with a
   * line-3 chip like `◴ refinement ready · send in 5s` so the countdown never
   * causes blank entries in the chat scrollback.
   */
  enhanceCountdown?: number | null | undefined;
  /**
   * Seconds remaining in the next-steps auto-submit countdown.
   * When non-null, renders a line-3 chip like `⏳ next step in 3s`
   * that auto-submits the suggested next step when the countdown reaches 0.
   */
  nextStepsAutoSubmitCountdown?: number | null | undefined;
  /**
   * Label of the step that will be auto-submitted (the suggestion text).
   * When provided alongside countdown, renders as `⏳ step text in 3s`.
   */
  nextStepsAutoSubmitLabel?: string | null | undefined;
  /** Number of live sessions across processes (from SessionRegistry). */
  sessionCount?: number | undefined;
  /** Mailbox activity — unread count, online agents, latest message. */
  mailbox?: MailboxStatus | undefined;
  /**
   * Token-saving tier. When set and not `'off'`, renders a `💾 <tier>` chip
   * on line 2 to remind the user that non-essential tools are omitted and
   * system prompt sections are trimmed at that compactness level.
   */
  tokenSavingMode?: TokenSavingTier | undefined;
  /**
   * Number of registered tools. Rendered as a chip on line 2 so the user
   * can see how many tools are available (lower count in token-saving mode).
   */
  toolCount?: number | undefined;
  /** Visible stream chips (brain, mailbox, enhance, debug_stream) for expiration tracking. */
  visibleChips?: ChipMeta[] | undefined;
  /**
   * Number of structured side effects (bash/install/fetch) recorded in the
   * current session. Rendered as a compact "⚠ N" chip on line 2 when > 0.
   * Clicking opens /audit (TUI) — in the REPL it's informational.
   */
  sideEffectCount?: number | undefined;
}
