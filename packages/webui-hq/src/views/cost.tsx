/**
 * Cost view — fleet-wide cost breakdown by project.
 */
import type React from 'react';
import { useHqStore } from '../store.js';

export function CostView(): React.ReactElement {
  const state = useHqStore();
  const projects = state.snapshot?.projects ?? [];
  const total = state.snapshot?.totals.totalCostUsd ?? 0;

  if (projects.length === 0) {
    return <div className="hq-empty">No cost data yet — connect some clients.</div>;
  }

  const sorted = [...projects].sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  return (
    <div>
      <div className="hq-card">
        <div className="hq-card-title">Total Fleet Cost</div>
        <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--green)' }}>
          ${total.toFixed(4)}
        </div>
      </div>
      <div className="hq-card-title">By Project</div>
      {sorted.map((p) => {
        const pct = total > 0 ? (p.totalCostUsd / total) * 100 : 0;
        return (
          <div key={p.projectId} className="hq-card">
            <div className="hq-row">
              <span style={{ fontWeight: 700 }}>{p.projectName}</span>
              <span className="hq-mono" style={{ color: 'var(--dim)' }}>{p.projectId}</span>
              <span style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--green)' }}>
                ${p.totalCostUsd.toFixed(4)}
              </span>
              <span className="hq-mono" style={{ color: 'var(--dim)' }}>{pct.toFixed(1)}%</span>
            </div>
            <div style={{ height: 4, background: 'var(--bg)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
            <div className="hq-row" style={{ marginTop: 4 }}>
              <span className="hq-pill info">{p.activeSessions} sessions</span>
              <span className="hq-pill active">{p.activeSubagents} subagents</span>
              <span className="hq-pill idle">{p.activeClients} clients</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
