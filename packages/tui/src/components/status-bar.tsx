import { expectDefined } from '@wrongstack/core';
import type { EventBus, TokenCounter, AutonomyStage, TokenSavingTier } from '@wrongstack/core';
import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';
import { isValidElement } from 'react';
import type { ChipMeta, StatuslineItem } from './statusline-picker.js';
import type { StatuslineMode } from './settings-picker.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTokenCounterRefresh } from '../hooks/use-token-counter-refresh.js';
import { normalizeTuiThinkingWord } from '../thinking-word.js';
import type { GitInfo } from '../git-info.js';
import {
  type AnimationStyle,
  CYCLE_TICK_INTERVAL_MS,
} from './animation-style.js';
import { PowerlineRail } from './powerline-rail.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import { displayWidth } from '../terminal-width.js';
import { BrainChip, EternalStageChip, ThinkingChip } from './status-bar-chips.js';

// ─── Stream chip expiration helpers ─────────────────────────────────────────

/** Returns true if a chip with the given metadata has expired. */
function chipExpired(meta: ChipMeta, now = Date.now()): boolean {
  if (meta.expiresIn == null) return false;
  return now >= meta.shownAt + meta.expiresIn * 60_000;
}

/**
 * Checks if a stream chip should be visible. A chip is visible when:
 * - Its data is present (not null/undefined)
 * - It is NOT in the hidden set
 * - It IS in visibleChips (registered by the useEffect)
 * - It has NOT expired
 *
 * @param key - The chip key (brain, mailbox, enhance, debug_stream)
 * @param dataIsPresent - The data for this chip (brain state, mailbox, countdown, debug stats)
 * @param hiddenSet - Set of user-hidden chip keys
 * @param visibleChips - Array of visible chip metadata with expiration info
 */
function isStreamChipVisible(
  key: 'brain' | 'mailbox' | 'enhance' | 'debug_stream',
  dataIsPresent: unknown,
  hiddenSet: ReadonlySet<string>,
  visibleChips: ChipMeta[],
): boolean {
  if (!dataIsPresent) return false;
  if (hiddenSet.has(key)) return false;
  const meta = visibleChips.find((c) => c.key === key);
  // Not yet registered — don't flash before the useEffect registers it
  if (!meta) return false;
  if (chipExpired(meta)) return false;
  return true;
}

function hasMailboxActivity(mailbox: MailboxStatus | undefined): boolean {
  if (!mailbox) return false;
  const peerClientCount =
    Math.max(0, mailbox.onlineClients.tui - 1) +
    mailbox.onlineClients.webui +
    mailbox.onlineClients.repl;
  return (
    mailbox.unread > 0 ||
    mailbox.onlineAgents > 1 ||
    peerClientCount > 0 ||
    Boolean(mailbox.lastSubject || mailbox.lastFrom)
  );
}

// ─── Mode icon map ───────────────────────────────────────────────────────────

/** Map mode ids to compact icons for the status bar chip. */
const MODE_ICONS: Record<string, string> = {
  teach: '◇',
  brief: '⚡',
  'code-reviewer': '⌕',
  'bug-hunter': '◇',
  'security-scanner': '⛨',
  'refactor-planner': '✎',
  architect: '▦',
  debugger: '◇',
  test: '⚗',
  document: '☷',
  'skill-creator': '✱',
};

function modeIcon(label?: string): string {
  if (!label) return '';
  const icon = MODE_ICONS[label] ?? '▪';
  return `${icon} ${label}`;
}

/**
 * Format a suggestion label for the status bar countdown chip.
 * Shows a short tag + the first few words rather than blindly truncating.
 * Examples: "fix null deref…" or "add tests for…" or "run typecheck…"
 * Returns empty string when the label has no meaningful content after stripping.
 */
function formatSuggestionLabel(label: string, maxLen = 28): string {
  // Strip /next N prefix like "/next 1" or "/next 1 2" before formatting
  const stripped = label.replace(/^\/next\s+[\d\s]+\s*/, '').trim();
  if (!stripped) return '';
  if (stripped.length <= maxLen) return stripped;
  // Try to break at a word boundary near maxLen
  const shortened = stripped.slice(0, maxLen);
  const lastSpace = shortened.lastIndexOf(' ');
  return lastSpace > 10 ? `${shortened.slice(0, lastSpace)}…` : `${shortened}…`;
}

/**
 * Shared green → yellow → red color ramp for countdown chips. `warn`/`danger`
 * are the (exclusive) thresholds at/below which the color steps down.
 */
function countdownColor(secs: number, warn: number, danger: number): string {
  if (secs > warn) return theme.success;
  if (secs > danger) return theme.warn;
  return theme.error;
}

/**
 * Head-truncate a chip's free-text payload (branch, path, project name) with a
 * trailing ellipsis so one long value can't blow out the line width. Mirrors
 * the inline pattern the goal/mailbox chips already use.
 */
export function truncateChip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Recover the visible plain text of a rendered chip by walking its React
 * element tree (string/number leaves only). Used purely to estimate display
 * width for overflow budgeting — deriving width from the SAME node we render
 * means there's no parallel text to drift out of sync.
 */
export function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * Approximate column cost of the ` │ ` separator block between two chips: the
 * glyph plus the `gap={2}` on each side. Conservative (over-estimating drops a
 * touch earlier, which is the safe direction for avoiding a wrapped line).
 */
const SB_SEP_COST = 5;

/**
 * Decide how many leading chips fit within `budget` columns. Trailing (lowest
 * priority) chips are dropped first, which keeps the high-value leading chips
 * — and the columns the mouse hit-test spans assume — stable. The first chip is
 * always kept even if it alone exceeds the budget (better one clipped chip than
 * an empty line). Pure + exported for testing.
 */
export function planChipFit(widths: number[], budget: number, sepCost = SB_SEP_COST): number {
  let used = 0;
  let keep = 0;
  for (const w of widths) {
    const cost = w + (keep > 0 ? sepCost : 0);
    if (keep > 0 && used + cost > budget) break;
    used += cost;
    keep += 1;
  }
  return keep;
}

/**
 * Render a status-bar chip line: separator-join the chips that fit within
 * `budget`, and append a dim `+N` marker when lower-priority chips were dropped
 * so the line never wraps (a wrapped status bar shifts Ink's layout and strands
 * the input row in scrollback).
 */
/** Minimum terminal width before we switch to ultra-compact mode. Exported so
 *  the TUI mouse hit-test can skip the model-chip click in compact mode (where
 *  line 1 uses a different layout than `statusBarModelSpan` assumes). */
export const COMPACT_THRESHOLD = 50;
/** Above this width, show most available information. */
const COMFORTABLE_THRESHOLD = 90;

/**
 * Return the color value in normal mode, or `undefined` in no-color mode so
 * Ink omits the color prop entirely. Centralises the `isNoColor ? undefined : color`
 * pattern that was repeated ~50× across this file.
 */
function chipColor(color: string, isNoColor: boolean): string | undefined {
  return isNoColor ? undefined : color;
}

/**
 * Per-line background tones for the 3 status bar lines + 1 spare.
 * Progressively darker from line 1 (top, lightest) to line 4 (bottom,
 * darkest) for a subtle layered/sunken effect.
 */
const LINE_BG_COLORS = [theme.surface, theme.surface, theme.surface, theme.surface] as const;

// Animated braille spinner shown when the agent is thinking/streaming.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 250;

export interface TokenDisplayTotals {
  input: number;
  output: number;
}

export function tokenDisplayTotals(
  usage:
    | {
        input: number;
        output: number;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
      }
    | undefined,
  currentRequest: { input: number; cacheRead: number; cacheWrite?: number | undefined } | undefined,
): TokenDisplayTotals {
  const usageInput = usage ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
  const usageOutput = usage?.output ?? 0;
  const fallbackInput = currentRequest
    ? currentRequest.input + currentRequest.cacheRead + (currentRequest.cacheWrite ?? 0)
    : 0;
  return {
    input: usageInput > 0 ? usageInput : fallbackInput,
    output: usageOutput,
  };
}

export function hasTokenDisplay(tokens: TokenDisplayTotals): boolean {
  return tokens.input > 0 || tokens.output > 0;
}

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
  /** Session start timestamp (ms). Elapsed time is computed internally on
   *  the same interval as the spinner so the display stays live without
   *  forcing a full App tree re-render every second. */
  startedAt?: number | undefined;
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

/**
 * Two-line status bar. The first line stays compact and shows the
 * runtime essentials (state · model · tokens · cost · queue · running
 * tool). The second line opts in only when there's actually something
 * to show — git branch, elapsed time, todo counts, YOLO marker — so a
 * vanilla session keeps the original single-line footprint.
 */
export function StatusBar({
  model,
  state,
  thinkingWord,
  thinkingAnimationStyle,
  tokenCounter,
  hint,
  queueCount = 0,
  yolo = false,
  autonomy,
  startedAt,
  todos,
  plan,
  tasks,
  fleet,
  fleetAgents,
  git,
  subagentCount = 0,
  brain,
  projectName,
  workingDir,
  processCount,
  context,
  contextStrategy,
  hiddenItems,
  mode = 'detailed',
  events,
  sessionId,
  eternalStage,
  goalSummary,
  indexState,
  breakerCountdown,
  modeLabel,
  debugStreamStats,
  enhanceCountdown,
  nextStepsAutoSubmitCountdown,
  nextStepsAutoSubmitLabel,
  autoProceedCountdown,
  sessionCount,
  mailbox,
  tokenSavingMode,
  toolCount,
  visibleChips = [],
  sideEffectCount = 0,
}: StatusBarProps): React.ReactElement {
  // Track terminal width so we can adapt layout on narrow terminals.
  // We snapshot into state so that renders are stable — we don't want
  // the live-region to churn on every resize event during active streaming.
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState(stdout?.columns ?? 90);
  useEffect(() => {
    const handleResize = () => setTermWidth(stdout?.columns ?? 90);
    handleResize(); // snapshot immediately
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);

  const isCompact = termWidth < COMPACT_THRESHOLD;
  const isComfortable = termWidth >= COMFORTABLE_THRESHOLD;
  const isNoColor = mode === 'no-color';
  const hiddenSet = useMemo(() => new Set(hiddenItems), [hiddenItems]);
  const showChip = (item: StatuslineItem): boolean => !hiddenSet.has(item);
  // Use the refresh hook so token/cost updates appear immediately when
  // the provider responds, instead of waiting for the next nowTick poll.
  const tokenData = useTokenCounterRefresh(tokenCounter, events, sessionId);
  const usage = tokenData?.usage;
  const displayTokens = tokenDisplayTotals(usage, tokenData?.currentRequest);
  const showTokenDisplay = hasTokenDisplay(displayTokens);
  const cost = tokenData?.cost;
  const cache = tokenData?.cacheStats;

  // Elapsed time display — updated locally on a 1s interval so the "⏱ 12:34"
  // chip stays live without forcing a full App tree re-render. When the chip
  // is hidden the interval is skipped entirely: otherwise the whole status-bar
  // subtree re-rendered every second for a value nobody could see — pure churn
  // that adds up over long autonomous sessions.
  const elapsedHidden = hiddenSet.has('elapsed');
  const [elapsedMs, setElapsedMs] = useState(startedAt ? Date.now() - startedAt : 0);
  useEffect(() => {
    if (startedAt == null || elapsedHidden) return;
    setElapsedMs(Date.now() - startedAt); // snapshot immediately on (re)enable
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [startedAt, elapsedHidden]);

  // Animated braille spinner — cycles while the agent is thinking/streaming.
  // Stops when idle so the interval doesn't drive unnecessary re-renders.
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  useEffect(() => {
    if (state === 'idle' || state === 'aborting') return;
    const t = setInterval(
      () => setSpinnerIdx((n) => (n + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(t);
  }, [state]);
  const spinner = expectDefined(SPINNER_FRAMES[spinnerIdx]);

  // ── Todos auto-clear ─────────────────────────────────────────────────────
  // When all todos are completed (no pending/in-progress), the todos chip
  // auto-hides after TODOS_CLEAR_DELAY_MS so the status bar doesn't linger on
  // stale info. New active todos before the timer fires cancel and reset.
  const TODOS_CLEAR_DELAY_MS = 3000;
  const [todosCleared, setTodosCleared] = useState(false);
  const todosClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const hasActive = todos && (todos.pending > 0 || todos.inProgress > 0);

    if (hasActive) {
      // Cancel any pending clear — active todos means show the chip
      if (todosClearTimerRef.current) {
        clearTimeout(todosClearTimerRef.current);
        todosClearTimerRef.current = null;
      }
      setTodosCleared(false);
      return;
    }

    // All completed but no active items — start auto-clear countdown
    if (todos && todos.completed > 0) {
      if (!todosClearTimerRef.current) {
        todosClearTimerRef.current = setTimeout(() => {
          setTodosCleared(true);
          todosClearTimerRef.current = null;
        }, TODOS_CLEAR_DELAY_MS);
      }
      return () => {
        if (todosClearTimerRef.current) {
          clearTimeout(todosClearTimerRef.current);
          todosClearTimerRef.current = null;
        }
      };
    }

    // No todos at all — nothing to clear
    setTodosCleared(true);
    return;
  }, [todos]);

  // Animation style for the working/thinking chip. Defaults to `rainbow`
  // when omitted (legacy callers) so the chip still works. Special value
  // `'cycle'` rotates through wave → pulse → dots → breathe every
  // `CYCLE_INTERVAL_SECONDS`; that interval is ticked locally on a 1Hz
  // timer and only re-renders when the user picked cycle mode AND the
  // agent is actively working.
  const animationStyle: AnimationStyle | 'cycle' = thinkingAnimationStyle ?? 'rainbow';
  const [cycleTick, setCycleTick] = useState(0);
  useEffect(() => {
    if (animationStyle !== 'cycle') return;
    if (state === 'idle' || state === 'aborting') return;
    const t = setInterval(() => setCycleTick((n) => n + 1), CYCLE_TICK_INTERVAL_MS);
    return () => clearInterval(t);
  }, [animationStyle, state]);

  const { label: stateLabel, color: stateColor } = stateChip(
    state,
    fleet?.running ?? 0,
    thinkingWord,
  );
  // Animated spinner for thinking/streaming; static ● for idle/aborting.
  const statePrefix = state === 'idle' || state === 'aborting' ? '●' : spinner;
  // When the agent is actively working, paint the state chip as a moving
  // rainbow wave (each glyph cycles through the hue wheel, offset per char and
  // shifted by the spinner tick). Idle/aborting stay flat-colored.
  const thinking = state === 'running' || state === 'streaming';

  // Line 2 is *session context* — slow-moving facts about where you
  // are: the project, the branch, the elapsed clock, YOLO chip. These
  // change at most once per session.
  const hasAutoProceed = autoProceedCountdown != null && autoProceedCountdown > 0;

  // Line 3 is *active work* — the dynamic chips that mutate as the
  // agent / subagents make progress. Hidden when nothing is in flight
  // so a fresh session keeps the two-line baseline.
  const fleetHasActivity =
    (fleet && (fleet.running > 0 || fleet.idle > 0 || fleet.pending > 0 || fleet.completed > 0)) ||
    subagentCount > 0;
  // Stream chip visibility — these gate both the chip render AND the separator before it.
  // Unlike the raw hasBrainActivity flags, these respect the hidden set and expiration.
  const showBrain = isStreamChipVisible('brain', brain, hiddenSet, visibleChips);
  const showDebugStream = isStreamChipVisible(
    'debug_stream',
    debugStreamStats,
    hiddenSet,
    visibleChips,
  );
  const showEnhance = isStreamChipVisible('enhance', enhanceCountdown, hiddenSet, visibleChips);
  const showMailbox = showChip('mailbox') && hasMailboxActivity(mailbox);
  const hasNextStepsAutoSubmit =
    nextStepsAutoSubmitCountdown != null && nextStepsAutoSubmitCountdown > 0;

  // Next-steps auto-submit countdown color: green → yellow → red as the timer
  // drops (thresholds 20s / 10s), via the shared countdownColor ramp.
  const nextStepsColor =
    nextStepsAutoSubmitCountdown != null
      ? countdownColor(nextStepsAutoSubmitCountdown, 20, 10)
      : theme.success;

  const hasTaskActivity =
    tasks &&
    (tasks.pending > 0 ||
      tasks.inProgress > 0 ||
      tasks.completed > 0 ||
      tasks.blocked > 0 ||
      tasks.failed > 0);
  const minimalWorkParts = [
    queueCount > 0 && showChip('queue') ? `q${queueCount}` : '',
    todos && showChip('todos') && todos.inProgress + todos.pending > 0
      ? `todo ${todos.inProgress}/${todos.pending}`
      : '',
    hasTaskActivity && showChip('tasks') ? `task ${tasks!.inProgress}/${tasks!.pending}` : '',
    fleetHasActivity && showChip('fleet')
      ? fleet
        ? `agent ▶${fleet.running} ·${fleet.idle}`
        : `agent ${subagentCount}`
      : '',
    typeof processCount === 'number' && processCount > 0 && showChip('processes')
      ? `proc ${processCount}`
      : '',
  ].filter(Boolean);

  const primaryChips: React.ReactElement[] = [
    showChip('state') && thinking ? (
      <ThinkingChip
        text={`${statePrefix} ${stateLabel}`}
        style={animationStyle}
        phase={spinnerIdx}
        cycleTick={cycleTick}
      />
    ) : showChip('state') ? (
      <Text color={isNoColor ? undefined : stateColor}>
        {statePrefix} {stateLabel}
      </Text>
    ) : null,
    showChip('model') ? (
      <Text color={isNoColor ? undefined : theme.monitor.agents}>
        {showChip('state') ? ` ${model}` : model}
      </Text>
    ) : null,
    // Combined context bar: meter · tokens · cost
    (context || showTokenDisplay || (cost?.total ?? 0) > 0) &&
    (showChip('context') || showChip('tokens') || showChip('cost'))
      ? (() => {
          const ratio = context ? Math.min(context.used / context.max, 1) : 0;
          const pctText = context ? `${Math.min(Math.round(ratio * 100), 100)}%` : '';
          const barColor = isNoColor ? undefined : ratio < 0.6 ? theme.success : ratio < 0.75 ? theme.warn : theme.error;
          const hasTokens = showTokenDisplay && showChip('tokens');
          const hasCost = cost && cost.total > 0 && showChip('cost');
          const segments: string[] = [];
          if (context) segments.push('meter');
          if (hasTokens) segments.push('tokens');
          if (hasCost) segments.push('cost');
          const sep = segments.length > 1;
          return (
            <Text>
              {context ? (
                <Text color={barColor}>
                  {renderMeter(ratio, 8)} {pctText}/{fmtTok(context.max)}
                  {contextStrategy ? (
                    <Text dimColor={!isNoColor}>{` [${contextStrategy}]`}</Text>
                  ) : null}
                </Text>
              ) : null}
              {sep && context ? <Text dimColor={!isNoColor}>{' · '}</Text> : null}
              {hasTokens ? (
                <Text>
                  <Text
                    color={isNoColor ? undefined : theme.textSecondary}
                  >{'↑'}</Text>
                  <Text color={isNoColor ? undefined : theme.accent}>{fmtTok(displayTokens.input)}</Text>
                  <Text
                    color={isNoColor ? undefined : theme.textSecondary}
                  >{' ↓'}</Text>
                  <Text color={isNoColor ? undefined : theme.accent}>{fmtTok(displayTokens.output)}</Text>
                </Text>
              ) : null}
              {sep && hasCost && (context || hasTokens) ? <Text dimColor={!isNoColor}>{' · '}</Text> : null}
              {hasCost ? (
                <Text color={isNoColor ? undefined : theme.warn}>
                  {glyphs.cost}{cost.total.toFixed(4)}
                </Text>
              ) : null}
            </Text>
          );
        })()
      : null,
    cache && cache.hitRatio > 0 && isComfortable && showChip('cache') ? (
      <Text dimColor={!isNoColor}>cache {(cache.hitRatio * 100).toFixed(0)}%</Text>
    ) : null,
    queueCount > 0 && showChip('queue') ? (
      <Text color={isNoColor ? undefined : theme.accent}>
        {glyphs.queue} queued {queueCount}
      </Text>
    ) : null,
    typeof processCount === 'number' && processCount > 0 && showChip('processes') ? (
      <Text color={isNoColor ? undefined : theme.error}>
        {glyphs.process} {processCount} process{processCount === 1 ? '' : 'es'}
      </Text>
    ) : null,
    hint && showChip('hint') ? <Text dimColor={!isNoColor}>{hint}</Text> : null,
    indexState?.indexing && showChip('index') ? (
      <Text color={isNoColor ? undefined : theme.warn}>
        {glyphs.index} indexing {indexState.currentFile}/{indexState.totalFiles}
      </Text>
    ) : indexState?.circuit?.state === 'open' && showChip('index') ? (
      <Text color={isNoColor ? undefined : theme.error}>{glyphs.index} index paused</Text>
    ) : null,
    breakerCountdown && showChip('breaker')
      ? (() => {
          const secs = Math.ceil(breakerCountdown.remainingMs / 1000);
          const c = secs > 20 ? theme.success : secs > 10 ? theme.warn : theme.error;
          return (
            <Text color={isNoColor ? undefined : c} bold>
              {glyphs.warning} kill/reset in {secs}s
            </Text>
          );
        })()
      : null,
  ].filter((chip): chip is React.ReactElement => chip !== null);

  const modeChips = [
    // Line 1 runtime chips: YOLO, autonomy, time, workfolder (user request),
    // then state, model, context, tokens, plus elapsed and working_dir.
    yolo && showChip('yolo') ? (
      <Text color={chipColor(theme.error, isNoColor)} bold>
        {isNoColor ? 'YOLO' : `${glyphs.warning} YOLO`}
      </Text>
    ) : null,
    autonomy && autonomy !== 'off' && showChip('autonomy') ? (
      <Text
        color={chipColor(
          autonomy === 'eternal'
            ? theme.error
            : autonomy === 'auto'
              ? theme.warn
              : theme.accent,
          isNoColor,
        )}
        bold
      >
        {isNoColor ? autonomy.toUpperCase() : `∞ ${autonomy.toUpperCase()}`}
      </Text>
    ) : null,
    projectName && showChip('project') ? (
      <Text color={chipColor(theme.accent, isNoColor)}>
        {isNoColor
          ? truncateChip(projectName, 24)
          : `${glyphs.folder} ${truncateChip(projectName, 24)}`}
      </Text>
    ) : null,
    ...primaryChips,
    elapsedMs !== undefined && showChip('elapsed') ? (
      <Text dimColor={!isNoColor}>
        {isNoColor ? fmtElapsed(elapsedMs) : `${glyphs.clock} ${fmtElapsed(elapsedMs)}`}
      </Text>
    ) : null,
    workingDir && showChip('working_dir') ? (
      <Text color={chipColor(theme.accent, isNoColor)}>
        {isNoColor
          ? truncateChip(workingDir, 28)
          : `${glyphs.workingDirectory} ${truncateChip(workingDir, 28)}`}
      </Text>
    ) : null,
  ].filter((c): c is React.ReactElement => c !== null);

  const minimumChips: React.ReactElement[] = [
    // State with animation
    showChip('state') && thinking ? (
      <ThinkingChip
        text={`${statePrefix} ${stateLabel}`}
        style={animationStyle}
        phase={spinnerIdx}
        cycleTick={cycleTick}
      />
    ) : showChip('state') ? (
      <Text color={chipColor(stateColor, isNoColor)}>
        {statePrefix} {stateLabel}
      </Text>
    ) : null,
    // Model
    showChip('model') ? (
      <Text color={chipColor(theme.monitor.agents, isNoColor)}>{model}</Text>
    ) : null,
    // Context bar (compact: 6 blocks, optional tokens)
    (context || showTokenDisplay) && showChip('context')
      ? (() => {
          const ratio = context ? Math.min(context.used / context.max, 1) : 0;
          const pct = context ? `${Math.min(Math.round(ratio * 100), 100)}%` : '';
          const c = context ? (ratio < 0.6 ? theme.success : ratio < 0.75 ? theme.warn : theme.error) : theme.textSecondary;
          const hasTokens = showTokenDisplay && showChip('tokens');
          return (
            <Text>
              <Text color={chipColor(c, isNoColor)}>
                {context ? renderMeter(ratio, 6) : ''} {pct}
              </Text>
              {hasTokens && context ? <Text dimColor={!isNoColor}>{' · '}</Text> : null}
              {hasTokens ? (
                <Text color={chipColor(theme.textSecondary, isNoColor)}>
                  ↑<Text color={chipColor(theme.accent, isNoColor)}>{fmtTok(displayTokens.input)}</Text>
                  {' '}↓<Text color={chipColor(theme.accent, isNoColor)}>{fmtTok(displayTokens.output)}</Text>
                </Text>
              ) : null}
            </Text>
          );
        })()
      : null,
    // Autonomy mode (if active)
    autonomy && autonomy !== 'off' && showChip('autonomy') ? (
      <Text
        color={chipColor(
          autonomy === 'eternal'
            ? theme.error
            : autonomy === 'auto'
              ? theme.warn
              : theme.accent,
          isNoColor,
        )}
        bold
      >
        {isNoColor ? autonomy.toUpperCase() : `∞ ${autonomy.toUpperCase()}`}
      </Text>
    ) : null,
    // Elapsed time
    elapsedMs !== undefined && showChip('elapsed') ? (
      <Text dimColor={!isNoColor}>{fmtElapsed(elapsedMs)}</Text>
    ) : null,
    // Work summary (compact)
    ...(minimalWorkParts.length > 0
      ? [
          <Text dimColor={!isNoColor}>
            {minimalWorkParts.slice(0, 2).join(' · ')}
          </Text>,
        ]
      : []),
  ].filter((c): c is React.ReactElement => c !== null);

  const fleetAgentChips: React.ReactElement[] =
    fleetAgents && showChip('fleet_agents')
      ? fleetAgents.map((agent) => (
          <Text key={agent.label}>
            <Text color={isNoColor ? undefined : agent.color} bold>
              {agent.label}
            </Text>
            <Text
              color={agent.running && !isNoColor ? theme.warn : undefined}
            >{` ${agent.running ? glyphs.running : '·'} `}</Text>
            <Text dimColor={!isNoColor}>
              {fmtElapsed(agent.elapsedMs)} · {agent.toolCalls}t
            </Text>
            {agent.tool ? (
              <Text color={isNoColor ? undefined : theme.accent}>{` · ${agent.tool}`}</Text>
            ) : null}
            {agent.extensions && agent.extensions > 0 ? (
              <Text
                color={isNoColor ? undefined : theme.warn}
              >{` · ${glyphs.process}×${agent.extensions}`}</Text>
            ) : null}
          </Text>
        ))
      : [];

  const detailChips: React.ReactElement[] = [];
  if (mailbox && showMailbox) {
    detailChips.push(
      mailbox.unread > 0 ? (
        <Text color={isNoColor ? undefined : theme.warn} bold>
          {glyphs.mail} {mailbox.unread} new
        </Text>
      ) : (
        <Text dimColor={!isNoColor}>{glyphs.mail} 0</Text>
      ),
      <Text color={isNoColor ? undefined : theme.accent}>
        {glyphs.peers} {mailbox.onlineAgents} agent{mailbox.onlineAgents === 1 ? '' : 's'}
        {mailbox.onlineClients.tui > 0
          ? ` · ${glyphs.desktop} TUI${mailbox.onlineClients.tui > 1 ? `×${mailbox.onlineClients.tui}` : ''}`
          : ''}
        {mailbox.onlineClients.webui > 0
          ? ` · ${glyphs.web} WebUI${mailbox.onlineClients.webui > 1 ? `×${mailbox.onlineClients.webui}` : ''}`
          : ''}
        {mailbox.onlineClients.repl > 0
          ? ` · ${glyphs.terminal} REPL${mailbox.onlineClients.repl > 1 ? `×${mailbox.onlineClients.repl}` : ''}`
          : ''}
      </Text>,
    );
    if (mailbox.lastSubject) {
      detailChips.push(
        <Text dimColor={!isNoColor}>
          {mailbox.lastFrom ? `${mailbox.lastFrom}: ` : ''}
          {truncateChip(mailbox.lastSubject, 40)}
        </Text>,
      );
    }
  }
  detailChips.push(...fleetAgentChips);

  // ── Line 3 activity detection ──────────────────────────────────────────
  // Only render line 3 when there's active work or connectivity to show.
  const hasActiveGoal = goalSummary != null && showChip('goal');
  const showEternalStage = eternalStage != null && showChip('eternal_stage');
  const hasWorkActivity =
    (todos && (todos.pending > 0 || todos.inProgress > 0 || (todos.completed > 0 && !todosCleared))) ||
    (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ||
    hasTaskActivity ||
    fleetHasActivity ||
    showBrain ||
    showDebugStream ||
    showEnhance ||
    hasNextStepsAutoSubmit ||
    hasActiveGoal ||
    hasAutoProceed ||
    showEternalStage ||
    detailChips.length > 0;

  if (mode === 'minimum') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <PowerlineRail
          segments={minimumChips}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[0]}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={0}>
      {/* Line 1 — Runtime + mode chips: YOLO, autonomy, state, model, context,
          tokens, cost, queue, processes, hint, index, breaker, elapsed, working_dir */}
      <PowerlineRail
        segments={isCompact ? modeChips.slice(0, 5) : modeChips}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[0]}
      />

      {/* Line 2 — Session context: git, mode, sessions, tools,
          token-saving */}
      <PowerlineRail
        segments={[
          git && showChip('git') ? (
            <Text>
              <Text color={theme.monitor.agents}>
                {glyphs.gitBranch} {truncateChip(git.branch, 24)}
              </Text>
              {git.deleted > 0 ? <Text color={theme.error}> -{git.deleted}</Text> : null}
              {git.untracked > 0 ? <Text dimColor={!isNoColor}> ?{git.untracked}</Text> : null}
            </Text>
          ) : null,
          modeLabel && showChip('mode') ? (
            <Text color={chipColor(theme.accent, isNoColor)}>
              {isNoColor ? modeLabel : modeIcon(modeLabel)}
            </Text>
          ) : null,
          sessionCount != null && sessionCount > 0 && showChip('sessions') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${sessionCount} session${sessionCount === 1 ? '' : 's'}`
                : `${glyphs.sessions} ${sessionCount} session${sessionCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
          toolCount != null && showChip('tools') ? (
            <Text color={isNoColor ? undefined : theme.accent}>
              {isNoColor
                ? `${toolCount} tool${toolCount === 1 ? '' : 's'}`
                : `${glyphs.tools} ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
          tokenSavingMode !== undefined && tokenSavingMode !== 'off' && showChip('token_saving') ? (
            <Text color={isNoColor ? undefined : theme.warn} bold>
              {isNoColor ? tokenSavingMode : `${glyphs.save} ${tokenSavingMode}`}
            </Text>
          ) : null,
          sideEffectCount > 0 ? (
            <Text color={isNoColor ? undefined : theme.warn}>
              {isNoColor
                ? `${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`
                : `${glyphs.audit} ${sideEffectCount} audit${sideEffectCount === 1 ? '' : 's'}`}
            </Text>
          ) : null,
        ].filter((c): c is React.ReactElement => c !== null)}
        budget={Math.max(12, termWidth)}
        monochrome={isNoColor}
        fillBg={LINE_BG_COLORS[1]}
      />

      {/* Line 3 — Active work + Connectivity: todos, plan, tasks, fleet,
          brain, debug stream, enhance, next-steps, mailbox, fleet agents.
          Only rendered when there's something to show. */}
      {hasWorkActivity ? (
        <PowerlineRail
          segments={[
            todos &&
                (todos.pending > 0 ||
                  todos.inProgress > 0 ||
                  (todos.completed > 0 && !todosCleared)) &&
                showChip('todos') ? (
              <Text>
                <Text dimColor={!isNoColor}>todos </Text>
                {todos.inProgress > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `⌛${todos.inProgress}` : `⌛${todos.inProgress}`}
                  </Text>
                ) : null}
                {todos.inProgress > 0 && (todos.pending > 0 || todos.completed > 0) ? ' ' : ''}
                {todos.pending > 0 ? (
                  <Text dimColor={!isNoColor}>
                    {isNoColor ? `☐${todos.pending}` : `☐${todos.pending}`}
                  </Text>
                ) : null}
                {todos.pending > 0 && todos.completed > 0 ? ' ' : ''}
                {todos.completed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `✓${todos.completed}` : `✓${todos.completed}`}
                  </Text>
                ) : null}
              </Text>
            ) : null,
            plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0) && showChip('plan') ? (
              <Text>
                <Text color={isNoColor ? undefined : theme.accent}>
                  {isNoColor ? '' : `${glyphs.plan} `}
                </Text>
                {plan.inProgress > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `⌛${plan.inProgress}` : `⌛${plan.inProgress}`}
                  </Text>
                ) : null}
                {plan.inProgress > 0 && (plan.open > 0 || plan.done > 0) ? ' ' : ''}
                {plan.open > 0 ? (
                  <Text dimColor={!isNoColor}>{isNoColor ? `☐${plan.open}` : `☐${plan.open}`}</Text>
                ) : null}
                {plan.open > 0 && plan.done > 0 ? ' ' : ''}
                {plan.done > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `✓${plan.done}` : `✓${plan.done}`}
                  </Text>
                ) : null}
                {plan.scope ? <Text dimColor={!isNoColor}> [{plan.scope}]</Text> : null}
              </Text>
            ) : null,
            hasTaskActivity && showChip('tasks') ? (
              <Text>
                <Text color={isNoColor ? undefined : theme.monitor.agents}>
                  {isNoColor ? '' : `${glyphs.task} `}
                </Text>
                {tasks!.inProgress > 0 ? (
                  <Text color={isNoColor ? undefined : theme.warn}>
                    {isNoColor ? `⌛${tasks!.inProgress}` : `⌛${tasks!.inProgress}`}
                  </Text>
                ) : null}
                {tasks!.inProgress > 0 && (tasks!.pending > 0 || tasks!.blocked > 0) ? ' ' : ''}
                {tasks!.pending > 0 ? (
                  <Text dimColor={!isNoColor}>
                    {isNoColor ? `☐${tasks!.pending}` : `☐${tasks!.pending}`}
                  </Text>
                ) : null}
                {tasks!.pending > 0 && tasks!.blocked > 0 ? ' ' : ''}
                {tasks!.blocked > 0 ? (
                  <Text color={isNoColor ? undefined : theme.error}>
                    {isNoColor ? `⊘${tasks!.blocked}` : `⊘${tasks!.blocked}`}
                  </Text>
                ) : null}
                {(tasks!.pending > 0 || tasks!.blocked > 0) &&
                (tasks!.completed > 0 || tasks!.failed > 0)
                  ? ' '
                  : ''}
                {tasks!.completed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.success}>
                    {isNoColor ? `✓${tasks!.completed}` : `✓${tasks!.completed}`}
                  </Text>
                ) : null}
                {tasks!.completed > 0 && tasks!.failed > 0 ? ' ' : ''}
                {tasks!.failed > 0 ? (
                  <Text color={isNoColor ? undefined : theme.error}>
                    {isNoColor ? `✗${tasks!.failed}` : `✗${tasks!.failed}`}
                  </Text>
                ) : null}
                {tasks!.scope ? <Text dimColor={!isNoColor}> [{tasks!.scope}]</Text> : null}
              </Text>
            ) : null,
            fleetHasActivity && showChip('fleet') ? (
              fleet ? (
                <Text>
                  <Text color={isNoColor ? undefined : theme.accent}>
                    {isNoColor ? '' : `${glyphs.fleet} `}
                  </Text>
                  {fleet.running > 0 ? (
                    <Text color={isNoColor ? undefined : theme.warn}>
                      {isNoColor ? `▶${fleet.running}` : `▶${fleet.running}`}
                    </Text>
                  ) : null}
                  {fleet.running > 0 &&
                  (fleet.pending > 0 || fleet.idle > 0 || fleet.completed > 0)
                    ? ' '
                    : ''}
                  {fleet.pending > 0 ? (
                    <Text dimColor={!isNoColor}>
                      {isNoColor ? `☐${fleet.pending}` : `☐${fleet.pending}`}
                    </Text>
                  ) : null}
                  {fleet.pending > 0 && (fleet.idle > 0 || fleet.completed > 0) ? ' ' : ''}
                  {fleet.idle > 0 ? <Text dimColor={!isNoColor}>·{fleet.idle}idle</Text> : null}
                  {fleet.idle > 0 && fleet.completed > 0 ? ' ' : ''}
                  {fleet.completed > 0 ? (
                    <Text color={isNoColor ? undefined : theme.success}>
                      {isNoColor ? `✓${fleet.completed}` : `✓${fleet.completed}`}
                    </Text>
                  ) : null}
                </Text>
              ) : (
                <Text color={isNoColor ? undefined : theme.accent}>
                  {isNoColor
                    ? `${subagentCount} agent${subagentCount === 1 ? '' : 's'}`
                    : `${glyphs.fleet} ${subagentCount} agent${subagentCount === 1 ? '' : 's'}`}
                </Text>
              )
            ) : null,
            showBrain ? <BrainChip brain={brain!} monochrome={isNoColor} /> : null,
            showDebugStream ? (
              <Text color={isNoColor ? undefined : theme.accent}>
                <Text bold>{isNoColor ? 'stream' : `${glyphs.bug} stream`}</Text>
                <Text dimColor={!isNoColor}> #{debugStreamStats!.chunkCount}</Text>
                <Text dimColor={!isNoColor}> · {debugStreamStats!.lastChunkSize}B</Text>
                <Text dimColor={!isNoColor}> · +{debugStreamStats!.lastDeltaMs}ms</Text>
                <Text dimColor={!isNoColor}> · {fmtDebugBytes(debugStreamStats!.totalBytes)}</Text>
              </Text>
            ) : null,
            showEnhance ? (
              <Text color={isNoColor ? undefined : countdownColor(enhanceCountdown!, 15, 5)}>
                {isNoColor
                  ? `refined · send in ${enhanceCountdown}s`
                  : `${glyphs.auto} refinement ready · send in ${enhanceCountdown}s`}
              </Text>
            ) : null,
            hasNextStepsAutoSubmit &&
            nextStepsAutoSubmitCountdown != null &&
            showChip('next_steps') ? (
              <>
                <Text color={isNoColor ? undefined : nextStepsColor} bold>
                  {isNoColor
                    ? `${nextStepsAutoSubmitCountdown}s`
                    : `${glyphs.auto} ${nextStepsAutoSubmitCountdown}s`}
                </Text>
                <Text dimColor={!isNoColor}>
                  {' '}
                  {nextStepsAutoSubmitLabel
                    ? formatSuggestionLabel(nextStepsAutoSubmitLabel)
                    : ''}
                  {' · ⇥ edit'}
                </Text>
              </>
            ) : null,
            showEternalStage ? (
              <EternalStageChip stage={eternalStage!} monochrome={isNoColor} />
            ) : null,
            hasActiveGoal ? (
              <Text
                color={
                  isNoColor
                    ? undefined
                    : goalSummary!.goalState === 'abandoned'
                      ? theme.textMuted
                      : goalSummary!.goalState === 'active' || goalSummary!.goalState === 'completed'
                        ? theme.success
                        : theme.warn
                }
              >
                {isNoColor ? '' : `${glyphs.goal} `}
                {goalSummary!.goal.length > 40
                  ? `${goalSummary!.goal.slice(0, 37)}…`
                  : goalSummary!.goal}{' '}
                [{goalSummary!.goalState}] (iter {goalSummary!.iterations})
              </Text>
            ) : null,
            hasAutoProceed && showChip('auto_proceed') ? (
              <Text
                color={
                  isNoColor
                    ? undefined
                    : autoProceedCountdown != null && autoProceedCountdown <= 5
                      ? theme.warn
                      : theme.accent
                }
              >
                {isNoColor
                  ? `auto in ${autoProceedCountdown}s`
                  : `${glyphs.auto} auto in ${autoProceedCountdown}s`}
              </Text>
            ) : null,
            ...detailChips,
          ].filter((c): c is React.ReactElement => c !== null)}
          budget={Math.max(12, termWidth)}
          monochrome={isNoColor}
          fillBg={LINE_BG_COLORS[2]}
        />
      ) : null}
    </Box>
  );
}

/** Compute the leading state chip (label + Ink color) for the status bar.
 *
 * The foreground loop reports 'idle' between turns, but background subagents
 * can still be running — e.g. between eternal/parallel autonomy iterations,
 * or a fleet spawned outside a foreground run. Showing plain "idle" then is
 * misleading, so when `fleetRunning > 0` and the foreground is idle we surface
 * the live agent count (`agents ▶N`) in a distinct color instead.
 */
// Powerline geometry: one start cap, one cell of padding on either side of
// every segment, and a one-cell transition between adjacent segments.
const RAIL_CAP = 1;
const RAIL_PAD = 2;
const RAIL_TRANSITION = 1;

/**
 * 0-based column span (offset from the box's left edge, including the left
 * paddingX) of the `{provider}/{model}` chip on status-bar line 1. The TUI
 * mouse handler uses it to make the model chip clickable (→ open model
 * picker). Mirrors the line-1 flex layout: optional `WS v…` chip + `│`, then
 * `● {stateLabel}` + `│`, then the model.
 */
export function statusBarModelSpan(opts: {
  state: 'idle' | 'running' | 'streaming' | 'aborting';
  fleetRunning?: number | undefined;
  thinkingWord?: string | undefined;
  /** When true the `state` chip is render-suppressed, so the model chip sits one
   *  segment further left (no `● {label}` term). */
  stateHidden?: boolean | undefined;
  model: string;
}): { start: number; len: number } {
  let col = RAIL_CAP;
  if (!opts.stateHidden) {
    const { label } = stateChip(opts.state, opts.fleetRunning ?? 0, opts.thinkingWord);
    col += displayWidth(`● ${label}`) + RAIL_PAD + RAIL_TRANSITION;
  }
  return { start: col + 1, len: displayWidth(opts.model) };
}

/**
 * 0-based column span of the `∞ MODE` autonomy chip on status-bar line 2, or
 * null when it isn't shown (autonomy off/unset). When YOLO is on it precedes
 * the autonomy chip (plus a `│` separator), so the span shifts right.
 */
export function statusBarAutonomySpan(opts: {
  yolo?: boolean | undefined;
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
}): { start: number; len: number } | null {
  if (!opts.autonomy || opts.autonomy === 'off') return null;
  let col = RAIL_CAP;
  if (opts.yolo) {
    col += displayWidth(`${glyphs.warning} YOLO`) + RAIL_PAD + RAIL_TRANSITION;
  }
  return { start: col + 1, len: 2 + opts.autonomy.toUpperCase().length }; // "∞ " + MODE
}

/**
 * 0-based column span of the `todos ⌛N ☐M ✓K` chip on status-bar line 3.
 * Returns null when no todos are visible. Used by the TUI mouse handler
 * to make the todos chip clickable (→ F5 right panel / F6 overlay).
 * The chip is always at the start of line 3 with only left padding.
 */
export function statusBarTodosSpan(): { start: number; len: number } {
  // Line 3: paddingX(1) + chip text (variable). The chip is the first item.
  // We return a fixed span for the label portion — the exact width depends
  // on counts, so we use a generous estimate that covers "todos ⌛99 ☐99 ✓99".
  const LABEL_MAX = 20;
  return { start: RAIL_CAP + 1, len: LABEL_MAX };
}

export function stateChip(
  state: 'idle' | 'running' | 'streaming' | 'aborting',
  fleetRunning: number,
  thinkingWord?: string | undefined,
): { label: string; color: string } {
  if (state === 'idle' && fleetRunning > 0) {
    return { label: `agents ▶${fleetRunning}`, color: theme.monitor.agents };
  }
  if (state === 'idle') return { label: 'idle', color: theme.accent };
  if (state === 'aborting') return { label: 'aborting…', color: theme.warn };
  return { label: `${normalizeTuiThinkingWord(thinkingWord)}…`, color: theme.success };
}

const FILLED = '█';
const EMPTY = '░';

export function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

// Sub-cell-precise meter: each cell is 1/8 resolution via Unicode block
// fractions, so the bar grows smoothly token-by-token instead of jumping a
// whole cell. Empty track stays '░'. Total width is always `width` chars.

/**
 * Bracket-style context meter, e.g. `[00o.......]`.
 *
 * Renders a fixed-width progress bar inside square brackets. `0` marks filled
 * cells, `o` is the boundary marker at the edge of used space, and `.` marks
 * remaining cells. The marker disappears at 0% (bar is all `.`) and at 100%
 * (bar is all `0`).
 */
export function renderMeter(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      bar += '0';
    } else if (i === filled && filled < width) {
      bar += 'o';
    } else {
      bar += '.';
    }
  }
  return '[' + bar + ']';
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${pad2(m)}:${pad2(s)}`;
}

function fmtDebugBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1_048_576).toFixed(1)}MB`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
