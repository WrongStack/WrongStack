import type { SessionScopedPayload } from './protocol-core.js';

export type WSFleetServerMessage =
  | {
      type: 'subagent.event';
      payload: SessionScopedPayload & Record<string, unknown> & { kind: string };
    }
  | {
      type: 'coordinator.status';
      payload: {
        status: 'idle' | 'running' | 'draining' | 'stopped';
        mode?: string;
        subagentCount?: number;
        taskQueue?: { pending: number; running: number; completed: number; failed: number };
      };
    }
  | {
      type: 'coordinator.stats';
      payload: SessionScopedPayload & {
        total: number;
        running: number;
        idle: number;
        stopped: number;
        inFlight: number;
        pending: number;
        completed: number;
        subagentStatuses?: Array<{
          id: string;
          name: string;
          status: string;
          currentTask?: string;
        }>;
      };
    }
  | {
      type: 'fleet.concurrency_update';
      payload: SessionScopedPayload & {
        fleetConcurrency: number;
        fleetConcurrencyMax: number;
        maxSpawns?: number;
        usedSpawns?: number;
        remainingSpawns?: number;
        maxSpawnsSource?: string;
        maxConcurrentSource?: string;
        effectiveSource?: string;
        checkpointMaxSpawns?: number;
        ceilingMismatch?: boolean;
      };
    }
  | {
      type: 'budget.threshold_reached';
      payload: SessionScopedPayload & {
        subagentId: string;
        taskId?: string;
        ts: number;
        kind: string;
        used: number;
        limit: number;
        timeoutMs: number;
      };
    }
  | {
      type: 'budget.decision';
      payload: {
        subagentId: string;
        kind: string;
        decision: 'extend' | 'deny';
        extended?: { timeoutMs?: number; maxIterations?: number; maxToolCalls?: number };
      };
    }
  | {
      type: 'subagent.budget_extended';
      payload: { subagentId: string; kind: string; extendedMs?: number; extendedTo?: number };
    }
  | {
      type: 'consensus.vote_initiated';
      payload: {
        changeId: string;
        title: string;
        eligible: Array<{ agentId: string; agentName: string }>;
      };
    }
  | {
      type: 'consensus.vote_cast';
      payload: { changeId: string; voterId: string; value: 'approve' | 'reject' | 'abstain' };
    }
  | {
      type: 'consensus.vote_resolved';
      payload: {
        changeId: string;
        result: 'approved' | 'rejected' | 'vetoed' | 'quorum_not_met';
        approveCount: number;
        rejectCount: number;
      };
    }
  | { type: 'task.pending'; payload: { taskId: string; description: string; priority?: number } }
  | { type: 'task.started'; payload: { taskId: string; subagentId: string } }
  | {
      type: 'task.completed';
      payload: { taskId: string; subagentId: string; status: string; durationMs: number };
    }
  | { type: 'task.failed'; payload: { taskId: string; subagentId: string; error: string } }
  | { type: 'tool.disabled'; payload: { name: string; ok: boolean } }
  | { type: 'tool.enabled'; payload: { name: string; ok: boolean } };
