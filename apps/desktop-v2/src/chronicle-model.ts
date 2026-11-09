import { entries, record } from './engine-values';
import type { VisualGraph } from './graph-model';

export interface ChronicleFilters {
  text: string;
  path: string;
  eventType: string;
  outcome: string;
  providerId: string;
  modelId: string;
  agentId: string;
  sessionId: string;
  from: string;
  to: string;
}
export function initialChronicleFilters(): ChronicleFilters {
  return {
    text: '',
    path: '',
    eventType: '',
    outcome: '',
    providerId: '',
    modelId: '',
    agentId: '',
    sessionId: '',
    from: new Date(Date.now() - 86400000).toISOString().slice(0, 16),
    to: '',
  };
}
export function chronicleQuery(
  filters: ChronicleFilters,
  words = {
    invalidDate: 'Choose valid UTC dates.',
    endBeforeStart: 'The end time must follow the start time.',
  },
): Record<string, unknown> {
  const query: Record<string, unknown> = { order: 'desc', limit: 100 };
  for (const key of ['text', 'path', 'providerId', 'modelId', 'agentId', 'sessionId'] as const)
    if (filters[key].trim()) query[key] = filters[key].trim();
  if (filters.eventType) query['eventTypes'] = [filters.eventType];
  if (filters.outcome) query['outcomes'] = [filters.outcome];
  for (const key of ['from', 'to'] as const) {
    if (!filters[key]) continue;
    const time = new Date(`${filters[key]}Z`);
    if (!Number.isFinite(time.getTime())) throw new Error(words.invalidDate);
    query[key] = time.toISOString();
  }
  if (query['from'] && query['to'] && String(query['from']) > String(query['to']))
    throw new Error(words.endBeforeStart);
  return query;
}
export function eventTitle(event: Record<string, unknown>): string {
  const attrs = record(event['attributes']);
  for (const key of ['summary', 'message', 'description', 'reason', 'toolName', 'name', 'command'])
    if (typeof attrs[key] === 'string' && attrs[key]) return attrs[key];
  return String(event['eventType'] ?? 'Event')
    .replaceAll('.', ' · ')
    .replaceAll('_', ' ');
}
/**
 * What an event row shows: its own title, with the event type as a caption; or, for an event
 * with no title of its own, the type read as words ("file.external.modified" → "File external
 * modified") and no caption repeating it.
 */
export function eventHeadline(event: Record<string, unknown>): {
  title: string;
  type: string | null;
} {
  const type = String(event['eventType'] ?? '');
  const title = eventTitle(event);
  const generic = title === type.replaceAll('.', ' · ').replaceAll('_', ' ');
  if (!generic) return { title, type: type || null };
  const words = type.split(/[._]+/).filter(Boolean).join(' ');
  return { title: words ? words[0]!.toUpperCase() + words.slice(1) : title, type: null };
}
export function chronicleGraph(value: unknown): VisualGraph {
  const raw = record(value),
    rows = entries(raw['nodes']);
  const ids = new Set(rows.map((row) => String(row['eventId'])));
  return {
    nodes: rows
      .filter((row) => typeof row['eventId'] === 'string')
      .map((row) => ({
        id: String(row['eventId']),
        label: eventTitle(row),
        detail: `${String(row['eventType'])} · ${String(row['outcome'] ?? 'unknown')}`,
        group: String(
          record(row['scope'])['agentId'] ?? record(row['runtime'])['providerId'] ?? 'Project',
        ),
        weight: row['outcome'] === 'failure' ? 1 : 0.3,
        data: row,
      })),
    edges: entries(raw['edges'])
      .filter((edge) => ids.has(String(edge['from'])) && ids.has(String(edge['to'])))
      .map((edge) => ({
        source: String(edge['from']),
        target: String(edge['to']),
        label: `${String(edge['kind']).replaceAll('_', ' ')} · ${String(edge['confidence'])}`,
        weight: 1,
      })),
  };
}
export function evidenceText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(evidenceText).join('\n');
  return Object.entries(record(value))
    .map(([key, v]) => `${key.replaceAll('_', ' ')}: ${evidenceText(v)}`)
    .join('\n');
}
