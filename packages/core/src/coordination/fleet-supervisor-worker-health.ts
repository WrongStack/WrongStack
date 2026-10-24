/**
 * Worker-health engagements (looping, stuck, failure streak, idle-with-work)
 * for FleetSupervisor. Split out of fleet-supervisor.ts; driven through the
 * same FleetSupervisorRebalanceHost as the rebalance engagements.
 */
import type { BrainDecisionOption } from '../brain/brain.js';
import type { FleetSupervisorRebalanceHost } from './fleet-supervisor-rebalance.js';
import type { SupervisedSubagent } from './fleet-supervisor-rebalance-types.js';

/**
 * A worker whose own loop detector has tripped `loopStreak` times without
 * finishing a task. Steering is the default because the detector's own cut
 * already ends the offending turn; termination is offered only when the
 * operator opted into it, matching the failure-streak path.
 */
export async function engageLooping(
  host: FleetSupervisorRebalanceHost,
  s: SupervisedSubagent,
  hits: number,
): Promise<void> {
  if (!host.cooldownOk('looping_agent', s.id) || !host.interventionBudgetOk(s.id)) return;
  host.engaging = true;
  try {
    host.emitSignal('looping_agent', `${hits} loop detections with no completed task`, s.id);
    const options: BrainDecisionOption[] = [
      {
        id: 'steer',
        label: 'Send a corrective steer to the worker',
        consequence: 'A steer mail is injected before its next step.',
        risk: 'low',
        recommended: true,
      },
      { id: 'wait', label: 'Give it more time', risk: 'low' },
    ];
    if (host.cfg.allowTerminate) {
      options.splice(1, 0, {
        id: 'terminate',
        label: 'Terminate the worker and reassign its work',
        consequence: 'The worker is aborted; its pending tasks need reassigning.',
        risk: 'medium',
        recommended: false,
      });
    }
    const { choice, decision } = await host.decide(
      `Worker ${s.name} (${s.id}) has tripped its loop detector ${hits} times without completing a task — it is busy but repeating itself.`,
      `Current task: ${s.currentTask ?? 'unknown'}`,
      options,
      'medium',
    );
    if (host.stopped) {
      host.record({
        kind: 'looping_agent',
        subagentId: s.id,
        proposedAction: 'steer|terminate',
        outcome: 'skipped',
        detail: 'supervisor stopped while the decision was in flight',
      });
      return;
    }
    if (choice === 'terminate' && host.cfg.allowTerminate) {
      host.recordIntervention(s.id);
      await host.opts.actions.terminate(s.id);
      host.emitAction('terminate', true, `${hits} loop detections`, s.id);
      await host.opts.actions
        .notifyLeader(
          `Worker ${s.name} terminated for looping`,
          `Supervisor terminated ${s.id} after ${hits} loop detections with no completed task. Reassign its pending work.`,
          s.id,
        )
        .catch(() => {});
      host.record({
        kind: 'looping_agent',
        subagentId: s.id,
        proposedAction: 'terminate',
        outcome: 'approved',
        detail: `terminated after ${hits} loop detections`,
      });
      return;
    }
    if (choice !== 'steer') {
      host.record({
        kind: 'looping_agent',
        subagentId: s.id,
        proposedAction: host.cfg.allowTerminate ? 'steer|terminate' : 'steer',
        outcome: decision.type === 'answer' ? 'denied' : 'escalated',
        detail: decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
      });
      return;
    }
    host.recordIntervention(s.id);
    await host.opts.actions.steerAgent(
      s.id,
      'Loop detected by fleet supervisor',
      `Your loop detector has tripped ${hits} times on: ${
        s.currentTask ?? 'your current task'
      }. You are repeating work, not advancing it. Stop retrying the same step: state what is blocking you via mail_send to the leader, then either take a genuinely different approach or hand the task back.`,
    );
    host.emitAction('steer', true, 'loop nudge', s.id);
    await host.opts.actions
      .notifyLeader(
        `Worker ${s.name} is looping`,
        `${hits} loop detections with no completed task. Supervisor steered it; consider terminate_subagent + reassigning if it keeps circling.`,
        s.id,
      )
      .catch(() => {});
    host.record({
      kind: 'looping_agent',
      subagentId: s.id,
      proposedAction: 'steer',
      outcome: 'approved',
      detail: 'steered + leader notified',
    });
  } catch {
    /* never destabilize the fleet */
  } finally {
    host.engaging = false;
  }
}

export async function engageStuck(
  host: FleetSupervisorRebalanceHost,
  s: SupervisedSubagent,
): Promise<void> {
  if (!host.cooldownOk('stuck_agent', s.id) || !host.interventionBudgetOk(s.id)) return;
  host.engaging = true;
  try {
    host.emitSignal(
      'stuck_agent',
      `no observable activity for ≥${Math.round(host.cfg.stuckMs / 1000)}s`,
      s.id,
    );
    const { choice, decision } = await host.decide(
      `Worker ${s.name} (${s.id}) is marked running but produced no observable activity for over ${Math.round(host.cfg.stuckMs / 1000)}s. Nudge it with a steer message?`,
      `Current task: ${s.currentTask ?? 'unknown'}`,
      [
        {
          id: 'steer',
          label: 'Send a corrective steer to the worker',
          consequence: 'A steer mail is injected before its next step.',
          risk: 'low',
          recommended: true,
        },
        { id: 'wait', label: 'Give it more time', risk: 'low' },
      ],
      'medium',
    );
    if (host.stopped) {
      host.record({
        kind: 'stuck_agent',
        subagentId: s.id,
        proposedAction: 'steer',
        outcome: 'skipped',
        detail: 'supervisor stopped while the decision was in flight',
      });
      return;
    }
    if (choice !== 'steer') {
      host.record({
        kind: 'stuck_agent',
        subagentId: s.id,
        proposedAction: 'steer',
        outcome: decision.type === 'answer' ? 'denied' : 'escalated',
        detail: decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
      });
      return;
    }
    host.recordIntervention(s.id);
    await host.opts.actions.steerAgent(
      s.id,
      'Progress check from fleet supervisor',
      `You appear stalled (no observable activity for ${Math.round(host.cfg.stuckMs / 1000)}s on: ${
        s.currentTask ?? 'your current task'
      }). If you are blocked, say so via mail_send to the leader and either narrow the scope or hand the task back — do not keep silently retrying the same step.`,
    );
    host.emitAction('steer', true, 'stuck nudge', s.id);
    await host.opts.actions
      .notifyLeader(
        `Worker ${s.name} may be stuck`,
        `No observable activity for ${Math.round(host.cfg.stuckMs / 1000)}s. Supervisor nudged it; consider terminate_subagent + reassigning if it stays silent.`,
        s.id,
      )
      .catch(() => {});
    host.record({
      kind: 'stuck_agent',
      subagentId: s.id,
      proposedAction: 'steer',
      outcome: 'approved',
      detail: 'steered + leader notified',
    });
  } catch {
    /* never destabilize the fleet */
  } finally {
    host.engaging = false;
  }
}

export async function engageFailureStreak(
  host: FleetSupervisorRebalanceHost,
  subagentId: string,
  streak: number,
): Promise<void> {
  if (!host.cooldownOk('failure_streak', subagentId) || !host.interventionBudgetOk(subagentId)) {
    return;
  }
  host.engaging = true;
  try {
    host.emitSignal('failure_streak', `${streak} consecutive failed/timeout tasks`, subagentId);
    const options: BrainDecisionOption[] = [
      {
        id: 'steer',
        label: 'Steer the worker to change approach',
        risk: 'low',
        recommended: true,
      },
      { id: 'observe', label: 'Keep observing', risk: 'low' },
    ];
    if (host.cfg.allowTerminate) {
      options.push({
        id: 'terminate',
        label: 'Terminate the worker',
        consequence: 'Its current task fails; pending pinned tasks need reassignment.',
        risk: 'high',
      });
    }
    const { choice, decision } = await host.decide(
      `Worker ${subagentId} produced ${streak} consecutive failed/timed-out tasks. Intervene?`,
      `Consecutive failures: ${streak}`,
      options,
      'high',
    );
    if (host.stopped) {
      host.record({
        kind: 'failure_streak',
        subagentId,
        proposedAction: host.cfg.allowTerminate ? 'steer|terminate' : 'steer',
        outcome: 'skipped',
        detail: 'supervisor stopped while the decision was in flight',
      });
      return;
    }
    if (choice === 'terminate' && host.cfg.allowTerminate) {
      host.recordIntervention(subagentId);
      await host.opts.actions.terminate(subagentId);
      host.emitAction('terminate', true, `${streak} consecutive failures`, subagentId);
      await host.opts.actions
        .notifyLeader(
          `Worker ${subagentId} terminated`,
          `Supervisor terminated ${subagentId} after ${streak} consecutive failures. Reassign its pending work.`,
          subagentId,
        )
        .catch(() => {});
      host.record({
        kind: 'failure_streak',
        subagentId,
        proposedAction: 'terminate',
        outcome: 'approved',
        detail: `terminated after ${streak} failures`,
      });
      return;
    }
    if (choice === 'steer') {
      host.recordIntervention(subagentId);
      await host.opts.actions.steerAgent(
        subagentId,
        'Change of approach required',
        `Your last ${streak} tasks failed. Stop, re-read the task, and take a different approach — if the task itself is impossible or under-specified, report that to the leader via mail_send instead of retrying.`,
      );
      host.emitAction('steer', true, 'failure streak', subagentId);
      await host.opts.actions
        .notifyLeader(
          `Worker ${subagentId} failing repeatedly`,
          `${streak} consecutive failures. Supervisor steered it; consider reassigning its work if the next task also fails.`,
          subagentId,
        )
        .catch(() => {});
      host.record({
        kind: 'failure_streak',
        subagentId,
        proposedAction: 'steer',
        outcome: 'approved',
        detail: `steered after ${streak} failures`,
      });
      return;
    }
    host.record({
      kind: 'failure_streak',
      subagentId,
      proposedAction: host.cfg.allowTerminate ? 'steer|terminate' : 'steer',
      outcome: decision.type === 'answer' ? 'denied' : 'escalated',
      detail: decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
    });
  } catch {
    /* never destabilize the fleet */
  } finally {
    host.engaging = false;
  }
}

export async function engageIdleWithWork(
  host: FleetSupervisorRebalanceHost,
  idleCount: number,
  pendingCount: number,
): Promise<void> {
  if (!host.cooldownOk('idle_with_work', 'fleet')) return;
  host.engaging = true;
  try {
    host.emitSignal(
      'idle_with_work',
      `${idleCount} idle worker(s) while ${pendingCount} task(s) cannot dispatch`,
    );
    // Pure notification — host state means tasks are pinned to
    // non-running workers or otherwise blocked; the leader owns the fix.
    await host.opts.actions.notifyLeader(
      'Idle workers with undispatchable tasks',
      `${idleCount} worker(s) idle while ${pendingCount} task(s) stay pending (likely pinned to stopped/errored workers). Reassign them with assign_task or let the supervisor retarget by unpinning.`,
    );
    host.emitAction('notify_leader', true, 'idle_with_work');
    host.record({
      kind: 'idle_with_work',
      proposedAction: 'notify_leader',
      outcome: 'approved',
      detail: `${idleCount} idle / ${pendingCount} pending`,
    });
  } catch {
    /* never destabilize the fleet */
  } finally {
    host.engaging = false;
  }
}
