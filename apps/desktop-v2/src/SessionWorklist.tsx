import { ClipboardList, ListChecks } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';
import './session-todos.css';

export const PLAN_STATUSES = ['open', 'in_progress', 'done'] as const;
export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'blocked',
  'review',
  'failed',
  'completed',
] as const;

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  detail: string;
}

/** Plan items from `plan.updated` (title and items; null plan means none). */
export function planItems(value: unknown): { title: string; items: WorkItem[] } {
  const plan = record(record(value)['plan']);
  return {
    title: typeof plan['title'] === 'string' ? plan['title'] : '',
    items: entries(plan['items'])
      .filter((item) => typeof item['id'] === 'string')
      .map((item) => ({
        id: String(item['id']),
        title: String(item['title'] ?? ''),
        status: String(item['status'] ?? 'open'),
        detail: typeof item['details'] === 'string' ? item['details'] : '',
      })),
  };
}

/** Tasks from `tasks.updated`. */
export function taskItems(value: unknown): WorkItem[] {
  return entries(record(value)['tasks'])
    .filter((task) => typeof task['id'] === 'string')
    .map((task) => ({
      id: String(task['id']),
      title: String(task['title'] ?? ''),
      status: String(task['status'] ?? 'pending'),
      detail: [task['priority'], task['type'], task['assignee']]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' · '),
    }));
}

function WorkList({
  label,
  icon,
  items,
  statuses,
  busy,
  onStatus,
}: {
  label: string;
  icon: React.ReactNode;
  items: WorkItem[];
  statuses: readonly string[];
  busy: boolean;
  onStatus: (item: WorkItem, status: string) => void;
}) {
  const done = items.filter((item) => item.status === 'done' || item.status === 'completed');
  return (
    <details className="session-todos">
      <summary>
        {icon} {label} · {done.length} of {items.length} done
      </summary>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <span>
              {item.title}
              {item.detail && <small> · {item.detail}</small>}
            </span>
            <select
              aria-label={`Status of ${item.title}`}
              value={item.status}
              disabled={busy}
              onChange={(event) => onStatus(item, event.target.value)}
            >
              {(statuses.includes(item.status) ? statuses : [item.status, ...statuses]).map(
                (status) => (
                  <option key={status} value={status}>
                    {status.replace('_', ' ')}
                  </option>
                ),
              )}
            </select>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * The session's plan (`plan.*`) and task list (`tasks.*`), kept live by their broadcasts. Each
 * item's status can be changed while the agent is not running; the engine reports refusals.
 */
export function SessionWorklist({
  state,
  command,
}: {
  state: EngineState;
  command: EngineCommand;
}) {
  const plan = planItems(state.results['plan.updated']);
  const tasks = taskItems(state.results['tasks.updated']);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sessionId = state.sessionId;
  useEffect(() => {
    if (!sessionId) return;
    // Engines without worklist storage answer with an empty list or an error field.
    void command('plan.get', {}, ['plan.updated']).catch(() => {});
    void command('tasks.get', {}, ['tasks.updated']).catch(() => {});
  }, [command, sessionId]);
  if (plan.items.length === 0 && tasks.length === 0) return null;
  const change = async (type: string, payload: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await command(type, payload, ['key.operation_result']);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || state.running;
  return (
    <>
      {plan.items.length > 0 && (
        <WorkList
          label={plan.title ? `Plan: ${plan.title}` : 'Plan'}
          icon={<ClipboardList size={14} />}
          items={plan.items}
          statuses={PLAN_STATUSES}
          busy={locked}
          onStatus={(item, status) => void change('plan.item.update', { target: item.id, status })}
        />
      )}
      {tasks.length > 0 && (
        <WorkList
          label="Tasks"
          icon={<ListChecks size={14} />}
          items={tasks}
          statuses={TASK_STATUSES}
          busy={locked}
          onStatus={(item, status) => void change('task.update', { id: item.id, status })}
        />
      )}
      {error && (
        <p role="alert" className="session-error session-worklist-error">
          {error}
        </p>
      )}
    </>
  );
}
