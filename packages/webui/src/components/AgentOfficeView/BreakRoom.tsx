import { Coffee, Mail } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SelectedAction } from '../AgentOfficeDetails.js';
import { AGENT_ROLE_ICONS, agentVisualRole, type OfficeAgentModel, relativeTime } from './model.js';

/** Agents with no live work gather in the break room instead of occupying a desk. */
export function isDeskAgent(model: OfficeAgentModel): boolean {
  return (
    model.agent.status === 'active' ||
    model.agent.status === 'streaming' ||
    model.agent.status === 'error'
  );
}

export function BreakRoom({
  agents,
  now,
  onSelect,
}: {
  agents: OfficeAgentModel[];
  now: number;
  onSelect: (selected: SelectedAction) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <section className="agent-office__lounge" aria-label={t('activity:agentOffice.breakRoom')}>
      <header className="agent-office__lounge-heading">
        <Coffee aria-hidden="true" />
        <strong>{t('activity:agentOffice.breakRoom')}</strong>
        <span>{t('activity:agentOffice.onBreak', { count: agents.length })}</span>
      </header>
      <div className="agent-office__lounge-seats">
        {agents.map((model) => {
          const { agent, history, mail } = model;
          const visualRole = agentVisualRole(agent);
          const RoleIcon = AGENT_ROLE_ICONS[visualRole];
          const unread = mail.filter((message) => message.unread).length;
          const latestActivityAt = history[0]?.completedAt ?? history[0]?.startedAt;
          const latestMail = mail[0];
          const openDetail = () => {
            if (agent.currentTask) {
              onSelect({
                kind: 'task',
                task: agent.currentTask,
                taskId: agent.taskId,
                agentName: agent.name,
              });
            } else if (latestMail) {
              onSelect({ kind: 'mail', mail: latestMail, agentName: agent.name });
            }
          };
          const selectable = Boolean(agent.currentTask) || Boolean(latestMail);
          return (
            <button
              type="button"
              key={model.key}
              className={cn('agent-office__lounge-seat', `is-${visualRole}`)}
              onClick={openDetail}
              disabled={!selectable}
            >
              <span className="agent-office__lounge-avatar">
                <RoleIcon aria-hidden="true" />
              </span>
              <span className="agent-office__lounge-copy">
                <strong>{agent.name}</strong>
                <small>{agent.role ?? t('activity:agentOffice.agent')}</small>
              </span>
              <span className="agent-office__lounge-meta">
                {latestActivityAt !== undefined && (
                  <span>{relativeTime(latestActivityAt, now)}</span>
                )}
                {unread > 0 && (
                  <span className="agent-office__lounge-mail">
                    <Mail aria-hidden="true" /> {unread}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
