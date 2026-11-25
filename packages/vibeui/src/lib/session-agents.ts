import { isActiveAgent } from './agent-state';
import { bounded, number, record, text } from './session-coercion';

export interface AgentEntry {
  hasWorked?: boolean;
  sequence: number;
  id: string;
  name: string;
  status: string;
  task: string;
  provider: string;
  model: string;
  currentTool: string;
  partialText: string;
  iterations: number;
  toolCalls: number;
  costUsd: number;
  tokens: number;
  maxContext: number;
  entries: { id: string; kind: string; content: string; ts: string; toolName: string }[];
}

export function updateAgent<S extends { agents: AgentEntry[] }>(
  state: S,
  p: Record<string, unknown>,
  type: string,
): S {
  const id = text(p.subagentId);
  if (!id || id === 'leader') return state;
  const previous = state.agents.find((agent) => agent.id === id);
  const kind = text(p.kind);
  if (
    !previous &&
    type === 'subagent.event' &&
    !['spawned', 'task_started', 'task_completed'].includes(kind)
  )
    return state;
  const agent: AgentEntry = previous
    ? { ...previous }
    : {
        id,
        name: id,
        sequence: 0,
        status: 'idle',
        task: '',
        provider: '',
        model: '',
        currentTool: '',
        partialText: '',
        iterations: 0,
        toolCalls: 0,
        costUsd: 0,
        tokens: 0,
        maxContext: 0,
        entries: [],
      };
  const isTimeline = type === 'agent.timeline.message';
  const name = text(p.agentName) || (!isTimeline ? text(p.name) : '');
  if (name && (name !== id || agent.name === id)) agent.name = name;
  if (!isTimeline && (text(p.description) || text(p.task)))
    agent.task = text(p.description) || text(p.task);
  if (text(p.model)) agent.model = text(p.model);
  if (text(p.provider)) agent.provider = text(p.provider);
  if (!isTimeline) {
    if (text(p.status)) agent.status = text(p.status);
    if (kind === 'task_started') agent.status = 'running';
    if (kind === 'removed') {
      agent.status = 'stopped';
      agent.currentTool = '';
    }
    if (kind === 'task_completed') {
      agent.status = text(p.status) || 'completed';
      agent.currentTool = '';
      agent.partialText = '';
    }
  } else if (!previous) {
    agent.status = 'running';
  }
  if (isActiveAgent(agent.status) || kind === 'task_completed' || type === 'agent.timeline.message')
    agent.hasWorked = true;
  if (typeof p.iteration === 'number' || typeof p.iterations === 'number')
    agent.iterations = Math.max(0, number(p.iteration ?? p.iterations));
  if (typeof p.toolCalls === 'number') agent.toolCalls = Math.max(0, number(p.toolCalls));
  if (typeof p.costUsd === 'number') agent.costUsd = Math.max(0, number(p.costUsd));
  if (typeof p.tokens === 'number') agent.tokens = Math.max(0, number(p.tokens));
  if (typeof p.maxContext === 'number') agent.maxContext = Math.max(0, number(p.maxContext));
  if (typeof p.currentTool === 'string') agent.currentTool = p.currentTool;
  if (typeof p.partialText === 'string') agent.partialText = p.partialText.slice(-20_000);
  if (!isActiveAgent(agent.status)) agent.currentTool = '';
  const content =
    type === 'agent.timeline.message'
      ? text(p.content)
      : kind === 'task_completed'
        ? text(p.finalText) || text(record(p.error).message)
        : '';
  if (content)
    agent.entries = [
      ...agent.entries,
      {
        id: `${id}-${++agent.sequence}`,
        kind:
          type === 'agent.timeline.message'
            ? kind || 'text'
            : p.status === 'failed'
              ? 'error'
              : 'result',
        content: bounded(content).slice(-20_000),
        ts: text(p.ts),
        toolName: text(p.toolName),
      },
    ].slice(-100);
  return {
    ...state,
    agents: previous
      ? state.agents.map((item) => (item.id === id ? agent : item))
      : [...state.agents, agent].slice(-40),
  };
}
