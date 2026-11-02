'use client';

/**
 * The last 7 days of a machine's health: free space on the project disk and
 * memory in use, each a small line with the change said in words (the words
 * carry the meaning; the lines are decoration). When the disk is filling, the
 * rate is projected to a "full in about N days" warning.
 */
import { fetchHealthHistory } from '@hq/data/api';
import type { HqHealthPoint } from '@wrongstack/hq';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { errorText } from '@/lib/error-text';
import { fullInWords, healthTrend, type SeriesPoint } from './health-trend';

const REFRESH_MS = 5 * 60_000;
const W = 240;
const H = 40;

function Sparkline({ points, max }: { points: readonly SeriesPoint[]; max?: number }): ReactNode {
  if (points.length < 2) return null;
  const first = points[0]!.at;
  const last = points[points.length - 1]!.at;
  const top = max ?? Math.max(...points.map((p) => p.value));
  const bottom = max === undefined ? Math.min(...points.map((p) => p.value)) : 0;
  const range = top - bottom || 1;
  const path = points
    .map((p, i) => {
      const x = ((p.at - first) / (last - first || 1)) * W;
      const y = H - ((p.value - bottom) / range) * (H - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-10 w-full text-primary"
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function HealthHistory({ machineKey }: { machineKey: string }): ReactNode {
  const [points, setPoints] = useState<HqHealthPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchHealthHistory(machineKey).then(
        (result) => {
          if (cancelled) return;
          setPoints(result.points);
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
  }, [machineKey]);

  const trend = useMemo(() => healthTrend(points ?? []), [points]);

  if (error !== null && points === null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The health history could not be read: {error}
      </p>
    );
  }
  if (points === null) return null;
  if (trend.diskSummary === undefined && trend.memorySummary === undefined) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="health-history">
        HQ keeps a reading every 15 minutes for 7 days; the trend shows once there are two.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="health-history">
      <h5 className="text-xs font-semibold text-muted-foreground">Last 7 days</h5>
      {trend.diskFullInDays !== undefined && (
        <p className="text-sm font-semibold text-warning" data-testid="disk-full-projection">
          At this rate the project disk is full {fullInWords(trend.diskFullInDays)}.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {trend.diskSummary !== undefined && (
          <div className="flex flex-col gap-1">
            <Sparkline points={trend.disk} />
            <p className="text-xs text-muted-foreground">{trend.diskSummary}</p>
          </div>
        )}
        {trend.memorySummary !== undefined && (
          <div className="flex flex-col gap-1">
            <Sparkline points={trend.memory} max={100} />
            <p className="text-xs text-muted-foreground">{trend.memorySummary}</p>
          </div>
        )}
      </div>
    </div>
  );
}
