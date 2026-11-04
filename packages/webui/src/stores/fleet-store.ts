import { applyFleetEvent } from '@wrongstack/project-surfaces/office/fleet-fold';
import { stripNextStepsBlock } from '@wrongstack/tools/next-steps';
import { create } from 'zustand';
import { agentBelongsToSession } from '@/lib/agent-session';
import type { FleetState, SessionFleetTotals } from './fleet-selectors.js';
import { selectSessionFleetTotals, selectSessionLeaderId } from './fleet-selectors.js';
import { appendTranscriptEntry, blankAgent, MAX_AGENT_TRANSCRIPT } from './fleet-transcript.js';
import { useActiveSessionId } from './session-lanes.js';
import type { AgentTranscriptEntry, AgentTranscriptKind, SubagentView } from './types.js';

export type { FleetState, FleetSummary, SessionFleetTotals } from './fleet-selectors.js';
export {
  selectFleetSummary,
  selectLeaderName,
  selectSessionFleetTotals,
  selectSessionLeaderId,
  selectSortedAgentList,
  shallow,
} from './fleet-selectors.js';

const MAX_AGENT_TIMELINE = 500;

export const EMPTY_AGENT_TRANSCRIPT: AgentTranscriptEntry[] = [];

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
        if (!s?.subagentId || s.subagentId === 'leader') continue;
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
  removeAgent: (subagentId) =>
    set((state) => {
      const agent = state.agents.get(subagentId);
      if (!agent) return state;
      const agents = new Map(state.agents);
      agents.delete(subagentId);
      const agentTranscripts = new Map(state.agentTranscripts);
      agentTranscripts.delete(subagentId);
      return {
        agents,
        agentTranscripts,
        agentTimeline: state.agentTimeline.filter((e) => e.subagentId !== subagentId),
        eventTimeline: state.eventTimeline.filter((e) => e.agentId !== subagentId),
        leaderId: state.leaderId === subagentId ? undefined : state.leaderId,
        // Same running-delta contract as clearFinishedAgents: totals are sums
        // of per-agent contributions, so the agent's tokens leave with it.
        fleetTokensIn: Math.max(0, state.fleetTokensIn - (agent.tokensIn ?? 0)),
        fleetTokensOut: Math.max(0, state.fleetTokensOut - (agent.tokensOut ?? 0)),
      };
    }),
  applyEvent: (e) =>
    set((state) => applyFleetEvent(state, e, { cleanFinalText: stripNextStepsBlock })),
}));

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
