/**
 * Event log rules as pure functions: type names, time presets, day grouping,
 * correlation chains and a short reading of each payload.
 */

export interface LoggedEvent {
  type?: string;
  timestamp?: string;
  clientId?: string;
  machineId?: string;
  sessionId?: string;
  correlationId?: string;
  payload?: unknown;
}

export const EVENT_TYPE_LABEL: Record<string, string> = {
  'client.hello': 'Client connected',
  'client.heartbeat': 'Heartbeat',
  'session.started': 'Session started',
  'session.status': 'Session status',
  'session.usage': 'Usage',
  'session.snapshot': 'Session snapshot',
  'session.transcript': 'Transcript',
  'session.ended': 'Session ended',
  'tool.started': 'Tool started',
  'tool.completed': 'Tool finished',
  'approval.requested': 'Approval asked',
  'approval.resolved': 'Approval answered',
  'user_input.requested': 'Question asked',
  'user_input.resolved': 'Question answered',
  'fleet.snapshot': 'Fleet snapshot',
  'fleet.event': 'Fleet event',
  'mailbox.snapshot': 'Mailbox snapshot',
  'mailbox.event': 'Mailbox message',
  'kanban.snapshot': 'Kanban snapshot',
  'sage.snapshot': 'Memory snapshot',
  'worklist.snapshot': 'Worklist snapshot',
  'git.snapshot': 'Git snapshot',
  'agent.message': 'Agent message',
  'agent.status': 'Agent status',
  'brain.event': 'Brain decision',
  'worktree.event': 'Worktree change',
  'mcp.health.snapshot': 'MCP health',
  'mcp.operation': 'MCP operation',
  'governance.snapshot': 'Governance',
  'peer.rehydrate': 'Peer back',
  'peer.lost': 'Peer lost',
};

export function eventLabel(type: string | undefined): string {
  if (type === undefined || type === '') return 'Unknown event';
  return EVENT_TYPE_LABEL[type] ?? type;
}

/** Types a reader usually wants to see first: they record something happening. */
export const NOISY_TYPES: ReadonlySet<string> = new Set(['client.heartbeat']);

export interface SincePreset {
  id: string;
  label: string;
  ms: number | null;
}

export const SINCE_PRESETS: readonly SincePreset[] = [
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { id: 'all', label: 'Any time', ms: null },
];

export const PAGE_SIZES = [200, 1000, 5000] as const;

export interface EventRow {
  event: LoggedEvent;
  /** Shared id when this row continues or starts a multi-row chain. */
  chainId: string | undefined;
  chainHead: boolean;
  chainSize: number;
}

/**
 * Correlation chains over CONSECUTIVE rows only: an id that reappears much
 * later is the same activity observed again, not a continuation, and a run of
 * one is not a chain.
 */
export function chainRows(events: readonly LoggedEvent[]): EventRow[] {
  const rows: EventRow[] = [];
  let index = 0;
  while (index < events.length) {
    const id = events[index]?.correlationId;
    let end = index + 1;
    if (id !== undefined && id !== '') {
      while (end < events.length && events[end]?.correlationId === id) end += 1;
    }
    const size = end - index;
    for (let offset = 0; offset < size; offset += 1) {
      const event = events[index + offset];
      if (event === undefined) continue;
      rows.push({
        event,
        chainId: size > 1 ? id : undefined,
        chainHead: size > 1 && offset === 0,
        chainSize: size,
      });
    }
    index = end;
  }
  return rows;
}

export interface DayGroup {
  key: string;
  rows: EventRow[];
}

/** Consecutive rows of the same local day, so a header can name the date once. */
export function groupByDay(rows: readonly EventRow[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const at = row.event.timestamp !== undefined ? new Date(row.event.timestamp) : null;
    const key =
      at === null || Number.isNaN(at.getTime())
        ? 'unknown'
        : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    const last = groups.at(-1);
    if (last !== undefined && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups;
}

/** Fields worth naming in a one-line reading of a payload, in order of interest. */
const FACT_KEYS = [
  'toolName',
  'tool',
  'name',
  'agentName',
  'status',
  'action',
  'decision',
  'model',
  'summary',
  'message',
  'error',
  'reason',
  'costUsd',
  'durationMs',
] as const;

const MAX_FACTS = 4;
const MAX_VALUE = 80;

/** Names for payload keys that read badly when only de-camel-cased. */
const FACT_LABELS: Record<string, string> = {
  toolName: 'Tool',
  agentName: 'Agent',
  costUsd: 'Cost',
  durationMs: 'Took',
  ownerLabel: 'Owner',
  baseBranch: 'Base',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cacheReadTokens: 'Cache read',
  cacheWriteTokens: 'Cache write',
};

/** `ownerLabel` → `Owner label`, `exit_code` → `Exit code`. */
function factLabel(key: string): string {
  const known = FACT_LABELS[key];
  if (known !== undefined) return known;
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

function formatNumber(key: string, value: number): string {
  if (key === 'costUsd') {
    // Small spends matter: below a dollar keep up to four decimals (never fewer than two).
    if (value === 0 || Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
    return `$${value.toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1')}`;
  }
  if (key === 'durationMs' || /Ms$/.test(key)) {
    return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
  }
  return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
}

function shortValue(key: string, value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text === '') return null;
    return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return formatNumber(key, value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

export interface PayloadFact {
  /** The payload key, stable for React keys and tests. */
  key: string;
  label: string;
  value: string;
}

/**
 * A short reading of a payload: the interesting scalar fields first, then any
 * other scalars except identifiers, at most four. Nested objects stay in the
 * full JSON. Keys are named in words and numbers formatted (cost, duration,
 * token counts); the raw payload stays one click away.
 */
export function payloadFacts(payload: unknown): PayloadFact[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const facts: PayloadFact[] = [];
  const seen = new Set<string>();
  const take = (key: string): void => {
    if (facts.length >= MAX_FACTS || seen.has(key)) return;
    seen.add(key);
    const value = shortValue(key, record[key]);
    if (value !== null) facts.push({ key, label: factLabel(key), value });
  };
  for (const key of FACT_KEYS) take(key);
  // Identifiers already show as the row's source; repeating them is noise.
  for (const key of Object.keys(record)) if (!/(^id|Id|Ids)$/.test(key)) take(key);
  return facts;
}

export function prettyPayload(payload: unknown): string {
  if (payload === undefined) return '';
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    return String(payload);
  }
}
