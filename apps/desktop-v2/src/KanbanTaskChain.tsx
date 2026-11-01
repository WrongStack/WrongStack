import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
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
      setResult(`Chained ${cards.length} cards.`);
      await onDone();
    } catch (failure) {
      setResult(
        `The chain was not saved: ${failure instanceof Error ? failure.message : String(failure)}.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="kanban-task-merge">
      <summary>
        <Link2 size={13} /> Chain{' '}
        {current.length ? `· ${current.length} cards` : 'with other cards'}
      </summary>
      {current.length > 0 && (
        <ol aria-label="Cards in this chain">
          {current.map(([id, name]) => (
            <li key={id}>{id === taskId ? <strong>{name}</strong> : name}</li>
          ))}
        </ol>
      )}
      {others.length > 0 && (
        <fieldset disabled={disabled || busy}>
          <legend>Cards that follow this one, in the order you pick them</legend>
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
          {picked.length > 0 && <p>Order: {[taskId, ...picked].map(title).join(' → ')}</p>}
          <label>
            <input
              type="checkbox"
              checked={enforce}
              onChange={(event) => setEnforce(event.target.checked)}
            />
            Each card waits for the one before it
          </label>
          <button
            type="button"
            className="button secondary small"
            disabled={!picked.length}
            onClick={() => void save()}
          >
            Save chain
          </button>
        </fieldset>
      )}
      {result && <p role="status">{result}</p>}
    </details>
  );
}
