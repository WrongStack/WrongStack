/**
 * useBackfilledEvents — merge the persisted event log with the live ring.
 *
 * A freshly-connected browser has an empty in-memory event ring, so views fed
 * purely by `hq.event` (Brain, Worktrees) used to render blank until NEW
 * events arrived. This hook seeds them from `GET /api/events?type=…` (the
 * JSONL-backed persistence layer) and folds in live envelopes as they stream,
 * deduped by envelope id, newest last.
 *
 * @module lib/use-backfilled-events
 */
import type { HqEventEnvelope } from '@wrongstack/core';
import { useEffect, useMemo, useState } from 'react';
import { fetchJson, useHqStore } from '../store.js';

export function useBackfilledEvents(
  type: string,
  limit = 200,
): { events: HqEventEnvelope[]; loading: boolean } {
  const liveEvents = useHqStore((s) => s.events);
  const [persisted, setPersisted] = useState<HqEventEnvelope[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ events: HqEventEnvelope[] }>(
      `/api/events?type=${encodeURIComponent(type)}&limit=${limit}`,
    )
      .then((data) => {
        if (!cancelled) {
          // The API returns newest-first; normalize to chronological.
          setPersisted([...(data.events ?? [])].reverse());
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false); // persistence may be disabled — live-only
      });
    return () => {
      cancelled = true;
    };
  }, [type, limit]);

  const events = useMemo(() => {
    const seen = new Set<string>();
    const out: HqEventEnvelope[] = [];
    for (const e of persisted) {
      if (e.type !== type || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    for (const e of liveEvents) {
      if (e.type !== type || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }, [persisted, liveEvents, type]);

  return { events, loading };
}
