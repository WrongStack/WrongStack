/**
 * Alerts view — live alert feed + active alerts.
 * Fed by `hq.alert` WS messages + /api/alerts history.
 */

import type { HqAlert } from '@wrongstack/core';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fetchJson, useHqStore } from '../store.js';

interface AlertsApiResponse {
  active: HqAlert[];
  history: HqAlert[];
}

export function AlertsView(): React.ReactElement {
  const { alerts, snapshot } = useHqStore(
    useShallow((s) => ({ alerts: s.alerts, snapshot: s.snapshot })),
  );
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

  const liveAlerts = alerts.slice(-50).reverse();

  return (
    <div>
      {apiActive.length > 0 && (
        <>
          <div className="hq-card-title">Active Alerts ({apiActive.length})</div>
          {apiActive.map((a) => (
            <div key={a.id} className={'hq-card hq-card-severity ' + a.severity}>
              <div className="hq-row">
                <span className={'hq-pill ' + a.severity}>{a.severity}</span>
                <span className="hq-text-bright">{a.ruleId}</span>
                <span className="hq-mono hq-ml-auto hq-text-dim">
                  since {new Date(a.firstFiredAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="hq-row-detail">{a.message}</div>
            </div>
          ))}
        </>
      )}

      <div className="hq-card-title">Live Alert Feed (last {liveAlerts.length})</div>
      {liveAlerts.length === 0 ? (
        <div className="hq-empty">
          No live alerts. Alerts fire when fleet rules trigger (cost, stale, failures).
        </div>
      ) : (
        liveAlerts.map((a, i) => (
          <div key={i} className="hq-card">
            <div className="hq-row">
              <span className={'hq-pill ' + a.severity}>{a.severity}</span>
              <span className="hq-mono hq-ml-auto hq-text-dim">
                {new Date(a.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="hq-row-detail">{a.message}</div>
          </div>
        ))
      )}

      <div className="hq-card-title">Alert History ({apiHistory.length})</div>
      <div className="hq-card">
        {apiHistory.length === 0 ? (
          <div className="hq-empty">No historical alerts.</div>
        ) : (
          apiHistory
            .slice(-30)
            .reverse()
            .map((a, i) => (
              <div key={i} className="hq-row">
                <span className={'hq-pill ' + a.severity}>{a.severity}</span>
                <span className="hq-mono">{a.ruleId}</span>
                <span className="hq-text-muted">{a.message}</span>
                <span className="hq-mono hq-ml-auto hq-text-dim">
                  {new Date(a.lastFiredAt).toLocaleTimeString()}
                </span>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
