/**
 * Per-session tool-call statistics, collected live from the WS stream.
 *
 * Every `tool.started` / `tool.executed` event of every open session tab lands
 * here — leader calls and agent-attributed calls alike (`agentName` on the
 * wire payload distinguishes agent-to-agent calls) — plus `delegate.*`
 * delegation outcomes. Aggregates only: tool names and counters, never tool
 * output, so the store stays bounded for the life of the page.
 *
 * Consumed by `ToolStatsModal` (one click from the chat header), which layers
 * the closed-session history catalogue (`useHistoryStore`) on top for sessions
 * that are no longer open as tabs.
 */
import { create } from 'zustand';

/** Leader-initiated calls when the wire payload carried no `agentName`. */
export const LEADER_AGENT_KEY = 'leader';

export interface ToolStatsBucket {
  started: number;
  ok: number;
  failed: number;
  totalMs: number;
}

export interface ToolStatsDelegation extends ToolStatsBucket {
  /** Tool calls reported inside delegated subagent runs. */
  toolCalls: number;
}

export interface ToolStatsSession {
  sessionId: string;
  firstActivityAt: number;
  lastActivityAt: number;
  /** Keyed by tool name. */
  perTool: Record<string, ToolStatsBucket>;
  /** Keyed by `LEADER_AGENT_KEY` or the `agentName` from the wire payload. */
  perAgent: Record<string, ToolStatsBucket>;
  delegations: ToolStatsDelegation;
}

interface ToolStatsState {
  sessions: Record<string, ToolStatsSession>;
  recordToolStarted: (
    sessionId: string,
    call: { name: string; agentName?: string | undefined },
  ) => void;
  recordToolExecuted: (
    sessionId: string,
    call: {
      name: string;
      ok: boolean;
      durationMs?: number | undefined;
      agentName?: string | undefined;
    },
  ) => void;
  recordDelegateStarted: (sessionId: string, delegation: { target: string }) => void;
  recordDelegateCompleted: (
    sessionId: string,
    delegation: { target: string; ok: boolean; toolCalls?: number | undefined },
  ) => void;
  resetSession: (sessionId: string) => void;
  clearAll: () => void;
}

function emptyBucket(): ToolStatsBucket {
  return { started: 0, ok: 0, failed: 0, totalMs: 0 };
}

function emptyDelegation(): ToolStatsDelegation {
  return { started: 0, ok: 0, failed: 0, totalMs: 0, toolCalls: 0 };
}

function emptySession(sessionId: string): ToolStatsSession {
  return {
    sessionId,
    firstActivityAt: Date.now(),
    lastActivityAt: Date.now(),
    perTool: {},
    perAgent: {},
    delegations: emptyDelegation(),
  };
}

/** Fetch-or-create a counter object without tripping noUncheckedIndexedAccess. */
function touchBucket(
  record: Record<string, ToolStatsBucket>,
  key: string,
): { record: Record<string, ToolStatsBucket>; bucket: ToolStatsBucket } {
  const existing = record[key];
  if (existing) return { record, bucket: existing };
  const fresh = emptyBucket();
  return { record: { ...record, [key]: fresh }, bucket: fresh };
}

function upsertSession(
  sessions: Record<string, ToolStatsSession>,
  sessionId: string,
): { sessions: Record<string, ToolStatsSession>; session: ToolStatsSession } {
  const existing = sessions[sessionId];
  if (existing) return { sessions, session: existing };
  const created = emptySession(sessionId);
  return { sessions: { ...sessions, [sessionId]: created }, session: created };
}

export const useToolStatsStore = create<ToolStatsState>((set) => ({
  sessions: {},
  recordToolStarted: (sessionId, call) =>
    set((state) => {
      const agentKey = call.agentName || LEADER_AGENT_KEY;
      const { sessions: withSession, session } = upsertSession(state.sessions, sessionId);
      const tool = touchBucket(session.perTool, call.name);
      const agent = touchBucket(session.perAgent, agentKey);
      const nextSession: ToolStatsSession = {
        ...session,
        lastActivityAt: Date.now(),
        perTool: {
          ...tool.record,
          [call.name]: { ...tool.bucket, started: tool.bucket.started + 1 },
        },
        perAgent: {
          ...agent.record,
          [agentKey]: { ...agent.bucket, started: agent.bucket.started + 1 },
        },
      };
      return { sessions: { ...withSession, [sessionId]: nextSession } };
    }),
  recordToolExecuted: (sessionId, call) =>
    set((state) => {
      const agentKey = call.agentName || LEADER_AGENT_KEY;
      const { sessions: withSession, session } = upsertSession(state.sessions, sessionId);
      const tool = touchBucket(session.perTool, call.name);
      const agent = touchBucket(session.perAgent, agentKey);
      const ms = Math.max(0, call.durationMs ?? 0);
      const nextSession: ToolStatsSession = {
        ...session,
        lastActivityAt: Date.now(),
        perTool: {
          ...tool.record,
          [call.name]: {
            ...tool.bucket,
            ok: tool.bucket.ok + (call.ok ? 1 : 0),
            failed: tool.bucket.failed + (call.ok ? 0 : 1),
            totalMs: tool.bucket.totalMs + ms,
          },
        },
        perAgent: {
          ...agent.record,
          [agentKey]: {
            ...agent.bucket,
            ok: agent.bucket.ok + (call.ok ? 1 : 0),
            failed: agent.bucket.failed + (call.ok ? 0 : 1),
            totalMs: agent.bucket.totalMs + ms,
          },
        },
      };
      return { sessions: { ...withSession, [sessionId]: nextSession } };
    }),
  recordDelegateStarted: (sessionId, delegation) =>
    set((state) => {
      const { sessions: withSession, session } = upsertSession(state.sessions, sessionId);
      const nextSession: ToolStatsSession = {
        ...session,
        lastActivityAt: Date.now(),
        delegations: {
          ...session.delegations,
          started: session.delegations.started + 1,
        },
      };
      return { sessions: { ...withSession, [sessionId]: nextSession } };
    }),
  recordDelegateCompleted: (sessionId, delegation) =>
    set((state) => {
      const { sessions: withSession, session } = upsertSession(state.sessions, sessionId);
      const nextSession: ToolStatsSession = {
        ...session,
        lastActivityAt: Date.now(),
        delegations: {
          ...session.delegations,
          ok: session.delegations.ok + (delegation.ok ? 1 : 0),
          failed: session.delegations.failed + (delegation.ok ? 0 : 1),
          toolCalls: session.delegations.toolCalls + Math.max(0, delegation.toolCalls ?? 0),
        },
      };
      return { sessions: { ...withSession, [sessionId]: nextSession } };
    }),
  resetSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.sessions)) return state;
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    }),
  clearAll: () => set({ sessions: {} }),
}));

/** Completed-call success ratio for a bucket, or null when nothing completed. */
export function bucketSuccessRatio(bucket: ToolStatsBucket): number | null {
  const completed = bucket.ok + bucket.failed;
  return completed > 0 ? bucket.ok / completed : null;
}

/** Calls started but not yet completed across a session (running right now). */
export function sessionInFlight(session: ToolStatsSession): number {
  const started = Object.values(session.perAgent).reduce((n, b) => n + b.started, 0);
  const completed = Object.values(session.perAgent).reduce((n, b) => n + b.ok + b.failed, 0);
  return Math.max(0, started - completed);
}
