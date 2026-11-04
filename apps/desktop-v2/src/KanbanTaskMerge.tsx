import { Merge } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';

/**
 * Merges this card with other cards on the same board into one new card (`kanban.task.merge`).
 * The engine combines descriptions, labels, outside dependencies, boundaries and estimates; the
 * source cards are closed unless the user keeps them open.
 */
export function KanbanTaskMerge({
  command,
  boardId,
  task,
  tasks,
  disabled,
  onDone,
}: {
  command: EngineCommand;
  boardId: string;
  task: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  disabled: boolean;
  onDone: (mergedTaskId: string) => Promise<void>;
}) {
  const { t } = useDesktopText();
  const taskId = String(task['id']);
  const others = tasks.filter((item) => typeof item['id'] === 'string' && item['id'] !== taskId);
  const [picked, setPicked] = useState<string[]>([]),
    [title, setTitle] = useState(String(task['title'] ?? '')),
    [closeSources, setCloseSources] = useState(true),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  if (!others.length) return null;
  const chosen = picked.filter((id) => others.some((item) => item['id'] === id));
  const merge = async () => {
    if (!chosen.length || !title.trim()) return;
    setBusy(true);
    setResult('');
    try {
      const reply = await command(
        'kanban.task.merge',
        {
          boardId,
          taskIds: [taskId, ...chosen],
          title: title.trim(),
          closeSourceTasks: closeSources,
          preserveAssignment: false,
        },
        ['kanban.task.merge'],
      );
      const merged = record(record(reply['data'])['task']);
      if (typeof merged['id'] !== 'string') throw Error(t('kanbanMerge.noCard'));
      setResult(
        t('kanbanMerge.merged', {
          number: chosen.length + 1,
          title: String(merged['title'] ?? title),
        }),
      );
      setPicked([]);
      await onDone(merged['id']);
    } catch (failure) {
      setResult(
        t('kanbanMerge.failed', {
          message: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="kanban-task-merge">
      <summary>
        <Merge size={13} /> {t('kanbanMerge.title')}
      </summary>
      <fieldset disabled={disabled || busy}>
        <legend>{t('kanbanMerge.legend')}</legend>
        <ul>
          {others.map((item) => {
            const id = String(item['id']);
            return (
              <li key={id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(id)}
                    onChange={(event) =>
                      setPicked((current) =>
                        event.target.checked
                          ? [...current, id]
                          : current.filter((value) => value !== id),
                      )
                    }
                  />
                  {String(item['title'] ?? id)}
                </label>
              </li>
            );
          })}
        </ul>
        <label>
          {t('kanbanMerge.newTitle')}
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={closeSources}
            onChange={(event) => setCloseSources(event.target.checked)}
          />
          {t('kanbanMerge.closeSources')}
        </label>
        <button
          type="button"
          className="button secondary small"
          disabled={!chosen.length || !title.trim()}
          onClick={() => void merge()}
        >
          {t('kanbanMerge.merge', { number: chosen.length ? chosen.length + 1 : '' })}
        </button>
      </fieldset>
      {result && <p role="status">{result}</p>}
    </details>
  );
}
