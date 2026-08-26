import { toast } from '@/components/Toaster';
import { isActiveSessionMessage } from '@/lib/ws-client-utils';
import { useCoordinatorMonitorStore } from '@/stores';
import type { WSServerMessage } from '@/types';

/**
 * Coordinator Monitor handlers.
 *
 * `useCoordinatorMonitorStore` is ONE snapshot of a coordinator run — status,
 * task queue, consensus votes, budget alerts — with no per-session lane behind
 * it. With four tabs open, an event from a background tab written straight
 * into it interleaves that tab's tasks and budget alerts with the foreground's.
 *
 * So the whole map is gated at export (below) rather than by twelve
 * hand-written guards: a handler added here later cannot forget the check.
 * Gating drops a background tab's coordinator events rather than misfiling
 * them — the same trade the other snapshot panels make (`side_effects`,
 * `todos.cleared`, the Brain council log). If this panel ever grows a real
 * surface, give it a lane registry keyed by session and route positively,
 * the way `chat-lanes` / `session-lanes` do, instead of widening this gate.
 */
const coordinatorHandlers: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'coordinator.status': (msg: WSServerMessage) => {
    const p = msg.payload as {
      status: string;
      mode?: string;
      subagentCount?: number;
      taskQueue?: { pending: number; running: number; completed: number; failed: number };
    };
    useCoordinatorMonitorStore
      .getState()
      .setCoordinatorStatus(p.status as 'idle' | 'running' | 'draining' | 'stopped', p.mode);
    if (p.taskQueue) {
      useCoordinatorMonitorStore.getState().updateCoordinatorStats({
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
    useCoordinatorMonitorStore.getState().updateCoordinatorStats(p);
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
    useCoordinatorMonitorStore
      .getState()
      .pushEvent('budget.threshold_reached', p, p.ts ?? Date.now(), p.subagentId, p.taskId);
    if (p.limit > 0) {
      const pct = (p.used / p.limit) * 100;
      if (pct >= 85) {
        useCoordinatorMonitorStore
          .getState()
          .recordBudgetAlert(
            p.subagentId,
            p.kind as 'iterations' | 'tool_calls' | 'tokens' | 'timeout' | 'idle_timeout' | 'cost',
            p.used,
            p.limit,
          );
      }
    }
    useCoordinatorMonitorStore.getState().updateSubagentBudget(p.subagentId, {
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
    useCoordinatorMonitorStore
      .getState()
      .recordBudgetDecision(p.subagentId, p.kind, p.decision as 'extend' | 'deny', newLimit);
    useCoordinatorMonitorStore
      .getState()
      .pushEvent(
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
    useCoordinatorMonitorStore.getState().recordBudgetExtended(p.subagentId, p.kind, p.extendedTo);
    useCoordinatorMonitorStore
      .getState()
      .pushEvent('subagent.budget_extended', p, Date.now(), p.subagentId);
  },
  'consensus.vote_initiated': (msg: WSServerMessage) => {
    const p = msg.payload as {
      changeId: string;
      title: string;
      eligible: Array<{ agentId: string; agentName: string }>;
    };
    useCoordinatorMonitorStore.getState().pushConsensusVote(p.changeId, p.title, p.eligible);
    useCoordinatorMonitorStore.getState().pushEvent('consensus.vote_initiated', p, Date.now());
    toast.info('Vote started: ' + p.title);
  },
  'consensus.vote_cast': (msg: WSServerMessage) => {
    const p = msg.payload as { changeId: string; voterId: string; value: string };
    const vote = useCoordinatorMonitorStore.getState().consensusVotes.get(p.changeId);
    const eligibleEntry = vote?.eligible.find((e) => e.agentId === p.voterId);
    useCoordinatorMonitorStore
      .getState()
      .recordConsensusVote(
        p.changeId,
        p.voterId,
        eligibleEntry?.agentName ?? p.voterId,
        p.value as 'approve' | 'reject' | 'abstain',
      );
    useCoordinatorMonitorStore
      .getState()
      .pushEvent('consensus.vote_cast', p, Date.now(), p.voterId);
  },
  'consensus.vote_resolved': (msg: WSServerMessage) => {
    const p = msg.payload as {
      changeId: string;
      result: string;
      approveCount: number;
      rejectCount: number;
    };
    useCoordinatorMonitorStore
      .getState()
      .resolveConsensusVote(
        p.changeId,
        p.result as 'approved' | 'rejected' | 'vetoed' | 'quorum_not_met' | 'pending',
        p.approveCount,
        p.rejectCount,
      );
    useCoordinatorMonitorStore.getState().pushEvent('consensus.vote_resolved', p, Date.now());
    toast.info('Vote resolved: ' + p.result + ' (y' + p.approveCount + ' n' + p.rejectCount + ')');
  },
  'task.pending': (msg: WSServerMessage) => {
    const p = msg.payload as { taskId: string; description: string; priority?: number };
    useCoordinatorMonitorStore.getState().pushTaskPending(p.taskId, p.description, p.priority);
    useCoordinatorMonitorStore.getState().pushEvent('task.pending', p, Date.now());
  },
  'task.started': (msg: WSServerMessage) => {
    const p = msg.payload as { taskId: string; subagentId: string };
    useCoordinatorMonitorStore.getState().startTask(p.taskId, p.subagentId);
    useCoordinatorMonitorStore.getState().pushEvent('task.started', p, Date.now(), p.subagentId);
  },
  'task.completed': (msg: WSServerMessage) => {
    const p = msg.payload as {
      taskId: string;
      subagentId: string;
      status: string;
      durationMs: number;
    };
    useCoordinatorMonitorStore.getState().completeTask(p.taskId, p.status, p.durationMs);
    useCoordinatorMonitorStore.getState().pushEvent('task.completed', p, Date.now(), p.subagentId);
  },
  'task.failed': (msg: WSServerMessage) => {
    const p = msg.payload as { taskId: string; subagentId: string; error: string };
    useCoordinatorMonitorStore.getState().failTask(p.taskId, p.error);
    useCoordinatorMonitorStore
      .getState()
      .pushEvent(
        'task.failed',
        { taskId: p.taskId, subagentId: p.subagentId, error: String(p.error).slice(0, 120) },
        Date.now(),
        p.subagentId,
      );
    toast.error('Task failed: ' + String(p.error).slice(0, 80));
  },
};

/**
 * Every entry above, wrapped so it only runs for the session in front.
 *
 * `isActiveSessionMessage` is fail-OPEN for untagged messages, which keeps the
 * single-session surfaces (SimpleUI, TUI, an older client) working exactly as
 * before — they never tag, and there is only ever one session to be in front.
 */
/* lane-routing: gated-at-export */
export const coordinatorHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> =
  Object.fromEntries(
    Object.entries(coordinatorHandlers).map(([type, handler]) => [
      type,
      (msg: WSServerMessage) => {
        if (!isActiveSessionMessage(msg)) return;
        handler?.(msg);
      },
    ]),
  );
