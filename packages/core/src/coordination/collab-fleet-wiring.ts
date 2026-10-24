/**
 * FleetBus wiring of a {@link CollabSession} (collab-debug.ts): progress
 * tracking, budget-threshold negotiation, director cancel, and collection of
 * the session's own findings / plans / evaluations — plus the ownership and
 * result-parsing helpers those subscriptions rely on.
 */

import type { TaskResult } from '@wrongstack/contracts/types/multi-agent';
import type {
  BugFinding,
  BugFoundPayload,
  CollabSessionOptions,
  CriticEvaluation,
  CriticEvaluationPayload,
  DirectorAlert,
  DirectorCancelCollabPayload,
  RefactorPlan,
  RefactorPlanPayload,
} from './collab-debug-types.js';
import { DirectorAlertLevel } from './collab-debug-types.js';
import type { CollabDirectorHost } from './collab-director-host.js';
import type { FleetBus } from './fleet-bus.js';
import { validateFleetEventEmission } from './fleet-event-validation.js';

/** ID prefixes for the three collab-debug agent roles. Used by ownsSubagent. */
const COLLAB_ID_PREFIXES = ['bug-hunter-', 'refactor-planner-', 'critic-'];

/** Role of a collab subagent: the tracked map first, then the deterministic id prefix. */
export function collabRoleFromSubagentId(
  subagentIds: ReadonlyMap<string, string>,
  subagentId: string,
): string | null {
  // Fast path: check tracked subagentIds map first (normal case during session).
  for (const [role, id] of subagentIds) {
    if (id === subagentId) return role;
  }
  // Fallback: derive from id prefix pattern used in spawnAgent.
  // Handles budget events that fire before subagentIds entry is populated
  // (edge case at session start — race between first tool call and map insert).
  const match = subagentId.match(/^(bug-hunter|refactor-planner|critic)/);
  return match?.[1] ?? null;
}

/** True when `subagentId` belongs to the session — see CollabSession.ownsSubagent. */
export function collabOwnsSubagent(
  subagentIds: ReadonlyMap<string, string>,
  sessionId: string,
  subagentId: string,
): boolean {
  for (const id of subagentIds.values()) {
    if (id === subagentId) return true;
  }
  // Startup race fallback: accept only the exact ids this session requested.
  // Keep this fallback active until all three spawns settle: once the first
  // agent is recorded, either sibling can still emit before spawn() returns
  // its runtime id and records it in subagentIds.
  return COLLAB_ID_PREFIXES.some((prefix) => subagentId === `${prefix}${sessionId}`);
}

/** Parse a finished collab task's JSON objects and re-emit the valid ones on the FleetBus. */
export function emitCollabResultEvents(
  fleetBus: FleetBus,
  result: TaskResult,
  extractJsonObjects: (text: string) => Array<Record<string, unknown>>,
  roleOf: (subagentId: string) => string | null,
): void {
  if (result.status !== 'success' || result.result == null) return;
  const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);

  for (const obj of extractJsonObjects(text)) {
    const type =
      'finding' in obj
        ? 'bug.found'
        : 'plan' in obj
          ? 'refactor.plan'
          : 'evaluation' in obj
            ? 'critic.evaluation'
            : null;
    if (!type) continue;
    const validationError = validateFleetEventEmission(
      type,
      obj,
      roleOf(result.subagentId) ?? undefined,
    );
    if (validationError) continue;
    fleetBus.emit({
      subagentId: result.subagentId,
      taskId: result.taskId,
      ts: Date.now(),
      type,
      payload: obj,
    });
  }
}

/** The session state the FleetBus subscriptions read and write. */
export interface CollabFleetWiringHost {
  readonly sessionId: string;
  readonly director: CollabDirectorHost;
  readonly fleetBus: FleetBus;
  readonly options: CollabSessionOptions;
  readonly alerts: DirectorAlert[];
  readonly disposers: (() => void)[];
  readonly progressBySubagent: Map<string, number>;
  readonly lastTimeoutProgress: Map<string, number>;
  readonly bugs: Map<string, BugFinding>;
  readonly plans: Map<string, RefactorPlan>;
  readonly evaluations: Map<string, CriticEvaluation>;
  ownsSubagent(subagentId: string): boolean;
  roleFromSubagentId(subagentId: string): string | null;
  cancel(reason: string): void;
  /** A director cancel signal arrived: mark cancelled and stop the session timer. */
  markCancelledByDirector(): void;
  emit(event: string, payload: unknown): void;
}

export function wireCollabFleetBus(host: CollabFleetWiringHost): void {
  // Track tool executions for progress-based timeout decisions.
  // Ownership guard: only count THIS session's agents so a concurrent
  // collab session's tool calls don't pollute the progress tracker.
  const dTool = host.fleetBus.filter('tool.executed', (e) => {
    if (!host.ownsSubagent(e.subagentId)) return;
    host.progressBySubagent.set(e.subagentId, (host.progressBySubagent.get(e.subagentId) ?? 0) + 1);
  });
  host.disposers.push(dTool);

  // budget.threshold_reached → Director's alert handler
  // Ownership guard: only handle THIS session's agents. Without it a
  // concurrent collab session's budget events would race here — both
  // sessions' heartbeat gates would call extend/deny on the same event.
  const dBudget = host.fleetBus.filter('budget.threshold_reached', (e) => {
    if (!host.ownsSubagent(e.subagentId)) return;
    const payload = e.payload as {
      kind: 'timeout' | 'idle_timeout' | 'iterations' | 'tool_calls' | 'tokens' | 'cost';
      used: number;
      limit: number;
      timeoutMs?: number | undefined;
      extend: (extra: Record<string, unknown>) => void;
      deny: () => void;
    };
    const role = host.roleFromSubagentId(e.subagentId);
    if (!role) return;

    // Gather /btw notes so the Director can inspect them before deciding
    const btwNotes = host.director.getLeaderBtwNotes();

    const alert: DirectorAlert = {
      sessionId: host.sessionId,
      subagentId: e.subagentId,
      role,
      level: DirectorAlertLevel.WARNING,
      message: `${role} hit ${payload.kind} soft limit (${payload.used}/${payload.limit})`,
      budgetKind: payload.kind,
      // `used` is elapsed milliseconds for timeout kinds. `timeoutMs` is the
      // negotiation response deadline (normally 60s), not agent runtime.
      elapsedMs:
        payload.kind === 'timeout' || payload.kind === 'idle_timeout' ? payload.used : undefined,
      limit: payload.limit,
      btwNotes,
    };

    host.alerts.push(alert);

    host.fleetBus.emit({
      subagentId: e.subagentId,
      ts: Date.now(),
      type: 'collab.warning',
      payload: alert,
    });

    const decision = host.options.onBudgetWarning?.(alert) ?? 'ignore';

    if (decision === 'cancel') {
      host.cancel(`Director cancelled: ${role} ${payload.kind} threshold`);
      return;
    }

    // Progress-based timeout handling: extend if agent is doing work,
    // deny only if genuinely stuck (no tool calls since last grant).
    // Both wall-clock timeout and idle timeout use this heartbeat-aware path.
    if (payload.kind === 'timeout' || payload.kind === 'idle_timeout') {
      const progress = host.progressBySubagent.get(e.subagentId) ?? 0;
      const lastProgress = host.lastTimeoutProgress.get(e.subagentId) ?? -1;
      if (progress <= lastProgress) {
        payload.deny();
        return;
      }
      host.lastTimeoutProgress.set(e.subagentId, progress);
      // Extend the agent's current wall/idle limit. `payload.timeoutMs` is
      // only how long the coordinator may take to answer this negotiation;
      // using it here can shrink a 15-minute agent budget to 2 minutes.
      const newLimit = Math.min(Math.ceil(payload.limit * 2), 24 * 60 * 60_000);
      setImmediate(() => {
        const field = payload.kind === 'timeout' ? 'timeoutMs' : 'idleTimeoutMs';
        payload.extend({ [field]: newLimit });
      });
      return;
    }

    if (decision === 'extend') {
      setImmediate(() => {
        const base = Math.max(payload.limit, payload.used);
        const extra: Record<string, unknown> = {};
        switch (payload.kind) {
          case 'iterations':
            extra.maxIterations = Math.min(Math.ceil(base * 1.5), 50_000);
            break;
          case 'tool_calls':
            extra.maxToolCalls = Math.min(Math.ceil(base * 1.5), 100_000);
            break;
          case 'tokens':
            extra.maxTokens = Math.min(Math.ceil(base * 1.5), 5_000_000);
            break;
          case 'cost':
            extra.maxCostUsd = Math.min(base * 1.5, 100);
            break;
        }
        payload.extend(extra);
      });
      return;
    }

    // 'ignore' (or any unrecognized decision): apply a conservative
    // auto-extension for the remaining non-timeout kinds so the session
    // keeps making progress rather than hitting a hard limit. The Director
    // sees the collab.warning event and can always call cancelCollabSession()
    // if the pattern looks like a bad infinite loop.
    //
    // Both 'timeout' and 'idle_timeout' are already fully handled by the
    // progress-based logic above (which returns), so TypeScript narrows
    // payload.kind to exclude them here — the switch below only sees
    // iterations / tool_calls / tokens / cost.
    setImmediate(() => {
      const base = Math.max(payload.limit, payload.used);
      const extra: Record<string, unknown> = {};
      switch (payload.kind) {
        case 'iterations':
          extra.maxIterations = Math.min(Math.ceil(base * 1.25), 50_000);
          break;
        case 'tool_calls':
          extra.maxToolCalls = Math.min(Math.ceil(base * 1.25), 100_000);
          break;
        case 'tokens':
          extra.maxTokens = Math.min(Math.ceil(base * 1.25), 5_000_000);
          break;
        case 'cost':
          extra.maxCostUsd = Math.min(base * 1.25, 100);
          break;
      }
      payload.extend(extra);
    });
  });
  host.disposers.push(dBudget);

  // Director cancel signal
  const dCancel = host.fleetBus.filter('director.cancel_collab', (e) => {
    const payload = e.payload as DirectorCancelCollabPayload;
    if (payload.sessionId !== host.sessionId) return;
    host.markCancelledByDirector();
    host.fleetBus.emit({
      subagentId: host.director.id,
      ts: Date.now(),
      type: 'collab.cancelled',
      payload: { sessionId: host.sessionId, reason: payload.reason },
    });
  });
  host.disposers.push(dCancel);

  // bug.found → RefactorPlanner + Critic
  // Ownership guard: only collect THIS session's findings. A concurrent
  // collab session's bug-hunter emits the same event type — without this
  // guard both sessions' reports contain the union of both sessions' bugs.
  const d1 = host.fleetBus.filter('bug.found', (e) => {
    if (!host.ownsSubagent(e.subagentId)) return;
    const payload = e.payload as BugFoundPayload;
    if (payload?.finding) {
      host.bugs.set(payload.finding.id, payload.finding);
      host.emit('bug.found', payload);
    }
  });
  host.disposers.push(d1);

  // refactor.plan → Critic
  // Ownership guard: only collect THIS session's plans (same rationale).
  const d2 = host.fleetBus.filter('refactor.plan', (e) => {
    if (!host.ownsSubagent(e.subagentId)) return;
    const payload = e.payload as RefactorPlanPayload;
    if (payload?.plan) {
      host.plans.set(payload.plan.id, payload.plan);
      host.emit('refactor.plan', payload);
    }
  });
  host.disposers.push(d2);

  // critic.evaluation
  // Ownership guard: only collect THIS session's evaluations (same rationale).
  const d3 = host.fleetBus.filter('critic.evaluation', (e) => {
    if (!host.ownsSubagent(e.subagentId)) return;
    const payload = e.payload as CriticEvaluationPayload;
    if (payload?.evaluation) {
      host.evaluations.set(payload.evaluation.id, payload.evaluation);
      host.emit('critic.evaluation', payload);
    }
  });
  host.disposers.push(d3);
}
