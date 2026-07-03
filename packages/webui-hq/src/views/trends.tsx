/**
 * Trends view — time-bucketed cost + activity from /api/trends/cost.
 */
import type React from 'react';
import { useEffect, useState } from 'react';
import { fetchJson } from '../store.js';
import type { HqTimeseriesSample } from '@wrongstack/core';

interface TrendsResponse {
  samples: HqTimeseriesSample[];
}

export function TrendsView(): React.ReactElement {
  const [samples, setSamples] = useState<HqTimeseriesSample[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        .catch((err) => {
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

  if (error !== null) return <div className="hq-empty">Error loading trends: {error}</div>;
  if (samples.length === 0) return <div className="hq-empty">No trend data yet. Trends accumulate as cost signals arrive.</div>;

  const totalCost = samples.reduce((s, b) => s + b.costUsd, 0);
  const totalTokens = samples.reduce((s, b) => s + b.inputTokens + b.outputTokens, 0);
  const totalTools = samples.reduce((s, b) => s + b.toolCalls, 0);
  const maxCost = Math.max(...samples.map((s) => s.costUsd), 0.001);

  return (
    <div>
      <div className="hq-card">
        <div className="hq-card-title">Aggregated (all buckets)</div>
        <div className="hq-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
          <div><div className="hq-stat-num" style={{ color: 'var(--green)' }}>${totalCost.toFixed(4)}</div><div className="hq-stat-label">total cost</div></div>
          <div><div className="hq-stat-num">{totalTokens.toLocaleString()}</div><div className="hq-stat-label">total tokens</div></div>
          <div><div className="hq-stat-num">{totalTools}</div><div className="hq-stat-label">tool calls</div></div>
        </div>
      </div>
      <div className="hq-card-title">Cost per bucket ({samples.length} buckets)</div>
      <div className="hq-card">
        {samples.slice(-60).map((s, i) => {
          const height = Math.round((s.costUsd / maxCost) * 8);
          return (
            <div key={i} className="hq-row" style={{ alignItems: 'center' }}>
              <span className="hq-mono" style={{ color: 'var(--dim)', minWidth: 60 }}>{new Date(s.ts).toLocaleTimeString()}</span>
              <span className="hq-spark" style={{ color: 'var(--accent)' }}>{'█'.repeat(height)}{'░'.repeat(8 - height)}</span>
              <span className="hq-mono" style={{ marginLeft: 'auto', color: 'var(--green)' }}>${s.costUsd.toFixed(4)}</span>
              <span className="hq-mono" style={{ color: 'var(--dim)' }}>{s.inputTokens + s.outputTokens} tok</span>
              {s.toolCalls > 0 && <span className="hq-mono" style={{ color: 'var(--cyan)' }}>{s.toolCalls} tools</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
