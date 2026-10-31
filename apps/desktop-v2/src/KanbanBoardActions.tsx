import { Copy, History, MoreHorizontal, Play, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { BOARD_HISTORY_LIMIT, boardHistoryRows, deleteConfirmed } from './kanban-board-actions';
import { boardSource } from './kanban-board-source';
import { Modal } from './Modal';
import { recoveryDate } from './session-recovery-model';

type Dialog = 'duplicate' | 'delete' | 'history' | 'run' | null;

/** Run, duplicate, inspect the history of, or permanently delete the selected board. */
export function KanbanBoardActions({
  command,
  board,
  disabled,
  onDuplicated,
  onDeleted,
  onRunStarted,
}: {
  command: EngineCommand;
  board: Record<string, unknown>;
  disabled: boolean;
  onDuplicated: (boardId: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  /** A Goal or SDD run started from this board (the note says which); it updates its cards. */
  onRunStarted?: ((note: string) => Promise<void>) | undefined;
}) {
  const boardId = String(board['id'] ?? '');
  const title = String(board['title'] ?? '');
  const tasks = entries(board['tasks']);
  const mirrored = boardSource(board);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copyTitle, setCopyTitle] = useState(''),
    [includeTasks, setIncludeTasks] = useState(true),
    [includeCompleted, setIncludeCompleted] = useState(false);
  const [typed, setTyped] = useState('');
  const [allBoards, setAllBoards] = useState(false);
  const [engine, setEngine] = useState<'goal' | 'sdd'>('goal'),
    [autonomous, setAutonomous] = useState(false);
  const [history, setHistory] = useState<ReturnType<typeof boardHistoryRows> | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const openDialog = (next: Dialog) => {
    menu.current?.removeAttribute('open');
    setError('');
    setDialog(next);
    if (next === 'duplicate') setCopyTitle(`${title} (copy)`);
    if (next === 'delete') setTyped('');
    if (next === 'history') void loadHistory(false);
  };
  const close = () => {
    if (!busy) setDialog(null);
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const loadHistory = (all: boolean) =>
    run(async () => {
      setAllBoards(all);
      setHistory(null);
      const reply = await command('kanban.board.history', all ? {} : { boardId }, [
        'kanban.board.history',
      ]);
      setHistory(boardHistoryRows(reply['data']));
    });
  return (
    <>
      <details className="kanban-board-actions" ref={menu}>
        <summary aria-label="Board actions" title="Board actions">
          <MoreHorizontal size={15} />
        </summary>
        <div>
          <button
            type="button"
            disabled={disabled || !!mirrored || !tasks.length}
            title={
              mirrored
                ? 'This board already mirrors a run.'
                : tasks.length
                  ? undefined
                  : 'Add cards before running the board.'
            }
            onClick={() => openDialog('run')}
          >
            <Play size={13} /> Run board…
          </button>
          <button
            type="button"
            disabled={disabled || !!mirrored}
            title={
              mirrored
                ? 'A copy would keep this run’s tags, and the run could then update the copy instead.'
                : undefined
            }
            onClick={() => openDialog('duplicate')}
          >
            <Copy size={13} /> Duplicate board…
          </button>
          <button type="button" onClick={() => openDialog('history')}>
            <History size={13} /> Board history
          </button>
          <button
            type="button"
            className="danger"
            disabled={disabled}
            onClick={() => openDialog('delete')}
          >
            <Trash2 size={13} /> Delete board…
          </button>
        </div>
      </details>
      {dialog === 'duplicate' && (
        <Modal title="Duplicate board" onClose={close}>
          <form
            className="kanban-board-action-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const reply = await command(
                  'kanban.duplicate',
                  {
                    boardId,
                    title: copyTitle.trim(),
                    includeTasks,
                    includeCompletedTasks: includeTasks && includeCompleted,
                    preserveAssignment: false,
                  },
                  ['kanban.duplicate'],
                );
                const created = String(record(reply['data'])['id'] ?? '');
                if (!created) throw Error('The engine did not report the new board.');
                setDialog(null);
                await onDuplicated(created);
              });
            }}
          >
            <label>
              New board title
              <input value={copyTitle} onChange={(event) => setCopyTitle(event.target.value)} />
            </label>
            <label className="kanban-check">
              <input
                type="checkbox"
                checked={includeTasks}
                onChange={(event) => setIncludeTasks(event.target.checked)}
              />
              Copy its {tasks.length} cards
            </label>
            <label className="kanban-check">
              <input
                type="checkbox"
                checked={includeTasks && includeCompleted}
                disabled={!includeTasks}
                onChange={(event) => setIncludeCompleted(event.target.checked)}
              />
              Include completed cards
            </label>
            <p className="settings-defaults-note">
              Copies start unassigned; worker assignments stay with the original board.
            </p>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="button secondary" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy || !copyTitle.trim()}>
                {busy ? 'Duplicating…' : 'Duplicate board'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'run' && (
        <Modal title="Run board" onClose={close}>
          <form
            className="kanban-board-action-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await command(
                  'kanban.run.start',
                  { boardId, engine, ...(engine === 'goal' ? { autonomous } : {}) },
                  ['kanban.run.start'],
                  { timeoutMs: 60000 },
                );
                setDialog(null);
                await onRunStarted?.(
                  engine === 'goal'
                    ? 'A Goal run started from this board.'
                    : 'An SDD run started from this board.',
                );
              });
            }}
          >
            <p className="field-help">
              Starts a run from the {tasks.length} cards on “{title}”. The run updates these cards
              as it works and uses your models, so it costs tokens.
            </p>
            <label className="kanban-check">
              <input
                type="radio"
                name="kanban-run-engine"
                checked={engine === 'goal'}
                onChange={() => setEngine('goal')}
              />
              Goal: phases and tasks run in order
            </label>
            <label className="kanban-check">
              <input
                type="radio"
                name="kanban-run-engine"
                checked={engine === 'sdd'}
                onChange={() => setEngine('sdd')}
              />
              SDD: worker agents run the tasks in worktrees
            </label>
            {engine === 'goal' && (
              <label className="kanban-check">
                <input
                  type="checkbox"
                  checked={autonomous}
                  onChange={(event) => setAutonomous(event.target.checked)}
                />
                Continue through the phases without asking
              </label>
            )}
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="button secondary" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? 'Starting…' : 'Start run'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'delete' && (
        <Modal title="Delete board" onClose={close}>
          <form
            className="kanban-board-action-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!deleteConfirmed(typed, title)) return;
              void run(async () => {
                const reply = await command('kanban.delete', { boardId }, ['kanban.delete']);
                if (record(reply['data'])['removed'] !== true)
                  throw Error('The engine did not remove the board. Refresh and check it.');
                setDialog(null);
                await onDeleted();
              });
            }}
          >
            <p>
              This permanently deletes <strong>{title}</strong>, its {tasks.length} cards and their
              activity. It cannot be undone; the project’s board history keeps only a record that
              the board was deleted.
            </p>
            {mirrored && (
              <p className="settings-defaults-note">
                This board mirrors {mirrored.system === 'goal' ? 'a Goal' : 'an SDD'} run. If the
                run updates it again, the engine creates a new board for it.
              </p>
            )}
            <label>
              Type the board title to confirm
              <input
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="button secondary" disabled={busy} onClick={close}>
                Keep board
              </button>
              <button
                type="submit"
                className="button primary kanban-danger"
                disabled={busy || !deleteConfirmed(typed, title)}
              >
                {busy ? 'Deleting…' : 'Delete board permanently'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'history' && (
        <Modal title="Board history" onClose={close}>
          <div className="kanban-board-history">
            <fieldset className="kanban-history-scope" aria-label="History scope">
              <button
                className="kanban-scope-option"
                type="button"
                aria-pressed={!allBoards}
                disabled={busy}
                onClick={() => void loadHistory(false)}
              >
                This board
              </button>
              <button
                className="kanban-scope-option"
                type="button"
                aria-pressed={allBoards}
                disabled={busy}
                onClick={() => void loadHistory(true)}
              >
                All boards, including deleted
              </button>
            </fieldset>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            {!history && !error && <p role="status">Reading board history…</p>}
            {history && !history.length && (
              <p className="quiet-state">No board history recorded.</p>
            )}
            {history && history.length > 0 && (
              <ol aria-label="Board history entries">
                {history.map((row) => (
                  <li key={row.id}>
                    <strong>{row.label}</strong>
                    {allBoards && <span> · {row.boardTitle || row.boardId}</span>}
                    {row.detail && <span> · {row.detail}</span>}
                    <small>
                      {recoveryDate(row.ts)}
                      {row.actor ? ` · ${row.actor}` : ''}
                    </small>
                  </li>
                ))}
              </ol>
            )}
            {history?.length === BOARD_HISTORY_LIMIT && (
              <p className="settings-defaults-note">
                Showing the newest {BOARD_HISTORY_LIMIT} entries.
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
