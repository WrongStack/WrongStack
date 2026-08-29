import { stripNextStepsBlock } from '@wrongstack/tools/next-steps';
import { create } from 'zustand';
import { agentBelongsToSession } from '@/lib/agent-session';
import { compareAgentsByActivity } from '@/lib/agent-status';
import { useActiveSessionId } from './session-lanes.js';
import type {
  AgentTranscriptEntry,
  AgentTranscriptKind,
  FleetTimelineEvent,
  SubagentEvent,
  SubagentView,
} from './types.js';

// ── Fleet store (live subagent roster; not persisted) ───────────────────────

const SPARKLINE_BINS = 12;
const MAX_TIMELINE = 20;
const MAX_AGENT_TIMELINE = 500;
const MAX_AGENT_TRANSCRIPT = 1000;
/** Roster cap — far above any real fleet; evicts terminal agents first. */
const MAX_FLEET_AGENTS = 200;

export const EMPTY_AGENT_TRANSCRIPT: AgentTranscriptEntry[] = [];

export interface FleetState {
  agents: Map<string, SubagentView>;
  /**
   * Process-wide LAST-ANNOUNCED leader (set via leader_updated). Tab-scoped
   * consumers must use `selectSessionLeaderId` / `useSessionLeaderId`, which
   * resolve the leader of ONE session from the roster's isLeader flag.
   */
  leaderId: string | undefined;
  /** Fleet-wide aggregated tokens (sum of all agent tokens). */
  fleetTokensIn: number;
  fleetTokensOut: number;
  /** Current / max concurrency from server. */
  fleetConcurrency: number;
  fleetConcurrencyMax: number;
  /** Lifetime spawn budget from server (issue #323). Undefined until first budget frame. */
  fleetMaxSpawns: number | undefined;
  fleetUsedSpawns: number | undefined;
  fleetRemainingSpawns: number | undefined;
  fleetBudgetSource: string | undefined;
  fleetCheckpointMaxSpawns: number | undefined;
  fleetCeilingMismatch: boolean;
  /** Last 20 fleet events for the Fleet Monitor timeline. */
  eventTimeline: FleetTimelineEvent[];
  /** Agent conversation timeline entries (agent.timeline.message + agent.status_changed). */
  agentTimeline: AgentTranscriptEntry[];
  /** Per-agent ordered chat transcripts (oldest first). */
  agentTranscripts: Map<string, AgentTranscriptEntry[]>;
  applyEvent: (e: SubagentEvent) => void;
  pushAgentTimelineEntry: (entry: Omit<AgentTranscriptEntry, 'id'>) => void;
  clear: () => void;
  /** Return all agents belonging to a session. Used for project-scoped filtering. */
  getAgentsBySession: (sessionId: string) => SubagentView[];
  /** Return one agent's full ordered transcript. */
  getAgentTranscript: (subagentId: string) => AgentTranscriptEntry[];
  /** Hydrate subagent virtual sessions and historical transcripts (from session.start replay). */
  hydrateAgentSessions: (
    sessions: Array<{
      subagentId: string;
      agentName?: string | undefined;
      status?: string | undefined;
      task?: string | undefined;
      transcript?: AgentTranscriptEntry[] | undefined;
    }>,
    sessionId?: string | undefined,
  ) => void;
  /** Remove non-running agents (completed, failed, timeout, stopped) from the
   *  roster. Scoped: only agents belonging to `sessionId` are removed, so a
   *  panel in one tab never drops another tab's finished agents. */
  clearFinishedAgents: (sessionId: string | null) => void;
}

function blankAgent(id: string, name?: string, sessionId?: string): SubagentView {
  return {
    id,
    name: name?.trim() || id,
    sessionId,
    status: 'running',
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: Date.now(),
    toolLog: [],
    sparklineBins: Array(SPARKLINE_BINS).fill(0),
  };
}

let _timelineSeq = 0;
function makeTimelineId(): string {
  return `tl_${Date.now()}_${++_timelineSeq}`;
}

function pushTimeline(
  timeline: FleetTimelineEvent[],
  event: FleetTimelineEvent,
): FleetTimelineEvent[] {
  return [event, ...timeline].slice(0, MAX_TIMELINE);
}

function normalizeTranscriptKind(kind: string): AgentTranscriptKind {
  switch (kind) {
    case 'text':
    case 'thinking':
    case 'tool_use':
    case 'tool_result':
    case 'error':
    case 'status':
    case 'system':
      return kind;
    default:
      return 'status';
  }
}

function canMergeTranscriptEntry(a: AgentTranscriptEntry, b: AgentTranscriptEntry): boolean {
  if (a.subagentId !== b.subagentId) return false;
  if (a.kind !== b.kind) return false;
  if (a.iteration !== b.iteration) return false;
  if (a.toolName !== b.toolName) return false;
  if (a.toolOk !== b.toolOk) return false;
  return a.kind === 'text' || a.kind === 'thinking';
}

function appendTranscriptEntry(
  entries: AgentTranscriptEntry[],
  entry: AgentTranscriptEntry,
): AgentTranscriptEntry[] {
  const last = entries[entries.length - 1];
  if (last && canMergeTranscriptEntry(last, entry)) {
    return [
      ...entries.slice(0, -1),
      { ...last, content: `${last.content}${entry.content}`, ts: entry.ts },
    ].slice(-MAX_AGENT_TRANSCRIPT);
  }
  return [...entries, entry].slice(-MAX_AGENT_TRANSCRIPT);
}

/** Update sparkline bins for an agent — bump bin 0 and shift left.
 *  The bins array has index 0 as the most recent bucket.
 *  Each event bumps bin 0, then the array is truncated to SPARKLINE_BINS. */
function bumpSparkline(bins: number[]): number[] {
  return [bins[0] + 1, ...bins.slice(0, SPARKLINE_BINS - 1)];
}

function clampContextPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

export const useFleetStore = create<FleetState>()((set, get) => ({
  agents: new Map(),
  leaderId: undefined,
  fleetTokensIn: 0,
  fleetTokensOut: 0,
  fleetConcurrency: 0,
  fleetConcurrencyMax: 4,
  fleetMaxSpawns: undefined,
  fleetUsedSpawns: undefined,
  fleetRemainingSpawns: undefined,
  fleetBudgetSource: undefined,
  fleetCheckpointMaxSpawns: undefined,
  fleetCeilingMismatch: false,
  eventTimeline: [],
  agentTimeline: [],
  agentTranscripts: new Map(),
  pushAgentTimelineEntry: (entry) =>
    set((state) => {
      const fullEntry: AgentTranscriptEntry = {
        id: `agent_tl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ...entry,
        kind: normalizeTranscriptKind(entry.kind),
      };
      const agents = new Map(state.agents);
      if (
        fullEntry.subagentId &&
        fullEntry.subagentId !== 'leader' &&
        !agents.has(fullEntry.subagentId)
      ) {
        agents.set(
          fullEntry.subagentId,
          blankAgent(fullEntry.subagentId, fullEntry.agentName, fullEntry.sessionId),
        );
      }
      const agentTranscripts = new Map(state.agentTranscripts);
      agentTranscripts.set(
        fullEntry.subagentId,
        appendTranscriptEntry(agentTranscripts.get(fullEntry.subagentId) ?? [], fullEntry),
      );
      return {
        agents,
        agentTimeline: [fullEntry, ...state.agentTimeline].slice(0, MAX_AGENT_TIMELINE),
        agentTranscripts,
      };
    }),
  hydrateAgentSessions: (sessions, sessionId) =>
    set((state) => {
      if (!Array.isArray(sessions) || sessions.length === 0) return state;
      const agents = new Map(state.agents);
      const agentTranscripts = new Map(state.agentTranscripts);
      for (const s of sessions) {
        if (!s || !s.subagentId || s.subagentId === 'leader') continue;
        const id = s.subagentId;
        const name = s.agentName?.trim() || id;
        const existingAgent = agents.get(id);
        if (!existingAgent) {
          const newAgent = blankAgent(id, name, sessionId);
          if (s.status) newAgent.status = s.status as SubagentView['status'];
          if (s.task) newAgent.description = s.task;
          agents.set(id, newAgent);
        } else if (s.task && !existingAgent.description) {
          existingAgent.description = s.task;
          agents.set(id, existingAgent);
        }
        if (Array.isArray(s.transcript) && s.transcript.length > 0) {
          const current = agentTranscripts.get(id) ?? [];
          if (current.length === 0) {
            agentTranscripts.set(id, s.transcript.slice(-MAX_AGENT_TRANSCRIPT));
          } else {
            let merged = [...current];
            for (const item of s.transcript) {
              if (
                !merged.some(
                  (m) =>
                    m.id === item.id ||
                    (m.ts === item.ts && m.content === item.content && m.kind === item.kind),
                )
              ) {
                merged = appendTranscriptEntry(merged, item);
              }
            }
            agentTranscripts.set(id, merged.slice(-MAX_AGENT_TRANSCRIPT));
          }
        }
      }
      return { agents, agentTranscripts };
    }),
  clear: () =>
    set({
      agents: new Map(),
      leaderId: undefined,
      fleetTokensIn: 0,
      fleetTokensOut: 0,
      fleetConcurrency: 0,
      fleetConcurrencyMax: 4,
      fleetMaxSpawns: undefined,
      fleetUsedSpawns: undefined,
      fleetRemainingSpawns: undefined,
      fleetBudgetSource: undefined,
      fleetCheckpointMaxSpawns: undefined,
      fleetCeilingMismatch: false,
      eventTimeline: [],
      agentTimeline: [],
      agentTranscripts: new Map(),
    }),
  getAgentsBySession: (sessionId) => {
    const result: SubagentView[] = [];
    for (const a of get().agents.values()) {
      if (a.sessionId === sessionId) result.push(a);
    }
    return result;
  },
  getAgentTranscript: (subagentId) =>
    get().agentTranscripts.get(subagentId) ?? EMPTY_AGENT_TRANSCRIPT,
  clearFinishedAgents: (sessionId) =>
    set((state) => {
      const survivors = new Map(state.agents);
      const finished = new Set<string>();
      let droppedTokensIn = 0;
      let droppedTokensOut = 0;
      for (const [id, agent] of survivors) {
        // Session-scoped by the same fail-closed rule the rosters use: an
        // agent leaves through THIS surface only when it belongs to THIS tab.
        if (agent.status !== 'running' && agentBelongsToSession(agent.sessionId, sessionId)) {
          survivors.delete(id);
          finished.add(id);
          droppedTokensIn += agent.tokensIn ?? 0;
          droppedTokensOut += agent.tokensOut ?? 0;
        }
      }
      const agentTranscripts = new Map(state.agentTranscripts);
      for (const id of finished) {
        agentTranscripts.delete(id);
      }
      return {
        agents: survivors,
        agentTranscripts,
        agentTimeline: state.agentTimeline.filter((e) => !finished.has(e.subagentId)),
        eventTimeline: state.eventTimeline.filter((e) => !finished.has(e.agentId)),
        leaderId: state.leaderId && finished.has(state.leaderId) ? undefined : state.leaderId,
        // Cleared agents leave the roster AND the token totals — the totals
        // are running deltas of per-agent contributions, so keeping the
        // tokens of agents no longer shown made the fleet chip drift up.
        fleetTokensIn: Math.max(0, state.fleetTokensIn - droppedTokensIn),
        fleetTokensOut: Math.max(0, state.fleetTokensOut - droppedTokensOut),
      };
    }),
  applyEvent: (e) =>
    set((state) => {
      const agents = new Map(state.agents);
      const agentTranscripts = new Map(state.agentTranscripts);
      let timeline = state.eventTimeline;
      let leaderId = state.leaderId;
      let fleetTokensIn = state.fleetTokensIn;
      let fleetTokensOut = state.fleetTokensOut;

      // session_stopped carries a sessionId instead of subagentId —
      // remove ALL agents belonging to that session.
      if (e.kind === 'session_stopped' && e.sessionId) {
        const removedIds = new Set<string>();
        let droppedTokensIn = 0;
        let droppedTokensOut = 0;
        for (const [id, agent] of agents) {
          if (agent.sessionId === e.sessionId) {
            agents.delete(id);
            agentTranscripts.delete(id);
            removedIds.add(id);
            droppedTokensIn += agent.tokensIn ?? 0;
            droppedTokensOut += agent.tokensOut ?? 0;
          }
        }
        return {
          agents,
          agentTranscripts,
          agentTimeline: state.agentTimeline.filter((entry) => !removedIds.has(entry.subagentId)),
          eventTimeline: state.eventTimeline.filter((entry) => !removedIds.has(entry.agentId)),
          leaderId: state.leaderId && removedIds.has(state.leaderId) ? undefined : state.leaderId,
          fleetTokensIn: Math.max(0, state.fleetTokensIn - droppedTokensIn),
          fleetTokensOut: Math.max(0, state.fleetTokensOut - droppedTokensOut),
        };
      }

      if (e.kind === 'removed' && e.subagentId) {
        // Subtract the departing agent's contribution from the fleet token
        // totals — they are running deltas fed by per-agent snapshots, so a
        // removed agent's tokens otherwise stayed counted forever (only
        // session_stopped ever reset them, unconditionally to zero).
        const departing = agents.get(e.subagentId);
        agents.delete(e.subagentId);
        agentTranscripts.delete(e.subagentId);
        return {
          agents,
          agentTranscripts,
          agentTimeline: state.agentTimeline.filter((entry) => entry.subagentId !== e.subagentId),
          eventTimeline: state.eventTimeline.filter((entry) => entry.agentId !== e.subagentId),
          leaderId: state.leaderId === e.subagentId ? undefined : state.leaderId,
          fleetTokensIn: Math.max(0, state.fleetTokensIn - (departing?.tokensIn ?? 0)),
          fleetTokensOut: Math.max(0, state.fleetTokensOut - (departing?.tokensOut ?? 0)),
        };
      }

      // leader_updated: mark the new leader and demote the old one.
      if (e.kind === 'leader_updated' && e.subagentId) {
        const leader = agents.get(e.subagentId) ?? blankAgent(e.subagentId, e.name, e.sessionId);
        const leaderSession = e.sessionId || leader.sessionId;
        // Demote only the outgoing leader of the SAME session. Demoting
        // whoever held the process-wide pointer took the crown off another
        // tab's leader every time a second tab promoted one, and that tab then
        // listed its own leader among its subagents.
        for (const [id, agent] of agents) {
          if (id === e.subagentId || !agent.isLeader) continue;
          if (leaderSession && agent.sessionId && agent.sessionId !== leaderSession) continue;
          agents.set(id, { ...agent, isLeader: false });
        }
        const name = e.name?.trim() || leader.name;
        leaderId = e.subagentId;
        agents.set(e.subagentId, {
          ...leader,
          isLeader: true,
          name,
        });
        // The server re-sends leader_updated on every subscribeSessions (it
        // must: a reconnecting page needs the roster). The ROSTER upsert above
        // is idempotent by subagentId, but the timeline is a log — a pure
        // re-announce (same agent, already crowned, same name) would push a
        // duplicate row into the 20-slot timeline on every reconnect and tab
        // open, evicting real events. Log only state CHANGES.
        if (!leader.isLeader || name !== leader.name) {
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'leader_updated',
            agentId: e.subagentId,
            agentName: name,
            timestamp: Date.now(),
            message: `${name} became leader`,
          });
        }
        return { agents, leaderId, eventTimeline: timeline };
      }

      // Every other event kind addresses a single agent — without an id
      // there is nothing to upsert (malformed/partial payload).
      if (!e.subagentId) return state;

      const prev = agents.get(e.subagentId) ?? blankAgent(e.subagentId, e.name, e.sessionId);
      const next: SubagentView = { ...prev };
      const now = Date.now();
      const isLeader = e.subagentId === 'leader' || prev.isLeader;
      let transcriptChanged = false;

      switch (e.kind) {
        case 'spawned':
          next.name = e.name?.trim() || next.name;
          next.provider = e.provider ?? next.provider;
          next.model = e.model ?? next.model;
          next.description = e.description ?? next.description;
          next.taskId = e.taskId ?? next.taskId;
          next.sessionId = e.sessionId ?? next.sessionId;
          next.status = 'running';
          next.sparklineBins = Array(SPARKLINE_BINS).fill(0);
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'spawned',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} spawned`,
          });
          if (!isLeader && e.description) {
            const existing = agentTranscripts.get(e.subagentId) ?? [];
            if (existing.length === 0) {
              agentTranscripts.set(
                e.subagentId,
                appendTranscriptEntry(existing, {
                  id: `agent_tl_${now}_spawn`,
                  subagentId: e.subagentId,
                  sessionId: e.sessionId,
                  agentName: next.name,
                  content: `🎯 Spawned: ${e.description}`,
                  kind: 'system',
                  iteration: 0,
                  ts: new Date(now).toISOString(),
                }),
              );
              transcriptChanged = true;
            }
          }
          break;
        case 'task_started':
          next.description = e.description ?? next.description;
          next.taskId = e.taskId ?? next.taskId;
          next.status = 'running';
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'task_started',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} started: ${e.description ?? 'new task'}`,
          });
          if (!isLeader && (e.description || e.taskId)) {
            const taskText = e.description || e.taskId;
            const existing = agentTranscripts.get(e.subagentId) ?? [];
            const lastEntry = existing[existing.length - 1];
            if (!lastEntry || !lastEntry.content.includes(taskText as string)) {
              agentTranscripts.set(
                e.subagentId,
                appendTranscriptEntry(existing, {
                  id: `agent_tl_${now}_task`,
                  subagentId: e.subagentId,
                  sessionId: e.sessionId,
                  agentName: next.name,
                  content: `🎯 Task: ${taskText}`,
                  kind: 'status',
                  iteration: 0,
                  ts: new Date(now).toISOString(),
                }),
              );
              transcriptChanged = true;
            }
          }
          break;
        case 'tool_executed': {
          const ok = typeof e.ok === 'boolean' ? e.ok : true;
          const dur = typeof e.durationMs === 'number' ? e.durationMs : 0;
          next.lastTool = e.toolName ?? next.lastTool;
          next.toolCalls = next.toolCalls + 1;
          // Prepend to tool log, cap at 50
          next.toolLog = [
            { name: e.toolName ?? 'unknown', ok, durationMs: dur, at: now },
            ...next.toolLog,
          ].slice(0, 50);
          // Bump sparkline
          next.sparklineBins = bumpSparkline(next.sparklineBins);
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'tool_executed',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} ${ok ? '✓' : '✗'} ${e.toolName ?? 'tool'}`,
            value: dur,
          });
          if (!isLeader) {
            const toolContent = dur > 0 ? `Completed in ${dur}ms` : ok ? 'Success' : 'Failed';
            const existing = agentTranscripts.get(e.subagentId) ?? [];
            agentTranscripts.set(
              e.subagentId,
              appendTranscriptEntry(existing, {
                id: `agent_tl_${now}_tool_${Math.random().toString(36).slice(2, 6)}`,
                subagentId: e.subagentId,
                sessionId: e.sessionId,
                agentName: next.name,
                content: toolContent,
                kind: 'tool_result',
                toolName: e.toolName,
                toolOk: ok,
                iteration: next.iteration,
                ts: new Date(now).toISOString(),
              }),
            );
            transcriptChanged = true;
          }
          break;
        }
        case 'iteration_summary':
          next.iteration = e.iteration ?? next.iteration;
          if (typeof e.toolCalls === 'number') next.toolCalls = e.toolCalls;
          if (typeof e.costUsd === 'number') next.costUsd = e.costUsd;
          next.currentTool = e.currentTool ?? next.currentTool;
          if (typeof e.partialText === 'string' && e.partialText) {
            next.partialText = e.partialText;
          }
          // Bump sparkline on iteration
          next.sparklineBins = bumpSparkline(next.sparklineBins);
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'iteration_summary',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} iter ${e.iteration ?? next.iteration} · ${e.currentTool ? `${e.currentTool}` : ''}`,
            value: e.costUsd,
          });
          if (!isLeader && typeof e.partialText === 'string' && e.partialText) {
            const existing = agentTranscripts.get(e.subagentId) ?? [];
            agentTranscripts.set(
              e.subagentId,
              appendTranscriptEntry(existing, {
                id: `agent_tl_${now}_iter_${e.iteration ?? 0}`,
                subagentId: e.subagentId,
                sessionId: e.sessionId,
                agentName: next.name,
                content: e.partialText,
                kind: 'text',
                iteration: e.iteration ?? next.iteration,
                costUsd: e.costUsd,
                ts: new Date(now).toISOString(),
              }),
            );
            transcriptChanged = true;
          }
          break;
        case 'budget_warning': {
          const kind = e.budgetKind ?? 'budget';
          const used = typeof e.used === 'number' ? e.used : 0;
          const limit = typeof e.limit === 'number' ? e.limit : 0;
          next.budgetWarning = { kind, used, limit };
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'budget_warning',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} hit ${kind} budget ${used}/${limit}`,
            value: used,
          });
          break;
        }
        case 'budget_extended':
          next.extensions = e.totalExtensions ?? next.extensions + 1;
          // Clear any stale budget warning — the extension resolved it
          next.budgetWarning = undefined;
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'budget_extended',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} extended budget ⚡×${next.extensions}`,
          });
          break;
        case 'ctx_pct':
          next.ctxPct = clampContextPct(Math.round(Math.max(0, e.load ?? 0) * 100));
          next.ctxTokens = e.tokens ?? next.ctxTokens;
          next.maxContext = e.maxContext ?? next.maxContext;

          // Derive a budget_warning when the agent crosses 80% context fill.
          // This matches the TUI's warn threshold behaviour. budget_extended
          // clears the warning, so it only fires once until the next extension.
          if (next.ctxPct >= 80 && !next.budgetWarning) {
            next.budgetWarning =
              next.ctxPct >= 100
                ? { kind: 'hard', used: next.ctxPct, limit: 100 }
                : { kind: 'soft', used: next.ctxPct, limit: 100 };
          }

          if (typeof e.costUsd === 'number') next.costUsd = e.costUsd;
          if (typeof e.tokensIn === 'number') {
            next.tokensIn = e.tokensIn;
            fleetTokensIn = fleetTokensIn - (prev.tokensIn ?? 0) + e.tokensIn;
          }
          if (typeof e.tokensOut === 'number') {
            next.tokensOut = e.tokensOut;
            fleetTokensOut = fleetTokensOut - (prev.tokensOut ?? 0) + e.tokensOut;
          }
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'ctx_pct',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} ctx ${next.ctxPct}%`,
            value: next.ctxPct,
          });
          break;
        case 'task_completed': {
          const finalStatus = e.status === 'success' ? 'completed' : (e.status ?? 'completed');
          next.status = finalStatus;
          if (typeof e.iterations === 'number') next.iteration = e.iterations;
          if (typeof e.toolCalls === 'number') next.toolCalls = e.toolCalls;
          next.error = e.error;
          next.currentTool = undefined;
          next.completedAt = now;
          next.failureReason = e.failureReason ?? next.failureReason;
          if (typeof e.finalText === 'string' && e.finalText) {
            // Strip <nextsteps> blocks from subagent output — suggestions belong
            // to the main assistant, not subagent results.
            next.finalText = stripNextStepsBlock(e.finalText);
          }
          const statusLabel =
            e.status === 'success'
              ? '✓ completed'
              : e.status === 'failed'
                ? `✗ failed${e.failureReason ? ` (${e.failureReason})` : ''}`
                : e.status === 'timeout'
                  ? `⏱ timeout${e.failureReason ? ` (${e.failureReason})` : ''}`
                  : 'stopped';
          timeline = pushTimeline(timeline, {
            id: makeTimelineId(),
            kind: 'task_completed',
            agentId: e.subagentId,
            agentName: next.name,
            timestamp: now,
            message: `${next.name} ${statusLabel}`,
            value: next.costUsd,
          });
          if (!isLeader) {
            const existing = agentTranscripts.get(e.subagentId) ?? [];
            if (typeof e.finalText === 'string' && e.finalText) {
              const cleaned = stripNextStepsBlock(e.finalText);
              const alreadyHas = existing.some(
                (item) => item.kind === 'text' && item.content.includes(cleaned),
              );
              if (!alreadyHas) {
                agentTranscripts.set(
                  e.subagentId,
                  appendTranscriptEntry(existing, {
                    id: `agent_tl_${now}_done_text`,
                    subagentId: e.subagentId,
                    sessionId: e.sessionId,
                    agentName: next.name,
                    content: cleaned,
                    kind: 'text',
                    iteration: e.iterations ?? next.iteration,
                    ts: new Date(now).toISOString(),
                  }),
                );
                transcriptChanged = true;
              }
            }
            if (e.status === 'failed' || e.status === 'timeout') {
              const errMsg =
                e.error?.message ??
                (e.failureReason ? `Failed: ${e.failureReason}` : `Agent ${e.status}`);
              agentTranscripts.set(
                e.subagentId,
                appendTranscriptEntry(agentTranscripts.get(e.subagentId) ?? [], {
                  id: `agent_tl_${now}_err`,
                  subagentId: e.subagentId,
                  sessionId: e.sessionId,
                  agentName: next.name,
                  content: errMsg,
                  kind: 'error',
                  iteration: e.iterations ?? next.iteration,
                  ts: new Date(now).toISOString(),
                }),
              );
              transcriptChanged = true;
            } else if (!e.finalText) {
              agentTranscripts.set(
                e.subagentId,
                appendTranscriptEntry(agentTranscripts.get(e.subagentId) ?? [], {
                  id: `agent_tl_${now}_done_status`,
                  subagentId: e.subagentId,
                  sessionId: e.sessionId,
                  agentName: next.name,
                  content: 'Task completed successfully',
                  kind: 'status',
                  iteration: e.iterations ?? next.iteration,
                  ts: new Date(now).toISOString(),
                }),
              );
              transcriptChanged = true;
            }
          }
          break;
        }
      }
      agents.set(e.subagentId, next);
      // Bound the roster at ingest (the coordinator-monitor-store pattern:
      // every Map capped, eviction prefers terminal records). `agents` was
      // the one uncapped Map here — AgentsPanel's "agents are bounded, show
      // all without pagination" comment relied on a bound that didn't
      // exist, and a long session with hundreds of spawns kept every
      // record resident. Evict oldest-inserted non-running agents first;
      // running agents are never evicted (they'd lose live telemetry), and
      // their token totals follow them out (same running-delta contract as
      // `removed`).
      let evicted = false;
      if (agents.size > MAX_FLEET_AGENTS) {
        for (const [id, agent] of agents) {
          if (agents.size <= MAX_FLEET_AGENTS) break;
          if (agent.status === 'running' || id === e.subagentId) continue;
          agents.delete(id);
          agentTranscripts.delete(id);
          evicted = true;
          fleetTokensIn = Math.max(0, fleetTokensIn - (agent.tokensIn ?? 0));
          fleetTokensOut = Math.max(0, fleetTokensOut - (agent.tokensOut ?? 0));
          if (leaderId === id) leaderId = undefined;
        }
      }
      return {
        agents,
        agentTranscripts: transcriptChanged || evicted ? agentTranscripts : state.agentTranscripts,
        leaderId,
        fleetTokensIn,
        fleetTokensOut,
        eventTimeline: timeline,
      };
    }),
}));

// ── Derived selectors ──────────────────────────────────────────────────
//
// These can be called directly against store state. When subscribing to a
// selector that returns a new object or array, wrap it with Zustand's
// `useShallow` so useSyncExternalStore receives a reference-stable snapshot:
//
//   const summary = useFleetStore(useShallow(selectFleetSummary));
//
// The local `shallow` export below remains available for direct comparisons.

/** Pre-computed fleet-wide summary statistics. */
export interface FleetSummary {
  running: number;
  completed: number;
  failed: number;
  total: number;
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
  concurrency: number;
  concurrencyMax: number;
  maxSpawns?: number | undefined;
  usedSpawns?: number | undefined;
  remainingSpawns?: number | undefined;
  budgetSource?: string | undefined;
  ceilingMismatch?: boolean | undefined;
  checkpointMaxSpawns?: number | undefined;
}

/** Shallow comparison for zustand selector equality checks.
 *  Compares own enumerable string-keyed properties by reference.
 *  Use with object selectors to avoid unnecessary re-renders:
 *    useFleetStore(selectFleetSummary, shallow)
 */
export function shallow<T extends Record<string, unknown>>(a: T, b: T): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Selector: derive fleet-wide summary from raw store state.
 *  Iterates the agents Map once to compute running/completed/failed
 *  counts and total cost, then reads scalar fields directly.
 */
export const selectFleetSummary = (state: FleetState): FleetSummary => {
  let running = 0;
  let completed = 0;
  let failed = 0;
  let totalCost = 0;
  for (const agent of state.agents.values()) {
    if (agent.status === 'running') running++;
    else if (agent.status === 'completed') completed++;
    else if (agent.status === 'failed' || agent.status === 'timeout') failed++;
    if (Number.isFinite(agent.costUsd) && agent.costUsd > 0) totalCost += agent.costUsd;
  }
  return {
    running,
    completed,
    failed,
    total: state.agents.size,
    totalCost,
    tokensIn: state.fleetTokensIn,
    tokensOut: state.fleetTokensOut,
    concurrency: state.fleetConcurrency,
    concurrencyMax: state.fleetConcurrencyMax,
    maxSpawns: state.fleetMaxSpawns,
    usedSpawns: state.fleetUsedSpawns,
    remainingSpawns: state.fleetRemainingSpawns,
    budgetSource: state.fleetBudgetSource,
    ceilingMismatch: state.fleetCeilingMismatch || undefined,
    checkpointMaxSpawns: state.fleetCheckpointMaxSpawns,
  };
};

/** Selector: return agents sorted leader-first → running-first → by start time.
 *  Creates a new array on every call; wrap with `useShallow` when subscribing
 *  through useFleetStore.
 *
 *  Leader-first ordering honors EVERY session's leader (`isLeader` flag),
 *  not the process-wide `leaderId` pointer: that pointer is last-writer-wins
 *  across four tabs, so sorting by it crowned only the most recently
 *  announced tab's leader and demoted the other three on every announce.
 */
export const selectSortedAgentList = (state: FleetState): SubagentView[] => {
  const arr = Array.from(state.agents.values());
  arr.sort((x, y) => {
    if (x === y || x.id === y.id) return 0;
    if (x.isLeader !== y.isLeader) return x.isLeader ? -1 : 1;
    return compareAgentsByActivity(x, y);
  });
  return arr;
};

/** Selector: O(1) lookup of the leader agent's name via the agents Map. */
export const selectLeaderName = (state: FleetState): string | undefined =>
  state.leaderId ? state.agents.get(state.leaderId)?.name : undefined;

// ── Per-session fleet accounting ───────────────────────────────────────────
//
// `leaderId` and `fleetTokensIn/Out` above are process-wide: one leader
// pointer and one running total for the whole roster. With four tabs open
// that is wrong in both directions — tab 1's crown lands on tab 3's card, and
// the Inspector shows the SUM of four sessions' subagent tokens as if it were
// this session's cost.
//
// The roster already knows better: every agent carries its own `sessionId`,
// `isLeader`, `tokensIn/Out`, status and cost. So rather than maintaining a
// second set of incremental counters per session — the existing global ones
// need three separate correction paths (removal, eviction, clear) precisely
// because incremental counters drift — the per-session view is DERIVED from
// the roster and cached against the `agents` Map identity. The Map is
// replaced on every applied event, so this recomputes at most once per event
// over a roster capped at 200, and it cannot disagree with what is displayed.

export interface SessionFleetTotals {
  /** The leader of THIS session, or undefined when it has none. */
  leaderId: string | undefined;
  tokensIn: number;
  tokensOut: number;
  totalCost: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
}

const EMPTY_SESSION_TOTALS: SessionFleetTotals = Object.freeze({
  leaderId: undefined,
  tokensIn: 0,
  tokensOut: 0,
  totalCost: 0,
  running: 0,
  completed: 0,
  failed: 0,
  total: 0,
});

/**
 * Agents with no `sessionId` at all. They belong to no tab, so they are
 * counted once under this key rather than added to every tab's totals.
 */
const UNATTRIBUTED = ' unattributed';

const totalsCache = new WeakMap<Map<string, SubagentView>, Map<string, SessionFleetTotals>>();

function totalsBySession(agents: Map<string, SubagentView>): Map<string, SessionFleetTotals> {
  const cached = totalsCache.get(agents);
  if (cached) return cached;
  const out = new Map<string, SessionFleetTotals>();
  for (const agent of agents.values()) {
    const key = agent.sessionId || UNATTRIBUTED;
    let bucket = out.get(key);
    if (!bucket) {
      bucket = { ...EMPTY_SESSION_TOTALS };
      out.set(key, bucket);
    }
    bucket.total++;
    if (agent.status === 'running') bucket.running++;
    else if (agent.status === 'completed') bucket.completed++;
    else if (agent.status === 'failed' || agent.status === 'timeout') bucket.failed++;
    if (Number.isFinite(agent.costUsd) && agent.costUsd > 0) bucket.totalCost += agent.costUsd;
    bucket.tokensIn += agent.tokensIn ?? 0;
    bucket.tokensOut += agent.tokensOut ?? 0;
    if (agent.isLeader) bucket.leaderId = agent.id;
  }
  totalsCache.set(agents, out);
  return out;
}

/** Fleet totals for ONE session. Never mutate the result — it is cached. */
export const selectSessionFleetTotals = (
  state: FleetState,
  sessionId: string | undefined,
): SessionFleetTotals => {
  if (!sessionId) return EMPTY_SESSION_TOTALS;
  return totalsBySession(state.agents).get(sessionId) ?? EMPTY_SESSION_TOTALS;
};

/**
 * The leader of ONE session.
 *
 * Falls back to the process-wide `leaderId` only when that agent actually
 * belongs to the session asked about — a leader that belongs to another tab
 * must never be reported here, which is exactly the crown-on-the-wrong-card
 * bug this replaces.
 */
export const selectSessionLeaderId = (
  state: FleetState,
  sessionId: string | undefined,
): string | undefined => {
  if (!sessionId) {
    if (!state.leaderId) return undefined;
    const globalAgent = state.agents.get(state.leaderId);
    return globalAgent && !globalAgent.sessionId ? state.leaderId : undefined;
  }
  const derived = totalsBySession(state.agents).get(sessionId)?.leaderId;
  if (derived) return derived;
  const global = state.leaderId;
  if (!global) return undefined;
  const agent = state.agents.get(global);
  return agent && agent.sessionId === sessionId ? global : undefined;
};

/** Hook: the leader of the tab in front (or of `sessionId` when given). */
export function useSessionLeaderId(sessionId?: string | undefined): string | undefined {
  const activeSessionId = useActiveSessionId();
  const target = sessionId ?? (activeSessionId || undefined);
  return useFleetStore((s) => selectSessionLeaderId(s, target));
}

/** Hook: fleet totals for the tab in front (or for `sessionId` when given). */
export function useSessionFleetTotals(sessionId?: string | undefined): SessionFleetTotals {
  const activeSessionId = useActiveSessionId();
  const target = sessionId ?? (activeSessionId || undefined);
  return useFleetStore((s) => selectSessionFleetTotals(s, target));
}
