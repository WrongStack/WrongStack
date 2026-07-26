import type {
  SubagentRunContext,
  SubagentRunner,
  TaskSpec,
} from '../types/multi-agent.js';
import {
  BudgetExceededError,
  DECISION_TIMEOUT_MS,
  SubagentBudget,
  TIMEOUT_PREEMPT_FRACTION,
} from './subagent-budget.js';

export interface ExecuteSubagentWithTimeoutOptions {
  runner: SubagentRunner;
  task: TaskSpec;
  ctx: SubagentRunContext;
  budget: SubagentBudget;
  preemptFraction?: number | undefined;
  abortSubagent: (subagentId: string) => void;
  currentSessionId: () => string | undefined;
}

export async function executeSubagentWithTimeout({
  runner,
  task,
  ctx,
  budget,
  preemptFraction = TIMEOUT_PREEMPT_FRACTION,
  abortSubagent,
  currentSessionId,
}: ExecuteSubagentWithTimeoutOptions) {
  const initialTimeoutMs = budget.limits.timeoutMs;
  const idleLimitMs = budget.limits.idleTimeoutMs;
  if (initialTimeoutMs === undefined && idleLimitMs === undefined) {
    return runner(task, ctx);
  }

  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
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
      const wallLimit = budget.limits.timeoutMs ?? initialTimeoutMs;
      const wallRemaining =
        initialTimeoutMs === undefined
          ? Number.POSITIVE_INFINITY
          : (wallLimit as number) - (Date.now() - start);
      const idleRemaining =
        idleLimitMs === undefined
          ? Number.POSITIVE_INFINITY
          : (budget.limits.idleTimeoutMs ?? idleLimitMs) - budget.idleMs();
      const preemptRemaining =
        initialTimeoutMs === undefined || preemptedCeiling === wallLimit
          ? Number.POSITIVE_INFINITY
          : (wallLimit as number) * preemptFraction - (Date.now() - start);
      armFor(Math.max(25, Math.min(wallRemaining, idleRemaining, preemptRemaining)));
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
          return new Promise<'stop' | { extend: { timeoutMs?: number | undefined } }>((resolveDecision) => {
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
          });
        },
      });
      return typeof result === 'string' ? result : await result;
    };

    const onTick = async () => {
      const elapsed = Date.now() - start;
      const wallLimit =
        initialTimeoutMs === undefined ? undefined : budget.limits.timeoutMs ?? initialTimeoutMs;
      const idleLimit =
        idleLimitMs === undefined ? undefined : budget.limits.idleTimeoutMs ?? idleLimitMs;
      const wallExceeded = wallLimit !== undefined && elapsed >= wallLimit;
      const idleExceeded = idleLimit !== undefined && budget.idleMs() >= idleLimit;

      if (idleExceeded && !wallExceeded) {
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
      if (!budget.onThreshold) {
        abortSubagent(ctx.subagentId);
        reject(new BudgetExceededError('timeout', limit, elapsed));
        return;
      }
      budget.setWatchdogNegotiation(limit);
      try {
        const decision = await negotiateTimeout(elapsed, limit);
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
    if (timer) clearTimeout(timer);
  }
}
