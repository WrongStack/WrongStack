import { CheckCircle2, Circle, ListTodo, LoaderCircle, Trash2 } from 'lucide-react';
import './session-todos.css';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';
import { surfaceI18n } from './surface-i18n';

export interface SessionTodo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
  /** A projection of a Kanban task: change it on the board, not here. */
  managed: boolean;
}

/** The session's todo list from `todos.updated`. */
export function sessionTodos(value: unknown): SessionTodo[] {
  return entries(record(value)['todos'])
    .filter((todo) => typeof todo['id'] === 'string' && typeof todo['content'] === 'string')
    .map((todo) => ({
      id: String(todo['id']),
      content: String(todo['content']),
      status:
        todo['status'] === 'in_progress' || todo['status'] === 'completed'
          ? todo['status']
          : 'pending',
      activeForm: typeof todo['activeForm'] === 'string' ? todo['activeForm'] : '',
      managed:
        typeof todo['kanbanBoardId'] === 'string' && typeof todo['kanbanTaskId'] === 'string',
    }));
}

function todoCounts(todos: readonly SessionTodo[]) {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.find((todo) => todo.status === 'in_progress');
  return { done, total: todos.length, current: active ? active.activeForm || active.content : '' };
}

/** The English progress line the slash command reports. */
export function todoProgress(todos: readonly SessionTodo[]): string {
  const { done, total, current } = todoCounts(todos);
  return `${done} of ${total} done${current ? ` · ${current}` : ''}`;
}

/**
 * The agent's todo list for this conversation, kept live by `todos.updated`. Items can be
 * marked or removed by hand; Kanban-bound items are task projections and change on the board.
 */
export function SessionTodos({
  state,
  command,
  embedded = false,
}: {
  state: EngineState;
  command: EngineCommand;
  embedded?: boolean;
}) {
  const { t } = useDesktopText();
  const { t: words } = useTranslation('sessionInspector', { i18n: surfaceI18n });
  const todos = sessionTodos(state.results['todos.updated']);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const sessionId = state.sessionId;
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    setLoading(true);
    setError('');
    void command('todos.get', {}, ['todos.updated']).then(
      () => {
        if (active) setLoading(false);
      },
      (failure: unknown) => {
        if (!active) return;
        setLoading(false);
        setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [command, sessionId, reload]);
  if (todos.length === 0)
    return embedded ? (
      <div className="session-plan-empty">
        <ListTodo size={24} aria-hidden="true" />
        {error ? (
          <>
            <p role="alert">
              {words('planError')}: {error}
            </p>
            <button
              type="button"
              className="button secondary small"
              onClick={() => setReload((value) => value + 1)}
            >
              {words('retry')}
            </button>
          </>
        ) : (
          <p role="status">
            {loading || state.hydrating ? t('chatView.loading') : words('planEmpty')}
          </p>
        )}
      </div>
    ) : null;
  const act = async (type: string, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    setError('');
    try {
      await command(type, payload, ['key.operation_result']);
      setClearing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const editable = todos.some((todo) => !todo.managed);
  const { done, total, current } = todoCounts(todos);
  return (
    <details className="session-todos" open={embedded || undefined}>
      <summary>
        <ListTodo size={14} /> {t('todoList.title')} · {t('todoList.progress', { done, total })}
        {current ? ` · ${current}` : ''}
      </summary>
      <ol>
        {todos.map((todo) => (
          <li key={todo.id} className={`todo-${todo.status}`}>
            {todo.status === 'completed' ? (
              <CheckCircle2 size={14} aria-label={t('todoList.done')} />
            ) : todo.status === 'in_progress' ? (
              <LoaderCircle size={14} aria-label={t('todoList.inProgress')} />
            ) : (
              <Circle size={14} aria-label={t('todoList.pending')} />
            )}
            <span>{todo.content}</span>
            {todo.managed ? (
              <small>{t('todoList.kanbanTask')}</small>
            ) : (
              <>
                <select
                  aria-label={t('todoList.statusOf', { item: todo.content })}
                  value={todo.status}
                  disabled={busy || state.running}
                  onChange={(event) =>
                    void act('todo.update', { id: todo.id, status: event.target.value })
                  }
                >
                  <option value="pending">{t('todoList.pending')}</option>
                  <option value="in_progress">{t('todoList.inProgress')}</option>
                  <option value="completed">{t('todoList.done')}</option>
                </select>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('todoList.remove', { item: todo.content })}
                  disabled={busy || state.running}
                  onClick={() => void act('todos.remove', { id: todo.id })}
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {state.running && editable && <p className="field-help">{t('todoList.running')}</p>}
      {editable && !todos.some((todo) => todo.managed) && (
        <div className="session-todos-actions">
          {clearing ? (
            <>
              <button
                type="button"
                className="button danger small"
                disabled={busy || state.running}
                onClick={() => void act('todos.clear')}
              >
                {t('todoList.clearConfirm')}
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() => setClearing(false)}
              >
                {t('todoList.keep')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button secondary small"
              disabled={busy || state.running}
              onClick={() => setClearing(true)}
            >
              {t('todoList.clear')}
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </details>
  );
}
