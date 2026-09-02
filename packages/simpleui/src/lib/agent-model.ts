import type { AgentSessionReplay, AgentTranscriptEntry, SimpleSubagent } from '../types.js';

export const LEADER_AGENT_ID = 'leader';
const MAX_AGENT_TRANSCRIPT_ENTRIES = 500;

/**
 * How long an idle/offline worker stays visible before it is pruned from the
 * UI. Active (running/busy) agents are never pruned regardless of age.
 */
export const IDLE_AGENT_TTL_MS = 60_000;

/** Statuses that mean the agent is still doing work and must stay a live tab. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'busy', 'working', 'active']);

/** Statuses that mean the agent is gone and should be pruned once it ages out. */
const REMOVABLE_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'offline',
  'off',
  'stopped',
  'cancelled',
  'canceled',
]);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status.toLowerCase());
}

export interface AgentTab {
  id: string;
  name: string;
  status: string;
  task?: string | undefined;
  isLeader: boolean;
  /** true when running/busy — kept as a strip tab rather than in the dropdown. */
  isActive: boolean;
  /** Epoch ms of the last update, when known. */
  updatedAt?: number | undefined;
}

/** UUIDs are 36-char hex strings with 4 hyphens. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pool of creative agent names — assigned round-robin when no explicit name
 *  or task is available. Each agent keeps its assigned name for life. */
const NAME_POOL: readonly string[] = [
  'Einstein',
  'Tesla',
  'Curie',
  'Turing',
  'Feynman',
  'Hopper',
  'Neumann',
  'Lovelace',
  'Babbage',
  'Knuth',
  'Ritchie',
  'Torvalds',
  'Berners',
  'Cerf',
  'Lamport',
  'Dijkstra',
  'Shannon',
  'McCarthy',
  'Backus',
  'Engelbart',
  'Borg',
  'Clarke',
  'Asimov',
  'Sagan',
  'Hawking',
  'Darwin',
  'Newton',
  'Galileo',
  'Kepler',
  'Copernicus',
];

/** Stable name assignments — an agent keeps its name forever once assigned. */
const nameCache = new Map<string, string>();
let nameCursor = 0;

/** Clear the name cache (e.g. on session reset). */
export function resetAgentNameCache(): void {
  nameCache.clear();
  nameCursor = 0;
}

/** Derive a short label from a task description — first sentence, max 48 chars. */
function taskToName(task: string): string {
  const firstSentence = task.split(/[.!?]\s/)[0] ?? task;
  const trimmed = firstSentence.trim();
  if (trimmed.length <= 48) return trimmed;
  // Try to break at a word boundary.
  const cut = trimmed.lastIndexOf(' ', 45);
  return cut > 30 ? `${trimmed.slice(0, cut)}…` : `${trimmed.slice(0, 45)}…`;
}

/** Pick the next unused creative name from the pool (round-robin, skips taken). */
function nextPoolName(): string {
  for (let attempt = 0; attempt < NAME_POOL.length; attempt++) {
    const name = NAME_POOL[nameCursor % NAME_POOL.length];
    nameCursor++;
    if (!nameCache.has(name)) return name;
  }
  // Pool exhausted — fall back to a numbered variant.
  for (let suffix = 2; ; suffix++) {
    const name = `${NAME_POOL[0]} ${suffix}`;
    if (!nameCache.has(name)) return name;
  }
}

/** Assign a stable, human-readable display name for an agent.
 *
 *  Priority order:
 *  1. Explicit non-UUID name from the server (e.g. "bug-hunter").
 *  2. Task-derived label ("Fix auth bug in login").
 *  3. Creative name from the pool (Einstein, Tesla, …).
 *
 *  Once assigned, the name is cached per agent id — reordering the agent list
 *  or re-rendering never changes an existing agent's display name. */
function assignName(id: string, name: string, task?: string | undefined): string {
  if (nameCache.has(id)) return nameCache.get(id)!;

  const explicitName = name.trim();
  if (
    explicitName &&
    !UUID_RE.test(explicitName) &&
    explicitName.toLowerCase() !== id.toLowerCase()
  ) {
    nameCache.set(id, explicitName);
    return explicitName;
  }

  if (task?.trim()) {
    const derived = taskToName(task.trim());
    // Avoid collisions with pool names by appending a suffix if needed.
    const unique = nameCache.has(derived) ? `${derived} #${id.slice(0, 4)}` : derived;
    nameCache.set(id, unique);
    return unique;
  }

  const poolName = nextPoolName();
  nameCache.set(id, poolName);
  return poolName;
}

/** The leader is always first; workers retain their stable discovery order. */
export function buildAgentTabs(subagents: SimpleSubagent[], leaderRunning: boolean): AgentTab[] {
  return [
    {
      id: LEADER_AGENT_ID,
      name: 'LEADER',
      status: leaderRunning ? 'running' : 'idle',
      isLeader: true,
      isActive: true,
    },
    ...subagents.map((agent) => ({
      ...agent,
      name: assignName(agent.id, agent.name, agent.task),
      isLeader: false,
      isActive: isActiveStatus(agent.status),
    })),
  ];
}

/**
 * Refresh `updatedAt` on agents whose identity is new or whose status changed
 * versus the previous list, leaving unchanged agents untouched so the idle TTL
 * measures time since the last *real* update, not every re-render.
 */
export function stampAgentUpdates(
  previous: SimpleSubagent[],
  next: SimpleSubagent[],
  now: number = Date.now(),
): SimpleSubagent[] {
  const before = new Map(previous.map((agent) => [agent.id, agent]));
  return next.map((agent) => {
    const prior = before.get(agent.id);
    if (prior && prior.status === agent.status && typeof prior.updatedAt === 'number') {
      return agent.updatedAt === prior.updatedAt ? agent : { ...agent, updatedAt: prior.updatedAt };
    }
    return { ...agent, updatedAt: now };
  });
}

/** Split worker tabs into live (strip) and finished (dropdown) groups. */
export function partitionAgentTabs(tabs: AgentTab[]): {
  active: AgentTab[];
  finished: AgentTab[];
} {
  const active: AgentTab[] = [];
  const finished: AgentTab[] = [];
  for (const tab of tabs) {
    if (tab.isLeader || tab.isActive) active.push(tab);
    else finished.push(tab);
  }
  return { active, finished };
}

/**
 * Drop idle/offline workers that haven't updated within the TTL so the strip
 * and dropdown don't accumulate agents no longer worth viewing. Agents without
 * a known `updatedAt` are treated as freshly seen (kept) to avoid pruning a
 * worker before its first timestamped update lands.
 */
export function pruneAgents(
  subagents: SimpleSubagent[],
  now: number,
  ttlMs: number = IDLE_AGENT_TTL_MS,
): SimpleSubagent[] {
  return subagents.filter((agent) => {
    if (isActiveStatus(agent.status)) return true;
    if (!REMOVABLE_STATUSES.has(agent.status.toLowerCase())) return true;
    if (typeof agent.updatedAt !== 'number') return true;
    return now - agent.updatedAt < ttlMs;
  });
}

/** Keep the current tab when it still exists, otherwise fall back to the leader. */
export function resolveSelectedAgentId(selectedId: string, tabs: AgentTab[]): string {
  return tabs.some((tab) => tab.id === selectedId) ? selectedId : LEADER_AGENT_ID;
}

export function canComposeForAgent(selectedId: string): boolean {
  return selectedId === LEADER_AGENT_ID;
}

/**
 * Coordinator snapshots describe what is live now, not the complete UI history.
 * Merge them so completed/retired agent tabs and their transcripts stay reachable.
 */
export function mergeSubagentSnapshot(
  current: SimpleSubagent[],
  snapshot: SimpleSubagent[],
): SimpleSubagent[] {
  const incoming = new Map(snapshot.map((agent) => [agent.id, agent]));
  const merged = current.map((agent) => {
    const update = incoming.get(agent.id);
    if (!update) return agent;
    incoming.delete(agent.id);
    return { ...agent, ...update };
  });
  return [...merged, ...incoming.values()];
}

/** Append one event without letting duplicate delivery or long runs grow unbounded. */
export function appendAgentTranscriptEntry(
  current: AgentTranscriptEntry[],
  entry: AgentTranscriptEntry,
): AgentTranscriptEntry[] {
  const previous = current.at(-1);
  if (
    previous?.content === entry.content &&
    previous.kind === entry.kind &&
    previous.toolName === entry.toolName
  ) {
    return [...current.slice(0, -1), { ...previous, ts: entry.ts }];
  }
  return [...current, entry].slice(-MAX_AGENT_TRANSCRIPT_ENTRIES);
}

function parseTranscriptEntry(value: unknown, fallbackId: string): AgentTranscriptEntry | null {
  if (!value || typeof value !== 'object') return null;
  return projectAgentTimelineEntry(value as Record<string, unknown>, fallbackId);
}

/**
 * Which timeline entry kinds are worth showing the user on a fresh page load.
 * Tool calls, debug status updates, and system/error spam from a long-ago
 * worker make a chat history noisy without adding comprehension; keep only the
 * conversational surface and surface errors as plain messages.
 */
const REPLAY_VISIBLE_KINDS: ReadonlySet<AgentTranscriptEntry['kind']> = new Set([
  'text',
  'thinking',
  'error',
]);

/** Maximum curated entries retained per agent on F5/reconnect. */
const REPLAY_ENTRIES_PER_AGENT = 64;

export function parseAgentSessionReplays(value: unknown): AgentSessionReplay[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.flatMap((rawSession, sessionIndex) => {
    if (!rawSession || typeof rawSession !== 'object') return [];
    const session = rawSession as Record<string, unknown>;
    const subagentId =
      typeof session['subagentId'] === 'string' ? session['subagentId'].trim() : '';
    if (!subagentId || subagentId === LEADER_AGENT_ID) return [];
    const agentName =
      typeof session['agentName'] === 'string' && session['agentName'].trim()
        ? session['agentName'].trim()
        : subagentId;
    if (!Array.isArray(session['transcript'])) return [];
    const transcript: AgentTranscriptEntry[] = [];
    for (let index = 0; index < session['transcript'].length; index++) {
      const parsed = parseTranscriptEntry(
        (session['transcript'] as unknown[])[index],
        `replay-${sessionIndex}-${index}`,
      );
      if (!parsed || !REPLAY_VISIBLE_KINDS.has(parsed.kind)) continue;
      transcript.push({ ...parsed, subagentId, agentName });
    }
    if (transcript.length === 0) return [];
    const trimmed = transcript.slice(-REPLAY_ENTRIES_PER_AGENT);
    return [
      {
        subagentId,
        agentName,
        status: typeof session['status'] === 'string' ? session['status'] : 'idle',
        task: typeof session['task'] === 'string' ? session['task'] : undefined,
        transcript: trimmed,
      } satisfies AgentSessionReplay,
    ];
  });
}

export function projectAgentTimelineEntry(
  payload: Record<string, unknown>,
  fallbackId: string,
): AgentTranscriptEntry | null {
  const subagentId = typeof payload['subagentId'] === 'string' ? payload['subagentId'].trim() : '';
  const content = typeof payload['content'] === 'string' ? payload['content'].trim() : '';
  if (!subagentId || subagentId === LEADER_AGENT_ID || !content) return null;

  const rawKind = typeof payload['kind'] === 'string' ? payload['kind'] : 'status';
  const kind: AgentTranscriptEntry['kind'] = [
    'text',
    'thinking',
    'tool_use',
    'tool_result',
    'error',
    'status',
    'system',
  ].includes(rawKind)
    ? (rawKind as AgentTranscriptEntry['kind'])
    : 'status';

  return {
    id: fallbackId,
    subagentId,
    agentName:
      typeof payload['agentName'] === 'string' && payload['agentName'].trim()
        ? payload['agentName'].trim()
        : subagentId,
    content,
    kind,
    iteration:
      typeof payload['iteration'] === 'number' && Number.isFinite(payload['iteration'])
        ? payload['iteration']
        : 0,
    ts:
      typeof payload['ts'] === 'string' && payload['ts'] ? payload['ts'] : new Date().toISOString(),
    toolName: typeof payload['toolName'] === 'string' ? payload['toolName'] : undefined,
    toolOk: typeof payload['toolOk'] === 'boolean' ? payload['toolOk'] : undefined,
  };
}

/** Recover the final answer even when the richer timeline monitor is unavailable. */
export function projectCompletedAgentText(
  payload: Record<string, unknown>,
  fallbackId: string,
  agentName: string,
): AgentTranscriptEntry | null {
  const subagentId = typeof payload['subagentId'] === 'string' ? payload['subagentId'].trim() : '';
  const content = typeof payload['finalText'] === 'string' ? payload['finalText'].trim() : '';
  if (!subagentId || subagentId === LEADER_AGENT_ID || !content) return null;
  return {
    id: fallbackId,
    subagentId,
    agentName,
    content,
    kind: 'text',
    iteration:
      typeof payload['iterations'] === 'number' && Number.isFinite(payload['iterations'])
        ? payload['iterations']
        : 0,
    ts: new Date().toISOString(),
  };
}
