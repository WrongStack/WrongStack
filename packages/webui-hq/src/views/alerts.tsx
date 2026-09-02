/**
 * Attention — the operator's single queue.
 *
 * Five independent sources of "someone needs to look at this" are resolved
 * into one prioritized rail: firing alert rules, agents blocked on a human,
 * degraded governance, failed commands and lost clients. Each card is a jump
 * to the surface that can actually resolve it — a count you cannot act on is
 * just anxiety.
 */
import type { HqAlert } from '@wrongstack/core/hq';
import { Bot, CircleAlert, Gauge, RadioTower, ServerOff, ShieldCheck } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { EmptyState, Mono } from '../components/hq/primitives.js';
import { HeroMetric, Section, ViewHero, ViewShell } from '../components/hq/view-chrome.js';
import { Badge, type BadgeTone } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { fetchJson } from '../data/api.js';
import { type HqViewId, useHqStore } from '../data/store/index.js';
import { cn } from '../lib/utils.js';
import { formatClock } from '../lib/format.js';

/** Alert history is polled, not pushed — 15s is well inside a rule's cadence. */
const ALERTS_POLL_MS = 15_000;
const LIVE_FEED_LIMIT = 50;
const HISTORY_LIMIT = 30;

interface AlertsApiResponse {
  active: HqAlert[];
  history: HqAlert[];
}

const SEVERITY_TONE: Record<string, BadgeTone> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
};

function severityTone(severity: string): BadgeTone {
  return SEVERITY_TONE[severity] ?? 'idle';
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
  view?: HqViewId;
}): React.ReactElement {
  return (
    <Card
      data-testid="attention-card"
      data-tone={tone}
      className={cn(
        'flex-row items-center gap-3 p-3',
        tone === 'error' ? 'border-l-2 border-l-destructive' : 'border-l-2 border-l-warning',
      )}
    >
      <Icon
        className={cn('size-5 shrink-0', tone === 'error' ? 'text-destructive' : 'text-warning')}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">{label}</div>
        <div className="tabular font-display text-xl leading-none">{value}</div>
        <div className="truncate text-[11px] text-muted-foreground">{detail}</div>
      </div>
      {view !== undefined ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => useHqStore.getState().setActiveView(view)}
        >
          {action}
        </Button>
      ) : (
        <span className="text-[11px] text-muted-foreground">{action}</span>
      )}
    </Card>
  );
}

export function AlertsView(): React.ReactElement {
  const { alerts, snapshot, commandStatuses } = useHqStore(
    useShallow((state) => ({
      alerts: state.alerts,
      snapshot: state.snapshot,
      commandStatuses: state.commandStatuses,
    })),
  );
  const [active, setActive] = useState<HqAlert[]>([]);
  const [history, setHistory] = useState<HqAlert[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      fetchJson<AlertsApiResponse>('/api/alerts')
        .then((data) => {
          if (cancelled) return;
          setActive(data.active);
          setHistory(data.history);
        })
        .catch(() => {
          // Best-effort: the live WS feed below is the primary signal.
        });
    };
    load();
    const timer = window.setInterval(load, ALERTS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const liveAlerts = alerts.slice(-LIVE_FEED_LIMIT).reverse();
  const errorCount = active.filter((alert) => alert.severity === 'error').length;
  const warningCount = active.filter((alert) => alert.severity === 'warn').length;

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

  const needsAction =
    active.length +
    governanceWarnings.length +
    waitingAgents.length +
    failedCommands.length +
    disconnectedClients.length;

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Operator attention center"
        headline={needsAction === 0 ? 'Fleet quiet' : 'Fleet requires review'}
        description="Alerts, waiting agents, governance warnings, failed commands and lost clients, resolved into one queue."
        tone={needsAction === 0 ? 'active' : errorCount > 0 ? 'error' : 'warn'}
        metrics={
          <>
            <HeroMetric
              label="needs action"
              value={needsAction}
              tone={needsAction > 0 ? 'warn' : 'active'}
            />
            <HeroMetric
              label="waiting agents"
              value={waitingAgents.length}
              tone={waitingAgents.length > 0 ? 'warn' : 'active'}
            />
            <HeroMetric
              label="governance"
              value={governanceWarnings.length}
              tone={governanceWarnings.length > 0 ? 'error' : 'active'}
            />
            <HeroMetric
              label="failed commands"
              value={failedCommands.length}
              tone={failedCommands.length > 0 ? 'error' : 'active'}
            />
          </>
        }
      />

      <Section
        eyebrow="Priority queue"
        title="Cross-system signals"
        action={
          <Badge tone={needsAction > 0 ? 'warn' : 'active'}>
            {needsAction > 0 ? `${needsAction} need review` : 'all clear'}
          </Badge>
        }
      >
        {needsAction === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="Nothing needs operator action"
            hint="This rail wakes when an agent blocks, a rule fires, a command fails or a client drops."
          />
        ) : (
          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
            {waitingAgents.length > 0 && (
              <AttentionCard
                icon={Bot}
                tone="warn"
                label="Agent attention"
                value={waitingAgents.length}
                detail={`${waitingAgents[0]?.agent.name ?? waitingAgents[0]?.agent.id ?? 'Agent'} · ${waitingAgents[0]?.agent.status}`}
                action="Open console"
                view="console"
              />
            )}
            {governanceWarnings.length > 0 && (
              <AttentionCard
                icon={Gauge}
                tone="error"
                label="Governance advisory"
                value={governanceWarnings.length}
                detail={`${governanceWarnings[0]?.projectName ?? 'Project'} · ${governanceWarnings[0]?.governance?.signal.code ?? 'warning'}`}
                action="Open fleet"
                view="fleet"
              />
            )}
            {failedCommands.length > 0 && (
              <AttentionCard
                icon={RadioTower}
                tone="error"
                label="Command failures"
                value={failedCommands.length}
                detail={`${failedCommands[0]?.type ?? 'command'} · ${failedCommands[0]?.ackStatus ?? 'failed'}`}
                action="Open audit"
                view="control"
              />
            )}
            {disconnectedClients.length > 0 && (
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
            )}
            {active.length > 0 && (
              <AttentionCard
                icon={CircleAlert}
                tone={errorCount > 0 ? 'error' : 'warn'}
                label="Active alert rules"
                value={active.length}
                detail={`${errorCount} errors · ${warningCount} warnings`}
                action="Review below"
              />
            )}
          </div>
        )}
      </Section>

      <Section
        eyebrow="Now"
        title={`Active alerts (${active.length})`}
        action={active.length > 0 && <Badge tone="warn">operator attention</Badge>}
      >
        {active.length === 0 ? (
          <EmptyState
            title="No alert rules are firing"
            hint="The live feed below wakes this rail when cost, stale-session or failure thresholds trip."
          />
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {active.map((alert) => (
              <Card
                key={alert.id}
                data-testid="active-alert"
                className={cn(
                  'border-l-2',
                  alert.severity === 'error' ? 'border-l-destructive' : 'border-l-warning',
                )}
              >
                <CardContent className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
                    <span className="text-xs font-medium">{alert.ruleId}</span>
                    <Mono className="tabular ml-auto">since {formatClock(alert.firstFiredAt)}</Mono>
                  </div>
                  <p className="text-xs text-muted-foreground">{alert.message}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-5 2xl:grid-cols-2">
        <Section
          eyebrow="Signal stream"
          title="Live alert feed"
          action={<Mono>last {liveAlerts.length}</Mono>}
        >
          {liveAlerts.length === 0 ? (
            <EmptyState title="No live alerts" hint="Alerts arrive here as fleet rules trigger." />
          ) : (
            <Card className="divide-y divide-border">
              {liveAlerts.map((alert) => (
                <div
                  key={`${alert.timestamp}-${alert.message}`}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {alert.message}
                  </span>
                  <Mono className="tabular">{formatClock(alert.timestamp)}</Mono>
                </div>
              ))}
            </Card>
          )}
        </Section>

        <Section
          eyebrow="Archive"
          title="Alert history"
          action={<Mono>{history.length} total</Mono>}
        >
          {history.length === 0 ? (
            <EmptyState title="No historical alerts" />
          ) : (
            <Card className="divide-y divide-border">
              {history
                .slice(-HISTORY_LIMIT)
                .reverse()
                .map((alert) => (
                  <div key={alert.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
                    <Mono>{alert.ruleId}</Mono>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {alert.message}
                    </span>
                    <Mono className="tabular">{formatClock(alert.lastFiredAt)}</Mono>
                  </div>
                ))}
            </Card>
          )}
        </Section>
      </div>
    </ViewShell>
  );
}
