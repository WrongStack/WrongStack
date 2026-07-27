/**
 * Alerts view — live alert feed + active alerts.
 * Fed by `hq.alert` WS messages + /api/alerts history.
 */

import type { HqAlert } from '@wrongstack/core/hq';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fetchJson, useHqStore } from '../store.js';

interface AlertsApiResponse {
  active: HqAlert[];
  history: HqAlert[];
}

export function AlertsView(): React.ReactElement {
  const alerts = useHqStore(useShallow((s) => s.alerts));
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
  const errorCount = apiActive.filter((alert) => alert.severity === 'error').length;
  const warningCount = apiActive.filter((alert) => alert.severity === 'warn').length;
  const quiet = apiActive.length === 0 && liveAlerts.length === 0;

  return (
    <div className="hq-screen hq-alerts-screen">
      <section className="hq-screen-hero hq-alerts-hero" aria-label="Alert command summary">
        <div>
          <span className="hq-section-kicker">Attention rail</span>
          <h2>{quiet ? 'Fleet quiet' : 'Fleet requires review'}</h2>
          <p>
            Active rules, live envelopes and historical transitions are separated so urgent alerts
            stay above routine telemetry.
          </p>
        </div>
        <div className="hq-hero-metrics">
          <Metric label="active" value={apiActive.length} tone={apiActive.length > 0 ? 'warn' : 'ok'} />
          <Metric label="errors" value={errorCount} tone={errorCount > 0 ? 'error' : 'ok'} />
          <Metric label="warnings" value={warningCount} tone={warningCount > 0 ? 'warn' : 'ok'} />
          <Metric label="live feed" value={liveAlerts.length} />
        </div>
      </section>

      <section className="hq-priority-section" aria-label="Active alerts">
        <div className="hq-section-head">
          <div>
            <span className="hq-section-kicker">Now</span>
            <h3>Active Alerts ({apiActive.length})</h3>
          </div>
          {apiActive.length > 0 ? <span className="hq-pill warn">operator attention</span> : null}
        </div>
        {apiActive.length > 0 ? (
          <div className="hq-alert-priority-grid">
            {apiActive.map((a) => (
              <div key={a.id} className={'hq-card hq-alert-card hq-card-severity ' + a.severity}>
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
          </div>
        ) : (
          <div className="hq-empty hq-empty-ornate">
            No active alert rules are firing. The live feed below will wake this rail when cost,
            stale-session or failure thresholds trip.
          </div>
        )}
      </section>

      <div className="hq-two-column hq-alerts-columns">
        <section>
          <div className="hq-section-head compact">
            <div>
              <span className="hq-section-kicker">Signal stream</span>
              <h3>Live Alert Feed</h3>
            </div>
            <span className="hq-mono hq-row-subtle">last {liveAlerts.length}</span>
          </div>
          {liveAlerts.length === 0 ? (
            <div className="hq-empty hq-pad-md">
              No live alerts. Alerts fire when fleet rules trigger.
            </div>
          ) : (
            <div className="hq-card hq-alert-feed-card">
              {liveAlerts.map((a) => (
                <div key={a.timestamp} className="hq-row hq-alert-feed-row">
                  <span className={'hq-pill ' + a.severity}>{a.severity}</span>
                  <span className="hq-text-muted">{a.message}</span>
                  <span className="hq-mono hq-ml-auto hq-text-dim">
                    {new Date(a.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="hq-section-head compact">
            <div>
              <span className="hq-section-kicker">Archive</span>
              <h3>Alert History</h3>
            </div>
            <span className="hq-mono hq-row-subtle">{apiHistory.length} total</span>
          </div>
          <div className="hq-card hq-alert-history-card">
            {apiHistory.length === 0 ? (
              <div className="hq-empty hq-pad-md">No historical alerts.</div>
            ) : (
              apiHistory
                .slice(-30)
                .reverse()
                .map((a) => (
                  <div key={a.id} className="hq-row hq-alert-history-row">
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
        </section>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'warn' | 'error';
}): React.ReactElement {
  return (
    <div className="hq-hero-metric" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
