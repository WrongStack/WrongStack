import type {
  AgentTranscriptEntry,
  SubagentView,
  VizEvent,
} from '@wrongstack/project-surfaces/office/types';
import type { EngineState } from './engine-state';

/** The fleet of a project's live conversations, as the office map shows it. */
export interface OfficeFleet {
  agents: ReadonlyMap<string, SubagentView>;
  transcripts: ReadonlyMap<string, AgentTranscriptEntry[]>;
  leaderId: string | undefined;
  /** Tool calls as office activity events, newest first. */
  toolEvents: VizEvent[];
}

type FleetSource = Pick<EngineState, 'sessionId' | 'fleet' | 'agents' | 'activity' | 'lastAt'>;

/** Tool events the office keeps, as many as the WebUI's activity store keeps. */
export const OFFICE_TOOL_EVENT_LIMIT = 600;

export const EMPTY_OFFICE_FLEET: OfficeFleet = {
  agents: new Map(),
  transcripts: new Map(),
  leaderId: undefined,
  toolEvents: [],
};

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const isTool = (type: string) => type === 'tool.started' || type === 'tool.executed';

/**
 * One conversation's tool calls from its activity frames, oldest first. A finished call is
 * named by its start, since `tool.executed` does not repeat the tool name.
 */
export function officeToolEvents(state: FleetSource): VizEvent[] {
  const names = new Map<string, string>();
  const events: VizEvent[] = [];
  for (const [index, event] of state.activity.entries()) {
    if (!isTool(event.type)) continue;
    const id = text(event.payload['id']);
    const name = text(event.payload['name']) ?? (id ? names.get(id) : undefined);
    if (!name) continue;
    if (id) names.set(id, name);
    events.push({
      id: `${state.sessionId}:${id ?? index}:${event.type}`,
      kind: event.type === 'tool.started' ? 'tool:started' : 'tool:executed',
      timestamp: event.at ?? state.lastAt,
      source: text(event.payload['agentId']) ?? 'leader',
      label: name,
      data: { ...event.payload, name, ...(state.sessionId ? { sessionId: state.sessionId } : {}) },
    });
  }
  return events;
}

/**
 * Merges the fleets of a project's conversations: their subagents, each agent's transcript
 * (the conversation's own timeline frames when it has them, fuller than the fleet's summary
 * lines), the leader and the tool calls, newest first.
 */
export function mergeOfficeFleet(states: readonly FleetSource[]): OfficeFleet {
  const agents = new Map<string, SubagentView>();
  const transcripts = new Map<string, AgentTranscriptEntry[]>();
  let leaderId: string | undefined;
  const toolEvents: VizEvent[] = [];
  for (const state of states) {
    for (const [id, agent] of state.fleet.agents) agents.set(id, agent);
    for (const [id, entries] of state.fleet.agentTranscripts) transcripts.set(id, entries);
    for (const [id, transcript] of Object.entries(state.agents))
      if (transcript.entries.length) transcripts.set(id, transcript.entries);
    leaderId ??= state.fleet.leaderId;
    toolEvents.push(...officeToolEvents(state));
  }
  // Reversed first so a call's finish stays ahead of its start when both carry the same time.
  toolEvents.reverse().sort((a, b) => b.timestamp - a.timestamp);
  return {
    agents,
    transcripts,
    leaderId,
    toolEvents: toolEvents.slice(0, OFFICE_TOOL_EVENT_LIMIT),
  };
}

/**
 * What a conversation's office fleet is made of, compared by identity: it changes when the
 * fleet, the transcripts or the tool calls do, not with every streamed token.
 */
export function officeFleetParts(state: FleetSource): unknown[] {
  let count = 0;
  let last = '';
  for (const event of state.activity) {
    if (!isTool(event.type)) continue;
    count += 1;
    last = `${event.type}:${String(event.payload['id'] ?? '')}`;
  }
  return [state.fleet, state.agents, `${state.sessionId}|${count}|${last}`];
}
