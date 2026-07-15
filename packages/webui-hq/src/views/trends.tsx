/**
 * Trends view — time-bucketed cost + activity from /api/trends/cost, rendered
 * as a KPI row plus one single-series column chart per measure (cost, tokens,
 * tool calls). One chart = one measure = one hue; never a dual axis. When the
 * server reports per-model / per-provider breakdowns (newer cost signals),
 * those roll up into a "By Model" / "By Provider" share table.
 */
import type { HqTimeseriesBreakdownEntry, HqTimeseriesSample } from '@wrongstack/core';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { TimeseriesChart } from '../lib/timeseries-chart.js';
import { fetchJson } from '../store.js';

interface TrendsResponse {
  samples: HqTimeseriesSample[];
}

const RANGES: { label: string; ms: number }[] = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/** Aggregate per-model / per-provider breakdown entries across shown buckets. */
function rollup(
  samples: readonly HqTimeseriesSample[],
  dim: 'byModel' | 'byProvider',
): { key: string; entry: HqTimeseriesBreakdownEntry }[] {
  const acc = new Map<string, HqTimeseriesBreakdownEntry>();
  for (const s of samples) {
    const map = s[dim];
    if (map === undefined) continue;
    for (const [key, raw] of Object.entries(map)) {
      const existing = acc.get(key);
      if (existing === undefined) {
        acc.set(key, { ...raw });
      } else {
        existing.costUsd += raw.costUsd;
        existing.inputTokens += raw.inputTokens;
        existing.outputTokens += raw.outputTokens;
        existing.cacheRead = (existing.cacheRead ?? 0) + (raw.cacheRead ?? 0);
        existing.cacheWrite = (existing.cacheWrite ?? 0) + (raw.cacheWrite ?? 0);
      }
    }
  }
  return [...acc.entries()]
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => b.entry.costUsd - a.entry.costUsd);
}

export function TrendsView(): React.ReactElement {
  const [samples, setSamples] = useState<HqTimeseriesSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rangeMs, setRangeMs] = useState(RANGES[2]!.ms);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<TrendsResponse>('/api/trends/cost')
        .then((data) => {
          if (!cancelled) {
            setSamples(data.samples);
            setError(null);
          }
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const { shown, totalCost, totalTokens, totalTools, byModel, byProvider, totalCacheRead, totalCacheWrite } =
    useMemo(() => {
      const cutoff = Date.now() - rangeMs;
      const inRange = samples.filter((s) => s.ts >= cutoff);
      const shown = inRange.length > 0 ? inRange : samples.slice(-24);
      const totalCost = shown.reduce((s, b) => s + b.costUsd, 0);
      const totalTokens = shown.reduce((s, b) => s + b.inputTokens + b.outputTokens, 0);
      const totalTools = shown.reduce((s, b) => s + b.toolCalls, 0);
      const byModel = rollup(shown, 'byModel');
      const byProvider = rollup(shown, 'byProvider');
      const totalCacheRead = byModel.reduce((s, e) => s + (e.entry.cacheRead ?? 0), 0);
      const totalCacheWrite = byModel.reduce((s, e) => s + (e.entry.cacheWrite ?? 0), 0);
      return { shown, totalCost, totalTokens, totalTools, byModel, byProvider, totalCacheRead, totalCacheWrite };
    }, [samples, rangeMs]);

  if (error !== null) return <div className="hq-empty">Error loading trends: {error}</div>;
  if (samples.length === 0) {
    return (
      <div className="hq-empty">No trend data yet. Trends accumulate as cost signals arrive.</div>
    );
  }

  const hasModelBreakdown = byModel.length > 0;
  const cacheHitPct =
    totalCacheRead + totalCacheWrite > 0
      ? (totalCacheRead / (totalCacheRead + totalCacheWrite)) * 100
      : null;

  return (
    <div>
      <div className="hq-filter-row">
        {RANGES.map((r) => (
          <button
            key={r.label}
            type="button"
            className={`hq-pill hq-filter-chip${rangeMs === r.ms ? ' selected' : ''}`}
            onClick={() => setRangeMs(r.ms)}
          >
            {r.label}
          </button>
        ))}
        <span className="hq-mono hq-row-subtle hq-ml-auto">
          {shown.length} × 5-min buckets
        </span>
      </div>

      <div className="hq-stat-row">
        <div className="hq-stat-block">
          <span className="hq-stat-block-value accent-cost">${totalCost.toFixed(4)}</span>
          <span className="hq-stat-block-label">cost</span>
        </div>
        <div className="hq-stat-block">
          <span className="hq-stat-block-value accent-tokens">{fmtTokens(totalTokens)}</span>
          <span className="hq-stat-block-label">tokens</span>
        </div>
        <div className="hq-stat-block">
          <span className="hq-stat-block-value accent-tools">{totalTools.toLocaleString()}</span>
          <span className="hq-stat-block-label">tool calls</span>
        </div>
        {cacheHitPct !== null && (
          <div className="hq-stat-block">
            <span className="hq-stat-block-value">{cacheHitPct.toFixed(0)}%</span>
            <span className="hq-stat-block-label">cache hit</span>
            <span className="hq-stat-block-sub">
              {fmtTokens(totalCacheRead)} read · {fmtTokens(totalCacheWrite)} write
            </span>
          </div>
        )}
      </div>

      <div className="hq-card">
        <div className="hq-card-title">Cost (USD)</div>
        <TimeseriesChart
          points={shown.map((s) => ({ ts: s.ts, value: s.costUsd }))}
          color="var(--chart-1)"
          format={(v) => `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`}
        />
      </div>
      <div className="hq-card">
        <div className="hq-card-title">Tokens (in + out)</div>
        <TimeseriesChart
          points={shown.map((s) => ({ ts: s.ts, value: s.inputTokens + s.outputTokens }))}
          color="var(--chart-2)"
          format={fmtTokens}
        />
      </div>
      <div className="hq-card">
        <div className="hq-card-title">Tool calls</div>
        <TimeseriesChart
          points={shown.map((s) => ({ ts: s.ts, value: s.toolCalls }))}
          color="var(--chart-3)"
          format={(v) => String(Math.round(v))}
        />
      </div>

      {hasModelBreakdown && (
        <>
          <div className="hq-card-title">By Model</div>
          <div className="hq-card">
            {byModel.map(({ key, entry }) => {
              const pct = totalCost > 0 ? (entry.costUsd / totalCost) * 100 : 0;
              return (
                <div key={key} className="hq-row">
                  <span className="hq-text-bright">{key}</span>
                  <span className="hq-mono hq-row-subtle">
                    {fmtTokens(entry.inputTokens)}→{fmtTokens(entry.outputTokens)}
                    {entry.cacheRead !== undefined || entry.cacheWrite !== undefined
                      ? ` · cache ${fmtTokens((entry.cacheRead ?? 0) + (entry.cacheWrite ?? 0))}`
                      : ''}
                  </span>
                  <span className="hq-cost-amount hq-ml-auto">${entry.costUsd.toFixed(4)}</span>
                  <span className="hq-mono hq-row-subtle">{pct.toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
          {byProvider.length > 1 && (
            <>
              <div className="hq-card-title">By Provider</div>
              <div className="hq-card">
                {byProvider.map(({ key, entry }) => {
                  const pct = totalCost > 0 ? (entry.costUsd / totalCost) * 100 : 0;
                  return (
                    <div key={key} className="hq-row">
                      <span className="hq-text-bright">{key}</span>
                      <span className="hq-cost-amount hq-ml-auto">${entry.costUsd.toFixed(4)}</span>
                      <span className="hq-mono hq-row-subtle">{pct.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
