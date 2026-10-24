import type { TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { BrainDecision, BrainDecisionOption } from '../brain/brain.js';

import type {
  FleetSupervisorOptions,
  ResolvedSupervisorConfig,
  SupervisorLogEntry,
} from './fleet-supervisor-rebalance-types.js';
export interface FleetSupervisorRebalanceHost {
  cooldownOk: (kind: string, subject: string) => boolean;
  interventionBudgetOk: (subagentId: string) => boolean;
  engaging: boolean;
  /**
   * True once `stop()` has been called.
   *
   * An engagement is suspended across `await host.decide(...)`, and that brain
   * call can take seconds. `stop()` cannot cancel it, so every engagement MUST
   * re-check this after the await before mutating the fleet — otherwise
   * `/supervisor off` ("no further automatic interventions this session")
   * still lands a retarget/steer/spawn from the decision already in flight.
   */
  stopped: boolean;
  emitSignal: (kind: string, detail: string, subagentId?: string, taskId?: string) => void;
  decide: (
    question: string,
    context: string,
    options: BrainDecisionOption[],
    risk: 'low' | 'medium' | 'high',
  ) => Promise<{ choice: string | null; decision: BrainDecision }>;
  record: (entry: Omit<SupervisorLogEntry, 'at'>) => void;
  recordIntervention: (subagentId: string) => void;
  opts: FleetSupervisorOptions;
  emitAction: (
    action: 'retarget' | 'spawn_helper' | 'steer' | 'notify_leader' | 'terminate',
    ok: boolean,
    detail: string,
    subagentId?: string,
    taskId?: string,
  ) => void;
  retargetedTasks: Set<string>;
  cfg: ResolvedSupervisorConfig;
}
export async function engageRebalance(
  host: FleetSupervisorRebalanceHost,
  kind: 'pinned_starvation' | 'overloaded_worker',
  fromWorkerId: string,
  tasks: TaskSpec[],
  idleWorkerIds: string[],
): Promise<void> {
  if (!host.cooldownOk(kind, fromWorkerId) || !host.interventionBudgetOk(fromWorkerId)) return;
  host.engaging = true;
  try {
    const taskList = tasks.map((t) => `- ${t.id}: ${t.description.slice(0, 80)}`).join('\n');
    host.emitSignal(
      kind,
      `${tasks.length} pending task(s) pinned to busy worker ${fromWorkerId} while ${idleWorkerIds.length} worker(s) idle`,
      fromWorkerId,
      tasks[0]?.id,
    );
    const { choice, decision } = await host.decide(
      `Worker ${fromWorkerId} is busy with ${tasks.length} more task(s) queued behind it while ${idleWorkerIds.length} sibling worker(s) sit idle. Rebalance the queued tasks to the idle workers?`,
      `Queued behind ${fromWorkerId}:\n${taskList}\nIdle workers: ${idleWorkerIds.join(', ')}`,
      [
        {
          id: 'rebalance',
          label: 'Move the queued task(s) to idle worker(s)',
          consequence: 'Only unstarted tasks move; the running task is untouched.',
          risk: 'low',
          recommended: true,
        },
        { id: 'wait', label: 'Leave the queue as is', risk: 'low' },
      ],
      'low',
    );
    if (host.stopped) {
      host.record({
        kind,
        subagentId: fromWorkerId,
        proposedAction: 'retarget',
        outcome: 'skipped',
        detail: 'supervisor stopped while the decision was in flight',
      });
      return;
    }
    if (choice !== 'rebalance') {
      host.record({
        kind,
        subagentId: fromWorkerId,
        proposedAction: 'retarget',
        outcome: decision.type === 'answer' ? 'denied' : 'escalated',
        detail: decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
      });
      return;
    }
    host.recordIntervention(fromWorkerId);
    const moved: string[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const target = idleWorkerIds[i % idleWorkerIds.length];
      if (!task || !target) continue;
      const ok = await host.opts.actions.retargetPendingTask(task.id, target);
      host.emitAction('retarget', ok, `→ ${target}`, fromWorkerId, task.id);
      if (ok) {
        host.retargetedTasks.add(task.id);
        moved.push(`${task.id} → ${target}`);
      }
    }
    host.record({
      kind,
      subagentId: fromWorkerId,
      taskId: tasks[0]?.id,
      proposedAction: 'retarget',
      outcome: 'approved',
      detail:
        moved.length > 0 ? `moved ${moved.join(', ')}` : 'nothing movable (already dispatched)',
    });
    if (moved.length > 0) {
      await host.opts.actions
        .steerAgent(
          fromWorkerId,
          'Workload reduced by fleet supervisor',
          `The fleet supervisor moved ${moved.length} of your queued task(s) to idle workers: ${moved.join(
            ', ',
          )}. Do not start them — focus on your current task.`,
        )
        .catch(() => {});
      await host.opts.actions
        .notifyLeader(
          'Fleet rebalanced',
          `Supervisor moved ${moved.length} queued task(s) off busy worker ${fromWorkerId}: ${moved.join(', ')}.`,
          fromWorkerId,
        )
        .catch(() => {});
    }
  } catch {
    // The supervisor must never destabilize the fleet it protects.
  } finally {
    host.engaging = false;
  }
}

export async function engageBacklog(
  host: FleetSupervisorRebalanceHost,
  pending: readonly TaskSpec[],
  liveWorkers: number,
): Promise<void> {
  if (!host.cooldownOk('backlog', 'fleet')) return;
  host.engaging = true;
  try {
    const pendingCount = pending.length;
    host.emitSignal('backlog', `${pendingCount} pending tasks vs ${liveWorkers} live worker(s)`);
    const { choice, decision } = await host.decide(
      `The task queue is deep: ${pendingCount} pending tasks for ${liveWorkers} live worker(s). Spawn one additional helper worker to drain it?`,
      `Pending: ${pendingCount}, live workers: ${liveWorkers}, factor threshold: ${host.cfg.backlogFactor}x`,
      [
        {
          id: 'spawn',
          label: 'Spawn one helper worker',
          consequence: 'One more subagent joins the fleet and takes queued work.',
          risk: 'medium',
          recommended: true,
        },
        { id: 'wait', label: 'Let the current fleet drain the queue', risk: 'low' },
      ],
      'medium',
    );
    if (host.stopped) {
      host.record({
        kind: 'backlog',
        proposedAction: 'spawn_helper',
        outcome: 'skipped',
        detail: 'supervisor stopped while the decision was in flight',
      });
      return;
    }
    if (choice !== 'spawn') {
      host.record({
        kind: 'backlog',
        proposedAction: 'spawn_helper',
        outcome: decision.type === 'answer' ? 'denied' : 'escalated',
        detail: decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
      });
      return;
    }
    const res = await host.opts.actions.spawnHelper({
      reason: `queue backlog: ${pendingCount} pending / ${liveWorkers} workers`,
      task: pending[0],
    });
    if ('subagentId' in res) {
      host.emitAction('spawn_helper', true, res.subagentId, res.subagentId);
      host.record({
        kind: 'backlog',
        subagentId: res.subagentId,
        proposedAction: 'spawn_helper',
        outcome: 'approved',
        detail: `spawned ${res.subagentId}`,
      });
      await host.opts.actions
        .notifyLeader(
          'Fleet helper spawned',
          `Supervisor spawned helper ${res.subagentId} to drain a ${pendingCount}-task backlog.`,
          res.subagentId,
        )
        .catch(() => {});
    } else {
      host.emitAction('spawn_helper', false, res.error);
      host.record({
        kind: 'backlog',
        proposedAction: 'spawn_helper',
        outcome: 'error',
        detail: res.error,
      });
      await host.opts.actions
        .notifyLeader(
          'Fleet backlog needs attention',
          `Queue is ${pendingCount} deep for ${liveWorkers} worker(s); supervisor could not spawn a helper (${res.error}). Consider rebalancing or finishing tasks before assigning more.`,
        )
        .catch(() => {});
    }
  } catch {
    /* never destabilize the fleet */
  } finally {
    host.engaging = false;
  }
}
