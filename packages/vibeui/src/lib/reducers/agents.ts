import { isActiveAgent } from '../agent-state';
import { updateAgent } from '../session-agents';
import { rows, text } from '../session-coercion';
import type { SessionState } from '../session-state';
import type { FrameReducer, FrameReducerTable } from './types';

const agentEvent: FrameReducer = (state, p, frame) => updateAgent(state, p, frame.type);

/** Replays a session.start agent snapshot (status, then up to 100 transcript entries). */
export function replayAgentSessions(
  state: SessionState,
  agentSessions: readonly Record<string, unknown>[],
): SessionState {
  return agentSessions.reduce<SessionState>(
    (s, agent) => {
      let next = updateAgent(s, agent, 'agent.status_changed');
      for (const entry of rows(agent.transcript).slice(-100))
        next = updateAgent(
          next,
          { ...entry, subagentId: agent.subagentId },
          'agent.timeline.message',
        );
      return next;
    },
    { ...state, agents: [] },
  );
}

/**
 * The canonical per-session agent list wins: active workers missing from it
 * are stopped, listed ones are merged in. A malformed snapshot changes nothing.
 */
const statusUpdate: FrameReducer = (state, p) => {
  const own = rows(p.sessions).find((s) => s.sessionId === state.id);
  if (!own || !Array.isArray(own.agents)) return state;
  const ids = new Set(rows(own.agents).map((agent) => text(agent.id)));
  const reconciled: SessionState = {
    ...state,
    agents: state.agents.map((agent) =>
      isActiveAgent(agent.status) && !ids.has(agent.id)
        ? { ...agent, status: 'stopped', currentTool: '' }
        : agent,
    ),
  };
  return rows(own.agents).reduce<SessionState>(
    (s, agent) =>
      updateAgent(
        s,
        {
          ...agent,
          subagentId: agent.id,
          agentName: agent.name,
          description: text(agent.currentTask),
          partialText: agent.partialText,
        },
        'agent.status_changed',
      ),
    reconciled,
  );
};

/** Subagent lifecycle, timelines, coordinator stats and session status reconciliation. */
export const agentReducers: FrameReducerTable = {
  'agent.status_changed': agentEvent,
  'subagent.event': agentEvent,
  'agent.timeline.message': agentEvent,
  'coordinator.stats': (state, p) =>
    rows(p.subagentStatuses).reduce(
      (s, agent) =>
        updateAgent(
          s,
          {
            ...agent,
            subagentId: agent.id,
            agentName: agent.name,
            description: s.agents.find((item) => item.id === agent.id)?.task || agent.currentTask,
          },
          'agent.status_changed',
        ),
      state,
    ),
  'sessions.status_update': statusUpdate,
};
