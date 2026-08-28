/**
 * agent-status — shared, presentation-agnostic helpers for in-process subagent
 * (`SubagentView`) state.
 *
 * The Fleet surfaces (FleetMonitor, FleetPanel) each hand-rolled the same
 * "running-first" sort, the same status counts, and the same `status ===
 * 'running'` active check. This module is the single source for that pure logic
 * so the surfaces stop drifting.
 *
 * Deliberately NOT here: the per-surface visual status maps. Presentation
 * components now use shared CSS-var theme tokens, while this module stays pure
 * and only owns canonical short labels plus activity sorting/counting.
 */

import type { SubagentView } from '@/stores';

type AgentStatus = SubagentView['status'];

/** Canonical short label per status (shared by the Fleet surfaces). */
export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  timeout: 'timeout',
  stopped: 'stopped',
};

/** A subagent is "active" only while running. */
export function isAgentActive(status: string): boolean {
  return status === 'running';
}

/**
 * Sort comparator: running agents first, then oldest-started first. Generic over
 * anything carrying `status` + `startedAt` so both the store's `SubagentView` and
 * lighter row shapes can use it. Callers that pin a leader to the top should
 * apply that special-case before delegating here.
 */
export function compareAgentsByActivity<T extends { status: string; startedAt: number }>(
  a: T,
  b: T,
): number {
  const aActive = isAgentActive(a.status) ? 0 : 1;
  const bActive = isAgentActive(b.status) ? 0 : 1;
  if (aActive !== bActive) return aActive - bActive;
  return a.startedAt - b.startedAt;
}

interface AgentTally {
  running: number;
  completed: number;
  /** failed + timeout — the two terminal-error states the Fleet UIs group. */
  failed: number;
  total: number;
}

/** Count agents by activity bucket (running / completed / failed-or-timeout). */
export function tallyAgents<T extends { status: string }>(list: readonly T[]): AgentTally {
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const a of list) {
    if (a.status === 'running') running++;
    else if (a.status === 'completed') completed++;
    else if (a.status === 'failed' || a.status === 'timeout') failed++;
  }
  return { running, completed, failed, total: list.length };
}

// ── Display-value helpers ──────────────────────────────────────────────
//
// Each formatter is a pure function that returns a display string. They are
// exported individually so consumers can use them standalone, and also
// aggregated via `computeAgentStats` for the roster-card use-case.

/** Context-fill severity band. */
type CtxSeverity = 'low' | 'medium' | 'high';

const CTX_THRESHOLD_HIGH = 85;
const CTX_THRESHOLD_MEDIUM = 70;

/** Clamp a context percentage [0, 100] and return its severity band. */
export function classifyCtxPct(pct: number): { clamped: number; severity: CtxSeverity } {
  const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  const severity: CtxSeverity =
    clamped >= CTX_THRESHOLD_HIGH ? 'high' : clamped >= CTX_THRESHOLD_MEDIUM ? 'medium' : 'low';
  return { clamped, severity };
}

/**
 * Format token count for display: "1.2K" / "3.4M" / raw number.
 * Handles Infinity, NaN, and negative values by returning "0".
 */
export function fmtTok(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * Format USD cost for display.
 *
 * - <=0 or non-finite -> "$0"
 * - <$0.01 -> 5 decimal places (sub-cent precision); values below 5e-6
 *   round to 5 zeroes at 5 decimals and render as "$0"
 * - >=$0.01 -> 3 decimal places
 */
export function fmtCost(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) {
    const s = n.toFixed(5);
    // All zeros at 5 decimals — value is effectively $0
    if (s === '0.00000') return '$0';
    return '$' + s.replace(/(\d)0+$/, '$1').replace(/\.$/, '');
  }
  return '$' + n.toFixed(3);
}

/**
 * Format elapsed milliseconds as a human duration string.
 *
 * - < 60s -> "Xs"
 * - 1-60 min -> "Xm Ys"  (always shows seconds)
 * - 1-24 h  -> "Xh Ym"
 * - >=24 h   -> "Xd"
 *
 * Pass `null` or non-finite values -> returns "-".
 */
export function fmtDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '\u2014';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 24) return `${totalH}h ${totalMin % 60}m`;
  return `${Math.floor(totalH / 24)}d`;
}

/**
 * Pre-computed display values for an agent card or row.
 * All fields are derived from the SubagentView and ready to render.
 */
interface AgentDisplayStats {
  /** Context percentage [0..100], clamped. */
  ctxClamped: number;
  /** Severity band for the context bar colour. */
  ctxSeverity: CtxSeverity;
  /** Formatted elapsed time (live for running agents). */
  elapsed: string;
  /** Formatted total cost. */
  cost: string;
  /** Number of iterations (raw). */
  iterationCount: number;
  /** Number of tool calls (raw). */
  toolCount: number;
  /** Formatted token counts. */
  tokensIn: string;
  tokensOut: string;
}

/**
 * Derive all display values from a SubagentView in one pass.
 *
 * @param agent  The agent to compute stats for.
 * @param now    Optional timestamp (ms) for computing elapsed time.
 *               Defaults to `Date.now()`. Pass a frozen timestamp in tests.
 */
export function computeAgentStats(
  agent: SubagentView,
  now: number = Date.now(),
): AgentDisplayStats {
  const { clamped, severity } = classifyCtxPct(agent.ctxPct);

  const elapsed: string =
    !Number.isFinite(agent.startedAt) || agent.startedAt <= 0
      ? '\u2014'
      : fmtDuration(
          agent.status === 'running'
            ? now - agent.startedAt
            : (agent.completedAt ?? now) - agent.startedAt,
        );

  return {
    ctxClamped: clamped,
    ctxSeverity: severity,
    elapsed,
    cost: fmtCost(agent.costUsd),
    iterationCount: agent.iteration,
    toolCount: agent.toolCalls,
    tokensIn: fmtTok(agent.tokensIn),
    tokensOut: fmtTok(agent.tokensOut),
  };
}
