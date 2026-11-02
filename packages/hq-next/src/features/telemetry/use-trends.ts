'use client';

/**
 * The cost time series from `/api/trends/cost`, polled every 30 seconds — well
 * inside the server's 5-minute buckets. A machine or project scope asks the
 * server for that breakdown instead of the fleet totals; a label scope sums
 * its machines from the per-machine breakdown of the fleet series.
 */
import { fetchJson } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import type { HqTimeseriesSample } from '@wrongstack/hq';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { machineKeysWithLabel } from '@/lib/scope';
import { useFleetScope } from '@/lib/use-scope';
import { samplesForMachines } from './model';

const POLL_MS = 30_000;

export interface Trends {
  samples: readonly HqTimeseriesSample[];
  loading: boolean;
  error: string | null;
  /** When the series was last fetched; the clock the windows are cut against. */
  fetchedAt: number;
  refresh: () => void;
}

export function useTrends(): Trends {
  const [samples, setSamples] = useState<readonly HqTimeseriesSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const sequence = useRef(0);
  const scope = useFleetScope();
  const query =
    scope.kind === 'machine'
      ? `?machineKey=${encodeURIComponent(scope.id)}`
      : scope.kind === 'project'
        ? `?projectId=${encodeURIComponent(scope.id)}`
        : '';

  const load = useCallback(async (): Promise<void> => {
    const request = ++sequence.current;
    try {
      const data = await fetchJson<{ samples: HqTimeseriesSample[] }>(`/api/trends/cost${query}`);
      if (request !== sequence.current) return;
      setSamples(Array.isArray(data.samples) ? data.samples : []);
      setError(null);
    } catch (cause) {
      if (request !== sequence.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === sequence.current) {
        setLoading(false);
        setFetchedAt(Date.now());
      }
    }
  }, [query]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      sequence.current += 1;
      window.clearInterval(timer);
    };
  }, [load]);

  const snapshot = useHqStore((state) => state.snapshot);
  const labelKeys = useMemo(
    () => (scope.kind === 'label' ? machineKeysWithLabel(snapshot, scope.id) : null),
    [scope.kind, scope.id, snapshot],
  );
  const scoped = useMemo(
    () => (labelKeys === null ? samples : samplesForMachines(samples, labelKeys)),
    [samples, labelKeys],
  );

  return { samples: scoped, loading, error, fetchedAt, refresh: () => void load() };
}
