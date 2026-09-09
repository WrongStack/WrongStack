import { Bot, CircleAlert, Gauge, RadioTower, ServerOff, ShieldCheck } from 'lucide-react';
import type * as React from 'react';
import { EmptyState } from '../components/hq/primitives.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { useHqStore } from '../data/store/index.js';

export interface MobileAttentionProps {
  onOpenConsole: (sessionId: string, agentId: string) => void;
  onOpenInbox: () => void;
  notificationPermission: NotificationPermission | 'unsupported';
  onEnableNotifications: () => void;
}

function SignalCard({
  icon: Icon,
  title,
  detail,
  tone = 'warn',
  action,
}: {
  icon: typeof Bot;
  title: string;
  detail: string;
  tone?: 'warn' | 'error';
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <article className="flex items-center gap-3 border border-border bg-card p-3">
      <Icon className={tone === 'error' ? 'size-5 text-destructive' : 'size-5 text-warning'} />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="truncate text-[11px] text-muted-foreground">{detail}</p>
      </div>
      {action}
    </article>
  );
}

function NotificationControl({
  permission,
  onEnable,
}: {
  permission: NotificationPermission | 'unsupported';
  onEnable: () => void;
}): React.ReactElement {
  if (permission === 'granted') return <Badge tone="active">alerts on</Badge>;
  if (permission === 'default') {
    return (
      <Button size="sm" variant="outline" onClick={onEnable}>
        Enable alerts
      </Button>
    );
  }
  return (
    <Badge tone="idle">{permission === 'denied' ? 'alerts blocked' : 'alerts unsupported'}</Badge>
  );
}

export function MobileAttention({
  onOpenConsole,
  onOpenInbox,
  notificationPermission,
  onEnableNotifications,
}: MobileAttentionProps): React.ReactElement {
  const snapshot = useHqStore((state) => state.snapshot);
  const alerts = useHqStore((state) => state.alerts);
  const commands = useHqStore((state) => state.commandStatuses);
  const waitingAgents = (snapshot?.liveSessions ?? []).flatMap((session) =>
    session.agents
      .filter((agent) => agent.status === 'waiting_user' || agent.status === 'error')
      .map((agent) => ({ session, agent })),
  );
  const governance = (snapshot?.projects ?? []).filter(
    (project) =>
      project.governance?.signal.level === 'warning' ||
      project.governance?.signal.level === 'unavailable',
  );
  const failedCommands = commands.filter(
    (command) => command.ackStatus === 'failed' || command.ackStatus === 'rejected',
  );
  const disconnected = (snapshot?.clients ?? []).filter((client) => !client.connected);
  const activeAlerts = alerts.filter((alert) => alert.severity !== 'info');
  const unread = snapshot?.totals.unreadMailboxMessages ?? 0;
  const total =
    waitingAgents.length +
    governance.length +
    failedCommands.length +
    disconnected.length +
    activeAlerts.length +
    Number(unread > 0);

  if (total === 0) {
    return (
      <section data-testid="mobile-attention" className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-3 flex justify-end">
          <NotificationControl
            permission={notificationPermission}
            onEnable={onEnableNotifications}
          />
        </div>
        <EmptyState
          icon={ShieldCheck}
          title="Fleet quiet"
          hint="Waiting agents, failed commands, alerts and unread mail will appear here."
        />
      </section>
    );
  }

  return (
    <section data-testid="mobile-attention" className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <div>
          <h2 className="font-display text-base font-semibold">Needs attention</h2>
          <p className="text-[11px] text-muted-foreground">{total} active signal groups</p>
        </div>
        <Badge tone="warn" className="ml-auto">
          {total}
        </Badge>
        <NotificationControl permission={notificationPermission} onEnable={onEnableNotifications} />
      </div>
      <div className="space-y-2">
        {waitingAgents.map(({ session, agent }) => (
          <SignalCard
            key={`${session.sessionId}:${agent.id}`}
            icon={Bot}
            title={`${agent.name ?? agent.id} · ${agent.status}`}
            detail={`${session.projectName} · ${session.hostname ?? session.machineId}`}
            tone={agent.status === 'error' ? 'error' : 'warn'}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenConsole(session.sessionId, agent.id)}
              >
                Open
              </Button>
            }
          />
        ))}
        {unread > 0 && (
          <SignalCard
            icon={CircleAlert}
            title={`${unread} unread mailbox message${unread === 1 ? '' : 's'}`}
            detail="Coordination work is waiting"
            action={
              <Button size="sm" variant="outline" onClick={onOpenInbox}>
                Inbox
              </Button>
            }
          />
        )}
        {activeAlerts.map((alert) => (
          <SignalCard
            key={`${alert.timestamp}:${alert.message}`}
            icon={CircleAlert}
            title={alert.severity === 'error' ? 'Critical alert' : 'Warning'}
            detail={alert.message}
            tone={alert.severity === 'error' ? 'error' : 'warn'}
          />
        ))}
        {governance.map((project) => (
          <SignalCard
            key={project.projectId}
            icon={Gauge}
            title="Governance advisory"
            detail={`${project.projectName} · ${project.governance?.signal.code ?? 'unavailable'}`}
            tone="error"
          />
        ))}
        {failedCommands.map((command) => (
          <SignalCard
            key={command.commandId}
            icon={RadioTower}
            title={`${command.type} ${command.ackStatus}`}
            detail={command.ackMessage ?? command.commandId}
            tone="error"
          />
        ))}
        {disconnected.map((client) => (
          <SignalCard
            key={client.clientId}
            icon={ServerOff}
            title="Client disconnected"
            detail={client.hostname ?? client.clientId}
          />
        ))}
      </div>
    </section>
  );
}
