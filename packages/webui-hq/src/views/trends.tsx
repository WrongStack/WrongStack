/**
 * Trends — time-bucketed telemetry.
 *
 * Three measures, three charts, one hue each. Cost, tokens and tool calls are
 * never plotted together: they differ by orders of magnitude, and a dual axis
 * would make any pair look correlated. When the server reports per-model or
 * per-provider cost, those roll up into share tables underneath.
 */
import type { HqTimeseriesBreakdownEntry, HqTimeseriesSample } from '@wrongstack/core/hq';
import { ChartNoAxesCombined } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { EmptyState, Mono } from '../components/hq/primitives.js';
import { TimeseriesChart } from '../components/hq/timeseries-chart.js';
import { HeroMetric, Section, ViewHero, ViewShell } from '../components/hq/view-chrome.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { fetchJson } from '../data/api.js';
import { cn } from '../lib/utils.js';
import { formatCount, formatPercent, formatUsd } from '../lib/format.js';

/** Trend buckets are five minutes wide; 30s polling is well inside that. */
const TRENDS_POLL_MS = 30_000;
const FALLBACK_BUCKETS = 24;

interface TrendsResponse {
  samples: HqTimeseriesSample[];
}

const RANGES = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

const DEFAULT_RANGE_MS = RANGES[2].ms;

/** Sum per-model / per-provider entries across the buckets in view. */
function rollup(
  samples: readonly HqTimeseriesSample[],
  dimension: 'byModel' | 'byProvider',
): { key: string; entry: HqTimeseriesBreakdownEntry }[] {
  const totals = new Map<string, HqTimeseriesBreakdownEntry>();
  for (const sample of samples) {
    const breakdown = sample[dimension];
    if (breakdown === undefined) continue;
    for (const [key, raw] of Object.entries(breakdown)) {
      const existing = totals.get(key);
      if (existing === undefined) {
        totals.set(key, { ...raw });
        continue;
      }
      existing.costUsd += raw.costUsd;
      existing.inputTokens += raw.inputTokens;
      existing.outputTokens += raw.outputTokens;
      existing.cacheRead = (existing.cacheRead ?? 0) + (raw.cacheRead ?? 0);
      existing.cacheWrite = (existing.cacheWrite ?? 0) + (raw.cacheWrite ?? 0);
    }
  }
  return [...totals.entries()]
    .map(([key, entry]) => ({ key, entry }))
    .sort((left, right) => right.entry.costUsd - left.entry.costUsd);
}

function BreakdownRows({
  rows,
  totalCost,
  showTokens,
}: {
  rows: { key: string; entry: HqTimeseriesBreakdownEntry }[];
  totalCost: number;
  showTokens: boolean;
}): React.ReactElement {
  return (
    <Card className="divide-y divide-border">
      {rows.map(({ key, entry }) => {
        const share = totalCost > 0 ? entry.costUsd / totalCost : 0;
        const cache = (entry.cacheRead ?? 0) + (entry.cacheWrite ?? 0);
        return (
          <div
            key={key}
            data-testid="breakdown-row"
            className="flex flex-wrap items-baseline gap-2 px-3 py-1.5 text-xs"
          >
            <span className="font-medium">{key}</span>
            {showTokens && (
              <Mono>
                {formatCount(entry.inputTokens)}→{formatCount(entry.outputTokens)}
                {cache > 0 ? ` · cache ${formatCount(cache)}` : ''}
              </Mono>
            )}
            <span className="tabular ml-auto font-semibold">{formatUsd(entry.costUsd)}</span>
            <Mono className="tabular w-12 text-right">{formatPercent(share, 1)}</Mono>
          </div>
        );
      })}
    </Card>
  );
}

export function TrendsView(): React.ReactElement {
  const [samples, setSamples] = useState<HqTimeseriesSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rangeMs, setRangeMs] = useState<number>(DEFAULT_RANGE_MS);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<TrendsResponse>('/api/trends/cost')
        .then((data) => {
          if (cancelled) return;
          setSamples(data.samples);
          setError(null);
        })
        .catch((cause: Error) => {
          if (!cancelled) setError(cause.message);
        });
    };
    load();
    const timer = window.setInterval(load, TRENDS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const view = useMemo(() => {
    const cutoff = Date.now() - rangeMs;
    const inRange = samples.filter((sample) => sample.ts >= cutoff);
    // An empty window on a quiet fleet reads as "broken"; fall back to the
    // most recent buckets so the charts always show the latest activity.
    const shown = inRange.length > 0 ? inRange : samples.slice(-FALLBACK_BUCKETS);
    const totalCost = shown.reduce((sum, bucket) => sum + bucket.costUsd, 0);
    const totalTokens = shown.reduce(
      (sum, bucket) => sum + bucket.inputTokens + bucket.outputTokens,
      0,
    );
    const totalTools = shown.reduce((sum, bucket) => sum + bucket.toolCalls, 0);
    const byModel = rollup(shown, 'byModel');
    const byProvider = rollup(shown, 'byProvider');
    const cacheRead = byModel.reduce((sum, row) => sum + (row.entry.cacheRead ?? 0), 0);
    const promptTokens = shown.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
    const cacheHit =
      promptTokens > 0 && cacheRead > 0 ? Math.min(1, cacheRead / promptTokens) : null;
    return { shown, totalCost, totalTokens, totalTools, byModel, byProvider, cacheHit };
  }, [samples, rangeMs]);

  if (error !== null) {
    return (
      <ViewShell>
        <EmptyState icon={ChartNoAxesCombined} title="Could not load trends" hint={error} />
      </ViewShell>
    );
  }

  if (samples.length === 0) {
    return (
      <ViewShell>
        <EmptyState
          icon={ChartNoAxesCombined}
          title="No trend data yet"
          hint="Buckets accumulate as cost signals arrive from the fleet."
        />
      </ViewShell>
    );
  }

  const activeRange = RANGES.find((range) => range.ms === rangeMs)?.label ?? 'custom';

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Telemetry runway"
        headline={`${activeRange} signal window`}
        description="Cost, tokens and tool activity in single-purpose charts, so a spike stays attributable."
        metrics={
          <>
            <HeroMetric label="cost" value={formatUsd(view.totalCost)} tone="running" />
            <HeroMetric label="tokens" value={formatCount(view.totalTokens)} tone="info" />
            <HeroMetric label="tool calls" value={formatCount(view.totalTools)} tone="active" />
            {view.cacheHit !== null && (
              <HeroMetric label="cache hit" value={formatPercent(view.cacheHit)} />
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {RANGES.map((range) => (
          <button
            key={range.label}
            type="button"
            data-testid="range-chip"
            aria-pressed={rangeMs === range.ms}
            onClick={() => setRangeMs(range.ms)}
            className={cn(
              'border px-2 py-0.5 text-[11px] transition-colors',
              rangeMs === range.ms
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {range.label}
          </button>
        ))}
        <Mono className="tabular ml-auto">{view.shown.length} × 5-min buckets</Mono>
      </div>

      <div className="grid gap-3 2xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Cost (USD)</CardTitle>
          </CardHeader>
          <CardContent>
            <TimeseriesChart
              label="Cost per 5-minute bucket"
              points={view.shown.map((sample) => ({ ts: sample.ts, value: sample.costUsd }))}
              color="hsl(var(--primary))"
              format={formatUsd}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tokens (in + out)</CardTitle>
          </CardHeader>
          <CardContent>
            <TimeseriesChart
              label="Tokens per 5-minute bucket"
              points={view.shown.map((sample) => ({
                ts: sample.ts,
                value: sample.inputTokens + sample.outputTokens,
              }))}
              color="hsl(var(--info))"
              format={formatCount}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tool calls</CardTitle>
          </CardHeader>
          <CardContent>
            <TimeseriesChart
              label="Tool calls per 5-minute bucket"
              points={view.shown.map((sample) => ({ ts: sample.ts, value: sample.toolCalls }))}
              color="hsl(var(--brand-orange))"
              format={(value) => String(Math.round(value))}
            />
          </CardContent>
        </Card>
      </div>

      {view.byModel.length > 0 && (
        <div className="grid gap-5 2xl:grid-cols-2">
          <Section eyebrow="Model economics" title="By model">
            <BreakdownRows rows={view.byModel} totalCost={view.totalCost} showTokens />
          </Section>
          {view.byProvider.length > 1 && (
            <Section eyebrow="Provider split" title="By provider">
              <BreakdownRows
                rows={view.byProvider}
                totalCost={view.totalCost}
                showTokens={false}
              />
            </Section>
          )}
        </div>
      )}
    </ViewShell>
  );
}
