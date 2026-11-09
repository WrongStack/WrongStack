import type { EngineEvent } from './engine-state';
import { entries, record } from './engine-values';

/** Calls of one tool (or by one agent): started, finished well, failed, and their time. */
export interface ToolBucket {
  started: number;
  ok: number;
  failed: number;
  totalMs: number;
}
export interface ToolStats {
  /** Per tool name, most used first. */
  tools: Array<{ name: string } & ToolBucket>;
  /** Calls attributed to a named agent (agent-to-agent work); the leader's own are not listed. */
  agents: Array<{ name: string } & ToolBucket>;
  totals: ToolBucket & { inFlight: number };
}

const empty = (): ToolBucket => ({ started: 0, ok: 0, failed: 0, totalMs: 0 });
/** Calls counted for a bucket: those started, or those finished when a start was not seen. */
export const callCount = (bucket: ToolBucket) =>
  Math.max(bucket.started, bucket.ok + bucket.failed);

/**
 * Per-tool statistics of one conversation, folded from its tool events (the WebUI's tool-call
 * statistics): `tool.started` counts a call, `tool.executed` its outcome and duration.
 */
export function conversationToolStats(events: readonly EngineEvent[]): ToolStats {
  const tools = new Map<string, ToolBucket>(),
    agents = new Map<string, ToolBucket>();
  const bucket = (map: Map<string, ToolBucket>, key: string) => {
    const found = map.get(key) ?? empty();
    map.set(key, found);
    return found;
  };
  for (const event of events) {
    if (event.type !== 'tool.started' && event.type !== 'tool.executed') continue;
    const rawName = typeof event.payload['name'] === 'string' ? event.payload['name'].trim() : '';
    const name = rawName || 'tool';
    const agent =
      typeof event.payload['agentName'] === 'string' && event.payload['agentName'].trim()
        ? event.payload['agentName'].trim()
        : '';
    const targets = [bucket(tools, name), ...(agent ? [bucket(agents, agent)] : [])];
    for (const target of targets) {
      if (event.type === 'tool.started') target.started += 1;
      else {
        if (event.payload['ok'] === false) target.failed += 1;
        else target.ok += 1;
        const ms = event.payload['durationMs'];
        if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) target.totalMs += ms;
      }
    }
  }
  const sorted = (map: Map<string, ToolBucket>) =>
    [...map]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => callCount(b) - callCount(a));
  const list = sorted(tools);
  const totals = list.reduce(
    (sum, item) => ({
      started: sum.started + callCount(item),
      ok: sum.ok + item.ok,
      failed: sum.failed + item.failed,
      totalMs: sum.totalMs + item.totalMs,
      inFlight: sum.inFlight + Math.max(0, item.started - item.ok - item.failed),
    }),
    { ...empty(), inFlight: 0 },
  );
  return { tools: list, agents: sorted(agents), totals };
}

/** One conversation in the project's catalog, with the tool counts the catalog keeps. */
export interface CatalogToolRow {
  id: string;
  title: string;
  calls: number;
  failed: number;
  current: boolean;
}
export interface CatalogToolStats {
  sessions: CatalogToolRow[];
  /** Calls per tool summed over every listed conversation, most used first. */
  tools: Array<{ name: string; calls: number }>;
  calls: number;
  failed: number;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Cross-conversation tool statistics from a `sessions.list` reply. */
export function catalogToolStats(reply: Record<string, unknown>): CatalogToolStats {
  const tools = new Map<string, number>();
  const sessions: CatalogToolRow[] = [];
  for (const row of entries(reply['sessions'])) {
    if (typeof row['id'] !== 'string') continue;
    const calls = count(row['toolCallCount']);
    for (const [name, value] of Object.entries(record(row['toolBreakdown'])))
      tools.set(name, (tools.get(name) ?? 0) + count(value));
    if (!calls) continue;
    sessions.push({
      id: row['id'],
      title:
        typeof row['name'] === 'string' && row['name']
          ? row['name']
          : typeof row['title'] === 'string' && row['title']
            ? row['title']
            : row['id'].slice(0, 8),
      calls,
      failed: Math.min(calls, count(row['toolErrorCount'])),
      current: row['isCurrent'] === true,
    });
  }
  sessions.sort((a, b) => b.calls - a.calls);
  return {
    sessions,
    tools: [...tools]
      .filter(([, calls]) => calls > 0)
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls),
    calls: sessions.reduce((sum, row) => sum + row.calls, 0),
    failed: sessions.reduce((sum, row) => sum + row.failed, 0),
  };
}

/** Completed-call success percentage, or null while nothing has completed. */
export function successRate(ok: number, failed: number): number | null {
  const safeOk = count(ok);
  const safeFailed = count(failed);
  const done = safeOk + safeFailed;
  return done > 0 ? Math.round((safeOk / done) * 100) : null;
}
