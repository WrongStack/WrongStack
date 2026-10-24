import type { BudgetKind, BudgetLimits } from '@wrongstack/contracts/types/subagent-budget';

/** One budget kind over its limit. */
export interface ExceededBudget {
  kind: BudgetKind;
  used: number;
  limit: number;
}

/** Wall-clock state, present only when the check comes from `checkTimeout()`. */
export interface BudgetClockCheck {
  elapsedMs: number;
  idleMs: number;
  /**
   * The coordinator watchdog owns the wall-clock ceiling: permanently for
   * gracefulFinish runs, or while it is negotiating this exact `timeoutMs`.
   */
  wallOwnedByWatchdog: boolean;
}

/** Every budget kind whose usage is over its limit, in a fixed order. */
export function collectExceededBudgets(
  limits: BudgetLimits,
  usage: { iterations: number; toolCalls: number; tokens: number; costUsd: number },
  clock: BudgetClockCheck | undefined,
): ExceededBudget[] {
  const exceeded: ExceededBudget[] = [];

  if (limits.maxIterations !== undefined && usage.iterations > limits.maxIterations) {
    exceeded.push({ kind: 'iterations', used: usage.iterations, limit: limits.maxIterations });
  }
  if (limits.maxToolCalls !== undefined && usage.toolCalls > limits.maxToolCalls) {
    exceeded.push({ kind: 'tool_calls', used: usage.toolCalls, limit: limits.maxToolCalls });
  }
  if (limits.maxTokens !== undefined && usage.tokens > limits.maxTokens) {
    exceeded.push({ kind: 'tokens', used: usage.tokens, limit: limits.maxTokens });
  }
  if (limits.maxCostUsd !== undefined && usage.costUsd > limits.maxCostUsd) {
    exceeded.push({ kind: 'cost', used: usage.costUsd, limit: limits.maxCostUsd });
  }
  // Timeout: called from checkTimeout() with elapsedMs (wall-clock) and the
  // current idle gap. Either crossing its limit trips its own kind so the
  // coordinator and auto-extend policy can distinguish them.
  // Wall-clock (`timeoutMs`) is an explicit hard cap; idle (`idleTimeoutMs`)
  // is the default guard that resets on activity. Both can be exceeded in
  // the same call — we push both entries so all violated limits are reported.
  if (clock !== undefined) {
    if (limits.idleTimeoutMs !== undefined && clock.idleMs > limits.idleTimeoutMs) {
      exceeded.push({ kind: 'idle_timeout', used: clock.idleMs, limit: limits.idleTimeoutMs });
    }
    // Skip the wall-clock 'timeout' kind while the coordinator watchdog is
    // negotiating this exact ceiling — it owns wall-clock; checkTimeout/here
    // own idle. Only suppress in the negotiation path (a handler is set); on
    // the no-handler hard-throw path the wall-clock must still trip. (Mirrors
    // the guard in checkTimeout, which previously was NOT applied here — so
    // an idle trip that called checkLimits re-added 'timeout' and defeated the
    // watchdog dedup.)
    //
    // `wallClockWatchdogOwned` (gracefulFinish runs) mirrors checkTimeout's
    // guard: wall-clock ownership is PERMANENT for those runs, not just
    // mid-negotiation. Without this mirror, a tool.progress heartbeat
    // landing in the sub-millisecond window between a deadline crossing and
    // the watchdog's own tick trips idle here, and checkLimits re-added
    // 'timeout' — starting a legacy wall-clock negotiation that raced the
    // watchdog's notify-then-grace path.
    if (
      limits.timeoutMs !== undefined &&
      clock.elapsedMs > limits.timeoutMs &&
      !clock.wallOwnedByWatchdog
    ) {
      exceeded.push({ kind: 'timeout', used: clock.elapsedMs, limit: limits.timeoutMs });
    }
  }
  return exceeded;
}
