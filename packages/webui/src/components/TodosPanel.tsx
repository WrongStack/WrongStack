import { CheckCircle2, Circle, Clock, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useActiveSessionId, useSessionStore } from '@/stores';
import { onLaneDisposed } from '@/stores/chat-lanes';

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
  /** Board-derived titles of the unfinished work this row waits on. */
  blockedBy?: string[] | undefined;
  kanbanBoardId?: string | undefined;
  kanbanTaskId?: string | undefined;
}

const STATUS_ORDER: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

const TODOS_PANEL_NO_SESSION = '__no_session__';
const todosCollapsedBySession = new Map<string, Set<string>>();
const disposedTodosPanelSessions = new Set<string>();

onLaneDisposed((sessionId) => {
  todosCollapsedBySession.delete(sessionId);
  disposedTodosPanelSessions.add(sessionId);
});

/**
 * Live agent todo list panel. Connects to the WebSocket on mount,
 * requests the current todo snapshot, and stays in sync via
 * `todos.updated` events broadcast by the server.
 *
 * **Interactive**: Click an item to toggle between completed ↔ pending.
 * Hover for a remove button. In-progress items are not toggleable (the
 * agent sets that state).
 *
 * Sections: In Progress → Pending → Completed, completed is collapsible.
 * Auto-hides when the todo list is empty.
 */
export function TodosPanel(): React.ReactElement | null {
  const { t } = useAppTranslation();
  const todos = useSessionStore((state) => state.todos) as TodoItem[];
  const sessionId = useActiveSessionId();
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const ws = getWSClient();
  const collapsedSessionRef = useRef<string>(sessionId ?? TODOS_PANEL_NO_SESSION);

  useLayoutEffect(() => {
    if (!disposedTodosPanelSessions.has(collapsedSessionRef.current)) {
      todosCollapsedBySession.set(collapsedSessionRef.current, new Set(collapsedSections));
    }
    const next = sessionId ?? TODOS_PANEL_NO_SESSION;
    disposedTodosPanelSessions.delete(next);
    setCollapsedSections(new Set(todosCollapsedBySession.get(next) ?? []));
    collapsedSessionRef.current = next;
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) ws.send({ type: 'todos.get', payload: { sessionId } });
  }, [sessionId, ws]);

  const handleRemove = useCallback(
    (id: string) => {
      ws.removeTodo(id);
    },
    [ws],
  );

  const handleToggle = useCallback(
    (t: TodoItem) => {
      // Only toggle pending ↔ completed. In-progress is agent-managed.
      if (t.status === 'in_progress') return;
      const next = t.status === 'completed' ? 'pending' : 'completed';
      ws.updateTodoStatus(t.id, next);
    },
    [ws],
  );

  // Sort: in_progress → pending → completed, stable within groups
  const sorted = [...todos].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
  );
  // Todos are bounded (per session), show all without pagination.
  const totalCompleted = sorted.filter((todo) => todo.status === 'completed').length;

  const inProgress = sorted.filter((todo) => todo.status === 'in_progress');
  const pending = sorted.filter((todo) => todo.status === 'pending');
  const completed = sorted.filter((todo) => todo.status === 'completed');
  const hasCompleted = completed.length > 0;
  const completedCollapsed = collapsedSections.has('completed');

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderItem = (todo: TodoItem) => {
    const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
    const isInProgress = todo.status === 'in_progress';
    const isCompleted = todo.status === 'completed';
    const isManagedProjection = Boolean(todo.kanbanBoardId && todo.kanbanTaskId);
    const isToggleable = !isInProgress && !(isManagedProjection && isCompleted);

    return (
      <div
        key={todo.id}
        className={cn(
          'relative px-3 py-1.5 flex items-start gap-2 text-[13px] group transition-colors',
          isToggleable && 'hover:bg-accent/40',
          isInProgress ? 'bg-warning/8' : isCompleted ? 'bg-success/5' : 'bg-background',
        )}
      >
        {isToggleable && (
          <button
            type="button"
            className="absolute inset-0 cursor-pointer"
            aria-label={t('activity:todos.toggleAria', { content: todo.content })}
            onClick={() => handleToggle(todo)}
          />
        )}
        <span className="pointer-events-none relative mt-0.5 shrink-0">
          {isCompleted ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
          ) : isInProgress ? (
            <Clock className="w-3.5 h-3.5 text-warning animate-spin" />
          ) : (
            <Circle
              className={cn(
                'w-3.5 h-3.5 transition-colors',
                'text-muted-foreground/65 group-hover:text-success',
              )}
            />
          )}
        </span>
        <span
          className={cn(
            'pointer-events-none relative leading-snug flex-1 min-w-0',
            isInProgress
              ? 'text-warning font-medium'
              : isCompleted
                ? 'text-muted-foreground line-through'
                : 'text-foreground/80',
          )}
        >
          {label}
          {/* The board computes readiness on every mutation. Without it here a
              blocked row reads exactly like a ready one, and the next item is
              picked by guesswork. */}
          {todo.blockedBy?.length ? (
            <span className="mt-0.5 block text-[11px] text-destructive">
              {t('activity:todos.blockedBy', { work: todo.blockedBy.join('; ') })}
            </span>
          ) : null}
        </span>
        {!isManagedProjection && (
          <button
            type="button"
            onClick={() => handleRemove(todo.id)}
            className="relative shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:opacity-100 hover:bg-destructive/10 transition-all"
            title={t('activity:todos.removeTitle')}
            aria-label={t('activity:todos.removeAria', { content: todo.content })}
          >
            <Trash2 className="w-3 h-3 text-muted-foreground" />
          </button>
        )}
      </div>
    );
  };

  if (todos.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
      {/* Header */}
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/50">
        <h2 className="text-[11px] font-semibold text-foreground uppercase tracking-wider">
          {t('activity:work.todos')}
        </h2>
        <span className="tabular text-[10px] text-muted-foreground ml-auto">
          {totalCompleted}/{todos.length}
        </span>
      </div>

      {/* In Progress */}
      {inProgress.length > 0 && (
        <div className="border-b border-border/30 last:border-b-0">
          {inProgress.map(renderItem)}
        </div>
      )}

      {/* Pending */}
      {pending.length > 0 && (
        <div className="border-b border-border/30 last:border-b-0">{pending.map(renderItem)}</div>
      )}

      {/* Completed — collapsible section */}
      {hasCompleted && (
        <div>
          <button
            type="button"
            onClick={() => toggleSection('completed')}
            className="w-full px-3 py-1 flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="tabular">
              {completedCollapsed ? '▶' : '▼'}{' '}
              {t('activity:todos.completedCount', { count: completed.length })}
            </span>
          </button>
          {!completedCollapsed && completed.map(renderItem)}
        </div>
      )}
    </div>
  );
}
