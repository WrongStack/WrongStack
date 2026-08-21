import {
  Activity,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  Code2,
  Coffee,
  File,
  FilePenLine,
  FolderOpen,
  HardDrive,
  Inbox,
  ListTodo,
  Mail,
  MessageSquareText,
  Search,
  Send,
  TerminalSquare,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import { type CSSProperties, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { fmtCost, fmtTok } from '@/lib/agent-status';
import {
  buildAgentMailActivities,
  buildAgentToolCalls,
  buildMailRoutes,
  buildSnapshotMailActivities,
  buildSnapshotToolCalls,
  type OfficeMailActivity,
  type OfficeToolCall,
  type OfficeToolKind,
  synthesizeCurrentTool,
} from '@/lib/agent-office';
import { cn } from '@/lib/utils';
import {
  useFleetStore,
  useMailboxStore,
  useMonitorStore,
  useOfficeMapStore,
  useSessionStore,
  useVizStore,
} from '@/stores';
import { ActionDetail, type SelectedAction } from './AgentOfficeDetails';
import { resolveClients } from './OfficeMapCanvas/resolve.js';
import { useRecentlyFinishedFleetAgents } from './OfficeMapCanvas/use-recently-finished.js';
import './AgentOfficeView.css';

import {
  AGENT_ROLE_ICONS,
  TOOL_ICONS,
  agentVisualRole,
  clientOfficeStats,
  deskPersonality,
  deskWaitState,
  fallbackLogCalls,
  formatUptime,
  mergeCalls,
  mergeMail,
  relativeTime,
  shortModelName,
  shortPath,
  type AgentVisualRole,
  type ClientOfficeModel,
  type OfficeAgentModel,
} from './AgentOfficeView/model';
function ToolGlyph({ kind, active }: { kind: OfficeToolKind; active?: boolean }) {
  const Icon = TOOL_ICONS[kind];
  return (
    <span className={cn('agent-office__tool-glyph', `is-${kind}`, active && 'is-active')}>
      {kind === 'read' && <File className="agent-office__file-underlay" aria-hidden="true" />}
      <Icon aria-hidden="true" />
    </span>
  );
}

function AgentAvatar({
  active,
  failed,
  role,
  variant,
  motion,
}: {
  active: boolean;
  failed: boolean;
  role: AgentVisualRole;
  variant: number;
  motion: number;
}) {
  const RoleIcon = AGENT_ROLE_ICONS[role];
  return (
    <div
      className={cn(
        'agent-office__avatar',
        `is-${role}`,
        `is-avatar-${variant}`,
        `is-motion-${motion}`,
        active && 'is-active',
        !active && !failed && 'is-idle',
        failed && 'is-failed',
      )}
      aria-hidden="true"
    >
      <span className="agent-office__avatar-chair" />
      <span className="agent-office__avatar-body" />
      <span className="agent-office__avatar-head">
        <span className="agent-office__avatar-hair" />
        <span className="agent-office__avatar-face" />
        <span className="agent-office__avatar-mouth" />
        <span className="agent-office__avatar-headset" />
      </span>
      <span className="agent-office__avatar-arm" />
      <span className="agent-office__avatar-prop" />
      <span className="agent-office__avatar-role-badge">
        <RoleIcon />
      </span>
    </div>
  );
}

function ToolParcel({
  call,
  compact = false,
  onSelect,
}: {
  call: OfficeToolCall;
  compact?: boolean;
  onSelect: () => void;
}) {
  const active = call.status === 'running';
  return (
    <button
      type="button"
      className={cn(
        'agent-office__parcel',
        `is-${call.kind}`,
        compact && 'is-compact',
        active && 'is-running',
        call.status === 'failed' && 'is-failed',
      )}
      onClick={onSelect}
      aria-label={`${call.toolName}: ${call.summary}`}
    >
      <ToolGlyph kind={call.kind} active={active} />
      <span className="agent-office__parcel-copy">
        <span className="agent-office__parcel-topline">
          <strong>{call.toolName}</strong>
          {call.lineLabel && <span className="agent-office__line-chip">{call.lineLabel}</span>}
        </span>
        {!compact && call.target && (
          <span className="agent-office__parcel-target">{shortPath(call.target)}</span>
        )}
        <span className="agent-office__parcel-summary">{call.summary}</span>
      </span>
      <span className="agent-office__parcel-state" aria-hidden="true">
        {active ? (
          <span className="agent-office__pulse-dot" />
        ) : call.status === 'failed' ? (
          <X />
        ) : (
          <Check />
        )}
      </span>
    </button>
  );
}

function MailParcel({
  mail,
  compact = false,
  onSelect,
}: {
  mail: OfficeMailActivity;
  compact?: boolean;
  onSelect: () => void;
}) {
  const incoming = mail.direction === 'incoming';
  return (
    <button
      type="button"
      className={cn(
        'agent-office__mail-parcel',
        compact && 'is-compact',
        incoming ? 'is-incoming' : 'is-outgoing',
        mail.unread && 'is-unread',
      )}
      onClick={onSelect}
      aria-label={`${incoming ? 'Incoming' : 'Outgoing'} mail: ${mail.subject}`}
    >
      <span className="agent-office__mail-icon">
        {incoming ? <Inbox aria-hidden="true" /> : <Send aria-hidden="true" />}
      </span>
      <span className="agent-office__parcel-copy">
        <strong>{incoming ? `${mail.from} →` : `→ ${mail.to}`}</strong>
        <span className="agent-office__parcel-summary">{mail.subject}</span>
      </span>
      <Mail aria-hidden="true" />
    </button>
  );
}

function ClientOfficeHeader({ office, now }: { office: ClientOfficeModel; now: number }) {
  const { t } = useAppTranslation();
  const { client, agents, stats } = office;
  const heartbeatAt = client.lastHeartbeatAt ? Date.parse(client.lastHeartbeatAt) : Number.NaN;
  const heartbeatFresh = Number.isFinite(heartbeatAt) && now - heartbeatAt < 20_000;
  const heartbeatDelayed = Number.isFinite(heartbeatAt) && !heartbeatFresh;
  const registryBacked = agents.some(({ agent }) => agent.presenceSource === 'registry');
  const presenceLabel = heartbeatFresh
    ? 'VERIFIED'
    : heartbeatDelayed
      ? 'DELAYED'
      : registryBacked
        ? 'REGISTRY'
        : 'LOCAL';
  const hasToolTelemetry = agents.some(
    ({ agent }) => agent.recentTools !== undefined || agent.activity !== undefined,
  );
  const hasLegacyAgent = agents.some(
    ({ agent }) =>
      agent.toolCalls > 0 && agent.recentTools === undefined && agent.activity === undefined,
  );
  return (
    <header className="agent-office__client-header">
      <div className="agent-office__client-title">
        <span className="agent-office__client-icon">
          <Building2 aria-hidden="true" />
        </span>
        <div className="agent-office__client-copy">
          <strong>{client.label}</strong>
          <span>{client.sublabel || client.sessionId}</span>
        </div>
        <div className="agent-office__client-presence">
          <span className="agent-office__client-agent-count">
            {agents.length} {t('activity:agentOffice.agents')}
          </span>
          <span
            className={cn(
              'agent-office__presence-chip',
              !heartbeatDelayed && 'is-live',
              heartbeatDelayed && 'is-legacy',
            )}
          >
            <Wifi aria-hidden="true" /> {presenceLabel}
          </span>
          <span className="agent-office__presence-chip">
            <Clock3 aria-hidden="true" /> {formatUptime(client.startedAt, now)} UP
          </span>
          <span
            className={cn(
              'agent-office__presence-chip',
              hasLegacyAgent ? 'is-legacy' : hasToolTelemetry && 'is-telemetry',
            )}
          >
            <Activity aria-hidden="true" />
            {hasLegacyAgent ? 'RECONNECT' : hasToolTelemetry ? 'TOOLS LIVE' : 'READY'}
          </span>
        </div>
      </div>
      <fieldset className="agent-office__client-stats" aria-label={t('activity:agentOffice.sessionActivityTotals')}>
        <span title={t('activity:agentOffice.uniqueFilesTouched')}>
          <FolderOpen /> <strong>{stats.files}</strong> {t('activity:agentOffice.files')}
        </span>
        <span title={t('activity:agentOffice.fileReads')}>
          <Search /> <strong>{stats.reads}</strong> {t('activity:agentOffice.read')}
        </span>
        <span title={t('activity:agentOffice.filesWritten')}>
          <FilePenLine /> <strong>{stats.writes}</strong> {t('activity:agentOffice.write')}
        </span>
        <span title={t('activity:agentOffice.filesEdited')}>
          <FilePenLine /> <strong>{stats.edits}</strong> {t('activity:agentOffice.edit')}
        </span>
        <span className="agent-office__client-delta" title={t('activity:agentOffice.linesAddedAndRemoved')}>
          <strong>+{stats.linesAdded}</strong> / <b>−{stats.linesRemoved}</b>
        </span>
        <span title={t('activity:agentOffice.terminalCommands')}>
          <TerminalSquare /> <strong>{stats.terminalCalls}</strong> {t('activity:agentOffice.term')}
        </span>
        <span title={t('activity:agentOffice.incomingAndOutgoingMail')}>
          <Mail /> <strong>{stats.incomingMail}</strong>↓ <strong>{stats.outgoingMail}</strong>↑
        </span>
      </fieldset>
    </header>
  );
}

function OfficeBriefing({
  office,
  now,
  onSelect,
}: {
  office: ClientOfficeModel;
  now: number;
  onSelect: (selected: SelectedAction) => void;
}) {
  const { t } = useAppTranslation();
  const { client } = office;
  const telemetryConnected = client.todos !== undefined;
  const todos = client.todos ?? [];
  const activeTodos = todos.filter((todo) => todo.status !== 'completed');
  const completedCount = todos.length - activeTodos.length;
  const instructionActive = Boolean(client.activeInstruction);
  const instruction = client.activeInstruction ?? client.latestPrompt;
  const promptIsFresh = client.latestPromptAt !== undefined && now - client.latestPromptAt < 30_000;
  const openBriefing = () =>
    onSelect({
      kind: 'briefing',
      officeLabel: client.label,
      prompt: instruction,
      promptAt: client.latestPromptAt,
      instructionActive,
      telemetryConnected,
      todos,
    });

  return (
    <section
      className="agent-office__briefing"
      aria-label={t('activity:agentOffice.officeBriefing')}
    >
      <button
        type="button"
        className={cn(
          'agent-office__prompt-card',
          instructionActive && 'is-active',
          promptIsFresh && 'is-fresh',
          !telemetryConnected && 'is-waiting',
        )}
        onClick={openBriefing}
      >
        <span className="agent-office__briefing-icon is-prompt">
          <MessageSquareText aria-hidden="true" />
        </span>
        <span className="agent-office__briefing-copy">
          <span>
            {instructionActive
              ? t('activity:agentOffice.activeInstruction')
              : t('activity:agentOffice.leaderPrompt')}
          </span>
          <strong>
            {instruction ??
              (telemetryConnected
                ? t('activity:agentOffice.noPrompt')
                : t('activity:agentOffice.telemetryWaiting'))}
          </strong>
        </span>
        {instructionActive && (
          <span className="agent-office__instruction-live">
            <i aria-hidden="true" /> {t('activity:agentOffice.live')}
          </span>
        )}
        {client.latestPromptAt !== undefined && (
          <time dateTime={new Date(client.latestPromptAt).toISOString()}>
            {relativeTime(client.latestPromptAt, now)}
          </time>
        )}
      </button>

      <button
        type="button"
        className={cn(
          'agent-office__todo-board',
          activeTodos.length > 0 && 'has-active',
          !telemetryConnected && 'is-waiting',
        )}
        onClick={openBriefing}
      >
        <span className="agent-office__todo-heading">
          <span>
            <ListTodo aria-hidden="true" /> {t('activity:agentOffice.activeTodos')}
          </span>
          <strong>
            {telemetryConnected
              ? t('activity:agentOffice.todoProgress', {
                  done: completedCount,
                  total: todos.length,
                })
              : t('activity:agentOffice.syncWaiting')}
          </strong>
        </span>
        <span className="agent-office__todo-preview">
          {!telemetryConnected ? (
            <span className="agent-office__todo-empty is-waiting">
              <Activity aria-hidden="true" />
              {t('activity:agentOffice.todoTelemetryWaiting')}
            </span>
          ) : activeTodos.length > 0 ? (
            activeTodos.slice(0, 3).map((todo) => (
              <span className={cn('agent-office__todo-line', `is-${todo.status}`)} key={todo.id}>
                <i aria-hidden="true" />
                <span>{todo.activeForm || todo.content}</span>
              </span>
            ))
          ) : (
            <span className="agent-office__todo-empty">
              <CheckCircle2 aria-hidden="true" />
              {todos.length > 0
                ? t('activity:agentOffice.allTodosDone')
                : t('activity:agentOffice.noActiveTodos')}
            </span>
          )}
          {activeTodos.length > 3 && (
            <span className="agent-office__todo-more">
              {t('activity:agentOffice.moreTodos', { count: activeTodos.length - 3 })}
            </span>
          )}
        </span>
      </button>
    </section>
  );
}

function EmptyParcel({ active }: { active: boolean }) {
  const { t } = useAppTranslation();
  return (
    <div className="agent-office__parcel agent-office__parcel--empty">
      <span className="agent-office__tool-glyph">
        <Bot aria-hidden="true" />
      </span>
      <span className="agent-office__parcel-copy">
        <strong>
          {active ? t('activity:agentOffice.thinking') : t('activity:agentOffice.waiting')}
        </strong>
        <span>
          {active ? t('activity:agentOffice.preparing') : t('activity:agentOffice.deskReady')}
        </span>
      </span>
    </div>
  );
}

/** Exported for tests: render a single desk lane with fixture models. */
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
        <span
          className="agent-office__metric"
          title={t('activity:agentOffice.contextUsed')}
        >
          <strong>{agent.ctxPct !== undefined ? `${Math.round(agent.ctxPct)}%` : '—'}</strong>
          <small>CTX</small>
          {agent.ctxPct !== undefined && (
            <i
              className={cn(
                'agent-office__ctx-bar',
                agent.ctxPct >= 80 && 'is-high',
              )}
            >
              <b style={{ width: `${Math.min(100, Math.max(0, agent.ctxPct))}%` }} />
            </i>
          )}
        </span>
        <span
          className="agent-office__metric agent-office__metric-action"
          title={actionLine}
        >
          <Activity aria-hidden="true" />
          <small>{actionLine}</small>
        </span>
      </div>
    </article>
  );
}

/** Agents with no live work gather in the break room instead of occupying a desk. */
function isDeskAgent(model: OfficeAgentModel): boolean {
  return (
    model.agent.status === 'active' ||
    model.agent.status === 'streaming' ||
    model.agent.status === 'error'
  );
}

function BreakRoom({
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
    <section
      className="agent-office__lounge"
      aria-label={t('activity:agentOffice.breakRoom')}
    >
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

export function AgentOfficeView() {
  const { t } = useAppTranslation();
  const liveSessions = useMonitorStore((state) => state.liveSessions);
  const aggregate = useMonitorStore((state) => state.aggregate);
  const fleetAgents = useFleetStore((state) => state.agents);
  const mailboxAgents = useMailboxStore((state) => state.agents);
  const mailboxMessages = useMailboxStore((state) => state.messages);
  const toolEvents = useVizStore((state) => state.toolEvents);
  const projectNameFromSession = useSessionStore((state) => state.projectName);
  const recentlyFinished = useRecentlyFinishedFleetAgents(fleetAgents);
  const [selected, setSelected] = useState<SelectedAction | null>(null);

  const clients = useMemo(
    () =>
      resolveClients(
        liveSessions,
        fleetAgents,
        mailboxAgents,
        recentlyFinished.map,
        recentlyFinished.now,
      ),
    [liveSessions, fleetAgents, mailboxAgents, recentlyFinished],
  );

  const models = useMemo<OfficeAgentModel[]>(
    () =>
      clients.flatMap((client) =>
        client.agents.map((agent) => {
          const richCalls = buildAgentToolCalls(toolEvents, agent.serverId, client.sessionId);
          const snapshotCalls = buildSnapshotToolCalls(
            agent.recentTools,
            agent.serverId,
            client.sessionId,
          );
          const logs = fleetAgents.get(agent.serverId)?.toolLog ?? [];
          const calls = mergeCalls(richCalls, snapshotCalls, fallbackLogCalls(agent, client, logs));
          const isActive = agent.status === 'active' || agent.status === 'streaming';
          let current = calls.find((call) => call.status === 'running');
          if (!current && isActive && agent.currentTool) {
            current = synthesizeCurrentTool(agent.serverId, agent.currentTool, client.sessionId);
          }
          const display = current ?? calls[0];
          const history = calls.filter((call) => call.status !== 'running').slice(0, 6);
          const mail = mergeMail(
            buildSnapshotMailActivities(agent.recentMail),
            buildAgentMailActivities(mailboxMessages, agent, client.sessionId),
          );
          return {
            key: agent.officeId,
            client,
            agent,
            calls,
            current,
            display,
            history,
            mail,
          };
        }),
      ),
    [clients, fleetAgents, mailboxMessages, toolEvents],
  );

  const offices = useMemo<ClientOfficeModel[]>(
    () =>
      clients
        .map((client) => {
          const agents = models.filter((model) => model.client.id === client.id);
          return { client, agents, stats: clientOfficeStats(agents) };
        })
        .filter((office) => office.agents.length > 0),
    [clients, models],
  );

  const activeCount = models.filter(
    ({ agent }) => agent.status === 'active' || agent.status === 'streaming',
  ).length;
  const projectName =
    projectNameFromSession ||
    liveSessions.find((candidate) => candidate.projectName)?.projectName ||
    t('activity:office.fleetHq');
  const now = Date.now();

  return (
    <div className="agent-office">
      <header className="agent-office__header">
        <div className="agent-office__title">
          <span className="agent-office__brand-mark">
            <Building2 aria-hidden="true" />
          </span>
          <div>
            <span>{t('activity:agentOffice.liveProjectOffice')}</span>
            <h1>{projectName}</h1>
          </div>
        </div>

        <div className="agent-office__live-pill">
          <span /> {t('activity:agentOffice.live')}
        </div>

        <div className="agent-office__summary">
          <div>
            <Bot />
            <strong>{models.length}</strong>
            <span>{t('activity:agentOffice.agents')}</span>
          </div>
          <div>
            <Zap />
            <strong>{activeCount}</strong>
            <span>{t('activity:agentOffice.working')}</span>
          </div>
          <div>
            <Activity />
            <strong>{aggregate.toolCalls.toLocaleString()}</strong>
            <span>{t('activity:agentOffice.toolCalls')}</span>
          </div>
        </div>
      </header>

      <main className="agent-office__floor">
        {models.length > 0 ? (
          offices.map((office) => {
            const deskAgents = office.agents.filter(isDeskAgent);
            const loungeAgents = office.agents.filter((model) => !isDeskAgent(model));
            const mailRoutes = buildMailRoutes(deskAgents, now);
            const routedMailIds = new Set(mailRoutes.map((route) => route.id));
            return (
              <section className="agent-office__client-office" key={office.client.id}>
                <ClientOfficeHeader office={office} now={now} />
                <OfficeBriefing office={office} now={now} onSelect={setSelected} />
                {deskAgents.length > 0 && (
                  <div className="agent-office__column-headings" aria-hidden="true">
                    <span>{t('activity:agentOffice.team')}</span>
                    <span>{t('activity:agentOffice.liveDesk')}</span>
                    <span>{t('activity:agentOffice.lastActions')}</span>
                  </div>
                )}
                <div className="agent-office__client-desks">
                  {deskAgents.map((model) => (
                    <AgentLane
                      key={model.key}
                      model={model}
                      now={now}
                      onSelect={setSelected}
                      routedMailIds={routedMailIds}
                    />
                  ))}
                  {mailRoutes.length > 0 && (
                    <div className="agent-office__mail-routes" aria-hidden="true">
                      {mailRoutes.map((route) => (
                        <div
                          key={route.id}
                          className="agent-office__mail-route"
                          style={
                            {
                              '--from': `${((route.fromIndex + 0.5) / deskAgents.length) * 100}%`,
                              '--to': `${((route.toIndex + 0.5) / deskAgents.length) * 100}%`,
                            } as CSSProperties
                          }
                        >
                          <span className="agent-office__mail-route-parcel">
                            <Mail aria-hidden="true" />
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {deskAgents.length === 0 && (
                    <div className="agent-office__desks-empty">
                      <Coffee aria-hidden="true" />
                      {t('activity:agentOffice.desksEmpty')}
                    </div>
                  )}
                </div>
                {loungeAgents.length > 0 && (
                  <BreakRoom agents={loungeAgents} now={now} onSelect={setSelected} />
                )}
              </section>
            );
          })
        ) : (
          <div className="agent-office__empty-state">
            <span>
              <Wifi aria-hidden="true" />
            </span>
            <h2>{t('activity:agentOffice.readyTitle')}</h2>
            <p>{t('activity:agentOffice.readyBody')}</p>
          </div>
        )}
      </main>

      <footer className="agent-office__footer">
        <span>
          <span className="agent-office__status-dot is-active" />{' '}
          {t('activity:agentOffice.liveEvent')}
        </span>
        <span>
          <HardDrive />{' '}
          {t('activity:agentOffice.connectedSessions', { count: liveSessions.length })}
        </span>
        <span>
          <Clock3 /> {t('activity:agentOffice.detailHint')}
        </span>
      </footer>

      {selected && (
        <>
          <button
            type="button"
            className="agent-office__detail-backdrop"
            onClick={() => setSelected(null)}
            aria-label={t('activity:agentOffice.closeToolDetails')}
          />
          <ActionDetail selected={selected} onClose={() => setSelected(null)} />
        </>
      )}
    </div>
  );
}
