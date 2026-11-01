import { ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { KanbanTaskChain } from './KanbanTaskChain';
import { KanbanTaskMerge } from './KanbanTaskMerge';
import { KanbanTaskMetrics } from './KanbanTaskMetrics';

/**
 * Copies or moves one card to another project board. The engine keeps the card's column; card
 * dependencies are board-local, so they do not travel. A move copies first and then removes the
 * original, so a failure after the copy can leave the card on both boards; the result says so.
 */
export function KanbanTaskTransfer({
  command,
  board,
  task,
  boards,
  disabled,
  onDone,
}: {
  command: EngineCommand;
  /** The open board; its cards are offered for merging with this one. */
  board: Record<string, unknown>;
  task: Record<string, unknown>;
  boards: Record<string, unknown>[];
  disabled: boolean;
  onDone: (targetBoardId: string, moved: boolean) => Promise<void>;
}) {
  const boardId = String(board['id']),
    taskId = String(task['id']),
    tasks = entries(board['tasks']);
  const targets = boards.filter((item) => item['id'] !== boardId);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const chosen = targets.some((item) => item['id'] === target) ? target : '';
  const send = async (moved: boolean) => {
    if (!chosen) return;
    setBusy(true);
    setResult('');
    const type = moved ? 'kanban.task.transfer' : 'kanban.task.copy';
    try {
      const reply = await command(
        type,
        { boardId, taskId, targetBoardId: chosen, preserveDependencies: false },
        [type],
      );
      if (record(reply['data'])['id'] !== chosen)
        throw Error('The engine did not report the target board.');
      const title = String(targets.find((item) => item['id'] === chosen)?.['title'] ?? chosen);
      setResult(`${moved ? 'Moved' : 'Copied'} to ${title}.`);
      await onDone(chosen, moved);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      setResult(
        moved
          ? `The move did not complete: ${message}. Check both boards; the card can be on both.`
          : `The copy did not complete: ${message}.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const merge = (
    <>
      <KanbanTaskMetrics
        command={command}
        boardId={boardId}
        task={task}
        disabled={disabled}
        onDone={() => onDone(boardId, false)}
      />
      <KanbanTaskChain
        command={command}
        boardId={boardId}
        task={task}
        tasks={tasks}
        disabled={disabled}
        // Chaining keeps the card open; the board refresh shows the new dependencies.
        onDone={() => onDone(boardId, false)}
      />
      <KanbanTaskMerge
        command={command}
        boardId={boardId}
        task={task}
        tasks={tasks}
        disabled={disabled}
        // The card was merged into a new one: leave it the way a move does when sources close.
        onDone={() => onDone(boardId, true)}
      />
    </>
  );
  if (!targets.length) return merge;
  return (
    <>
      {merge}
      <section className="kanban-task-transfer" aria-label="Copy or move to another board">
        <label>
          <ArrowRightLeft size={13} /> Another board
          <select
            value={chosen}
            disabled={disabled || busy}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Choose a board…</option>
            {targets.map((item) => (
              <option key={String(item['id'])} value={String(item['id'])}>
                {String(item['title'] ?? item['id'])}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || busy || !chosen}
            onClick={() => void send(false)}
          >
            Copy card
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={disabled || busy || !chosen}
            onClick={() => void send(true)}
          >
            Move card
          </button>
        </div>
        <small>Same column on the target board; dependencies on this board are not carried.</small>
        {result && <p role="status">{result}</p>}
      </section>
    </>
  );
}
