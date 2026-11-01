/**
 * Side-effect audit records read back from a session journal.
 *
 * `side_effects.list` serves the live runtime window (at most 500 records, emptied by a host
 * restart). Every record is also appended to the session JSONL as a `side_effect` event, so this
 * reads that durable copy with the same paging shape: `before` is an exclusive index into the
 * journal's records in write order and `limit` is 1–200 (default 100).
 */

import type { SessionEvent } from '@wrongstack/contracts/types';

type SideEffectEvent = Extract<SessionEvent, { type: 'side_effect' }>;

export function readJournalSideEffects(
  sessionId: string,
  events: readonly SessionEvent[],
  raw: unknown,
) {
  const paging = (raw && typeof raw === 'object' ? raw : {}) as {
    before?: unknown;
    limit?: unknown;
  };
  const all = events.filter((event): event is SideEffectEvent => event.type === 'side_effect');
  const limit =
    Number.isSafeInteger(paging.limit) && (paging.limit as number) >= 1
      ? Math.min(paging.limit as number, 200)
      : 100;
  const end =
    Number.isSafeInteger(paging.before) && (paging.before as number) >= 0
      ? Math.min(paging.before as number, all.length)
      : all.length;
  const start = Math.max(0, end - limit);
  return {
    sessionId,
    total: all.length,
    truncated: start > 0,
    start,
    sideEffects: all.slice(start, end).map((effect) => ({
      toolUseId: effect.toolUseId,
      toolName: effect.toolName,
      ts: effect.ts,
      input: effect.input,
      ...(effect.outcome !== undefined ? { outcome: effect.outcome } : {}),
      risk: effect.risk,
    })),
  };
}

/** How many of the newest recorded conversations a project side-effect summary reads at most. */
export const SIDE_EFFECT_SCAN_DEFAULT = 200;
const SIDE_EFFECT_SCAN_MAX = 1000;
const SIDE_EFFECT_RECORDS = 200;

/**
 * Side effects recorded across a project's conversations, read from each session journal: counts
 * per risk and per tool, and the newest records with the conversation they belong to. Bounded to
 * the newest `sessions` conversations (default 200, at most 1,000); an optional `risk` narrows
 * every count. A journal that cannot be read is counted and skipped.
 */
export async function projectSideEffectsSummary(
  store: {
    list(
      limit: number,
    ): Promise<
      ReadonlyArray<{ id: string; title?: string | undefined; name?: string | undefined }>
    >;
    load(id: string): Promise<{ events: readonly SessionEvent[] }>;
  },
  raw: unknown,
) {
  const options = (raw && typeof raw === 'object' ? raw : {}) as {
    sessions?: unknown;
    risk?: unknown;
  };
  const scan =
    Number.isSafeInteger(options.sessions) && (options.sessions as number) >= 1
      ? Math.min(options.sessions as number, SIDE_EFFECT_SCAN_MAX)
      : SIDE_EFFECT_SCAN_DEFAULT;
  const risk = typeof options.risk === 'string' && options.risk ? options.risk : undefined;
  const summaries = await store.list(scan);
  const byRisk: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const records: Array<{
    sessionId: string;
    sessionTitle: string;
    toolName: string;
    ts: string;
    risk: string;
    outcome?: string;
    input: string;
  }> = [];
  let total = 0,
    sessionsWithEffects = 0,
    unreadable = 0;
  for (const summary of summaries) {
    let events: readonly SessionEvent[];
    try {
      events = (await store.load(summary.id)).events;
    } catch {
      unreadable++;
      continue;
    }
    const effects = events.filter(
      (event): event is SideEffectEvent =>
        event.type === 'side_effect' && (!risk || event.risk === risk),
    );
    if (!effects.length) continue;
    sessionsWithEffects++;
    total += effects.length;
    for (const effect of effects) {
      byRisk[effect.risk] = (byRisk[effect.risk] ?? 0) + 1;
      byTool[effect.toolName] = (byTool[effect.toolName] ?? 0) + 1;
      records.push({
        sessionId: summary.id,
        sessionTitle: summary.name || summary.title || summary.id,
        toolName: effect.toolName,
        ts: effect.ts,
        risk: effect.risk,
        ...(effect.outcome !== undefined ? { outcome: effect.outcome } : {}),
        input: JSON.stringify(effect.input ?? {}).slice(0, 300),
      });
    }
  }
  records.sort((a, b) => b.ts.localeCompare(a.ts));
  return {
    sessionsScanned: summaries.length,
    capped: summaries.length >= scan,
    sessionsWithEffects,
    unreadable,
    total,
    byRisk,
    byTool,
    records: records.slice(0, SIDE_EFFECT_RECORDS),
    recordsTruncated: records.length > SIDE_EFFECT_RECORDS,
  };
}
