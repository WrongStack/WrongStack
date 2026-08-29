import type { EventBus } from '@wrongstack/core/kernel';
import type { AutonomyStage, TokenCounter, TokenSavingTier } from '@wrongstack/core/types';
import type { GitInfo } from '../git-info.js';
import type { MemoryContextMonitorState } from '../memory-context-monitor.js';
import type { StatuslineLines } from '@wrongstack/core/statusline';
import type { AnimationStyle } from './animation-style.js';
import type { StatuslineMode } from './settings-picker.js';
import type { ChipMeta, StatuslineItem } from './statusline-picker.js';
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
  /** Cumulative budget auto-extensions granted — rendered as `"glyphs.process ×N"`. */
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
   * App version string (e.g. "0.7.0"). Rendered as a right-anchored version
   * chip on the status bar (line 1, and the minimum-mode rail) so it stays
   * visible after the startup banner scrolls off — in addition to the
   * composer top rail (`WRONGSTACK v{version}`). When omitted, the chip is
   * hidden — keeps tests / legacy callers quiet.
   */
  version?: string | undefined;
  /**
   * Latest version published to the npm registry, when known. When paired
   * with {@link updateAvailable} (and not equal to {@link version}), the
   * version chip on the right edge of the status bar gains an orange
   * "(update v…)" suffix so the operator notices the upgrade without
   * scrolling back through history to find the startup banner. Sourced from
   * the CLI's preflight update-check.
   */
  latestVersion?: string | undefined;
  /**
   * True when the preflight update-check found a newer published version
   * than {@link version}. Both must be present (and non-equal) to render the
   * orange update notice on the status bar.
   */
  updateAvailable?: boolean | undefined;
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
   * chip uses a different glyph (`glyphs.plan`) so the user can tell them apart
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
   * as a `glyphs.folder` chip so the user knows which subdirectory tools will resolve
   * against. Updated live via `ctx.onWorkingDirChanged()`.
   */
  workingDir?: string | undefined;
  /**
   * Active color theme preset name (e.g. "catppuccin", "dracula", "tokyo-night").
   * Rendered as a `glyphs.palette` chip on line 2 so the user can see their active theme.
   */
  themeName?: string | undefined;
  /** Autonomy mode chip: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel'. */
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
  /**
   * Number of tools dropped from the provider request due to the maxTools
   * limit. When > 0, renders a warning chip on line 2 (e.g. "⊘ 5 tools")
   * so the user knows some tools are unavailable to the model this session.
   */
  droppedTools?: number | undefined;
  /** Number of tracked bash/exec processes from the process registry. Currently unused on the rail. */
  processCount?: number | undefined;
  /** Items to hide from the status bar. Canonical set: {@link StatuslineItem}. */
  hiddenItems?: StatuslineItem[] | undefined;
  /**
   * Per-chip line assignment (statusline.json schema v2). Absent keys render
   * on the core contract's DEFAULT_LINES; values outside 1–4 are clamped by
   * the persistence layer and again by the registry partition.
   */
  statuslineLines?: StatuslineLines | undefined;
  /**
   * Statusline density. The prop default 'detailed' is kept for back-compat
   * with tests/callers that omit `mode`; the user-facing default is 'minimum'
   * (DEFAULT_STATUSLINE_MODE), applied at the settings layer.
   */
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
  /** Codebase indexing and detached project-server state, rendered on the final service-detail line. */
  indexState?: {
    ready: boolean;
    indexing: boolean;
    currentFile: number;
    totalFiles: number;
    lastError?: string | null | undefined;
    server?: {
      status:
        | 'unavailable'
        | 'offline'
        | 'connecting'
        | 'connected'
        | 'degraded'
        | 'unresponsive'
        | 'error'
        | 'stopping';
      connected: boolean;
      pid?: number | undefined;
      lastError?: string | undefined;
      health?:
        | {
            status: 'healthy' | 'degraded' | 'unresponsive';
            checkedAt: number;
            lastHealthyAt: number | null;
            latencyMs: number | null;
            missedHeartbeats: number;
            server?:
              | {
                  uptimeMs: number;
                  memory: {
                    rss: number;
                    heapUsed: number;
                    heapTotal: number;
                    external: number;
                  };
                  clients: number;
                  activeRequests: number;
                  activeWrites: number;
                  queuedWrites: number;
                  pendingExternalFiles: number;
                  watchingExternal: boolean;
                  watchingClients?: number | undefined;
                  clientLeaseTimeoutMs?: number | undefined;
                  oldestClientIdleMs?: number | undefined;
                }
              | undefined;
          }
        | undefined;
    };
    /** Circuit-breaker snapshot — 'open' means indexing is paused after repeated failures. */
    circuit?: { state: 'closed' | 'open' | 'half-open'; cooldownRemainingMs: number };
  };
  /**
   * Live countdown to the process circuit breaker's automatic kill/reset.
   * Rendered as an urgent chip on line 1 (`glyphs.warning kill/reset in Ns`) while armed;
   * null/undefined hides it. The host ticks this every second.
   */
  breakerCountdown?: { remainingMs: number; totalMs: number } | null | undefined;
  /** Active agent mode label with icon (e.g. `glyphs.brand teach`, `glyphs.running brief`). Rendered on line 2. */
  modeLabel?: string | undefined;
  /**
   * Active system-prompt variant — rendered as a `⌘ PRO|STANDARD|LITE` chip on
   * line 1 (workspace & identity) so the session's prompt density is visible
   * at a glance. Sourced from `config.systemPrompt.variant`.
   */
  promptVariant?: 'lite' | 'default' | 'pro' | undefined;
  /**
   * Live debug-stream telemetry — pushed into the TUI reducer by the
   * throttled callback from stream-debug-state.ts. When non-null, renders
   * a `glyphs.bug stream` chip on line 3 with chunk count, size, delta, and total
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
   * When non-null, renders a line-3 chip like `glyphs.auto next step in 3s`
   * that auto-submits the suggested next step when the countdown reaches 0.
   */
  nextStepsAutoSubmitCountdown?: number | null | undefined;
  /**
   * Label of the step that will be auto-submitted (the suggestion text).
   * When provided alongside countdown, renders as `glyphs.auto step text in 3s`.
   */
  nextStepsAutoSubmitLabel?: string | null | undefined;
  /** Number of live sessions across processes (from SessionRegistry). */
  sessionCount?: number | undefined;
  /** Mailbox activity — unread count, online agents, latest message. */
  mailbox?: MailboxStatus | undefined;
  /**
   * Token-saving tier. When set and not `'off'`, renders a `glyphs.save <tier>` chip
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
  /**
   * Optional cap on the column width used for layout adaptation. When set,
   * the status bar treats this as its effective terminal width instead of
   * `stdout.columns` — needed when the bar sits in a column narrower than
   * the full terminal (e.g. beside a sidebar).
   */
  maxWidth?: number | undefined;
  /**
   * When provided, the bar publishes a fresh {@link StatusBarClickMap} on
   * every render: the 0-based content-line index and column spans of each
   * clickable chip, derived from the SAME segment nodes PowerlineRail
   * draws. The app-level mouse handler resolves clicks against this map —
   * it must never dead-reckon chip columns itself.
   */
  clickMapRef?: import('react').MutableRefObject<StatusBarClickMap | null> | undefined;
}

/** Column spans of clickable status-bar chips, per rendered content line. */
export interface StatusBarClickMap {
  lines: Array<{
    /** 0-based content-line index within the status-bar box (line 1 = 0). */
    line: number;
    spans: Array<import('./powerline-rail.js').RailSpan>;
  }>;
}
