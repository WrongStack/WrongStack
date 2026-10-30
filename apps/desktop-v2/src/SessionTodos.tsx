import { CheckCircle2, Circle, ListTodo, LoaderCircle, Trash2 } from 'lucide-react';
import './session-todos.css';
import { useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';

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

export function todoProgress(todos: readonly SessionTodo[]): string {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const active = todos.find((todo) => todo.status === 'in_progress');
  return `${done} of ${todos.length} done${active ? ` · ${active.activeForm || active.content}` : ''}`;
}

/**
 * The agent's todo list for this conversation, kept live by `todos.updated`. Items can be
 * marked or removed by hand; Kanban-bound items are task projections and change on the board.
 */
export function SessionTodos({ state, command }: { state: EngineState; command: EngineCommand }) {
  const todos = sessionTodos(state.results['todos.updated']);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [clearing, setClearing] = useState(false);
  const sessionId = state.sessionId;
  useEffect(() => {
    if (!sessionId) return;
    void command('todos.get', {}, ['todos.updated']).catch(() => {
      // An engine without worklist routes simply shows no todo list.
    });
  }, [command, sessionId]);
  if (todos.length === 0) return null;
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
  return (
    <details className="session-todos">
      <summary>
        <ListTodo size={14} /> Todo list · {todoProgress(todos)}
      </summary>
      <ol>
        {todos.map((todo) => (
          <li key={todo.id} className={`todo-${todo.status}`}>
            {todo.status === 'completed' ? (
              <CheckCircle2 size={14} aria-label="Done" />
            ) : todo.status === 'in_progress' ? (
              <LoaderCircle size={14} aria-label="In progress" />
            ) : (
              <Circle size={14} aria-label="Pending" />
            )}
            <span>{todo.content}</span>
            {todo.managed ? (
              <small>Kanban task</small>
            ) : (
              <>
                <select
                  aria-label={`Status of ${todo.content}`}
                  value={todo.status}
                  disabled={busy || state.running}
                  onChange={(event) =>
                    void act('todo.update', { id: todo.id, status: event.target.value })
                  }
                >
                  <option value="pending">Pending</option>
                  <option value="in_progress">In progress</option>
                  <option value="completed">Done</option>
                </select>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${todo.content}`}
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
      {state.running && editable && (
        <p className="field-help">The agent is working; change the list when the run ends.</p>
      )}
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
                Clear the list
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() => setClearing(false)}
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button secondary small"
              disabled={busy || state.running}
              onClick={() => setClearing(true)}
            >
              Clear list…
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
