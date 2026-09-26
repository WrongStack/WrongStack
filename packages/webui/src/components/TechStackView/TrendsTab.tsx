/**
 * TechStackView — Trends tab.
 *
 * Renders the cross-snapshot trend report from `GET /api/techstack/trends`:
 *
 * - The dependency/outdated/vulnerable curve over the last N snapshots
 *   (small SVG line chart, no charting library — three series, hand-drawn
 *   so the file stays dependency-free).
 * - The top-flickering dependencies: which packages changed versions the
 *   most across snapshots, with the locked-version age.
 *
 * The page is intentionally read-only here: the heavy lifting
 * (`TrendStore.analyze`) lives server-side, the handler ships a serialized
 * payload, and the tab renders it.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { Loader2, RefreshCw, TrendingUp } from 'lucide-react';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { type TechStackTrendReport, useTechStackStore } from '@/stores';
import { Button } from '@/components/ui/button';
import { Badge, ecosystemLabel } from './shared';
import { useAppTranslation } from '@/i18n';

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body: unknown = text.length > 0 ? safeParse(text) : null;
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: unknown }).error)
        : text || `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchTrend(): Promise<TechStackTrendReport> {
  const res = await fetch('/api/techstack/trends', { method: 'GET' });
  const body = await jsonOrThrow<{ trend: TechStackTrendReport }>(res);
  return body.trend;
}

export function TrendsTab() {
  const { t } = useAppTranslation();
  const trend = useTechStackStore((state) => state.trend);
  const loading = useTechStackStore((state) => state.trendLoading);
  const error = useTechStackStore((state) => state.trendError);
  const setTrend = useTechStackStore((state) => state.setTrend);
  const setTrendLoading = useTechStackStore((state) => state.setTrendLoading);
  const setTrendError = useTechStackStore((state) => state.setTrendError);

  const reload = useCallback(async () => {
    setTrendLoading(true);
    try {
      const next = await fetchTrend();
      setTrend(next);
    } catch (cause) {
      setTrendError(toErrorMessage(cause));
    }
  }, [setTrend, setTrendError, setTrendLoading]);

  useEffect(() => {
    if (!trend && !loading && !error) {
      void reload();
    }
  }, [trend, loading, error, reload]);

  if (error && !trend) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-sm text-xs text-destructive" role="alert">
          {error}
        </p>
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          <RefreshCw className="size-3.5" />
          {t('activity:techStack.retry')}
        </Button>
      </div>
    );
  }

  if (loading && !trend) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!trend || trend.points.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="max-w-sm text-xs text-muted-foreground">
          {t('activity:techStack.trendNeedsHistory')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/70 bg-card/45 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {t('activity:techStack.trendOverTime')}
          </p>
          <Badge className="border-border/70 bg-muted text-muted-foreground">
            {trend.snapshots} {t('activity:techStack.snapshots')}
          </Badge>
          {typeof trend.vulnerabilityHalfLifeMs === 'number' && (
            <Badge className="border-info/35 bg-info/10 text-info">
              <TrendingUp className="size-2.5" />
              {t('activity:techStack.vulnHalfLife', {
                days: Math.round(trend.vulnerabilityHalfLifeMs / 86_400_000),
              })}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void reload()}
          disabled={loading}
          className="mt-2 h-7 text-[10px]"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          {t('activity:techStack.refresh')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <TrendChart trend={trend} />
        <TopFlickering trend={trend} t={t} />
      </div>
    </div>
  );
}

function TrendChart({ trend }: { trend: TechStackTrendReport }) {
  // Three series: total dependencies, outdated, vulnerable.
  // Hand-drawn SVG so we don't pull a charting library for three lines.
  const width = 720;
  const height = 140;
  const padding = 24;
  const points = trend.points;
  if (points.length === 0) return null;

  const maxTotal = Math.max(
    1,
    ...points.map((p) => Math.max(p.dependencies, p.outdated, p.vulnerable)),
  );
  const xStep = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const toPath = (key: 'dependencies' | 'outdated' | 'vulnerable'): string =>
    points
      .map((point, index) => {
        const x = padding + xStep * index;
        const y = height - padding - (point[key] / maxTotal) * (height - padding * 2);
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  return (
    <section className="border border-border/70 bg-card/40 p-2.5">
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        Dependencies / outdated / vulnerable
      </p>
      <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 w-full">
        <title>Dependencies, outdated and vulnerable over time</title>
        <path d={toPath('dependencies')} stroke="currentColor" strokeWidth={1.5} fill="none" className="text-muted-foreground" />
        <path d={toPath('outdated')} stroke="currentColor" strokeWidth={1.5} fill="none" className="text-info" />
        <path d={toPath('vulnerable')} stroke="currentColor" strokeWidth={1.5} fill="none" className="text-destructive" />
        {points.map((point, index) => {
          const x = padding + xStep * index;
          return (
            <circle
              key={point.snapshotId}
              cx={x}
              cy={height - padding - (point.vulnerable / maxTotal) * (height - padding * 2)}
              r={2}
              className="fill-destructive"
            >
              <title>
                {`${new Date(point.createdAt).toLocaleString()} — ${point.dependencies} deps, ${point.outdated} outdated, ${point.vulnerable} vulnerable`}
              </title>
            </circle>
          );
        })}
      </svg>
      <ul className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />
          total
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-info" aria-hidden="true" />
          outdated
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-destructive" aria-hidden="true" />
          vulnerable
        </li>
      </ul>
    </section>
  );
}

function TopFlickering({
  trend,
  t,
}: {
  trend: TechStackTrendReport;
  t: (key: string) => string;
}) {
  const items = useMemo(
    () => [...trend.dependencies].sort((a, b) => b.versionChanges - a.versionChanges).slice(0, 10),
    [trend.dependencies],
  );
  if (items.length === 0) return null;
  return (
    <section className="mt-3 border border-border/70 bg-card/40 p-2.5">
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {t('activity:techStack.mostVersionChanges')}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex items-center justify-between gap-2 border-b border-border/40 pb-1 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="truncate font-mono text-[11px] text-foreground">{item.name}</p>
              <p className="text-[10px] text-muted-foreground">
                {ecosystemLabel(item.ecosystem, t)} · {item.currentVersion ?? '—'}
              </p>
            </div>
            <Badge className="border-border/70 bg-muted text-muted-foreground">
              {item.versionChanges}× {t('activity:techStack.changes')}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function cn(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}
