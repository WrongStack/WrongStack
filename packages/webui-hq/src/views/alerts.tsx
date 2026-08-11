/**
 * Alerts view — live alert feed + active alerts.
 * Fed by `hq.alert` WS messages + /api/alerts history.
 */

import type { HqAlert } from '@wrongstack/core/hq';
import { Bot, CircleAlert, Gauge, RadioTower, ServerOff } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { fetchJson, useHqStore } from '../store.js';

interface AlertsApiResponse {
  active: HqAlert[];
  history: HqAlert[];
}

export function AlertsView(): React.ReactElement {
  const { alerts, snapshot, commandStatuses } = useHqStore(
    useShallow((s) => ({
      alerts: s.alerts,
      snapshot: s.snapshot,
      commandStatuses: s.commandStatuses,
    })),
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
  const errorCount = apiActive.filter((alert) => alert.severity === 'error').length;
  const warningCount = apiActive.filter((alert) => alert.severity === 'warn').length;
  const governanceWarnings = (snapshot?.projects ?? []).filter(
    (project) =>
      project.governance?.signal.level === 'warning' ||
      project.governance?.signal.level === 'unavailable',
  );
  const waitingAgents = (snapshot?.liveSessions ?? []).flatMap((session) =>
    (session.agents ?? [])
      .filter((agent) => agent.status === 'waiting_user' || agent.status === 'error')
      .map((agent) => ({ agent, session })),
  );
  const failedCommands = commandStatuses.filter(
    (command) => command.ackStatus === 'failed' || command.ackStatus === 'rejected',
  );
  const disconnectedClients = (snapshot?.clients ?? []).filter((client) => !client.connected);
  const attentionCount =
    apiActive.length +
    governanceWarnings.length +
    waitingAgents.length +
    failedCommands.length +
    disconnectedClients.length;
  const quiet = attentionCount === 0 && liveAlerts.length === 0;

  return (
    <div className="hq-screen hq-alerts-screen">
      <section className="hq-screen-hero hq-alerts-hero" aria-label="Alert command summary">
        <div>
          <span className="hq-section-kicker">Operator attention center</span>
          <h2>{quiet ? 'Fleet quiet' : 'Fleet requires review'}</h2>
          <p>
            Alerts, waiting agents, governance warnings and failed commands are resolved into one
            prioritized operator queue.
          </p>
        </div>
        <div className="hq-hero-metrics">
          <Metric
            label="needs action"
            value={attentionCount}
            tone={attentionCount > 0 ? 'warn' : 'ok'}
          />
          <Metric
            label="waiting agents"
            value={waitingAgents.length}
            tone={waitingAgents.length > 0 ? 'warn' : 'ok'}
          />
          <Metric
            label="governance"
            value={governanceWarnings.length}
            tone={governanceWarnings.length > 0 ? 'error' : 'ok'}
          />
          <Metric
            label="failed commands"
            value={failedCommands.length}
            tone={failedCommands.length > 0 ? 'error' : 'ok'}
          />
        </div>
      </section>

      <section className="hq-attention-section" aria-label="Cross-system attention signals">
        <div className="hq-section-head">
          <div>
            <span className="hq-section-kicker">Priority queue</span>
            <h3>Cross-system signals</h3>
          </div>
          <span className={'hq-pill ' + (attentionCount > 0 ? 'warn' : 'active')}>
            {attentionCount > 0 ? `${attentionCount} need review` : 'all clear'}
          </span>
        </div>
        {attentionCount === 0 ? (
          <div className="hq-empty hq-pad-md">No cross-system signals need operator action.</div>
        ) : (
          <div className="hq-attention-grid">
            {waitingAgents.length > 0 ? (
              <AttentionCard
                icon={Bot}
                tone="warn"
                label="Agent attention"
                value={waitingAgents.length}
                detail={`${waitingAgents[0]?.agent.name ?? waitingAgents[0]?.agent.id ?? 'Agent'} · ${waitingAgents[0]?.agent.status}`}
                action="Open console"
                view="console"
              />
            ) : null}
            {governanceWarnings.length > 0 ? (
              <AttentionCard
                icon={Gauge}
                tone="error"
                label="Governance advisory"
                value={governanceWarnings.length}
                detail={`${governanceWarnings[0]?.projectName ?? 'Project'} · ${governanceWarnings[0]?.governance?.signal.code ?? 'warning'}`}
                action="Open fleet"
                view="fleet"
              />
            ) : null}
            {failedCommands.length > 0 ? (
              <AttentionCard
                icon={RadioTower}
                tone="error"
                label="Command failures"
                value={failedCommands.length}
                detail={`${failedCommands[0]?.type ?? 'command'} · ${failedCommands[0]?.ackStatus ?? 'failed'}`}
                action="Open audit"
                view="control"
              />
            ) : null}
            {disconnectedClients.length > 0 ? (
              <AttentionCard
                icon={ServerOff}
                tone="warn"
                label="Disconnected clients"
                value={disconnectedClients.length}
                detail={
                  disconnectedClients[0]?.hostname ?? disconnectedClients[0]?.clientId ?? 'Client'
                }
                action="Open fleet"
                view="fleet"
              />
            ) : null}
            {apiActive.length > 0 ? (
              <AttentionCard
                icon={CircleAlert}
                tone={errorCount > 0 ? 'error' : 'warn'}
                label="Active alert rules"
                value={apiActive.length}
                detail={`${errorCount} errors · ${warningCount} warnings`}
                action="Review below"
              />
            ) : null}
          </div>
        )}
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

function AttentionCard({
  icon: Icon,
  tone,
  label,
  value,
  detail,
  action,
  view,
}: {
  icon: typeof Bot;
  tone: 'warn' | 'error';
  label: string;
  value: number;
  detail: string;
  action: string;
  view?: 'console' | 'fleet' | 'control';
}): React.ReactElement {
  return (
    <article className="hq-attention-card" data-tone={tone}>
      <span className="hq-attention-icon">
        <Icon size={17} />
      </span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
      {view !== undefined ? (
        <button type="button" onClick={() => useHqStore.getState().setActiveView(view)}>
          {action}
        </button>
      ) : (
        <span className="hq-attention-action-label">{action}</span>
      )}
    </article>
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
