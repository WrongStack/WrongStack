import { displayLocale } from '../lib/i18n';
import type { ChronicleEventView } from './chronicle-types';

/**
 * Context-window timeline for the session story: one point per answered
 * request (`context.residency`) plus the events that took content OUT of the
 * window (compaction, trims, repair, rewind). Built from the same Chronicle
 * history the rest of the story uses — nothing here is estimated client-side.
 */

export type ContextLane = 'cached' | 'written' | 'uncached';

export interface ContextPoint {
  id: string;
  at: number;
  agentId: string;
  seq: number;
  provider: string;
  model: string;
  mechanism: string;
  maxContext: number;
  /** Estimated request tokens per cache lane. */
  cached: number;
  written: number;
  uncached: number;
  total: number;
  /** Provider-reported prompt tokens (input + cache read + cache write). */
  usage: number;
  cacheRead: number;
  cacheWrite: number;
  verdict: string;
  breakers: string[];
  segments: Array<{ kind: string; tokens: number; lane: ContextLane; count: number }>;
  live: Array<{ source: string; tokens: number }>;
  historyMessages: number;
  /** Tokens that entered since the previous point (new history + live tail). */
  added: number;
}

export type ContextMarkKind = 'compaction' | 'trim' | 'repair' | 'rewind' | 'failed';

export interface ContextMark {
  id: string;
  at: number;
  agentId: string;
  kind: ContextMarkKind;
  /** Tokens that left the window, when the event says. */
  removed: number;
  before?: number | undefined;
  after?: number | undefined;
  level?: string | undefined;
  /** Short facts: compaction phases, dropped messages, removed tool blocks. */
  facts: string[];
}

export interface ContextTimeline {
  points: ContextPoint[];
  marks: ContextMark[];
  agents: string[];
  /** Largest known window across the points (0 = unknown). */
  maxContext: number;
  peak: number;
  /** Provider cache read / prompt tokens over every point. */
  cacheRate: number;
  removedTotal: number;
}

const LEADER = 'leader';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
/** Chronicle caps arrays at 20 and wraps longer ones as `{ items, total }`. */
function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: unknown[] }).items;
  }
  return [];
}
function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return num((value as { total?: unknown }).total);
  return 0;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function timeOf(event: ChronicleEventView): number {
  const parsed = Date.parse(event.occurredAt ?? event.observedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
function lane(value: unknown): ContextLane {
  return value === 'cached' || value === 'written' ? value : 'uncached';
}

function toPoint(event: ChronicleEventView): ContextPoint {
  const a = record(event.attributes);
  const segments = list(a.segments).map((raw) => {
    const s = record(raw);
    return { kind: str(s.kind), tokens: num(s.tokens), lane: lane(s.lane), count: num(s.count) };
  });
  const live = list(a.live).map((raw) => {
    const p = record(raw);
    return { source: str(p.source, '?'), tokens: num(p.tokens) };
  });
  const cacheRead = num(a.usageCacheRead);
  const cacheWrite = num(a.usageCacheWrite);
  return {
    id: event.eventId,
    at: timeOf(event),
    agentId: str(a.agentId, event.scope.agentId ?? LEADER),
    seq: num(a.seq),
    provider: str(a.provider, event.runtime?.providerId ?? ''),
    model: str(a.model, event.runtime?.modelId ?? ''),
    mechanism: str(a.mechanism, 'none'),
    maxContext: num(a.maxContext),
    cached: num(a.cached),
    written: num(a.written),
    uncached: num(a.uncached),
    total: num(a.total),
    usage: num(a.usageInput) + cacheRead + cacheWrite,
    cacheRead,
    cacheWrite,
    verdict: str(a.verdict, 'pending'),
    breakers: list(a.breakers).filter((b): b is string => typeof b === 'string'),
    segments,
    live,
    historyMessages: num(a.historyMessages),
    added: segments
      .filter((s) => s.kind === 'history-new' || s.kind === 'live-tail')
      .reduce((sum, s) => sum + s.tokens, 0),
  };
}

function toMark(event: ChronicleEventView): ContextMark | undefined {
  const a = record(event.attributes);
  const base = {
    id: event.eventId,
    at: timeOf(event),
    // Compaction/repair events carry no agent; they belong to the main lane.
    agentId: str(a.agentId, event.scope.agentId ?? ''),
    level: str(a.level) || undefined,
  };
  switch (event.eventType) {
    case 'compaction.fired': {
      const report = record(a.report);
      const before = num(report.fullRequestTokensBefore) || num(report.before);
      const after = num(report.fullRequestTokensAfter) || num(report.after);
      const facts = list(report.reductions)
        .map(record)
        .filter((r) => num(r.saved) > 0)
        .map((r) => `${str(r.phase, 'phase')} −${num(r.saved).toLocaleString(displayLocale())}`);
      return {
        ...base,
        kind: 'compaction',
        removed: Math.max(0, before - after),
        before,
        after,
        facts,
      };
    }
    case 'compaction.emergency_trim':
    case 'compaction.target_trim':
      return {
        ...base,
        kind: 'trim',
        removed: num(a.saved),
        facts: [
          `${num(a.trimmedBlocks)} blocks trimmed`,
          `${num(a.droppedMessages)} messages dropped`,
        ],
      };
    case 'compaction.failed':
      return { ...base, kind: 'failed', removed: 0, facts: [] };
    case 'context.repaired':
      if (a.changed === false) return undefined;
      return {
        ...base,
        kind: 'repair',
        removed: 0,
        facts: [
          `${count(a.removedToolUses)} tool_use`,
          `${count(a.removedToolResults)} tool_result`,
          `${num(a.removedMessages)} messages`,
        ],
      };
    case 'session.rewound':
      return {
        ...base,
        kind: 'rewind',
        removed: 0,
        facts: [`to prompt ${num(a.toPromptIndex)}`, `${num(a.removedEvents)} events removed`],
      };
    default:
      return undefined;
  }
}

/**
 * Build the timeline for one agent lane — the leader by default, or the first
 * agent with data when the host names its leader differently.
 */
export function buildContextTimeline(
  events: readonly ChronicleEventView[],
  requested?: string,
): ContextTimeline & { agent: string } {
  const allPoints: ContextPoint[] = [];
  const allMarks: ContextMark[] = [];
  for (const event of events) {
    if (event.eventType === 'context.residency') allPoints.push(toPoint(event));
    else {
      const mark = toMark(event);
      if (mark) allMarks.push(mark);
    }
  }
  const agents = [...new Set(allPoints.map((p) => p.agentId))].sort((x, y) =>
    x === LEADER ? -1 : y === LEADER ? 1 : x.localeCompare(y),
  );
  const agent = requested && agents.includes(requested) ? requested : (agents[0] ?? LEADER);
  const points = allPoints
    .filter((p) => p.agentId === agent)
    .sort((x, y) => x.at - y.at || x.seq - y.seq);
  const mainLane = agents[0] ?? LEADER;
  const marks = allMarks
    .filter((m) => m.agentId === agent || (m.agentId === '' && agent === mainLane))
    .sort((x, y) => x.at - y.at);
  const promptTokens = points.reduce((sum, p) => sum + p.usage, 0);
  return {
    agent,
    points,
    marks,
    agents,
    maxContext: points.reduce((max, p) => Math.max(max, p.maxContext), 0),
    peak: points.reduce((max, p) => Math.max(max, p.total, p.usage), 0),
    cacheRate: promptTokens > 0 ? points.reduce((s, p) => s + p.cacheRead, 0) / promptTokens : 0,
    removedTotal: marks.reduce((sum, m) => sum + m.removed, 0),
  };
}

/**
 * Fractional point index for a moment in time, so marks sit between the two
 * requests they happened between on an index-based x axis.
 */
export function indexAt(points: readonly ContextPoint[], at: number): number {
  if (points.length === 0) return 0;
  const first = points[0] as ContextPoint;
  if (at <= first.at) return -0.5;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1] as ContextPoint;
    const next = points[i] as ContextPoint;
    if (at <= next.at) {
      const span = Math.max(1, next.at - prev.at);
      return i - 1 + (at - prev.at) / span;
    }
  }
  return points.length - 0.5;
}
