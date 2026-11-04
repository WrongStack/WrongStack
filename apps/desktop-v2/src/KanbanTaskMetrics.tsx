import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';

export const METRIC_STATUSES = ['pending', 'met', 'missed', 'waived'] as const;

/** A number when the text is one, otherwise the trimmed text (targets may be "p95 < 200"). */
export function metricValue(text: string): string | number | undefined {
  const value = text.trim();
  if (!value) return undefined;
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

/**
 * The card's goal metrics: record a current value or status (`kanban.task.metric.update`) and
 * add a metric (`kanban.task.metric.add`). Contract map nodes can bind to these metrics.
 */
export function KanbanTaskMetrics({
  command,
  boardId,
  task,
  disabled,
  onDone,
}: {
  command: EngineCommand;
  boardId: string;
  task: Record<string, unknown>;
  disabled: boolean;
  onDone: () => Promise<void>;
}) {
  const { t } = useDesktopText();
  const taskId = String(task['id']);
  const metrics = entries(task['goalMetrics']).filter((m) => typeof m['id'] === 'string');
  const [edits, setEdits] = useState<Record<string, { current: string; status: string }>>({}),
    [draft, setDraft] = useState({ name: '', target: '', unit: '' }),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const run = async (type: string, payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    setResult('');
    try {
      await command(type, { boardId, taskId, ...payload }, [type]);
      setResult(done);
      await onDone();
      return true;
    } catch (failure) {
      setResult(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="kanban-task-merge">
      <summary>
        <Gauge size={13} /> {t('kanbanMetrics.title')}
        {metrics.length ? ` · ${metrics.length}` : ''}
      </summary>
      <fieldset disabled={disabled || busy}>
        {metrics.map((metric) => {
          const id = String(metric['id']);
          const edit = edits[id] ?? {
            current: metric['current'] === undefined ? '' : String(metric['current']),
            status: String(metric['status'] ?? 'pending'),
          };
          return (
            <div key={id} className="kanban-metric-row">
              <span>
                {String(metric['name'] ?? id)}
                <small>
                  {' '}
                  {t('kanbanMetrics.target', {
                    target: String(metric['target'] ?? '—'),
                    unit: String(metric['unit'] ?? ''),
                  })}
                </small>
              </span>
              <input
                aria-label={t('kanbanMetrics.current', { name: String(metric['name'] ?? id) })}
                value={edit.current}
                onChange={(event) =>
                  setEdits({ ...edits, [id]: { ...edit, current: event.target.value } })
                }
              />
              <select
                aria-label={t('kanbanMetrics.statusOf', { name: String(metric['name'] ?? id) })}
                value={edit.status}
                onChange={(event) =>
                  setEdits({ ...edits, [id]: { ...edit, status: event.target.value } })
                }
              >
                {METRIC_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(`kanbanMetrics.status.${status}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button secondary small"
                disabled={!edits[id]}
                onClick={() => {
                  const current = metricValue(edit.current);
                  void run(
                    'kanban.task.metric.update',
                    {
                      metricId: id,
                      status: edit.status,
                      ...(current !== undefined ? { current } : {}),
                    },
                    t('kanbanMetrics.updated', { name: String(metric['name'] ?? id) }),
                  ).then((ok) => {
                    if (!ok) return;
                    const { [id]: _saved, ...rest } = edits;
                    setEdits(rest);
                  });
                }}
              >
                {t('kanbanMetrics.save')}
              </button>
            </div>
          );
        })}
        <div className="kanban-metric-row">
          <input
            aria-label={t('kanbanMetrics.newName')}
            placeholder={t('kanbanMetrics.namePlaceholder')}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <input
            aria-label={t('kanbanMetrics.newTarget')}
            placeholder={t('kanbanMetrics.targetPlaceholder')}
            value={draft.target}
            onChange={(event) => setDraft({ ...draft, target: event.target.value })}
          />
          <input
            aria-label={t('kanbanMetrics.newUnit')}
            placeholder={t('kanbanMetrics.unitPlaceholder')}
            value={draft.unit}
            onChange={(event) => setDraft({ ...draft, unit: event.target.value })}
          />
          <button
            type="button"
            className="button secondary small"
            disabled={!draft.name.trim()}
            onClick={() => {
              const target = metricValue(draft.target);
              void run(
                'kanban.task.metric.add',
                {
                  name: draft.name.trim(),
                  ...(target !== undefined ? { target } : {}),
                  ...(draft.unit.trim() ? { unit: draft.unit.trim() } : {}),
                },
                t('kanbanMetrics.added', { name: draft.name.trim() }),
              ).then((ok) => ok && setDraft({ name: '', target: '', unit: '' }));
            }}
          >
            {t('kanbanMetrics.add')}
          </button>
        </div>
      </fieldset>
      {result && <p role="status">{result}</p>}
    </details>
  );
}
