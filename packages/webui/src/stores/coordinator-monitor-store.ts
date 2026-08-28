import type { StateCreator } from 'zustand';
import { createSessionScopedStore } from './session-scoped-store';

// ── Types ──────────────────────────────────────────────────────────────────

export type CoordinatorStatus = 'idle' | 'running' | 'draining' | 'stopped';
export type BudgetKind = 'iterations' | 'tool_calls' | 'tokens' | 'timeout' | 'idle_timeout' | 'cost';
export type ConsensusResult = 'approved' | 'rejected' | 'vetoed' | 'quorum_not_met' | 'pending';
export type VoteValue = 'approve' | 'reject' | 'abstain';

export interface SubagentEntry {
  id: string;
  name: string;
  role: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
  currentTask?: string;
  budgetLimits?: {
    maxIterations?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
    idleTimeoutMs?: number;
  };
  budgetUsage?: {
    iterations: number;
    toolCalls: number;
    tokens: number;
    costUsd: number;
    elapsedMs: number;
  };
  lastSeen: number;
}

export interface FleetEvent {
  id: string;
  ts: number;
  type: string;
  subagentId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
  // Pre-computed display fields
  kind?: string;
  level?: 'info' | 'warning' | 'danger';
  message?: string;
}

export interface ConsensusVote {
  changeId: string;
  title: string;
  status: ConsensusResult;
  eligible: Array<{ agentId: string; agentName: string }>;
  votes: Array<{
    agentId: string;
    agentName: string;
    value: VoteValue;
    rationale?: string;
    votedAt: number;
  }>;
  approveCount: number;
  rejectCount: number;
  abstainCount: number;
  expiresAt?: number;
  resolvedAt?: number;
}

export interface TaskEntry {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  subagentId?: string;
  priority?: number;
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface BudgetAlert {
  id: string;
  ts: number;
  subagentId: string;
  kind: BudgetKind;
  level: 'warning' | 'danger';
  used: number;
  limit: number;
  pct: number;       // used/limit as percentage
  decision?: 'extend' | 'deny';
  newLimit?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function alertLevel(kind: BudgetKind, pct: number): 'warning' | 'danger' {
  if (kind === 'cost' || kind === 'timeout' || kind === 'idle_timeout') return pct >= 100 ? 'danger' : 'warning';
  return pct >= 100 ? 'danger' : pct >= 85 ? 'warning' : 'warning';
}

function buildEventMessage(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'budget.threshold_reached': {
      const p = payload as { kind: string; used: number; limit: number; subagentId: string };
      const pct = p.limit > 0 ? Math.round((p.used / p.limit) * 100) : 0;
      return `${p.subagentId} [${p.kind}] ${pct}% (${p.used}/${p.limit})`;
    }
    case 'budget.decision': {
      const p = payload as { subagentId: string; kind: string; decision: string };
      return `${p.subagentId} [${p.kind}] → ${p.decision}`;
    }
    case 'consensus.vote_initiated': {
      const p = payload as { title: string; eligible: unknown[] };
      return `Vote: "${p.title}" — ${(p.eligible as unknown[]).length} voters`;
    }
    case 'consensus.vote_cast': {
      const p = payload as { voterId: string; value: string };
      return `${p.voterId} voted ${p.value}`;
    }
    case 'consensus.vote_resolved': {
      const p = payload as { result: string; approveCount: number; rejectCount: number };
      return `${p.result} — ✅${p.approveCount} ❌${p.rejectCount}`;
    }
    case 'task.pending': {
      const p = payload as { taskId: string; description: string };
      return `Task queued: "${p.description.slice(0, 60)}"`;
    }
    case 'task.started': {
      const p = payload as { taskId: string; subagentId: string };
      return `${p.subagentId} started ${p.taskId}`;
    }
    case 'task.completed': {
      const p = payload as { taskId: string; status: string; durationMs: number };
      return `Task ${p.taskId} ${p.status} (${p.durationMs}ms)`;
    }
    case 'task.failed': {
      const p = payload as { taskId: string; error: string };
      return `Task ${p.taskId} failed: ${p.error.slice(0, 60)}`;
    }
    case 'subagent.budget_extended': {
      const p = payload as { subagentId: string; kind: string; extendedTo?: number };
      return `${p.subagentId} [${p.kind}] extended → ${p.extendedTo}ms`;
    }
    default:
      return type;
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface CoordinatorMonitorState {
  // Coordinator
  coordinatorStatus: CoordinatorStatus;
  coordinatorMode?: string;
  // Subagents
  subagents: Map<string, SubagentEntry>;
  // FleetBus event timeline (last 200 events)
  events: FleetEvent[];
  // Active consensus votes
  consensusVotes: Map<string, ConsensusVote>;
  // Task queue
  tasks: Map<string, TaskEntry>;
  taskCounts: { pending: number; running: number; completed: number; failed: number };
  // Budget alerts (last 50)
  budgetAlerts: BudgetAlert[];
  // Last update timestamp
  lastUpdated: number;

  // Actions
  setCoordinatorStatus: (status: CoordinatorStatus, mode?: string) => void;
  updateCoordinatorStats: (p: {
    total: number; running: number; idle: number; stopped: number;
    inFlight: number; pending: number; completed: number;
    subagentStatuses?: Array<{ id: string; name: string; status: string; currentTask?: string }>;
  }) => void;
  updateSubagentBudget: (subagentId: string, entry: Partial<SubagentEntry>) => void;
  pushEvent: (type: string, payload: Record<string, unknown>, ts: number, subagentId?: string, taskId?: string) => void;
  pushConsensusVote: (changeId: string, title: string, eligible: Array<{ agentId: string; agentName: string }>) => void;
  recordConsensusVote: (changeId: string, voterId: string, agentName: string, value: VoteValue) => void;
  resolveConsensusVote: (changeId: string, result: ConsensusResult, approveCount: number, rejectCount: number) => void;
  pushTaskPending: (taskId: string, description: string, priority?: number) => void;
  startTask: (taskId: string, subagentId: string) => void;
  completeTask: (taskId: string, status: string, durationMs: number) => void;
  failTask: (taskId: string, error: string) => void;
  recordBudgetDecision: (subagentId: string, kind: string, decision: 'extend' | 'deny', newLimit?: number) => void;
  recordBudgetAlert: (subagentId: string, kind: BudgetKind, used: number, limit: number) => void;
  recordBudgetExtended: (subagentId: string, kind: string, extendedTo?: number) => void;
  clear: () => void;
}

const MAX_EVENTS = 200;
const MAX_ALERTS = 50;
// Caps so the task / subagent / consensus Maps don't grow without bound over a
// long-lived session (only `events`/`budgetAlerts` were previously bounded).
const MAX_TASKS = 300;
const MAX_SUBAGENTS = 200;
const MAX_VOTES = 100;

/**
 * Evict from a Map (in insertion order) until it is within `max`. Entries for
 * which `evictableFirst` is true (terminal/resolved) are dropped first; if that
 * is not enough, the oldest remaining entries go next. Mutates `map` in place.
 */
function capMap<V>(map: Map<string, V>, max: number, evictableFirst?: (v: V) => boolean): void {
  if (map.size <= max) return;
  if (evictableFirst) {
    for (const [k, v] of map) {
      if (map.size <= max) break;
      if (evictableFirst(v)) map.delete(k);
    }
  }
  for (const k of map.keys()) {
    if (map.size <= max) break;
    map.delete(k);
  }
}

/**
 * One coordinator snapshot PER TAB.
 *
 * A coordinator run belongs to the conversation that started it: its
 * subagents, task counts, budget alerts and consensus votes are that tab's
 * fleet. As one global store it held whichever tab last emitted, and the
 * handlers had to defend it by dropping every background tab's task
 * lifecycle at the door — so a tab that ran a fleet while another was in
 * front came back to an empty monitor. Four tabs, four instances.
 */
const coordinatorMonitorState: StateCreator<CoordinatorMonitorState, [], []> = (set) => ({
  coordinatorStatus: 'idle',
  subagents: new Map(),
  events: [],
  consensusVotes: new Map(),
  tasks: new Map(),
  taskCounts: { pending: 0, running: 0, completed: 0, failed: 0 },
  budgetAlerts: [],
  lastUpdated: Date.now(),

  setCoordinatorStatus: (status, mode) =>
    set((_s) => ({ coordinatorStatus: status, coordinatorMode: mode, lastUpdated: Date.now() })),

  updateCoordinatorStats: (p) =>
    set((s) => {
      const subagents = new Map(s.subagents);
      for (const ag of p.subagentStatuses ?? []) {
        const existing = subagents.get(ag.id);
        subagents.set(ag.id, {
          id: ag.id,
          name: ag.name,
          role: existing?.role ?? 'agent',
          status: ag.status as SubagentEntry['status'],
          currentTask: ag.currentTask,
          budgetLimits: existing?.budgetLimits,
          budgetUsage: existing?.budgetUsage,
          lastSeen: existing?.lastSeen ?? Date.now(),
        });
      }
      capMap(subagents, MAX_SUBAGENTS, (a) => a.status === 'stopped');
      return {
        subagents,
        taskCounts: { pending: p.pending, running: p.inFlight, completed: p.completed, failed: 0 },
        lastUpdated: Date.now(),
      };
    }),

  updateSubagentBudget: (subagentId, entry) =>
    set((s) => {
      const subagents = new Map(s.subagents);
      const existing = subagents.get(subagentId);
      subagents.set(subagentId, {
        id: subagentId,
        name: existing?.name ?? subagentId,
        role: existing?.role ?? 'agent',
        status: existing?.status ?? 'idle',
        ...existing,
        ...entry,
        lastSeen: Date.now(),
      });
      capMap(subagents, MAX_SUBAGENTS, (a) => a.status === 'stopped');
      return { subagents, lastUpdated: Date.now() };
    }),

  pushEvent: (type, payload, ts, subagentId, taskId) =>
    set((s) => {
      const kind = (payload.kind as string) ?? type;
      const isBudget = type.includes('budget') || type.includes('threshold');
      const pct =
        isBudget && typeof payload.limit === 'number' && (payload.limit as number) > 0
          ? Math.round(((payload.used as number) / (payload.limit as number)) * 100)
          : undefined;
      const level: FleetEvent['level'] =
        pct !== undefined
          ? pct >= 100 ? 'danger' : pct >= 85 ? 'warning' : 'info'
          : type.includes('consensus.vote_resolved') ? 'info'
          : type.includes('consensus.vote_initiated') ? 'warning'
          : 'info';

      const event: FleetEvent = {
        id: `${ts}-${type}`,
        ts,
        type,
        subagentId,
        taskId,
        payload,
        kind,
        level,
        message: buildEventMessage(type, payload),
      };
      return {
        events: [event, ...s.events].slice(0, MAX_EVENTS),
        lastUpdated: Date.now(),
      };
    }),

  pushConsensusVote: (changeId, title, eligible) =>
    set((s) => {
      const votes = new Map(s.consensusVotes);
      votes.set(changeId, {
        changeId,
        title,
        status: 'pending',
        eligible,
        votes: [],
        approveCount: 0,
        rejectCount: 0,
        abstainCount: 0,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 min default
      });
      capMap(votes, MAX_VOTES, (v) => v.status !== 'pending');
      return { consensusVotes: votes, lastUpdated: Date.now() };
    }),

  recordConsensusVote: (changeId, voterId, agentName, value) =>
    set((s) => {
      const votes = new Map(s.consensusVotes);
      const vote = votes.get(changeId);
      if (!vote) return {};
      const updatedVote: ConsensusVote = {
        ...vote,
        votes: [
          ...vote.votes.filter((v) => v.agentId !== voterId),
          { agentId: voterId, agentName, value, votedAt: Date.now() },
        ],
        approveCount: value === 'approve' ? vote.approveCount + 1 : vote.approveCount,
        rejectCount: value === 'reject' ? vote.rejectCount + 1 : vote.rejectCount,
        abstainCount: value === 'abstain' ? vote.abstainCount + 1 : vote.abstainCount,
      };
      votes.set(changeId, updatedVote);
      return { consensusVotes: votes, lastUpdated: Date.now() };
    }),

  resolveConsensusVote: (changeId, result, approveCount, rejectCount) =>
    set((s) => {
      const votes = new Map(s.consensusVotes);
      const vote = votes.get(changeId);
      if (!vote) return {};
      votes.set(changeId, { ...vote, status: result, approveCount, rejectCount, resolvedAt: Date.now() });
      return { consensusVotes: votes, lastUpdated: Date.now() };
    }),

  pushTaskPending: (taskId, description, priority) =>
    set((s) => {
      const tasks = new Map(s.tasks);
      tasks.set(taskId, { id: taskId, description, status: 'pending', priority, queuedAt: Date.now() });
      capMap(tasks, MAX_TASKS, (t) => t.status === 'completed' || t.status === 'failed');
      return {
        tasks,
        taskCounts: { ...s.taskCounts, pending: s.taskCounts.pending + 1 },
        lastUpdated: Date.now(),
      };
    }),

  startTask: (taskId, subagentId) =>
    set((s) => {
      const tasks = new Map(s.tasks);
      const task = tasks.get(taskId);
      if (!task) {
        tasks.set(taskId, { id: taskId, description: '', status: 'running', subagentId, startedAt: Date.now() });
      } else {
        tasks.set(taskId, { ...task, status: 'running', subagentId, startedAt: Date.now() });
      }
      return {
        tasks,
        taskCounts: { ...s.taskCounts, pending: Math.max(0, s.taskCounts.pending - 1), running: s.taskCounts.running + 1 },
        lastUpdated: Date.now(),
      };
    }),

  completeTask: (taskId, status, durationMs) =>
    set((s) => {
      const tasks = new Map(s.tasks);
      const task = tasks.get(taskId);
      if (task) tasks.set(taskId, { ...task, status: status as TaskEntry['status'], completedAt: Date.now(), durationMs });
      capMap(tasks, MAX_TASKS, (t) => t.status === 'completed' || t.status === 'failed');
      return {
        tasks,
        taskCounts: {
          ...s.taskCounts,
          running: Math.max(0, s.taskCounts.running - 1),
          completed: status === 'completed' ? s.taskCounts.completed + 1 : s.taskCounts.completed,
          failed: status === 'failed' ? s.taskCounts.failed + 1 : s.taskCounts.failed,
        },
        lastUpdated: Date.now(),
      };
    }),

  failTask: (taskId, error) =>
    set((s) => {
      const tasks = new Map(s.tasks);
      const task = tasks.get(taskId);
      if (task) tasks.set(taskId, { ...task, status: 'failed', error, completedAt: Date.now() });
      capMap(tasks, MAX_TASKS, (t) => t.status === 'completed' || t.status === 'failed');
      return {
        tasks,
        taskCounts: { ...s.taskCounts, running: Math.max(0, s.taskCounts.running - 1), failed: s.taskCounts.failed + 1 },
        lastUpdated: Date.now(),
      };
    }),

  recordBudgetDecision: (subagentId, kind, decision, newLimit) =>
    set((s) => {
      // Collapse to one alert per `${subagentId}:${kind}`, keeping the newest
      // (budgetAlerts is newest-first, so the first occurrence of a key wins).
      //
      // The matching alert must stay IN the map: this reduce used to skip it
      // (`if (a.subagentId === subagentId && a.kind === kind) return acc`),
      // which made the `alerts.get(key)` below always undefined. The whole
      // `if (existing)` annotation branch was therefore unreachable, and the
      // net effect of recording a decision was to *delete* the alert it was
      // supposed to annotate.
      const alerts = new Map<string, BudgetAlert>();
      for (const a of s.budgetAlerts) {
        const alertKey = `${a.subagentId}:${a.kind}`;
        if (!alerts.has(alertKey)) alerts.set(alertKey, a);
      }
      const key = `${subagentId}:${kind}`;
      const existing = alerts.get(key);
      if (existing) {
        alerts.set(key, {
          ...existing,
          decision,
          newLimit,
          level: decision === 'extend' ? 'warning' : 'danger',
        });
      }
      return { budgetAlerts: Array.from(alerts.values()) as BudgetAlert[], lastUpdated: Date.now() };
    }),

  recordBudgetAlert: (subagentId, kind, used, limit) =>
    set((s) => {
      const id = `${Date.now()}-${subagentId}-${kind}`;
      const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
      const alert: BudgetAlert = {
        id,
        ts: Date.now(),
        subagentId,
        kind,
        level: alertLevel(kind, pct),
        used,
        limit,
        pct,
      };
      return {
        budgetAlerts: [alert, ...s.budgetAlerts].slice(0, MAX_ALERTS),
        lastUpdated: Date.now(),
      };
    }),

  recordBudgetExtended: (subagentId, kind, extendedTo) =>
    set((s) => {
      const subagents = new Map(s.subagents);
      const existing = subagents.get(subagentId);
      if (existing?.budgetLimits) {
        const updatedLimits = { ...existing.budgetLimits };
        if (kind === 'timeout' && extendedTo) updatedLimits.timeoutMs = extendedTo;
        if (kind === 'iterations') updatedLimits.maxIterations = extendedTo;
        if (kind === 'tool_calls') updatedLimits.maxToolCalls = extendedTo;
        subagents.set(subagentId, { ...existing, budgetLimits: updatedLimits, lastSeen: Date.now() });
      }
      return { subagents, lastUpdated: Date.now() };
    }),

  clear: () =>
    set({
      coordinatorStatus: 'idle',
      coordinatorMode: undefined,
      subagents: new Map(),
      events: [],
      consensusVotes: new Map(),
      tasks: new Map(),
      taskCounts: { pending: 0, running: 0, completed: 0, failed: 0 },
      budgetAlerts: [],
      lastUpdated: Date.now(),
    }),
});

export const useCoordinatorMonitorStore = createSessionScopedStore(coordinatorMonitorState, {
  max: 4,
});
