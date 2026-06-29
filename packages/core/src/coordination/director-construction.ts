/**
 * Director construction helpers.
 *
 * The `Director` constructor was historically a single 300+ line function
 * that interleaved field assignments with two pieces of event-listener
 * wiring: the `task.completed` listener on the coordinator (which mirrors
 * completions into the in-memory wait table, the on-disk checkpoint, and
 * the session JSONL event stream) and the `budget.threshold_reached`
 * filter on the FleetBus (which implements the heartbeat-driven timeout
 * policy and the per-kind auto-extension logic).
 *
 * Both wirings were inlined because they close over a lot of Director
 * private state (`completed`, `taskWaiters`, `taskDescriptions`,
 * `appendSessionEvent`, `scheduleManifest`, `recordExtension`,
 * `maxBudgetExtensions`, `maxFleetCostUsd`, etc.). Pulling them out
 * without losing the closures requires a narrow `DirectorInternals`
 * shape — exactly what this module exposes.
 *
 * The constructor itself stays a member-initializer; the helpers below
 * are called *during* construction, after the relevant fields are
 * populated. Each helper ends with `coordinator.on(...)` /
 * `fleet.filter(...)` registration so the listener is wired exactly
 * once, at construction time.
 */

import type { TaskResult, TaskSpec } from '../types/multi-agent.js';

/** Cap on the in-memory `completed` map. Trimmed oldest-first when exceeded. */
export const MAX_COMPLETED = 10_000;

/** Narrow shape the wiring helpers need from a partially-constructed Director.
 *  The helpers accept a `Director` instance (structural typing — the class
 *  exposes every field this interface requires), so the constructor can pass
 *  `this` directly without an explicit cast.
 *
 *  Note: Private/protected members cannot be picked via Pick<> because keyof
 *  only returns public keys. We define the interface explicitly rather than
 *  deriving from Director to include private fields the wiring code needs. */
export interface DirectorInternals {
  id: string;
  directorRunId: string;
  completed: Map<string, import('../types/multi-agent.js').TaskResult>;
  taskWaiters: Map<
    string,
    { promise: Promise<import('../types/multi-agent.js').TaskResult>; resolve: (r: import('../types/multi-agent.js').TaskResult) => void }
  >;
  taskDescriptions: Map<string, string>;
  stateCheckpoint: import('../storage/director-state.js').DirectorStateCheckpoint | null;
  usage: import('./fleet-bus.js').FleetUsageAggregator;
  fleetManager: import('./fleet-manager.js').FleetManager | undefined;
  fleet: import('./fleet-bus.js').FleetBus;
  coordinator: import('./icoordinator.js').ICoordinator;
  maxBudgetExtensions: number;
  maxFleetCostUsd: number;
  recordExtension: (subagentId: string, taskId: string | undefined, kind: string, newLimit: number) => void;
  appendSessionEvent: (event: Parameters<import('../types/session.js').SessionWriter['append']>[0]) => Promise<void>;
  scheduleManifest: () => void;
  brain: import('./brain.js').BrainArbiter | undefined;
}

/** Payload shape for `budget.threshold_reached` events. */
interface BudgetThresholdPayload {
  kind: 'timeout' | 'idle_timeout' | 'iterations' | 'tool_calls' | 'tokens' | 'cost';
  used: number;
  limit: number;
  timeoutMs: number;
  extend: (extra: Record<string, unknown>) => void;
  deny: () => void;
}

const COLLAB_SUBAGENT_PREFIXES = ['bug-hunter-', 'refactor-planner-', 'critic-'] as const;

/** Returns true if the subagent id belongs to a Collab session
 *  (BugHunter / RefactorPlanner / Critic) whose budget routing is owned
 *  by the CollabSession, not the Director. */
function isCollabSubagent(subagentId: string): boolean {
  return COLLAB_SUBAGENT_PREFIXES.some((p) => subagentId.startsWith(p));
}

// Re-exported from subagent-budget.ts so that future consumers of
// budget.threshold_reached events can reference the same 85% lead point
// without a cross-module import. See subagent-budget.ts for the canonical
// definition and documentation.
export { TIMEOUT_PREEMPT_FRACTION } from './subagent-budget.js';

const HEARTBEAT_MAX_LIMIT_MS = 24 * 60 * 60_000; // 24h ceiling for timeout grants
const IDLE_HEARTBEAT_MAX_LIMIT_MS = 24 * 60 * 60_000; // same ceiling for idle_timeout grants
const ITERATIONS_CEILING = 50_000;
const TOOL_CALLS_CEILING = 100_000;
const TOKENS_CEILING = 5_000_000;
const COST_CEILING = 100; // $100 hard cap on a single cost extension

/**
 * Wire the coordinator's `task.completed` event into the Director's
 * in-memory wait table, the on-disk state checkpoint, and the session
 * JSONL event stream.
 *
 * Mirrors coordinator completion events into:
 * - `d.completed` (capped at `Director.MAX_COMPLETED`, oldest-first trim)
 * - `d.taskWaiters` (resolve and clear the matching waiter)
 * - `d.stateCheckpoint.recordTaskStatus(...)` + `setUsage(...)`
 * - session event stream via `d.appendSessionEvent(...)`
 * - fleet manifest via `d.fleetManager?.flushManifest()` or `d.scheduleManifest()`
 *
 * Returns the listener so the Director can call `coordinator.off(...)`
 * during `shutdown()`.
 */
export function wireTaskCompletedListener(d: DirectorInternals): (payload: { task: TaskSpec; result: TaskResult }) => void {
  // Trim oldest entries when the cap is exceeded — keep most recent
  // results so rollUp() and completedResults() still have data.

  const listener = (payload: { task: TaskSpec; result: TaskResult }): void => {
    const r = payload.result;
    d.completed.set(r.taskId, r);
    // Trim oldest entries when the cap is exceeded — keep most recent
    // results so rollUp() and completedResults() still have data.
    if (d.completed.size > MAX_COMPLETED) {
      const toDelete = d.completed.size - MAX_COMPLETED;
      const keys = [...d.completed.keys()].slice(0, toDelete);
      for (const k of keys) d.completed.delete(k);
    }
    const waiter = d.taskWaiters.get(r.taskId);
    if (waiter) {
      waiter.resolve(r);
      d.taskWaiters.delete(r.taskId);
    }
    // Mirror into the on-disk checkpoint + session event stream so a
    // crashed director leaves a complete picture of which tasks landed.
    const title = d.taskDescriptions.get(r.taskId) ?? payload.task.description ?? r.taskId;
    const failed = r.status !== 'success';
    // Disk-side state-checkpoint and session JSONL both store `error`
    // as a string for historical reasons. The structured SubagentError
    // envelope carries `kind`, `message`, `retryable`, etc. — flatten
    // to a `kind: message` string here so old readers stay valid and
    // grep-friendly. The full envelope is still available live via
    // the EventBus / TaskResult to in-process consumers.
    const errorString = r.error ? `${r.error.kind}: ${r.error.message}` : undefined;
    d.stateCheckpoint?.recordTaskStatus(r.taskId, {
      status: failed ? (r.status as 'failed' | 'timeout' | 'stopped') : 'completed',
      completedAt: new Date().toISOString(),
      iterations: r.iterations,
      toolCalls: r.toolCalls,
      durationMs: r.durationMs,
      error: errorString,
    });
    d.stateCheckpoint?.setUsage(d.usage.snapshot());
    void d.appendSessionEvent(
      failed
        ? {
            type: 'task_failed',
            ts: new Date().toISOString(),
            taskId: r.taskId,
            title,
            error: errorString ?? r.status,
          }
        : {
            type: 'task_completed',
            ts: new Date().toISOString(),
            taskId: r.taskId,
            title,
          },
    );
    // Flush immediately on task completion — the result should be
    // visible in the manifest without waiting for the debounce window.
    if (d.fleetManager) {
      d.fleetManager.flushManifest();
    } else {
      d.scheduleManifest();
    }
  };
  d.coordinator.on('task.completed', listener);
  return listener;
}

/**
 * Wire the FleetBus's `budget.threshold_reached` filter with the
 * Director's auto-extend/deny policy. Implements:
 *
 * - Heartbeat-driven timeout policy: while a subagent keeps executing
 *   tools it never dies on time; once it stops making progress between
 *   grants, deny. Wall-clock time alone is never a reliable "stuck" signal.
 * - Per-kind auto-extension with `maxBudgetExtensions` cap.
 * - Brain-decision routing when a brain arbiter is configured.
 * - Collab-subagent passthrough (BugHunter / RefactorPlanner / Critic
 *   own their own budget routing via the CollabSession).
 */
export function wireBudgetHandler(d: DirectorInternals): void {
  // Extension guard: a subagent that hits the same soft limit
  // `maxBudgetExtensions` times without completing is looping on a
  // prompt/config issue, not running out of budget legitimately.
  // After the configured number of extends we deny and let the task
  // fail — the host agent should then split the work or narrow the
  // scope. We track this per subagent+kind combination.
  const extendCounts = new Map<string, number>();
  // Per-subagent progress heartbeat: counts tool executions so the
  // timeout kind can extend indefinitely WHILE the agent is doing work,
  // yet still deny a wedged agent that produces no new tool calls
  // between grants.
  const progressBySubagent = new Map<string, number>();
  const lastTimeoutProgress = new Map<string, number>();

  d.fleet.filter('tool.executed', (e) => {
    progressBySubagent.set(e.subagentId, (progressBySubagent.get(e.subagentId) ?? 0) + 1);
  });

  d.fleet.filter('budget.threshold_reached', (e) => {
    const payload = e.payload as BudgetThresholdPayload;

    // Collab agents are NOT handled here — their CollabSession owns the
    // budget.threshold_reached routing. It calls session.cancel() (never
    // payload.deny()) when the Director decides to stop, so the agent
    // finishes naturally. The Director's auto-extend/deny logic would
    // conflict with that decision and must not run for collab subagents.
    if (isCollabSubagent(e.subagentId)) {
      return;
    }

    // Both timeout kinds — wall-clock `timeout` and `idle_timeout` (the
    // default roster guard) — are governed by the heartbeat, not the
    // extension cap. While the subagent keeps executing tools it never
    // dies on time; once it stops making progress between grants, it's
    // genuinely stuck → deny.
    if (payload.kind === 'timeout' || payload.kind === 'idle_timeout') {
      const heartbeatKey = `${e.subagentId}:${payload.kind}`;
      const progress = progressBySubagent.get(e.subagentId) ?? 0;
      const lastProgress = lastTimeoutProgress.get(heartbeatKey) ?? -1;
      if (progress <= lastProgress) {
        payload.deny();
        return;
      }
      lastTimeoutProgress.set(heartbeatKey, progress);
      const field = payload.kind === 'timeout' ? 'timeoutMs' : 'idleTimeoutMs';
      const ceiling = payload.kind === 'timeout' ? HEARTBEAT_MAX_LIMIT_MS : IDLE_HEARTBEAT_MAX_LIMIT_MS;
      setImmediate(() => {
        const newLimit = Math.min(Math.ceil(payload.limit * 2), ceiling);
        d.recordExtension(e.subagentId, e.taskId, payload.kind, newLimit);
        payload.extend({ [field]: newLimit });
      });
      return;
    }

    const guardKey = `${e.subagentId}:${payload.kind}`;
    const prior = extendCounts.get(guardKey) ?? 0;
    if (prior >= d.maxBudgetExtensions) {
      payload.deny();
      extendCounts.delete(guardKey);
      return;
    }

    if (payload.kind === 'cost' && d.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
      const totalCost = d.usage.snapshot().total?.cost ?? 0;
      if (totalCost >= d.maxFleetCostUsd) {
        payload.deny();
        return;
      }
    }

    const grantExtension = (): void => {
      setImmediate(() => {
        const extra: Record<string, unknown> = {};
        const base = Math.max(payload.limit, payload.used);
        const grow = (ceiling: number) => Math.min(Math.ceil(base * 1.5), ceiling);
        let newLimit = base;
        switch (payload.kind) {
          case 'iterations':
            newLimit = grow(ITERATIONS_CEILING);
            extra.maxIterations = newLimit;
            break;
          case 'tool_calls':
            newLimit = grow(TOOL_CALLS_CEILING);
            extra.maxToolCalls = newLimit;
            break;
          case 'tokens':
            newLimit = grow(TOKENS_CEILING);
            extra.maxTokens = newLimit;
            break;
          case 'cost':
            newLimit = Math.min(base * 1.5, COST_CEILING);
            extra.maxCostUsd = newLimit;
            break;
        }
        extendCounts.set(guardKey, prior + 1);
        d.recordExtension(e.subagentId, e.taskId, payload.kind, newLimit);
        payload.extend(extra);
      });
    };

    if (d.brain) {
      void d.brain
        .decide({
          id: `director-budget-${e.subagentId}-${payload.kind}`,
          sessionId: d.directorRunId,
          source: 'director',
          question: `Should the director extend the ${payload.kind} budget for subagent ${e.subagentId}?`,
          context: [
            e.taskId ? `Task id: ${e.taskId}` : undefined,
            `Used: ${payload.used}`,
            `Limit: ${payload.limit}`,
            `Prior extensions for this kind: ${prior}`,
          ]
            .filter(Boolean)
            .join('\n'),
          risk: payload.kind === 'cost' ? 'high' : 'medium',
          fallback: 'continue',
          options: [
            {
              id: 'extend',
              label: 'Grant the director default budget extension',
              consequence: 'The subagent continues with a larger per-kind budget.',
              risk: payload.kind === 'cost' ? 'high' : 'medium',
              recommended: true,
            },
            {
              id: 'stop',
              label: 'Stop this subagent at the current budget limit',
              consequence: 'The current task will fail or stop due to budget pressure.',
              risk: 'low',
            },
          ],
        })
        .then((decision) => {
          if (decision.type === 'deny') {
            payload.deny();
            return;
          }
          if (decision.type === 'ask_human') {
            payload.deny();
            return;
          }
          if (decision.optionId === 'stop' || /\bstop\b/i.test(decision.text)) {
            payload.deny();
            return;
          }
          grantExtension();
        })
        .catch(() => payload.deny());
      return;
    }

    grantExtension();
  });
}
