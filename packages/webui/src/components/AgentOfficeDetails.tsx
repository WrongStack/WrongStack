import {
  Code2,
  File,
  FilePenLine,
  FolderSearch,
  Globe2,
  ListTodo,
  Lock,
  type LucideIcon,
  Mail,
  MemoryStick,
  MessageSquareText,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useAppTranslation } from '@/i18n';
import type { OfficeMailActivity, OfficeToolCall, OfficeToolKind } from '@/lib/agent-office';
import { cn } from '@/lib/utils';
import type { LiveTodoItem } from '@/stores/monitor-store';

export type SelectedAction =
  | { kind: 'tool'; call: OfficeToolCall; agentName: string }
  | { kind: 'mail'; mail: OfficeMailActivity; agentName: string }
  | { kind: 'task'; task: string; taskId?: string | undefined; agentName: string }
  | {
      kind: 'briefing';
      officeLabel: string;
      prompt?: string | undefined;
      promptAt?: number | undefined;
      instructionActive: boolean;
      telemetryConnected: boolean;
      todos: LiveTodoItem[];
    };

const TOOL_DETAIL_ICONS: Record<OfficeToolKind, LucideIcon> = {
  read: Search,
  write: FilePenLine,
  edit: FilePenLine,
  terminal: TerminalSquare,
  web: Globe2,
  search: FolderSearch,
  memory: MemoryStick,
  other: Code2,
};

function shortPath(value: string | undefined, max = 46): string | undefined {
  if (!value || value.length <= max) return value;
  const parts = value.split(/[\\/]/);
  const tail = parts.slice(-2).join('/');
  return tail.length <= max ? `…/${tail}` : `…${value.slice(-(max - 1))}`;
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '—';
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function stringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="agent-office__detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ToolActionDetail({
  selected,
  onClose,
}: {
  selected: Extract<SelectedAction, { kind: 'tool' }>;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const { call, agentName } = selected;
  const ToolIcon = TOOL_DETAIL_ICONS[call.kind];
  const input = stringify(call.input);
  const output = stringify(call.output);

  return (
    <aside className="agent-office__detail" aria-label={`${call.toolName} details`}>
      <div className="agent-office__detail-header">
        <div className={cn('agent-office__detail-icon', `is-${call.kind}`)}>
          <ToolIcon aria-hidden="true" />
        </div>
        <div>
          <span>{t('activity:agentOffice.toolCall')}</span>
          <h2>{call.toolName}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label={t('activity:agentOffice.closeDetails')}>
          <X />
        </button>
      </div>

      <div className="agent-office__detail-status">
        <span
          className={cn(
            'agent-office__status-dot',
            call.status === 'running' && 'is-active',
            call.status === 'failed' && 'is-failed',
          )}
        />
        <strong>{call.summary}</strong>
        <span>{call.status}</span>
      </div>

      <section className="agent-office__detail-section">
        <h3>{t('activity:agentOffice.execution')}</h3>
        <DetailRow label={t('activity:agentOffice.agent')} value={agentName} />
        <DetailRow
          label={t('activity:agentOffice.started')}
          value={new Date(call.startedAt).toLocaleTimeString()}
        />
        <DetailRow
          label={t('activity:agentOffice.duration')}
          value={formatDuration(call.durationMs)}
        />
        {call.sessionId && (
          <DetailRow
            label={t('activity:agentOffice.session')}
            value={shortPath(call.sessionId, 28)}
          />
        )}
      </section>

      {(call.target || call.fileTargets.length > 0) && (
        <section className="agent-office__detail-section">
          <h3>{t('activity:agentOffice.target')}</h3>
          {call.target && <code className="agent-office__target-code">{call.target}</code>}
          {call.fileTargets.map((target, index) => (
            <div className="agent-office__file-target" key={`${target.filePath}:${index}`}>
              <File aria-hidden="true" />
              <span>{target.filePath}</span>
              {(target.line || target.endLine) && (
                <strong>
                  L{target.line ?? 1}
                  {target.endLine ? `–${target.endLine}` : ''}
                </strong>
              )}
            </div>
          ))}
        </section>
      )}

      {(call.outputLines !== undefined ||
        call.outputBytes !== undefined ||
        call.outputTokens !== undefined) && (
        <section className="agent-office__detail-section">
          <h3>{t('activity:agentOffice.resultSize')}</h3>
          <div className="agent-office__metric-grid">
            {call.outputLines !== undefined && (
              <div>
                <strong>{call.outputLines.toLocaleString()}</strong>
                <span>{t('activity:agentOffice.lines')}</span>
              </div>
            )}
            {call.outputBytes !== undefined && (
              <div>
                <strong>{call.outputBytes.toLocaleString()}</strong>
                <span>{t('activity:agentOffice.bytes')}</span>
              </div>
            )}
            {call.outputTokens !== undefined && (
              <div>
                <strong>≈{call.outputTokens.toLocaleString()}</strong>
                <span>{t('activity:agentOffice.tokens')}</span>
              </div>
            )}
          </div>
        </section>
      )}

      {input && (
        <section className="agent-office__detail-section">
          <h3>{t('activity:agentOffice.input')}</h3>
          <pre>
            <code>{input}</code>
          </pre>
        </section>
      )}

      {output && (
        <section className="agent-office__detail-section">
          <h3>{t('activity:agentOffice.outputPreview')}</h3>
          <pre>
            <code>{output}</code>
          </pre>
        </section>
      )}
    </aside>
  );
}

function MailActionDetail({
  selected,
  onClose,
}: {
  selected: Extract<SelectedAction, { kind: 'mail' }>;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const { mail, agentName } = selected;
  return (
    <aside className="agent-office__detail" aria-label={`${mail.subject} details`}>
      <div className="agent-office__detail-header">
        <div className="agent-office__detail-icon is-mail">
          <Mail aria-hidden="true" />
        </div>
        <div>
          <span>{mail.direction === 'incoming' ? 'INCOMING MAIL' : 'OUTGOING MAIL'}</span>
          <h2>{mail.subject}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('activity:agentOffice.closeMailDetails')}
        >
          <X />
        </button>
      </div>

      <div className="agent-office__detail-status">
        <span className={cn('agent-office__status-dot', mail.unread && 'is-active')} />
        <strong>
          {mail.from} → {mail.to}
        </strong>
        <span>{mail.type}</span>
        {mail.audience === 'leaders' && (
          <span>
            <Lock className="h-3 w-3" /> {t('activity:mailbox.audienceLeaders')}
          </span>
        )}
      </div>

      <section className="agent-office__detail-section">
        <h3>{t('activity:mailbox.messages')}</h3>
        <DetailRow label={t('activity:agentOffice.agent')} value={agentName} />
        <DetailRow
          label={t('activity:agentOffice.started')}
          value={new Date(mail.timestampMs).toLocaleTimeString()}
        />
        <DetailRow label={t('activity:agentOffice.priority')} value={mail.priority} />
        <DetailRow label={t('activity:agentOffice.route')} value={`${mail.from} → ${mail.to}`} />
      </section>

      <section className="agent-office__detail-section">
        <h3>{mail.subject}</h3>
        <div className="agent-office__mail-body">{mail.body}</div>
      </section>
    </aside>
  );
}

function TaskActionDetail({
  selected,
  onClose,
}: {
  selected: Extract<SelectedAction, { kind: 'task' }>;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <aside className="agent-office__detail" aria-label={`${selected.agentName} task details`}>
      <div className="agent-office__detail-header">
        <div className="agent-office__detail-icon is-task">
          <ListTodo aria-hidden="true" />
        </div>
        <div>
          <span>{t('activity:agentOffice.currentTask')}</span>
          <h2>{selected.agentName}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('activity:agentOffice.closeTaskDetails')}
        >
          <X />
        </button>
      </div>

      <section className="agent-office__detail-section">
        <h3>{t('activity:agentOffice.task')}</h3>
        {selected.taskId && <DetailRow label="ID" value={selected.taskId} />}
        <div className="agent-office__task-body">{selected.task}</div>
      </section>
    </aside>
  );
}

function OfficeBriefingDetail({
  selected,
  onClose,
}: {
  selected: Extract<SelectedAction, { kind: 'briefing' }>;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const activeCount = selected.todos.filter((todo) => todo.status !== 'completed').length;
  return (
    <aside className="agent-office__detail" aria-label={`${selected.officeLabel} briefing`}>
      <div className="agent-office__detail-header">
        <div className="agent-office__detail-icon is-briefing">
          <MessageSquareText aria-hidden="true" />
        </div>
        <div>
          <span>
            {selected.instructionActive
              ? t('activity:agentOffice.activeInstruction')
              : t('activity:agentOffice.officeBriefing')}
          </span>
          <h2>{selected.officeLabel}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('activity:agentOffice.closeOfficeBriefing')}
        >
          <X />
        </button>
      </div>

      <div className="agent-office__detail-status">
        <span
          className={cn(
            'agent-office__status-dot',
            (selected.instructionActive || activeCount > 0) && 'is-active',
          )}
        />
        <strong>
          {selected.telemetryConnected
            ? t('activity:agentOffice.activeTodos')
            : t('activity:agentOffice.telemetryWaiting')}
        </strong>
        <span>{selected.telemetryConnected ? activeCount : '—'}</span>
      </div>

      <section className="agent-office__detail-section">
        <h3>
          {selected.instructionActive
            ? t('activity:agentOffice.activeInstruction')
            : t('activity:agentOffice.leaderPrompt')}
        </h3>
        {selected.promptAt !== undefined && (
          <DetailRow
            label={t('activity:agentOffice.promptReceived')}
            value={new Date(selected.promptAt).toLocaleString()}
          />
        )}
        <div className="agent-office__task-body">
          {selected.prompt ??
            (selected.telemetryConnected
              ? t('activity:agentOffice.noPrompt')
              : t('activity:agentOffice.telemetryWaiting'))}
        </div>
      </section>

      <section className="agent-office__detail-section">
        <h3>{t('activity:agentOffice.todos')}</h3>
        <div className="agent-office__todo-detail-list">
          {!selected.telemetryConnected ? (
            <span className="agent-office__history-empty">
              {t('activity:agentOffice.todoTelemetryWaiting')}
            </span>
          ) : selected.todos.length > 0 ? (
            selected.todos.map((todo) => (
              <div className={cn('agent-office__todo-detail', `is-${todo.status}`)} key={todo.id}>
                <span aria-hidden="true" />
                <div>
                  <strong>{todo.content}</strong>
                  <small>{t(`activity:agentOffice.todoStatus.${todo.status}`)}</small>
                </div>
              </div>
            ))
          ) : (
            <span className="agent-office__history-empty">
              {t('activity:agentOffice.noActiveTodos')}
            </span>
          )}
        </div>
      </section>
    </aside>
  );
}

export function ActionDetail({
  selected,
  onClose,
}: {
  selected: SelectedAction;
  onClose: () => void;
}) {
  if (selected.kind === 'tool') return <ToolActionDetail selected={selected} onClose={onClose} />;
  if (selected.kind === 'mail') return <MailActionDetail selected={selected} onClose={onClose} />;
  if (selected.kind === 'task') return <TaskActionDetail selected={selected} onClose={onClose} />;
  return <OfficeBriefingDetail selected={selected} onClose={onClose} />;
}
