import {
  Check,
  Circle,
  Clock3,
  ListChecks,
  Pause,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  PlanStatus,
  SimplePlanItem,
  SimpleTaskItem,
  SimpleTodoItem,
  TaskStatus,
  TodoStatus,
  WorklistSnapshot,
  WorklistView,
} from './lib/worklist-store.js';

interface WorklistSidebarProps {
  view: WorklistView;
  snapshot: WorklistSnapshot;
  onTodoStatusChange: (id: string, status: TodoStatus) => void;
  onTaskStatusChange: (id: string, status: TaskStatus) => void;
  onPlanStatusChange: (id: string, status: PlanStatus) => void;
}

interface DisplayItem {
  id: string;
  title: string;
  detail?: string | undefined;
  status: string;
  tone: 'pending' | 'running' | 'blocked' | 'failed' | 'done';
  start?: (() => void) | undefined;
  complete?: (() => void) | undefined;
  reopen?: (() => void) | undefined;
}

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  blocked: 1,
  review: 2,
  pending: 3,
  open: 3,
  failed: 4,
  completed: 5,
  done: 5,
};

function statusTone(status: string): DisplayItem['tone'] {
  if (status === 'in_progress' || status === 'review') return 'running';
  if (status === 'blocked') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'completed' || status === 'done') return 'done';
  return 'pending';
}

function StatusIcon({ tone }: { tone: DisplayItem['tone'] }) {
  if (tone === 'running') return <Clock3 size={13} className="spin" aria-hidden="true" />;
  if (tone === 'blocked') return <Pause size={13} aria-hidden="true" />;
  if (tone === 'failed') return <X size={13} aria-hidden="true" />;
  if (tone === 'done') return <Check size={13} aria-hidden="true" />;
  return <Circle size={13} aria-hidden="true" />;
}

function todoItems(
  todos: SimpleTodoItem[],
  onStatusChange: WorklistSidebarProps['onTodoStatusChange'],
): DisplayItem[] {
  return todos.map((item) => ({
    id: item.id,
    title: item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content,
    status: item.status,
    tone: statusTone(item.status),
    ...(item.status === 'pending'
      ? { complete: () => onStatusChange(item.id, 'completed') }
      : item.status === 'completed'
        ? { reopen: () => onStatusChange(item.id, 'pending') }
        : {}),
  }));
}

function taskItems(
  tasks: SimpleTaskItem[],
  onStatusChange: WorklistSidebarProps['onTaskStatusChange'],
): DisplayItem[] {
  return tasks.map((item) => ({
    id: item.id,
    title: item.title,
    detail: [item.type, item.priority !== 'medium' ? item.priority : '', item.assignee ? `@${item.assignee}` : '']
      .filter(Boolean)
      .join(' · '),
    status: item.status,
    tone: statusTone(item.status),
    ...(item.status !== 'in_progress' && item.status !== 'completed'
      ? { start: () => onStatusChange(item.id, 'in_progress') }
      : {}),
    ...(item.status === 'in_progress'
      ? { complete: () => onStatusChange(item.id, 'completed') }
      : {}),
    ...(item.status === 'completed'
      ? { reopen: () => onStatusChange(item.id, 'pending') }
      : {}),
  }));
}

function planItems(
  items: SimplePlanItem[],
  onStatusChange: WorklistSidebarProps['onPlanStatusChange'],
): DisplayItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    detail: item.details,
    status: item.status,
    tone: statusTone(item.status),
    ...(item.status === 'open' ? { start: () => onStatusChange(item.id, 'in_progress') } : {}),
    ...(item.status !== 'done' ? { complete: () => onStatusChange(item.id, 'done') } : {}),
    ...(item.status === 'done' ? { reopen: () => onStatusChange(item.id, 'open') } : {}),
  }));
}

const VIEW_COPY: Record<WorklistView, { empty: string; noun: string }> = {
  todos: { empty: 'No todos in this session yet.', noun: 'todo' },
  tasks: { empty: 'No structured tasks in this session yet.', noun: 'task' },
  plan: { empty: 'No persistent plan in this session yet.', noun: 'plan item' },
};

export function WorklistSidebar({
  view,
  snapshot,
  onTodoStatusChange,
  onTaskStatusChange,
  onPlanStatusChange,
}: WorklistSidebarProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  const items = useMemo(() => {
    const next =
      view === 'todos'
        ? todoItems(snapshot.todos, onTodoStatusChange)
        : view === 'tasks'
          ? taskItems(snapshot.tasks, onTaskStatusChange)
          : planItems(snapshot.planItems, onPlanStatusChange);
    return next.sort(
      (left, right) => (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9),
    );
  }, [onPlanStatusChange, onTaskStatusChange, onTodoStatusChange, snapshot, view]);
  const completed = items.filter((item) => item.tone === 'done');
  const active = items.filter((item) => item.tone !== 'done');
  const visible = showCompleted ? [...active, ...completed] : active;
  const copy = VIEW_COPY[view];

  if (items.length === 0) {
    return (
      <div className="tool-sidebar-empty worklist-empty">
        <ListChecks size={20} strokeWidth={1.5} aria-hidden="true" />
        <span>{copy.empty}</span>
        <small>Items appear here from the current agent session.</small>
      </div>
    );
  }

  return (
    <div className="worklist-content">
      <div className="worklist-summary">
        <span>{active.length} ACTIVE</span>
        <span>{completed.length} DONE</span>
        {completed.length > 0 && (
          <button type="button" onClick={() => setShowCompleted((current) => !current)}>
            {showCompleted ? 'HIDE DONE' : 'SHOW DONE'}
          </button>
        )}
      </div>
      <div className="worklist-items">
        {visible.map((item) => (
          <article className={`worklist-item ${item.tone}`} key={item.id}>
            <span className="worklist-status-icon">
              <StatusIcon tone={item.tone} />
            </span>
            <div className="worklist-item-copy">
              <strong>{item.title}</strong>
              <span>{item.detail || item.status.replaceAll('_', ' ')}</span>
            </div>
            <div className="worklist-actions">
              {item.start && (
                <button type="button" onClick={item.start} title="Start item">
                  <Clock3 size={11} aria-hidden="true" /> START
                </button>
              )}
              {item.complete && (
                <button type="button" onClick={item.complete} title="Complete item">
                  <Check size={11} aria-hidden="true" /> DONE
                </button>
              )}
              {item.reopen && (
                <button type="button" onClick={item.reopen} title="Reopen item">
                  <RotateCcw size={11} aria-hidden="true" /> REOPEN
                </button>
              )}
            </div>
            {(item.tone === 'blocked' || item.tone === 'failed') && (
              <ShieldAlert size={12} className="worklist-alert" aria-label={item.tone} />
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
