import { getWSClient } from '@/lib/ws-client';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { CheckCircle2, Circle, Clock, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
}

const STATUS_ORDER: Record<TodoItem['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

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
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const ws = getWSClient();
  const offRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    ws.send({ type: 'todos.get' });
    offRef.current = ws.on('todos.updated', (msg: unknown) => {
      const payload = (msg as { payload?: { todos?: TodoItem[] | undefined } })?.payload;
      if (payload?.todos) setTodos(payload.todos);
    });
    return () => { offRef.current?.(); };
  }, [ws]);

  const handleRemove = useCallback((id: string) => { ws.removeTodo(id); }, [ws]);

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

  const inProgress = sorted.filter((t) => t.status === 'in_progress');
  const pending = sorted.filter((t) => t.status === 'pending');
  const completed = sorted.filter((t) => t.status === 'completed');
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
    const isToggleable = !isInProgress;

    return (
      <div
        key={todo.id}
        onClick={() => isToggleable && handleToggle(todo)}
        className={cn(
          'px-3 py-1.5 flex items-start gap-2 text-[13px] group transition-colors',
          isToggleable && 'cursor-pointer hover:bg-accent/40',
          isInProgress
            ? 'bg-warning/8'
            : isCompleted
              ? 'bg-success/5'
              : 'bg-background',
        )}
        role={isToggleable ? 'button' : undefined}
        aria-label={isToggleable ? t('activity:todos.toggleAria', { content: todo.content }) : undefined}
        tabIndex={isToggleable ? 0 : undefined}
        onKeyDown={(e) => {
          if (isToggleable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            handleToggle(todo);
          }
        }}
      >
        <span className="mt-0.5 shrink-0">
          {isCompleted ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
          ) : isInProgress ? (
            <Clock className="w-3.5 h-3.5 text-warning animate-spin" />
          ) : (
            <Circle
              className={cn(
                'w-3.5 h-3.5 transition-colors',
                'text-muted-foreground/40 group-hover:text-success',
              )}
            />
          )}
        </span>
        <span
          className={cn(
            'leading-snug flex-1 min-w-0',
            isInProgress
              ? 'text-warning font-medium'
              : isCompleted
                ? 'text-muted-foreground line-through'
                : 'text-foreground/80',
          )}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleRemove(todo.id); }}
          className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-50 hover:opacity-100 hover:bg-destructive/10 transition-all"
          title={t('activity:todos.removeTitle')}
          aria-label={t('activity:todos.removeAria', { content: todo.content })}
        >
          <Trash2 className="w-3 h-3 text-muted-foreground" />
        </button>
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
          {completed.length}/{todos.length}
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
        <div className="border-b border-border/30 last:border-b-0">
          {pending.map(renderItem)}
        </div>
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
              {completedCollapsed ? '▶' : '▼'} {t('activity:todos.completedCount', { count: completed.length })}
            </span>
          </button>
          {!completedCollapsed && completed.map(renderItem)}
        </div>
      )}
    </div>
  );
}
