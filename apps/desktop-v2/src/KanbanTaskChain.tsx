import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

/** The cards of a chain reply in chain order, as [id, title] pairs. */
export function chainCards(data: unknown): [string, string][] {
  return entries(record(data)['tasks']).flatMap((task) =>
    typeof task['id'] === 'string' ? [[task['id'], String(task['title'] ?? task['id'])]] : [],
  ) as [string, string][];
}

/**
 * Shows the chain this card belongs to (`kanban.task.chain.get`) and builds a new one from this
 * card and others picked in order (`kanban.task.chain`). With dependencies enforced, each card in
 * the chain waits for the one before it.
 */
export function KanbanTaskChain({
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
  onDone: () => Promise<void>;
}) {
  const { t } = useDesktopText();
  const taskId = String(task['id']);
  const chainId = typeof task['chainId'] === 'string' ? task['chainId'] : '';
  const others = tasks.filter((item) => typeof item['id'] === 'string' && item['id'] !== taskId);
  const [current, setCurrent] = useState<[string, string][]>([]),
    [order, setOrder] = useState<string[]>([]),
    [enforce, setEnforce] = useState(true),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  useEffect(() => {
    if (!chainId) {
      setCurrent([]);
      return;
    }
    let live = true;
    command('kanban.task.chain.get', { boardId, taskId }, ['kanban.task.chain.get'])
      .then((reply) => live && setCurrent(chainCards(reply['data'])))
      .catch(() => live && setCurrent([]));
    return () => {
      live = false;
    };
  }, [boardId, chainId, command, taskId]);
  if (!others.length && !current.length) return null;
  const picked = order.filter((id) => others.some((item) => item['id'] === id));
  const title = (id: string) => String(tasks.find((item) => item['id'] === id)?.['title'] ?? id);
  const save = async () => {
    setBusy(true);
    setResult('');
    try {
      const reply = await command(
        'kanban.task.chain',
        { boardId, taskIds: [taskId, ...picked], enforceDependencies: enforce },
        ['kanban.task.chain'],
      );
      const cards = chainCards(reply['data']);
      setCurrent(cards);
      setOrder([]);
      setResult(t('kanbanChain.chained', { number: cards.length }));
      await onDone();
    } catch (failure) {
      setResult(
        t('kanbanChain.failed', {
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
        <Link2 size={13} />{' '}
        {current.length
          ? t('kanbanChain.summaryCount', { number: current.length })
          : t('kanbanChain.summaryEmpty')}
      </summary>
      {current.length > 0 && (
        <ol aria-label={t('kanbanChain.cards')}>
          {current.map(([id, name]) => (
            <li key={id}>{id === taskId ? <strong>{name}</strong> : name}</li>
          ))}
        </ol>
      )}
      {others.length > 0 && (
        <fieldset disabled={disabled || busy}>
          <legend>{t('kanbanChain.legend')}</legend>
          <ul>
            {others.map((item) => {
              const id = String(item['id']);
              const position = picked.indexOf(id);
              return (
                <li key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={position >= 0}
                      onChange={(event) =>
                        setOrder((value) =>
                          event.target.checked ? [...value, id] : value.filter((v) => v !== id),
                        )
                      }
                    />
                    {position >= 0 ? `${position + 2}. ` : ''}
                    {String(item['title'] ?? id)}
                  </label>
                </li>
              );
            })}
          </ul>
          {picked.length > 0 && (
            <p>{t('kanbanChain.order', { cards: [taskId, ...picked].map(title).join(' → ') })}</p>
          )}
          <label>
            <input
              type="checkbox"
              checked={enforce}
              onChange={(event) => setEnforce(event.target.checked)}
            />
            {t('kanbanChain.enforce')}
          </label>
          <button
            type="button"
            className="button secondary small"
            disabled={!picked.length}
            onClick={() => void save()}
          >
            {t('kanbanChain.save')}
          </button>
        </fieldset>
      )}
      {result && <p role="status">{result}</p>}
    </details>
  );
}
