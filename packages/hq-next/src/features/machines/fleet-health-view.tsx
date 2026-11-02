'use client';

/**
 * Fleet health: every machine's project disk and memory over the last 7 days
 * on one page, the machine that fills up first on top. Follows the scope.
 * Each row opens that machine's card for the full reading.
 */
import { fetchHealthOverview } from '@hq/data/api';
import type { HqHealthPoint } from '@wrongstack/hq';
import { HeartPulse } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useAttentionQueue } from '@/features/attention/use-attention-queue';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';
import { useScopedSnapshot } from '@/lib/use-scope';
import { type FleetHealthRow, fleetHealthHeadline, fleetHealthRows } from './fleet-health';
import { formatBytes } from './health';
import { Sparkline } from './health-history';
import { fullInWords } from './health-trend';
import { machineSummaries } from './model';

const REFRESH_MS = 5 * 60_000;

function useHealthOverview(): {
  overview: { key: string; points: HqHealthPoint[] }[] | null;
  error: string | null;
} {
  const [overview, setOverview] = useState<{ key: string; points: HqHealthPoint[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchHealthOverview().then(
        (result) => {
          if (cancelled) return;
          setOverview(result.machines);
          setError(null);
        },
        (cause: unknown) => {
          if (!cancelled) setError(errorText(cause));
        },
      );
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return { overview, error };
}

export function FleetHealthView(): ReactNode {
  const snapshot = useScopedSnapshot();
  const { items } = useAttentionQueue();
  const machines = useMemo(() => machineSummaries(snapshot, items), [snapshot, items]);
  const { overview, error } = useHealthOverview();
  const rows = useMemo(() => fleetHealthRows(machines, overview ?? []), [machines, overview]);

  if (snapshot === null) {
    return <p className="p-6 text-sm text-muted-foreground">Waiting for fleet data…</p>;
  }
  if (rows.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <HeartPulse className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">No machine has reported yet</h2>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold" data-testid="fleet-health-headline">
          {fleetHealthHeadline(rows)}
        </h2>
        <p className="text-base text-muted-foreground">
          Project disk and memory on every machine over the last 7 days. The one that runs out first
          is on top.
        </p>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            The health history could not be read: {error}. Showing the current readings only.
          </p>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm" data-testid="fleet-health">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 font-normal">Machine</th>
              <th className="py-2 text-right font-normal">Project disk free</th>
              <th className="w-48 py-2 pl-4 font-normal">Free space, 7 days</th>
              <th className="py-2 font-normal">Outlook</th>
              <th className="w-48 py-2 pl-4 font-normal">Memory in use, 7 days</th>
              <th className="py-2 text-right font-normal">Average · peak</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <HealthRow key={row.key} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HealthRow({ row }: { row: FleetHealthRow }): ReactNode {
  const outlook =
    row.diskFullInDays !== undefined
      ? `Full ${fullInWords(row.diskFullInDays)}`
      : row.readings === 0 && row.diskFreeBytes === undefined
        ? 'No reading yet'
        : row.readings < 2
          ? 'Not enough history yet'
          : 'Not filling up';
  return (
    <tr className="border-t border-border align-middle" data-health-row={row.key}>
      <td className="py-2.5">
        <Link
          href={`/fleet/machines/?machine=${encodeURIComponent(row.key)}`}
          className="flex items-center gap-2 font-medium hover:underline"
        >
          <span
            aria-hidden
            className={cn('size-2 shrink-0', row.online ? 'bg-success' : 'bg-muted-foreground/50')}
          />
          {row.hostname}
          <span className="sr-only">{row.online ? ', online' : ', offline'}</span>
        </Link>
        {row.problems.map((problem) => (
          <p key={problem} className="text-xs text-warning">
            {problem}
          </p>
        ))}
      </td>
      <td className="tabular py-2.5 text-right">
        {row.diskFreeBytes === undefined ? (
          <span className="text-muted-foreground">No reading</span>
        ) : (
          <>
            {formatBytes(row.diskFreeBytes)}
            {row.diskFreePct !== undefined && (
              <span className="text-muted-foreground"> · {row.diskFreePct}%</span>
            )}
          </>
        )}
      </td>
      <td className="py-2.5 pl-4">
        <Sparkline points={row.disk} />
      </td>
      <td
        className={cn(
          'py-2.5',
          row.diskFullInDays !== undefined && row.diskFullInDays <= 7
            ? 'font-semibold text-warning'
            : 'text-muted-foreground',
        )}
      >
        {outlook}
      </td>
      <td className="py-2.5 pl-4">
        <Sparkline points={row.memory} max={100} />
      </td>
      <td className="tabular py-2.5 text-right">
        {row.memoryAveragePct === undefined
          ? '—'
          : `${row.memoryAveragePct}% · ${row.memoryPeakPct}%`}
      </td>
    </tr>
  );
}
