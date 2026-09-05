import { Activity, CheckCircle2, ListTodo, MessageSquareText } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SelectedAction } from '../AgentOfficeDetails.js';
import { type ClientOfficeModel, relativeTime } from './model.js';

export function OfficeBriefing({
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
