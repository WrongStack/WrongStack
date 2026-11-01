'use client';

import { useHqStore } from '@hq/data/store/index';
/**
 * Trends — cost, tokens and tool calls over time.
 *
 * Three measures, three charts: they differ by orders of magnitude, and a
 * shared axis would make any two look correlated. The window lives in the URL
 * (`?range=`). An empty window says so and names the last activity, instead of
 * quietly showing older data under the newer label.
 */
import { RefreshCw } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { scopeLabel } from '@/lib/scope';
import { useFleetScope } from '@/lib/use-scope';
import { BreakdownTable } from './breakdown-table';
import { ColumnChart } from './column-chart';
import { breakdown, count, percent, TREND_RANGES, trendTotals, trendWindow, usd } from './model';
import { useTrends } from './use-trends';

const DEFAULT_RANGE = TREND_RANGES[2] ?? TREND_RANGES[0];

export function TrendsView(): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const trends = useTrends();
  const scope = useFleetScope();
  const snapshot = useHqStore((state) => state.snapshot);
  const range =
    TREND_RANGES.find((candidate) => candidate.id === params.get('range')) ?? DEFAULT_RANGE;

  const view = useMemo(
    () => (range === undefined ? null : trendWindow(trends.samples, range, trends.fetchedAt)),
    [trends.samples, range, trends.fetchedAt],
  );
  const totals = useMemo(() => trendTotals(view?.samples ?? []), [view]);
  const byModel = useMemo(() => breakdown(view?.samples ?? [], 'byModel'), [view]);
  const byProvider = useMemo(() => breakdown(view?.samples ?? [], 'byProvider'), [view]);

  if (range === undefined || view === null) return null;

  const pick = (id: string): void => {
    const next = new URLSearchParams(params.toString());
    if (id === DEFAULT_RANGE?.id) next.delete('range');
    else next.set('range', id);
    const query = next.toString();
    router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
  };

  const empty = view.samples.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-2xl font-semibold">{range.label}</h2>
          <p className="text-sm text-muted-foreground">
            {trends.loading
              ? 'Loading the series…'
              : empty
                ? 'No cost, token or tool activity in this window.'
                : `${usd(totals.costUsd)} · ${count(totals.inputTokens + totals.outputTokens)} tokens · ${count(totals.toolCalls)} tool calls${
                    totals.cacheShare !== null
                      ? ` · ${percent(totals.cacheShare)} of prompt tokens read from cache`
                      : ''
                  }`}
          </p>
          {scope.kind !== 'all' && (
            <p className="text-sm text-muted-foreground" data-testid="trends-scope">
              Only {scopeLabel(scope, snapshot)}. Model and provider splits are fleet-wide and
              hidden here; history recorded before HQ kept per-machine and per-project figures
              counts toward the whole fleet only.
            </p>
          )}
        </div>
        <fieldset className="ml-auto flex border border-border">
          <legend className="sr-only">Time view</legend>
          {TREND_RANGES.map((candidate) => (
            <label
              key={candidate.id}
              className={cn(
                'flex h-9 cursor-pointer items-center px-3 text-sm focus-within:ring-2 focus-within:ring-ring',
                candidate.id === range.id
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <input
                type="radio"
                name="trend-range"
                value={candidate.id}
                checked={candidate.id === range.id}
                onChange={() => pick(candidate.id)}
                className="sr-only"
              />
              {candidate.id}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={trends.refresh}
          aria-label="Refresh trends"
          className="grid size-9 place-items-center border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>

      {trends.error !== null && (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          The series could not be loaded: {trends.error}
        </p>
      )}

      {!trends.loading && empty && (
        <p className="text-base text-muted-foreground">
          {view.lastActivity === undefined
            ? 'HQ has not recorded any activity yet. The series fills as connected clients report spend.'
            : `The last recorded activity was ${new Date(view.lastActivity).toLocaleString()}. Pick a longer window to see it.`}
        </p>
      )}

      {!empty && (
        <>
          <p className="-mt-4 text-sm text-muted-foreground">
            One column per {range.bucketLabel}. Hover a chart to read a column; each chart lists its
            numbers underneath.
          </p>
          <ColumnChart
            title="Cost"
            total={usd(totals.costUsd)}
            columns={view.columns.map((column) => ({ ts: column.ts, value: column.costUsd }))}
            bucketMs={range.bucketMs}
            color="var(--color-primary)"
            format={usd}
          />
          <ColumnChart
            title="Tokens"
            total={`${count(totals.inputTokens)} in · ${count(totals.outputTokens)} out`}
            columns={view.columns.map((column) => ({ ts: column.ts, value: column.tokens }))}
            bucketMs={range.bucketMs}
            color="var(--color-info)"
            format={count}
          />
          <ColumnChart
            title="Tool calls"
            total={count(totals.toolCalls)}
            columns={view.columns.map((column) => ({ ts: column.ts, value: column.toolCalls }))}
            bucketMs={range.bucketMs}
            color="var(--color-brand-orange)"
            format={count}
          />
          {byModel.length > 0 && <BreakdownTable title="By model" rows={byModel} showTokens />}
          {byProvider.length > 1 && (
            <BreakdownTable title="By provider" rows={byProvider} showTokens={false} />
          )}
        </>
      )}
    </div>
  );
}
