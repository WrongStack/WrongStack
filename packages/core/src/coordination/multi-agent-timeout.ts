import type { SubagentRunContext, SubagentRunner, TaskSpec } from '../types/multi-agent.js';
import {
  BudgetExceededError,
  DECISION_TIMEOUT_MS,
  type SubagentBudget,
  TIMEOUT_PREEMPT_FRACTION,
} from './subagent-budget.js';
import type { GracefulFinish } from './subagent-finish.js';

export interface ExecuteSubagentWithTimeoutOptions {
  runner: SubagentRunner;
  task: TaskSpec;
  ctx: SubagentRunContext;
  budget: SubagentBudget;
  preemptFraction?: number | undefined;
  abortSubagent: (subagentId: string) => void;
  currentSessionId: () => string | undefined;
  /**
   * Model-driven completion policy resolved from the subagent config. When
   * set, crossing the wall-clock deadline does NOT abort the runner: the
   * budget emits `subagent.finish_requested` in-band (folded into the
   * conversation between tool batches) and extends its own ceiling by the
   * grace window. The terminal stop applies only if that window also
   * elapses — the subagent's bounded maximum lifetime.
   */
  gracefulFinish?: GracefulFinish | undefined;
}

export async function executeSubagentWithTimeout({
  runner,
  task,
  ctx,
  budget,
  preemptFraction = TIMEOUT_PREEMPT_FRACTION,
  abortSubagent,
  currentSessionId,
  gracefulFinish,
}: ExecuteSubagentWithTimeoutOptions) {
  const initialTimeoutMs = budget.limits.timeoutMs;
  const idleLimitMs = budget.limits.idleTimeoutMs;
  if (initialTimeoutMs === undefined && idleLimitMs === undefined) {
    return runner(task, ctx);
  }

  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  enum PreemptState {
    ACTIVE = 'active',
    LOCKED = 'locked',
  }
  let preemptedCeiling: number | null = null;
  let preemptState: PreemptState = PreemptState.ACTIVE;
  let lastGrantActivityTs = -1;

  const timeoutPromise = new Promise<never>((_, reject) => {
    const terminate = (kind: 'timeout' | 'idle_timeout', limit: number, used: number) => {
      abortSubagent(ctx.subagentId);
      reject(
        budget._events?.hasListenerFor('budget.threshold_reached')
          ? new Error(`subagent stopped: budget ${kind} (limit=${limit}, used=${used})`)
          : new BudgetExceededError(kind, limit, used),
      );
    };
    const armFor = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onTick, Math.max(0, ms));
    };
    const scheduleNext = () => {
      if (settled) return;
      const wallLimit = budget.limits.timeoutMs ?? initialTimeoutMs;
      const wallRemaining =
        initialTimeoutMs === undefined
          ? Number.POSITIVE_INFINITY
          : (wallLimit as number) - (Date.now() - start);
      // Components disabled under a graceful-finish policy must not drive
      // the timer either. The idle and preempt branches are skipped for
      // those runs, so their remaining times go negative and pin
      // `Math.min(...)` below the 25ms floor — a busy-spin that fires
      // onTick for the whole grace window. Only the wall deadline (the
      // sole terminal authority under the policy) schedules the tick.
      const idleRemaining =
        idleLimitMs === undefined ||
        (gracefulFinish !== undefined && initialTimeoutMs !== undefined)
          ? Number.POSITIVE_INFINITY
          : (budget.limits.idleTimeoutMs ?? idleLimitMs) - budget.idleMs();
      const preemptRemaining =
        initialTimeoutMs === undefined ||
        preemptedCeiling === wallLimit ||
        gracefulFinish !== undefined
          ? Number.POSITIVE_INFINITY
          : (wallLimit as number) * preemptFraction - (Date.now() - start);
      const next = Math.min(wallRemaining, idleRemaining, preemptRemaining);
      // No finite authority left (e.g. gracefulFinish with an idle-only
      // budget: wall/preempt/idle all disabled) — the watchdog has nothing
      // to enforce. Passing Infinity to setTimeout coerces to a 1ms timer,
      // a busy-spin for the rest of the run. Stand down instead; the
      // timeoutPromise simply never rejects and the runner completes
      // naturally, bounded by its other budgets and the leader's sweep.
      if (!Number.isFinite(next)) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      armFor(Math.max(25, next));
    };

    const negotiateTimeout = async (
      used: number,
      limit: number,
    ): Promise<'stop' | 'continue' | 'throw' | { extend: { timeoutMs?: number | undefined } }> => {
      const handler = budget.onThreshold;
      if (!handler) return 'stop';
      const result = handler({
        kind: 'timeout',
        used,
        limit,
        requestDecision: () => {
          if (!budget._events?.hasListenerFor('budget.threshold_reached')) {
            return Promise.resolve<'stop' | { extend: { timeoutMs?: number | undefined } }>('stop');
          }
          return new Promise<'stop' | { extend: { timeoutMs?: number | undefined } }>(
            (resolveDecision) => {
              let settled = false;
              const resolve = (d: 'stop' | { extend: { timeoutMs?: number | undefined } }) => {
                if (settled) return;
                settled = true;
                resolveDecision(d);
              };
              const fallback = setTimeout(() => resolve('stop'), DECISION_TIMEOUT_MS);
              const sessionId = currentSessionId();
              budget._events?.emit('budget.threshold_reached', {
                ...(sessionId ? { sessionId } : {}),
                kind: 'timeout',
                used,
                limit,
                timeoutMs: DECISION_TIMEOUT_MS,
                extend: (extra) => {
                  clearTimeout(fallback);
                  queueMicrotask(() => resolve({ extend: extra }));
                },
                deny: () => {
                  clearTimeout(fallback);
                  resolve('stop');
                },
              });
            },
          );
        },
      });
      return typeof result === 'string' ? result : await result;
    };

    const onTick = async () => {
      if (settled) return;
      const elapsed = Date.now() - start;
      const wallLimit =
        initialTimeoutMs === undefined ? undefined : (budget.limits.timeoutMs ?? initialTimeoutMs);
      const idleLimit =
        idleLimitMs === undefined ? undefined : (budget.limits.idleTimeoutMs ?? idleLimitMs);
      const wallExceeded = wallLimit !== undefined && elapsed >= wallLimit;
      const idleExceeded = idleLimit !== undefined && budget.idleMs() >= idleLimit;

      if (idleExceeded && !wallExceeded) {
        // Under a graceful-finish policy WITH a wall clock, the grace deadline
        // IS the bound: the wall-clock ceiling was extended to cover it, so the
        // wall branch below owns the terminal decision. A reviewer sitting
        // between tool calls while composing its final output must not be
        // reaped by the idle path first — that would be exactly the external
        // interrupt the policy forbids. A genuine stall still ends at the wall
        // deadline.
        //
        // Without a wall clock (idle-only budget) there is no grace deadline to
        // defer to — deferring here would leave the run with NO reaper at all.
        // The idle reaper stays the bound for that shape.
        if (gracefulFinish !== undefined && initialTimeoutMs !== undefined) {
          scheduleNext();
          return;
        }
        const sessionId = currentSessionId();
        budget._events?.emit('budget.threshold_reached', {
          ...(sessionId ? { sessionId } : {}),
          kind: 'idle_timeout',
          used: budget.idleMs(),
          limit: idleLimit ?? 0,
          timeoutMs: DECISION_TIMEOUT_MS,
          extend: () => {},
          deny: () => {},
        });
        abortSubagent(ctx.subagentId);
        reject(new BudgetExceededError('idle_timeout', idleLimit ?? 0, budget.idleMs()));
        return;
      }

      if (
        wallLimit !== undefined &&
        !wallExceeded &&
        gracefulFinish === undefined &&
        budget.onThreshold &&
        preemptState === PreemptState.ACTIVE &&
        elapsed >= wallLimit * preemptFraction
      ) {
        const activityTs = Date.now() - budget.idleMs();
        if (activityTs <= lastGrantActivityTs) {
          preemptState = PreemptState.LOCKED;
          preemptedCeiling = wallLimit;
          scheduleNext();
          return;
        }
        budget.setWatchdogNegotiation(wallLimit);
        try {
          const decision = await negotiateTimeout(elapsed, wallLimit);
          if (settled) return;
          if (typeof decision !== 'string' && decision.extend.timeoutMs !== undefined) {
            budget.patchLimits({ timeoutMs: decision.extend.timeoutMs });
            lastGrantActivityTs = Date.now() - budget.idleMs();
            preemptState = PreemptState.ACTIVE;
            preemptedCeiling = null;
          } else {
            preemptState = PreemptState.LOCKED;
            preemptedCeiling = wallLimit;
          }
        } catch {
          preemptState = PreemptState.LOCKED;
          preemptedCeiling = wallLimit;
        } finally {
          budget.clearWatchdogNegotiation();
        }
        scheduleNext();
        return;
      }

      if (!wallExceeded) {
        scheduleNext();
        return;
      }

      const limit = wallLimit ?? 0;

      if (gracefulFinish !== undefined) {
        if (!budget.graceGranted) {
          // First deadline crossing under a graceful-finish policy: notify,
          // never kill. The budget emits `subagent.finish_requested` in-band
          // (the agent loop folds the notice in between tool batches) and
          // extends its own wall-clock ceiling by the grace window, so
          // `scheduleNext()` re-arms for the finish deadline.
          const reason = `wall-clock budget of ${Math.round(limit / 1000)}s reached`;
          if (budget.notifyFinish(reason, { graceMs: gracefulFinish.graceMs })) {
            scheduleNext();
            return;
          }
          // The in-band notification could not be delivered (no EventBus
          // wired / budget not started). The model-driven contract is
          // undeliverable here, so do NOT fall through to the legacy
          // negotiation — an un-notified extension would let the subagent
          // run on with no finish request, the exact stall this policy
          // exists to bound. Apply the terminal stop; the run stays bounded.
          abortSubagent(ctx.subagentId);
          reject(new BudgetExceededError('timeout', limit, elapsed));
          return;
        } else {
          // The grace window has elapsed: the model was given legitimate
          // working time and did not finish its turn. Apply the terminal
          // stop — the subagent's bounded maximum lifetime.
          abortSubagent(ctx.subagentId);
          reject(new BudgetExceededError('timeout', limit, elapsed));
          return;
        }
      }

      if (!budget.onThreshold) {
        abortSubagent(ctx.subagentId);
        reject(new BudgetExceededError('timeout', limit, elapsed));
        return;
      }
      budget.setWatchdogNegotiation(limit);
      try {
        const decision = await negotiateTimeout(elapsed, limit);
        if (settled) return;
        if (decision === 'throw') {
          terminate('timeout', limit, elapsed);
          return;
        }
        if (decision === 'continue') {
          preemptState = PreemptState.LOCKED;
          preemptedCeiling = wallLimit;
          armFor(Math.max(1_000, limit));
          return;
        }
        if (decision === 'stop') {
          terminate('timeout', limit, elapsed);
          return;
        }
        if (decision.extend.timeoutMs !== undefined) {
          budget.patchLimits({ timeoutMs: decision.extend.timeoutMs });
          lastGrantActivityTs = Date.now() - budget.idleMs();
          preemptState = PreemptState.ACTIVE;
          preemptedCeiling = null;
          scheduleNext();
          return;
        }
        terminate('timeout', limit, elapsed);
        return;
      } catch (err) {
        if (settled) return;
        abortSubagent(ctx.subagentId);
        reject(
          err instanceof BudgetExceededError
            ? err
            : new BudgetExceededError('timeout', limit, elapsed),
        );
        return;
      } finally {
        budget.clearWatchdogNegotiation();
      }
    };
    scheduleNext();
  });

  try {
    return await Promise.race([runner(task, ctx), timeoutPromise]);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
  }
}
