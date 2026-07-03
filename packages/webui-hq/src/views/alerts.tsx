/**
 * Alerts view — live alert feed + active alerts.
 * Fed by `hq.alert` WS messages (Phase 6) + /api/alerts history.
 */
import type React from 'react';
import { useEffect, useState } from 'react';
import { useHqStore, fetchJson } from '../store.js';
import type { HqAlert } from '@wrongstack/core';

interface AlertsApiResponse {
  active: HqAlert[];
  history: HqAlert[];
}

export function AlertsView(): React.ReactElement {
  const state = useHqStore();
  const [apiActive, setApiActive] = useState<HqAlert[]>([]);
  const [apiHistory, setApiHistory] = useState<HqAlert[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<AlertsApiResponse>('/api/alerts')
        .then((data) => {
          if (!cancelled) {
            setApiActive(data.active);
            setApiHistory(data.history);
          }
        })
        .catch(() => {
          /* best-effort */
        });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const liveAlerts = state.alerts.slice(-50).reverse();

  return (
    <div>
      {apiActive.length > 0 && (
        <>
          <div className="hq-card-title">Active Alerts ({apiActive.length})</div>
          {apiActive.map((a) => (
            <div key={a.id} className="hq-card" style={{ borderColor: 'var(--red)' }}>
              <div className="hq-row">
                <span className={'hq-pill ' + a.severity}>{a.severity}</span>
                <span style={{ fontWeight: 700 }}>{a.ruleId}</span>
                <span className="hq-mono" style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
                  since {new Date(a.firstFiredAt).toLocaleTimeString()}
                </span>
              </div>
              <div style={{ marginTop: 4 }}>{a.message}</div>
            </div>
          ))}
        </>
      )}

      <div className="hq-card-title">Live Alert Feed (last {liveAlerts.length})</div>
      {liveAlerts.length === 0 ? (
        <div className="hq-empty">No live alerts. Alerts fire when fleet rules trigger (cost, stale, failures).</div>
      ) : (
        liveAlerts.map((a, i) => (
          <div key={i} className="hq-card">
            <div className="hq-row">
              <span className={'hq-pill ' + a.severity}>{a.severity}</span>
              <span className="hq-mono" style={{ marginLeft: 'auto', color: 'var(--dim)' }}>{new Date(a.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style={{ marginTop: 4 }}>{a.message}</div>
          </div>
        ))
      )}

      <div className="hq-card-title">Alert History ({apiHistory.length})</div>
      <div className="hq-card">
        {apiHistory.length === 0 ? (
          <div className="hq-empty">No historical alerts.</div>
        ) : (
          apiHistory.slice(-30).reverse().map((a, i) => (
            <div key={i} className="hq-row">
              <span className={'hq-pill ' + a.severity}>{a.severity}</span>
              <span className="hq-mono">{a.ruleId}</span>
              <span style={{ color: 'var(--muted)' }}>{a.message}</span>
              <span className="hq-mono" style={{ marginLeft: 'auto', color: 'var(--dim)' }}>{new Date(a.lastFiredAt).toLocaleTimeString()}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
