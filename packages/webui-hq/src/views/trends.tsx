/**
 * Trends view — time-bucketed cost + activity from /api/trends/cost, rendered
 * as a KPI row plus one single-series column chart per measure (cost, tokens,
 * tool calls). One chart = one measure = one hue; never a dual axis. When the
 * server reports per-model / per-provider breakdowns (newer cost signals),
 * those roll up into a "By Model" / "By Provider" share table.
 */
import type { HqTimeseriesBreakdownEntry, HqTimeseriesSample } from '@wrongstack/core/hq';
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

  const {
    shown,
    totalCost,
    totalTokens,
    totalTools,
    byModel,
    byProvider,
    totalCacheRead,
    totalPromptTokens,
  } = useMemo(() => {
    const cutoff = Date.now() - rangeMs;
    const inRange = samples.filter((s) => s.ts >= cutoff);
    const shown = inRange.length > 0 ? inRange : samples.slice(-24);
    const totalCost = shown.reduce((s, b) => s + b.costUsd, 0);
    const totalTokens = shown.reduce((s, b) => s + b.inputTokens + b.outputTokens, 0);
    const totalTools = shown.reduce((s, b) => s + b.toolCalls, 0);
    const byModel = rollup(shown, 'byModel');
    const byProvider = rollup(shown, 'byProvider');
    const totalCacheRead = byModel.reduce((s, e) => s + (e.entry.cacheRead ?? 0), 0);
    const totalPromptTokens = shown.reduce((s, b) => s + b.inputTokens, 0);
    return {
      shown,
      totalCost,
      totalTokens,
      totalTools,
      byModel,
      byProvider,
      totalCacheRead,
      totalPromptTokens,
    };
  }, [samples, rangeMs]);

  if (error !== null)
    return <div className="hq-empty hq-empty-ornate">Error loading trends: {error}</div>;
  if (samples.length === 0) {
    return (
      <div className="hq-empty hq-empty-ornate">
        No trend data yet. Trends accumulate as cost signals arrive.
      </div>
    );
  }

  const hasModelBreakdown = byModel.length > 0;
  const cacheHitPct =
    totalPromptTokens > 0 && totalCacheRead > 0
      ? Math.min(100, Math.max(0, (totalCacheRead / totalPromptTokens) * 100))
      : null;
  const activeRange = RANGES.find((range) => range.ms === rangeMs)?.label ?? 'custom';

  return (
    <div className="hq-screen hq-trends-screen">
      <section className="hq-screen-hero hq-trends-hero" aria-label="Telemetry trend summary">
        <div>
          <span className="hq-section-kicker">Telemetry runway</span>
          <h2>{activeRange} signal window</h2>
          <p>
            Cost, tokens and tool activity are split into single-purpose charts so spikes stay
            attributable without dual-axis ambiguity.
          </p>
        </div>
        <div className="hq-hero-metrics">
          <Metric label="cost" value={`$${totalCost.toFixed(4)}`} />
          <Metric label="tokens" value={fmtTokens(totalTokens)} tone="warn" />
          <Metric label="tool calls" value={totalTools.toLocaleString()} tone="ok" />
          {cacheHitPct !== null ? (
            <Metric label="cache hit" value={`${cacheHitPct.toFixed(0)}%`} />
          ) : null}
        </div>
      </section>

      <div className="hq-filter-row hq-trends-filter-row">
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
        <span className="hq-mono hq-row-subtle hq-ml-auto">{shown.length} × 5-min buckets</span>
      </div>

      <section className="hq-chart-gallery" aria-label="Trend charts">
        <div className="hq-card hq-chart-card primary">
          <div className="hq-section-head compact">
            <div>
              <span className="hq-section-kicker">Spend</span>
              <h3>Cost (USD)</h3>
            </div>
          </div>
          <TimeseriesChart
            points={shown.map((s) => ({ ts: s.ts, value: s.costUsd }))}
            color="var(--chart-1)"
            format={(v) => `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`}
          />
        </div>
        <div className="hq-card hq-chart-card">
          <div className="hq-section-head compact">
            <div>
              <span className="hq-section-kicker">Volume</span>
              <h3>Tokens (in + out)</h3>
            </div>
          </div>
          <TimeseriesChart
            points={shown.map((s) => ({ ts: s.ts, value: s.inputTokens + s.outputTokens }))}
            color="var(--chart-2)"
            format={fmtTokens}
          />
        </div>
        <div className="hq-card hq-chart-card">
          <div className="hq-section-head compact">
            <div>
              <span className="hq-section-kicker">Activity</span>
              <h3>Tool calls</h3>
            </div>
          </div>
          <TimeseriesChart
            points={shown.map((s) => ({ ts: s.ts, value: s.toolCalls }))}
            color="var(--chart-3)"
            format={(v) => String(Math.round(v))}
          />
        </div>
      </section>

      {hasModelBreakdown && (
        <section className="hq-two-column hq-trends-breakdowns">
          <div>
            <div className="hq-section-head compact">
              <div>
                <span className="hq-section-kicker">Model economics</span>
                <h3>By Model</h3>
              </div>
            </div>
            <div className="hq-card hq-breakdown-card">
              {byModel.map(({ key, entry }) => {
                const pct = totalCost > 0 ? (entry.costUsd / totalCost) * 100 : 0;
                return (
                  <div key={key} className="hq-row hq-breakdown-row">
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
          </div>
          {byProvider.length > 1 && (
            <div>
              <div className="hq-section-head compact">
                <div>
                  <span className="hq-section-kicker">Provider split</span>
                  <h3>By Provider</h3>
                </div>
              </div>
              <div className="hq-card hq-breakdown-card">
                {byProvider.map(({ key, entry }) => {
                  const pct = totalCost > 0 ? (entry.costUsd / totalCost) * 100 : 0;
                  return (
                    <div key={key} className="hq-row hq-breakdown-row">
                      <span className="hq-text-bright">{key}</span>
                      <span className="hq-cost-amount hq-ml-auto">${entry.costUsd.toFixed(4)}</span>
                      <span className="hq-mono hq-row-subtle">{pct.toFixed(1)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'ok' | 'warn' | 'error';
}): React.ReactElement {
  return (
    <div className="hq-hero-metric" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
