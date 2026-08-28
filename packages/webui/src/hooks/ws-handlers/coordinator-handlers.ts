import { toast } from '@/components/Toaster';
import { messageSessionId } from '@/lib/ws-client-utils';
import { useCoordinatorMonitorStore } from '@/stores';
import { activeLaneId } from '@/stores/chat-lanes';
import type { WSServerMessage } from '@/types';

/**
 * Coordinator Monitor handlers.
 *
 * A coordinator run — status, task queue, consensus votes, budget alerts —
 * belongs to the tab that started it. The store used to be one global
 * snapshot, so this map was gated at export and every background tab's task
 * lifecycle was DROPPED: a tab that ran a fleet while another was in front
 * came back to an empty monitor. Dropping is not isolation, it is loss.
 *
 * `useCoordinatorMonitorStore` is now one instance per session, so each
 * handler writes to the lane the message NAMES (`monitorFor`) and nothing is
 * discarded. An untagged message — every single-session surface sends only
 * those — lands in the default lane, exactly as before.
 *
 * Toasts are the one thing that stays foreground-only: a toast is a claim on
 * the screen, and the screen belongs to the tab in front.
 */

/** The coordinator snapshot of the tab this message belongs to. */
function monitorFor(msg: WSServerMessage) {
  return useCoordinatorMonitorStore.for(messageSessionId(msg)).getState();
}

/** Is this message from the tab the user is looking at? Toasts only. */
function isForeground(msg: WSServerMessage): boolean {
  const id = messageSessionId(msg);
  return !id || id === activeLaneId();
}
const coordinatorHandlers: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'coordinator.status': (msg: WSServerMessage) => {
    const p = msg.payload as {
      status: string;
      mode?: string;
      subagentCount?: number;
      taskQueue?: { pending: number; running: number; completed: number; failed: number };
    };
    monitorFor(msg).setCoordinatorStatus(
      p.status as 'idle' | 'running' | 'draining' | 'stopped',
      p.mode,
    );
    if (p.taskQueue) {
      monitorFor(msg).updateCoordinatorStats({
        total: p.subagentCount ?? 0,
        running: 0,
        idle: 0,
        stopped: 0,
        inFlight: p.taskQueue.running,
        pending: p.taskQueue.pending,
        completed: p.taskQueue.completed,
      });
    }
  },
  'coordinator.stats': (msg: WSServerMessage) => {
    const p = msg.payload as {
      total: number;
      running: number;
      idle: number;
      stopped: number;
      inFlight: number;
      pending: number;
      completed: number;
      subagentStatuses?: Array<{ id: string; name: string; status: string; currentTask?: string }>;
    };
    monitorFor(msg).updateCoordinatorStats(p);
  },
  'budget.threshold_reached': (msg: WSServerMessage) => {
    const p = msg.payload as {
      subagentId: string;
      taskId?: string;
      ts?: number;
      kind: string;
      used: number;
      limit: number;
      timeoutMs: number;
    };
    monitorFor(msg).pushEvent(
      'budget.threshold_reached',
      p,
      p.ts ?? Date.now(),
      p.subagentId,
      p.taskId,
    );
    if (p.limit > 0) {
      const pct = (p.used / p.limit) * 100;
      if (pct >= 85) {
        monitorFor(msg).recordBudgetAlert(
          p.subagentId,
          p.kind as 'iterations' | 'tool_calls' | 'tokens' | 'timeout' | 'idle_timeout' | 'cost',
          p.used,
          p.limit,
        );
      }
    }
    monitorFor(msg).updateSubagentBudget(p.subagentId, {
      budgetUsage: { iterations: 0, toolCalls: 0, tokens: 0, costUsd: 0, elapsedMs: p.used ?? 0 },
    });
  },
  'budget.decision': (msg: WSServerMessage) => {
    const p = msg.payload as {
      subagentId: string;
      kind: string;
      decision: string;
      extended?: { timeoutMs?: number; maxIterations?: number; maxToolCalls?: number };
    };
    const newLimit = p.extended?.timeoutMs ?? p.extended?.maxIterations ?? p.extended?.maxToolCalls;
    monitorFor(msg).recordBudgetDecision(
      p.subagentId,
      p.kind,
      p.decision as 'extend' | 'deny',
      newLimit,
    );
    monitorFor(msg).pushEvent(
      'budget.decision',
      { subagentId: p.subagentId, kind: p.kind, decision: p.decision, newLimit },
      Date.now(),
      p.subagentId,
    );
  },
  'subagent.budget_extended': (msg: WSServerMessage) => {
    const p = msg.payload as {
      subagentId: string;
      kind: string;
      extendedMs?: number;
      extendedTo?: number;
    };
    monitorFor(msg).recordBudgetExtended(p.subagentId, p.kind, p.extendedTo);
    monitorFor(msg).pushEvent('subagent.budget_extended', p, Date.now(), p.subagentId);
  },
  'consensus.vote_initiated': (msg: WSServerMessage) => {
    const p = msg.payload as {
      changeId: string;
      title: string;
      eligible: Array<{ agentId: string; agentName: string }>;
    };
    monitorFor(msg).pushConsensusVote(p.changeId, p.title, p.eligible);
    monitorFor(msg).pushEvent('consensus.vote_initiated', p, Date.now());
    if (isForeground(msg)) toast.info('Vote started: ' + p.title);
  },
  'consensus.vote_cast': (msg: WSServerMessage) => {
    const p = msg.payload as { changeId: string; voterId: string; value: string };
    const vote = monitorFor(msg).consensusVotes.get(p.changeId);
    const eligibleEntry = vote?.eligible.find((e) => e.agentId === p.voterId);
    monitorFor(msg).recordConsensusVote(
      p.changeId,
      p.voterId,
      eligibleEntry?.agentName ?? p.voterId,
      p.value as 'approve' | 'reject' | 'abstain',
    );
    monitorFor(msg).pushEvent('consensus.vote_cast', p, Date.now(), p.voterId);
  },
  'consensus.vote_resolved': (msg: WSServerMessage) => {
    const p = msg.payload as {
      changeId: string;
      result: string;
      approveCount: number;
      rejectCount: number;
    };
    monitorFor(msg).resolveConsensusVote(
      p.changeId,
      p.result as 'approved' | 'rejected' | 'vetoed' | 'quorum_not_met' | 'pending',
      p.approveCount,
      p.rejectCount,
    );
    monitorFor(msg).pushEvent('consensus.vote_resolved', p, Date.now());
    if (isForeground(msg))
      toast.info(
        'Vote resolved: ' + p.result + ' (y' + p.approveCount + ' n' + p.rejectCount + ')',
      );
  },
  'task.pending': (msg: WSServerMessage) => {
    const p = msg.payload as { taskId: string; description: string; priority?: number };
    monitorFor(msg).pushTaskPending(p.taskId, p.description, p.priority);
    monitorFor(msg).pushEvent('task.pending', p, Date.now());
  },
  'task.started': (msg: WSServerMessage) => {
    const p = msg.payload as { taskId: string; subagentId: string };
    monitorFor(msg).startTask(p.taskId, p.subagentId);
    monitorFor(msg).pushEvent('task.started', p, Date.now(), p.subagentId);
  },
  'task.completed': (msg: WSServerMessage) => {
    const p = msg.payload as {
      taskId: string;
      subagentId: string;
      status: string;
      durationMs: number;
    };
    monitorFor(msg).completeTask(p.taskId, p.status, p.durationMs);
    monitorFor(msg).pushEvent('task.completed', p, Date.now(), p.subagentId);
  },
  'task.failed': (msg: WSServerMessage) => {
    const p = msg.payload as { taskId: string; subagentId: string; error: string };
    monitorFor(msg).failTask(p.taskId, p.error);
    monitorFor(msg).pushEvent(
      'task.failed',
      { taskId: p.taskId, subagentId: p.subagentId, error: String(p.error).slice(0, 120) },
      Date.now(),
      p.subagentId,
    );
    if (isForeground(msg)) toast.error('Task failed: ' + String(p.error).slice(0, 80));
  },
};

/**
 * Exported as-is: each handler already routes to the lane its message names.
 *
 * The wrapper that used to sit here ran `isActiveSessionMessage` over the
 * whole map and returned early — which is why a background tab's fleet left
 * no trace. Positive routing replaces it; there is nothing left to gate.
 */
export const coordinatorHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> =
  coordinatorHandlers;
