import type {
  AgentTranscriptEntry,
  AgentTranscriptKind,
} from '@wrongstack/project-surfaces/office/types';

/**
 * Each subagent's own transcript in a conversation, folded from the engine's
 * `agent.timeline.message` and `agent.status_changed` frames as the WebUI's fleet store folds
 * them: consecutive text or thinking of one iteration joins into one entry, and every agent keeps
 * its newest entries only.
 */
export interface AgentTranscript {
  id: string;
  name: string;
  /** As the engine reports it: running, completed, failed, timeout, stopped… */
  status: string;
  task?: string | undefined;
  entries: AgentTranscriptEntry[];
}
export type AgentTranscripts = Readonly<Record<string, AgentTranscript>>;

const MAX_ENTRIES = 600;
const KINDS: readonly AgentTranscriptKind[] = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'error',
  'status',
  'system',
];
const text = (value: unknown) => (typeof value === 'string' ? value : '');

function append(entries: AgentTranscriptEntry[], entry: AgentTranscriptEntry) {
  const last = entries.at(-1);
  if (
    last &&
    last.kind === entry.kind &&
    last.iteration === entry.iteration &&
    (entry.kind === 'text' || entry.kind === 'thinking')
  )
    return [
      ...entries.slice(0, -1),
      { ...last, content: last.content + entry.content, ts: entry.ts },
    ];
  return [...entries, entry].slice(-MAX_ENTRIES);
}

/** Applies one engine frame; returns `agents` itself for any other frame. */
export function reduceAgentTranscripts(
  agents: AgentTranscripts,
  type: string,
  payload: Record<string, unknown>,
): AgentTranscripts {
  if (type !== 'agent.timeline.message' && type !== 'agent.status_changed') return agents;
  const id = text(payload['subagentId']);
  if (!id || id === 'leader') return agents;
  const name = text(payload['agentName']).trim();
  const agent = agents[id] ?? { id, name: name || id, status: 'running', entries: [] };
  const base = {
    id: `${id}:${agent.entries.length}:${text(payload['ts'])}`,
    subagentId: id,
    agentName: name || agent.name,
    iteration: typeof payload['iteration'] === 'number' ? payload['iteration'] : 0,
    ts: text(payload['ts']),
  };
  if (type === 'agent.status_changed') {
    const status = text(payload['status']) || agent.status;
    return {
      ...agents,
      [id]: {
        ...agent,
        name: name || agent.name,
        status,
        task: text(payload['task']) || agent.task,
        entries: append(agent.entries, {
          ...base,
          kind: 'status',
          content: text(payload['summary']) || status,
          status,
        }),
      },
    };
  }
  const kind = KINDS.find((candidate) => candidate === payload['kind']) ?? 'status';
  return {
    ...agents,
    [id]: {
      ...agent,
      name: name || agent.name,
      entries: append(agent.entries, {
        ...base,
        kind,
        content: text(payload['content']),
        ...(typeof payload['toolName'] === 'string' ? { toolName: payload['toolName'] } : {}),
        ...(typeof payload['toolOk'] === 'boolean' ? { toolOk: payload['toolOk'] } : {}),
      }),
    },
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function transcriptEntry(id: string, name: string, value: unknown): AgentTranscriptEntry | null {
  const line = record(value);
  const kind = KINDS.find((candidate) => candidate === line['kind']);
  if (!kind || typeof line['content'] !== 'string') return null;
  const ts = text(line['ts']);
  return {
    id: text(line['id']) || `${id}:${kind}:${ts}`,
    subagentId: id,
    agentName: text(line['agentName']).trim() || name,
    kind,
    content: line['content'],
    iteration: typeof line['iteration'] === 'number' ? line['iteration'] : 0,
    ts,
    ...(typeof line['toolName'] === 'string' ? { toolName: line['toolName'] } : {}),
    ...(typeof line['toolOk'] === 'boolean' ? { toolOk: line['toolOk'] } : {}),
    ...(typeof line['costUsd'] === 'number' ? { costUsd: line['costUsd'] } : {}),
  };
}

/**
 * Brings back the subagents a reopened conversation had, from the `agentSessions` its
 * `session.start` replay carries, as the WebUI's fleet store hydrates them: an agent the live
 * frames already know keeps its status, and replayed entries it already holds are not doubled.
 */
export function hydrateAgentTranscripts(
  agents: AgentTranscripts,
  sessions: unknown,
): AgentTranscripts {
  if (!Array.isArray(sessions) || sessions.length === 0) return agents;
  let next = agents;
  for (const value of sessions) {
    const session = record(value);
    const id = text(session['subagentId']);
    if (!id || id === 'leader') continue;
    const known = next[id];
    const name = known?.name ?? (text(session['agentName']).trim() || id);
    const task = known?.task || text(session['task']) || undefined;
    const replayed = Array.isArray(session['transcript'])
      ? session['transcript'].flatMap((line) => transcriptEntry(id, name, line) ?? [])
      : [];
    const current = known?.entries ?? [];
    const fresh = replayed.filter(
      (entry) =>
        !current.some(
          (held) =>
            held.id === entry.id ||
            (held.ts === entry.ts && held.content === entry.content && held.kind === entry.kind),
        ),
    );
    next = {
      ...next,
      [id]: {
        id,
        name,
        status: known?.status ?? (text(session['status']) || 'completed'),
        ...(task ? { task } : {}),
        // Replayed entries are older than anything a live frame added since.
        entries: [...fresh, ...current].slice(-MAX_ENTRIES),
      },
    };
  }
  return next;
}

/** A transcript step for display: a tool call is joined with its result. */
export type TranscriptStep =
  | { kind: 'entry'; entry: AgentTranscriptEntry }
  | {
      kind: 'tool';
      call?: AgentTranscriptEntry | undefined;
      result?: AgentTranscriptEntry | undefined;
    };

export function transcriptSteps(entries: readonly AgentTranscriptEntry[]): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  const open: Array<Extract<TranscriptStep, { kind: 'tool' }>> = [];
  for (const entry of entries) {
    if (entry.kind === 'tool_use') {
      const step = { kind: 'tool' as const, call: entry };
      open.push(step);
      steps.push(step);
    } else if (entry.kind === 'tool_result') {
      const index = open.findIndex(
        (step) => !step.result && step.call?.toolName === entry.toolName,
      );
      if (index >= 0) {
        open[index]!.result = entry;
        open.splice(index, 1);
      } else steps.push({ kind: 'tool', result: entry });
    } else steps.push({ kind: 'entry', entry });
  }
  return steps;
}
