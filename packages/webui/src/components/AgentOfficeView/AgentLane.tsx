import { Activity, Check, Clock3, Code2, ListTodo, Mail } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { fmtCost, fmtTok } from '@/lib/agent-status';
import { cn } from '@/lib/utils';
import { useOfficeMapStore } from '@/stores';
import type { SelectedAction } from '../AgentOfficeDetails.js';
import {
  agentVisualRole,
  deskPersonality,
  deskWaitState,
  type OfficeAgentModel,
  relativeTime,
  shortModelName,
} from './model.js';
import { AgentAvatar, EmptyParcel, MailParcel, ToolGlyph, ToolParcel } from './parcels.js';

export function AgentLane({
  model,
  now,
  onSelect,
  routedMailIds,
}: {
  model: OfficeAgentModel;
  now: number;
  onSelect: (selected: SelectedAction) => void;
  /** Mail ids animated by the desk-to-desk route overlay — skip the local flyby. */
  routedMailIds?: ReadonlySet<string> | undefined;
}) {
  const { t } = useAppTranslation();
  const waitThresholdMs = useOfficeMapStore((s) => s.waitThresholdMs);
  const { agent, client, current, display, history, mail } = model;
  const active = agent.status === 'active' || agent.status === 'streaming';
  const failed = agent.status === 'error';
  const latestMail = mail[0];
  const visualRole = agentVisualRole(agent);
  const desk = deskPersonality(`${client.sessionId}:${agent.serverId}:${agent.name}`, visualRole);
  const wait = deskWaitState(model, now, waitThresholdMs);
  // The badge is only interactive when something backs its claim: a
  // resolvable pending mail, or a reported task to open.
  const waitActionable =
    wait.reason === 'mail-reply'
      ? mail.some((item) => item.id === wait.anchorId)
      : Boolean(agent.currentTask);
  const waitIdleLabel = Number.isFinite(wait.idleMs) ? relativeTime(now - wait.idleMs, now) : '—';
  const waitTitle = wait.waiting
    ? wait.reason === 'mail-reply'
      ? t('activity:agentOffice.waitingForReply', {
          subject: wait.anchor || t('activity:agentOffice.waitingMailFallback'),
          duration: waitIdleLabel,
        })
      : wait.reason === 'telemetry'
        ? t('activity:agentOffice.waitingTelemetry')
        : t('activity:agentOffice.waitingNoWork', {
            duration: waitIdleLabel,
            last: wait.anchor || t('activity:agentOffice.waitingNothingYet'),
          })
    : undefined;
  // `buildMailRoutes` only emits desk↔desk routes today; revisit this gate if
  // lounge agents ever get lanes of their own. A mail the wait badge already
  // represents (anchorId) is not double-animated either.
  const latestMailIsFresh =
    latestMail &&
    now - latestMail.timestampMs < 30_000 &&
    !routedMailIds?.has(latestMail.id) &&
    wait.anchorId !== latestMail.id;
  const recentWork = history.slice(0, 6);
  const latestActivityAt =
    recentWork[0]?.completedAt ??
    recentWork[0]?.startedAt ??
    display?.completedAt ??
    display?.startedAt;
  const activeToolClass = current ? `is-tool-${current.kind}` : undefined;
  // The one-liner the metrics strip carries: what this desk is doing *right
  // now* — the running call, or the freshest completed action. Falls back to
  // the wait/waiting labels when there is nothing to show.
  const actionLine = current
    ? current.summary
    : display
      ? display.summary
      : wait.waiting
        ? (waitTitle ?? t('activity:agentOffice.waiting'))
        : active
          ? t('activity:agentOffice.preparing')
          : t('activity:agentOffice.waiting');

  return (
    <article
      className={cn(
        'agent-office__lane',
        `is-desk-${desk.palette}`,
        `is-layout-${desk.layout}`,
        `is-clutter-${desk.clutter}`,
        active && 'is-active',
        failed && 'is-failed',
        wait.waiting && 'is-waiting',
      )}
    >
      <div className="agent-office__identity">
        <div className="agent-office__identity-line">
          <span
            className={cn('agent-office__status-dot', active && 'is-active', failed && 'is-failed')}
          />
          <strong title={agent.name}>{agent.name}</strong>
          <span
            className="agent-office__agent-verified"
            title={
              agent.presenceSource === 'registry'
                ? 'Verified by live session registry'
                : 'Verified by local fleet state'
            }
          >
            <Check aria-hidden="true" />
            {agent.presenceSource === 'registry' ? 'LIVE' : 'LOCAL'}
          </span>
        </div>
        {wait.waiting && waitActionable && (
          <button
            type="button"
            className={cn('agent-office__wait-badge', `is-${wait.reason}`)}
            title={waitTitle}
            aria-label={waitTitle}
            onClick={() => {
              // Route the click to what actually backs the claim: the pending
              // mail for mail-reply, the task for the rest. An empty task
              // detail would be worse than doing nothing.
              if (wait.reason === 'mail-reply') {
                const pending = mail.find((item) => item.id === wait.anchorId);
                if (pending) onSelect({ kind: 'mail', mail: pending, agentName: agent.name });
                return;
              }
              // waitActionable already guarantees a task is reported; this
              // guard just narrows `currentTask` for TS inside the closure.
              if (!agent.currentTask) return;
              onSelect({
                kind: 'task',
                task: agent.currentTask,
                taskId: agent.taskId,
                agentName: agent.name,
              });
            }}
          >
            <Clock3 aria-hidden="true" />
            <span>{waitIdleLabel}</span>
          </button>
        )}
        {wait.waiting && !waitActionable && (
          // No anchor to open (no task, no resolvable mail) — render as pure
          // status so keyboard/screen-reader users aren't offered a dead button.
          <span
            role="status"
            className={cn('agent-office__wait-badge', `is-${wait.reason}`)}
            title={waitTitle}
            aria-label={waitTitle}
          >
            <Clock3 aria-hidden="true" />
            <span>{waitIdleLabel}</span>
          </span>
        )}
        <span className="agent-office__role">
          {agent.role ??
            (agent.serverId === 'leader' || agent.serverId.startsWith('leader@')
              ? t('activity:agentOffice.leadAgent')
              : t('activity:agentOffice.agent'))}
        </span>
        <div className="agent-office__agent-meta">
          <span>{client.branch ? `⎇ ${client.branch}` : client.type.toUpperCase()}</span>
          <span>{t('activity:agentOffice.callsCount', { count: agent.toolCalls })}</span>
          {agent.model && (
            <span className="agent-office__model-chip" title={agent.model}>
              {shortModelName(agent.model)}
            </span>
          )}
        </div>
        {agent.currentTask && (
          <button
            type="button"
            className="agent-office__agent-task"
            onClick={() =>
              onSelect({
                kind: 'task',
                task: agent.currentTask ?? '',
                taskId: agent.taskId,
                agentName: agent.name,
              })
            }
          >
            <ListTodo aria-hidden="true" />
            <span>
              <strong>{t('activity:agentOffice.currentTask')}</strong>
              <small>{agent.currentTask}</small>
            </span>
          </button>
        )}
        {!agent.currentTask && active && (
          <div className="agent-office__agent-task is-missing">
            <Activity aria-hidden="true" />
            <span>
              <strong>{t('activity:agentOffice.currentTask')}</strong>
              <small>
                {client.todos === undefined
                  ? t('activity:agentOffice.telemetryWaiting')
                  : t('activity:agentOffice.taskNotReported')}
              </small>
            </span>
          </div>
        )}
        {latestMail && (
          <button
            type="button"
            className={cn('agent-office__identity-mail', latestMail.unread && 'is-unread')}
            onClick={() => onSelect({ kind: 'mail', mail: latestMail, agentName: agent.name })}
            aria-label={`${mail.length} mail messages. Latest: ${latestMail.subject}`}
          >
            <Mail aria-hidden="true" />
            <span>
              <strong>{mail.length} MAIL</strong>
              <small>{latestMail.subject}</small>
            </span>
          </button>
        )}
      </div>

      <div className={cn('agent-office__scene', activeToolClass)}>
        <div className="agent-office__window" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="agent-office__plant" aria-hidden="true">
          <span />
          <i />
          <b />
        </div>
        <div className="agent-office__desk-zone" aria-hidden="true">
          <AgentAvatar
            active={active}
            failed={failed}
            role={visualRole}
            variant={desk.avatar}
            motion={desk.motion}
          />
          <span className="agent-office__monitor">
            {display ? <ToolGlyph kind={display.kind} active={current !== undefined} /> : <Code2 />}
          </span>
          <span className="agent-office__activity-fx">
            <span />
            <i />
            <b />
          </span>
          <span className="agent-office__desk" />
          <span className="agent-office__desk-lamp" />
          <span className="agent-office__desk-clutter">
            <i />
            <b />
          </span>
          <span className={cn('agent-office__desk-charm', `is-${desk.charm}`)}>
            <i />
            <b />
          </span>
          <span className={cn('agent-office__mug', `is-${visualRole}`)}>
            <i aria-hidden="true" />
            <b aria-hidden="true" />
          </span>
        </div>

        {latestMailIsFresh && (
          <div className={cn('agent-office__mail-flyby', `is-${latestMail.direction}`)}>
            <MailParcel
              key={latestMail.id}
              mail={latestMail}
              compact
              onSelect={() => onSelect({ kind: 'mail', mail: latestMail, agentName: agent.name })}
            />
          </div>
        )}

        <div className={cn('agent-office__conveyor', current && 'is-moving')}>
          <div className="agent-office__belt" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="agent-office__current-action">
            {display ? (
              <ToolParcel
                key={display.id}
                call={display}
                onSelect={() => onSelect({ kind: 'tool', call: display, agentName: agent.name })}
              />
            ) : (
              <EmptyParcel active={active} />
            )}
          </div>
        </div>
      </div>

      <div className="agent-office__history">
        <div className="agent-office__history-heading">
          <span>{t('activity:agentOffice.recent')}</span>
          {latestActivityAt !== undefined && <span>{relativeTime(latestActivityAt, now)}</span>}
        </div>
        <div className="agent-office__history-list">
          {recentWork.length > 0 ? (
            recentWork.map((call) => (
              <ToolParcel
                key={`tool:${call.id}`}
                call={call}
                compact
                onSelect={() => onSelect({ kind: 'tool', call, agentName: agent.name })}
              />
            ))
          ) : (
            <span className="agent-office__history-empty">
              {agent.toolCalls > 0 &&
              agent.recentTools === undefined &&
              agent.activity === undefined
                ? t('activity:agentOffice.telemetryReconnect')
                : t('activity:agentOffice.noCalls')}
            </span>
          )}
        </div>
      </div>

      <div className="agent-office__desk-metrics">
        <span
          className="agent-office__metric"
          title={`${t('activity:agentOffice.tokens')}: in ${fmtTok(agent.tokensIn)} / out ${fmtTok(agent.tokensOut)}`}
        >
          <strong>{fmtTok(agent.tokensIn + agent.tokensOut)}</strong>
          <small>TOK</small>
        </span>
        <span className="agent-office__metric" title={t('activity:agentOffice.cost')}>
          <strong>{fmtCost(agent.costUsd)}</strong>
          <small>COST</small>
        </span>
        <span className="agent-office__metric" title={t('activity:agentOffice.contextUsed')}>
          <strong>{agent.ctxPct !== undefined ? `${Math.round(agent.ctxPct)}%` : '—'}</strong>
          <small>CTX</small>
          {agent.ctxPct !== undefined && (
            <i className={cn('agent-office__ctx-bar', agent.ctxPct >= 80 && 'is-high')}>
              <b style={{ width: `${Math.min(100, Math.max(0, agent.ctxPct))}%` }} />
            </i>
          )}
        </span>
        <span className="agent-office__metric agent-office__metric-action" title={actionLine}>
          <Activity aria-hidden="true" />
          <small>{actionLine}</small>
        </span>
      </div>
    </article>
  );
}
