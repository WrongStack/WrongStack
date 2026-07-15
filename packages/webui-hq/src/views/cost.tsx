/**
 * Cost view — fleet-wide cost: hero total, per-project share bars, and a
 * per-session/agent breakdown (model, tokens, cost) from the live snapshot.
 */
import type React from 'react';
import { useMemo } from 'react';
import { useHqStore } from '../store.js';

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function CostView(): React.ReactElement {
  const snapshot = useHqStore((s) => s.snapshot);
  const projects = snapshot?.projects ?? [];
  const sessions = snapshot?.liveSessions ?? [];
  const total = snapshot?.totals.totalCostUsd ?? 0;

  const sessionRows = useMemo(() => {
    const rows = sessions.map((s) => {
      let cost = 0;
      let tokens = 0;
      const models = new Set<string>();
      for (const a of s.agents) {
        cost += a.costUsd ?? 0;
        tokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0);
        if (a.model !== undefined) models.add(a.model);
      }
      return { s, cost, tokens, models: [...models] };
    });
    return rows.filter((r) => r.cost > 0 || r.tokens > 0).sort((a, b) => b.cost - a.cost);
  }, [sessions]);

  if (projects.length === 0) {
    return <div className="hq-empty">No cost data yet — connect some clients.</div>;
  }

  const sorted = [...projects].sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  return (
    <div>
      <div className="hq-kpi-row">
        <div className="hq-kpi hero">
          <span className="hq-kpi-value accent-cost">${total.toFixed(4)}</span>
          <span className="hq-kpi-label">total fleet cost</span>
        </div>
        <div className="hq-kpi">
          <span className="hq-kpi-value">{projects.length}</span>
          <span className="hq-kpi-label">projects</span>
        </div>
        <div className="hq-kpi">
          <span className="hq-kpi-value">{sessionRows.length}</span>
          <span className="hq-kpi-label">costed sessions</span>
        </div>
      </div>

      <div className="hq-card-title">By Project</div>
      {sorted.map((p) => {
        const pct = total > 0 ? (p.totalCostUsd / total) * 100 : 0;
        return (
          <div key={p.projectId} className="hq-card">
            <div className="hq-row">
              <span className="hq-text-bright">{p.projectName}</span>
              <span className="hq-mono hq-row-subtle">{p.projectId}</span>
              <span className="hq-cost-amount">${p.totalCostUsd.toFixed(4)}</span>
              <span className="hq-mono hq-row-subtle">{pct.toFixed(1)}%</span>
            </div>
            <div className="hq-share-track">
              <div className="hq-share-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="hq-row hq-row-detail">
              <span className="hq-pill info">{p.activeSessions} sessions</span>
              <span className="hq-pill active">{p.activeSubagents} subagents</span>
              <span className="hq-pill idle">{p.activeClients} clients</span>
            </div>
          </div>
        );
      })}

      {sessionRows.length > 0 && (
        <>
          <div className="hq-card-title">By Session</div>
          <div className="hq-card">
            {sessionRows.map(({ s, cost, tokens, models }) => (
              <button
                key={s.sessionId}
                type="button"
                className="hq-row hq-row-click"
                onClick={() => {
                  useHqStore.getState().selectSession(s.sessionId);
                  useHqStore.getState().setActiveView('console');
                }}
                title="Open in Console"
              >
                <span className="hq-text-bright">{s.projectName}</span>
                <span className="hq-pill idle">{s.clientKind}</span>
                {models.map((m) => (
                  <span key={m} className="hq-pill info">
                    {m}
                  </span>
                ))}
                <span className="hq-mono hq-row-subtle">{fmtTokens(tokens)} tok</span>
                <span className="hq-cost-amount">${cost.toFixed(4)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
