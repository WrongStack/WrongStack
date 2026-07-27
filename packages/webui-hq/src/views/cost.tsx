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
    return <div className="hq-empty hq-empty-ornate">No cost data yet — connect some clients.</div>;
  }

  const sorted = [...projects].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  const leader = sorted[0];
  const leaderPct = leader && total > 0 ? (leader.totalCostUsd / total) * 100 : 0;
  const totalTokens = sessionRows.reduce((sum, row) => sum + row.tokens, 0);

  return (
    <div className="hq-screen hq-cost-screen">
      <section className="hq-screen-hero hq-cost-hero" aria-label="Cost command summary">
        <div>
          <span className="hq-section-kicker">Economics</span>
          <h2>${total.toFixed(4)}</h2>
          <p>
            Fleet spend is ranked by project first, then drilled down into costed sessions and model
            fingerprints.
          </p>
        </div>
        <div className="hq-hero-metrics">
          <Metric label="projects" value={projects.length} />
          <Metric label="costed sessions" value={sessionRows.length} />
          <Metric label="tokens" value={fmtTokens(totalTokens)} />
          <Metric label="top share" value={`${leaderPct.toFixed(0)}%`} tone={leaderPct > 60 ? 'warn' : undefined} />
        </div>
      </section>

      <section className="hq-priority-section" aria-label="Project cost ranking">
        <div className="hq-section-head">
          <div>
            <span className="hq-section-kicker">Spend distribution</span>
            <h3>By Project</h3>
          </div>
          {leader ? <span className="hq-pill info">leader: {leader.projectName}</span> : null}
        </div>
        <div className="hq-cost-rank-list">
          {sorted.map((p, index) => {
            const pct = total > 0 ? (p.totalCostUsd / total) * 100 : 0;
            return (
              <article key={p.projectId} className="hq-card hq-cost-project-card">
                <div className="hq-cost-rank">#{index + 1}</div>
                <div className="hq-cost-project-main">
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
              </article>
            );
          })}
        </div>
      </section>

      {sessionRows.length > 0 && (
        <section>
          <div className="hq-section-head compact">
            <div>
              <span className="hq-section-kicker">Drilldown</span>
              <h3>By Session</h3>
            </div>
            <span className="hq-mono hq-row-subtle">{sessionRows.length} costed</span>
          </div>
          <div className="hq-card hq-cost-session-card">
            {sessionRows.map(({ s, cost, tokens, models }) => (
              <button
                key={s.sessionId}
                type="button"
                className="hq-row hq-row-click hq-cost-session-row"
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
