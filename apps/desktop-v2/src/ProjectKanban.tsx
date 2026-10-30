import {
  CalendarDays,
  Check,
  CheckCircle2,
  Columns3,
  Flag,
  GripVertical,
  List,
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { BoardDialog } from './KanbanBoardDialog';
import { KanbanBoundaryEditor } from './KanbanBoundaryEditor';
import { KanbanQueueHealth } from './KanbanQueueHealth';
import { KanbanTaskInspector } from './KanbanTaskInspector';
import { type BoardSource, boardSource, type RunFocus, runBoardId } from './kanban-board-source';
import { Modal } from './Modal';
import './kanban.css';

/** A run whose mirror board should be shown; `nonce` distinguishes repeated requests. */
export type KanbanFocus = RunFocus & { nonce: number };

export function ProjectKanban({
  command,
  focus = null,
  onOpenSource,
}: {
  command: EngineCommand;
  focus?: KanbanFocus | null | undefined;
  /** Opens the Goal or SDD view that owns a mirror board's run. */
  onOpenSource?: ((source: BoardSource) => void) | undefined;
}) {
  const [boards, setBoards] = useState<Record<string, unknown>[]>([]);
  const [boardId, setBoardId] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [board, setBoard] = useState<Record<string, unknown> | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [boundaryOpen, setBoundaryOpen] = useState(false);
  const [draftColumn, setDraftColumn] = useState('');
  const [dropColumn, setDropColumn] = useState('');
  const [move, setMove] = useState<{
    task: Record<string, unknown>;
    columnId: string;
    stage: string;
  } | null>(null);
  const [note, setNote] = useState('');
  const [focusNote, setFocusNote] = useState('');
  const handledFocus = useRef(0);
  const generation = useRef(0);
  const activeBoard = useRef(boardId);
  activeBoard.current = boardId;
  const loadBoards = useCallback(async () => {
    const result = await command('kanban.list', {}, ['kanban.list']);
    const all = entries(result['data']).filter(
      (board) => board['kind'] !== 'session_mirror' && board['kind'] !== 'archive',
    );
    setBoards(all);
    setBoardId((current) =>
      all.some((item) => item['id'] === current)
        ? current
        : String(
            all.find((item) => item['kind'] !== 'session_mirror')?.['id'] ?? all[0]?.['id'] ?? '',
          ),
    );
  }, [command]);
  const loadBoard = useCallback(async () => {
    if (!boardId || activeBoard.current !== boardId) return;
    const current = ++generation.current;
    const result = await command('kanban.get', { boardId }, ['kanban.get']);
    if (current === generation.current && activeBoard.current === boardId) {
      const board = record(result['data']);
      setBoard(board);
      setSelected((selected) =>
        selected
          ? (entries(board['tasks']).find((task) => task['id'] === selected['id']) ?? selected)
          : null,
      );
    }
  }, [boardId, command]);
  // A run opened from Goals shows the board its mirror keeps, once the boards are listed.
  useEffect(() => {
    if (!focus || handledFocus.current === focus.nonce || !boards.length) return;
    handledFocus.current = focus.nonce;
    const id = runBoardId(boards, focus);
    if (id) {
      setBoardId(id);
      setFocusNote('');
    } else
      setFocusNote(
        'This goal has no mirror board yet. Its board appears here once the run has started.',
      );
  }, [focus, boards]);
  useEffect(() => {
    void loadBoards().catch((error: unknown) =>
      setError(String(error instanceof Error ? error.message : error)),
    );
  }, [loadBoards]);
  useEffect(() => {
    setBoard(null);
    setSelected(null);
    setEditing(false);
    void loadBoard().catch((error: unknown) =>
      setError(String(error instanceof Error ? error.message : error)),
    );
    const timer = setInterval(() => void loadBoard().catch(() => {}), 4000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [loadBoard]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A stale-version refusal keeps the inspector and its draft open for review.
      setError(message.replace(/^KANBAN_TASK_CONFLICT: /, ''));
    } finally {
      setBusy(false);
    }
  };
  const columns = entries(board?.['columns']).sort(
    (a, b) => Number(a['order']) - Number(b['order']),
  );
  const tasks = entries(board?.['tasks']);
  const matches = tasks.filter((task) =>
    `${task['title']} ${task['description']} ${Array.isArray(task['labels']) ? task['labels'].join(' ') : ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const completed = tasks.filter((task) => task['status'] === 'completed').length;
  const source = boardSource(board);
  const startTask = (task: Record<string, unknown> | null, columnId?: string) => {
    if (busy) return;
    setSelected(task);
    setDraftColumn(columnId ?? String(task?.['columnId'] ?? columns[0]?.['id'] ?? 'backlog'));
    setEditing(true);
  };
  const moveTask = (task: Record<string, unknown>, columnId: string) => {
    if (task['columnId'] === columnId || busy) return;
    const lifecycle = record(board?.['lifecycle']);
    if (lifecycle['mode'] === 'managed') {
      const stage = Object.entries(record(lifecycle['columns'])).find(
        ([, id]) => id === columnId,
      )?.[0];
      if (!stage) {
        setError('This column is outside the board lifecycle.');
        return;
      }
      setMove({ task, columnId, stage });
      setNote('');
      return;
    }
    void run(async () => {
      await command(
        'kanban.task.move',
        { boardId, taskId: task['id'], columnId, activityNote: 'Moved on the project board' },
        ['kanban.task.move'],
      );
      await loadBoard();
    });
  };
  return (
    <section className="kanban-studio" aria-label="Project kanban">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">PLAN TOGETHER. KEEP THE WORK MOVING.</span>
          <h1>
            Kanban<span className="heading-dot">.</span>
          </h1>
          <p>A project board shared by your agents, sessions, and next ideas.</p>
        </div>
        <button type="button" className="button secondary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          New board
        </button>
      </header>
      {error && (
        <div className="session-error" role="alert">
          {error}
        </div>
      )}
      <div className="kanban-workbench">
        <nav className="project-board-list" aria-label="Project boards">
          <header>
            <span className="eyebrow">YOUR BOARDS</span>
            <small>{boards.length}</small>
          </header>
          {boards.map((item) => {
            const total = Number(item['taskCount'] ?? 0);
            const done = Number(item['completedTaskCount'] ?? 0);
            return (
              <button
                type="button"
                key={String(item['id'])}
                aria-label={String(item['title'])}
                disabled={busy}
                aria-current={boardId === item['id'] ? 'page' : undefined}
                onClick={() => setBoardId(String(item['id']))}
              >
                <Columns3 size={16} />
                <span>
                  <strong>{String(item['title'])}</strong>
                  <small>{String(item['description'] || 'Project planning')}</small>
                  <span>
                    {total} tasks · {done} complete
                  </span>
                  <progress max={Math.max(1, total)} value={done} />
                </span>
              </button>
            );
          })}
          {!boards.length && <p>Your project boards will appear here.</p>}
          <button type="button" className="board-list-create" onClick={() => setCreating(true)}>
            <Plus size={14} />
            New board
          </button>
        </nav>
        <div className="kanban-board-content">
          <div className="board-topline">
            <div>
              <Columns3 size={18} className="board-heading-icon" />
              <strong className="board-current-title">
                {String(board?.['title'] ?? 'Choose a board')}
              </strong>
              <span className="board-scope">PROJECT BOARD</span>
            </div>
            <div>
              <span className="board-completion">
                <CheckCircle2 size={14} />
                {completed}/{tasks.length} complete
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Refresh board"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await loadBoards();
                    await loadBoard();
                  })
                }
              >
                <RefreshCw size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Board boundary"
                title="Board boundary"
                disabled={busy || !board}
                onClick={() => setBoundaryOpen(true)}
              >
                <ShieldCheck size={15} />
              </button>
            </div>
          </div>
          {focusNote && <p role="status">{focusNote}</p>}
          {source && (
            <p className="kanban-board-source">
              Mirrors {source.system === 'goal' ? 'a Goal run' : 'an SDD run'}
              {source.phaseId ? ` · phase ${source.phaseId}` : ''}. The run updates these cards.
              {onOpenSource && (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => onOpenSource(source)}
                >
                  {source.system === 'goal' ? 'Open goal' : 'Open SDD'}
                </button>
              )}
            </p>
          )}
          {board && boardId && (
            <KanbanQueueHealth
              command={command}
              boardId={boardId}
              revision={board}
              disabled={busy}
              onOpenTask={(taskId) => {
                const task = tasks.find((item) => item['id'] === taskId);
                if (task) setSelected(task);
                else setError('That card is no longer on this board. Refresh the board.');
              }}
              onAudited={async () => {
                await loadBoards();
                await loadBoard();
              }}
            />
          )}
          {boundaryOpen && board && (
            <Modal title="Board resource boundary" onClose={() => setBoundaryOpen(false)}>
              <KanbanBoundaryEditor
                key={boardId}
                board={board}
                boardId={boardId}
                command={command}
                disabled={busy}
                onSaved={loadBoard}
              />
            </Modal>
          )}
          <progress
            className="board-progress"
            max={Math.max(tasks.length, 1)}
            value={completed}
            aria-label={`${completed} of ${tasks.length} tasks complete`}
          />
          <div className="studio-toolbar">
            <input
              aria-label="Search project tasks"
              placeholder="Find a task, label, or idea…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <fieldset className="view-segment" aria-label="Task view">
              <button
                type="button"
                aria-pressed={view === 'board'}
                onClick={() => setView('board')}
              >
                <Columns3 size={14} />
                Board
              </button>
              <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                <List size={14} />
                List
              </button>
            </fieldset>
            <span className="board-task-count">{matches.length} tasks</span>
            <button
              type="button"
              className="button primary"
              disabled={!board || busy}
              onClick={() => startTask(null)}
            >
              <Plus size={14} />
              Add task
            </button>
          </div>
          {!boards.length ? (
            <div className="board-empty">
              <Columns3 size={40} />
              <h2>A clear place for the next step.</h2>
              <p>
                Create a board for your roadmap, release, or ongoing work. Its tasks belong to this
                project.
              </p>
              <button type="button" className="button primary" onClick={() => setCreating(true)}>
                Create your first board
              </button>
            </div>
          ) : !board ? (
            <p className="quiet-state">Opening your board…</p>
          ) : (
            <div className={`board-layout ${editing ? 'with-task-inspector' : ''}`}>
              {view === 'list' ? (
                <section className="task-list-view" aria-label="Board task list">
                  <div className="task-list-heading">
                    <span>Task</span>
                    <span>Stage</span>
                    <span>Priority</span>
                    <span>Owner / due</span>
                  </div>
                  {matches.map((task) => (
                    <button
                      type="button"
                      key={String(task['id'])}
                      aria-label={String(task['title'])}
                      disabled={busy}
                      aria-pressed={editing && selected?.['id'] === task['id']}
                      onClick={() => startTask(task)}
                    >
                      <span>
                        <strong>{String(task['title'])}</strong>
                        <small>{String(task['description'] ?? '')}</small>
                      </span>
                      <span>
                        {String(
                          columns.find((c) => c['id'] === task['columnId'])?.['title'] ??
                            task['status'],
                        )}
                      </span>
                      <span className={`task-priority priority-${task['priority']}`}>
                        {String(task['priority'])}
                      </span>
                      <span>
                        {String(task['assignee'] ?? task['assignedAgent'] ?? 'Unassigned')}
                        <small>
                          {task['dueDate']
                            ? new Date(String(task['dueDate'])).toLocaleDateString()
                            : 'No due date'}
                        </small>
                      </span>
                    </button>
                  ))}
                  {!matches.length && <p className="quiet-state">No tasks match this view.</p>}
                </section>
              ) : (
                <div className="kanban-columns">
                  {columns.map((column, index) => {
                    const items = matches
                      .filter((task) => task['columnId'] === column['id'])
                      .sort((a, b) => Number(a['order']) - Number(b['order']));
                    return (
                      <section
                        key={String(column['id'])}
                        className={`kanban-column board-column-${index % 5} ${dropColumn === column['id'] ? 'column-drop-target' : ''}`}
                        aria-label={`${column['title']} column`}
                        onDragOver={(event) => {
                          if (event.dataTransfer.types.includes('application/x-wrongstack-task')) {
                            event.preventDefault();
                            setDropColumn(String(column['id']));
                          }
                        }}
                        onDragLeave={() => setDropColumn('')}
                        onDrop={(event) => {
                          event.preventDefault();
                          setDropColumn('');
                          try {
                            const source = JSON.parse(
                              event.dataTransfer.getData('application/x-wrongstack-task'),
                            ) as { boardId: string; taskId: string };
                            const task = tasks.find((task) => task['id'] === source.taskId);
                            if (source.boardId === boardId && task)
                              moveTask(task, String(column['id']));
                          } catch {
                            setError('This card could not be moved.');
                          }
                        }}
                      >
                        <header>
                          <span className="column-dot" />
                          <h2>{String(column['title'])}</h2>
                          <span>{items.length}</span>
                          <button
                            type="button"
                            className="icon-button column-new-task"
                            aria-label={`Add task to ${column['title']}`}
                            onClick={() => startTask(null, String(column['id']))}
                          >
                            <Plus size={14} />
                          </button>
                        </header>
                        <div className="kanban-card-list">
                          {items.map((task) => (
                            <button
                              type="button"
                              key={String(task['id'])}
                              className={`kanban-task-card ${selected?.['id'] === task['id'] && editing ? 'task-selected' : ''}`}
                              draggable={!busy}
                              disabled={busy}
                              onDragStart={(event) => {
                                event.dataTransfer.setData(
                                  'application/x-wrongstack-task',
                                  JSON.stringify({ boardId, taskId: task['id'] }),
                                );
                                event.dataTransfer.effectAllowed = 'move';
                              }}
                              onClick={() => startTask(task)}
                              aria-label={String(task['title'])}
                            >
                              <div className="task-card-top">
                                <span className={`task-priority priority-${task['priority']}`}>
                                  <Flag size={11} />
                                  {String(task['priority'] ?? 'medium')}
                                </span>
                                <GripVertical size={13} />
                              </div>
                              <h3>{String(task['title'])}</h3>
                              {Boolean(task['description']) && <p>{String(task['description'])}</p>}
                              <div className="task-labels">
                                {(Array.isArray(task['labels']) ? task['labels'] : [])
                                  .slice(0, 3)
                                  .map((label) => (
                                    <span key={String(label)}>{String(label)}</span>
                                  ))}
                              </div>
                              <footer>
                                <span>
                                  {String(
                                    task['assignee'] ?? task['assignedAgent'] ?? 'Unassigned',
                                  )}
                                </span>
                                <div className="task-card-meta">
                                  {Boolean(task['dueDate']) && (
                                    <span className="task-card-meta-item">
                                      <CalendarDays size={11} />
                                      {new Date(String(task['dueDate'])).toLocaleDateString(
                                        undefined,
                                        {
                                          month: 'short',
                                          day: 'numeric',
                                        },
                                      )}
                                    </span>
                                  )}
                                  {entries(task['notes']).length > 0 && (
                                    <span className="task-card-meta-item">
                                      <MessageSquare size={11} />
                                      {entries(task['notes']).length}
                                    </span>
                                  )}
                                </div>
                              </footer>
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="column-add-task"
                          onClick={() => startTask(null, String(column['id']))}
                        >
                          <Plus size={13} />
                          Add task
                        </button>
                      </section>
                    );
                  })}
                </div>
              )}
              {editing && (
                <KanbanTaskInspector
                  key={String(selected?.['id'] ?? `new-${draftColumn}`)}
                  task={selected}
                  board={board}
                  command={command}
                  onRefresh={async () => {
                    await loadBoard();
                    await loadBoards();
                  }}
                  onSelect={(task) => startTask(task)}
                  columns={columns}
                  columnId={draftColumn}
                  busy={busy}
                  onClose={() => setEditing(false)}
                  onMove={(columnId) => {
                    if (selected) moveTask(selected, columnId);
                  }}
                  onSave={(draft) =>
                    void run(async () => {
                      const type = selected ? 'kanban.task.update' : 'kanban.task.add';
                      await command(
                        type,
                        {
                          boardId,
                          ...(selected ? { taskId: selected['id'] } : { columnId: draftColumn }),
                          ...draft,
                        },
                        [type],
                      );
                      setEditing(false);
                      await loadBoard();
                      await loadBoards();
                    })
                  }
                  onDelete={() =>
                    void run(async () => {
                      if (!selected) return;
                      await command('kanban.task.remove', { boardId, taskId: selected['id'] }, [
                        'kanban.task.remove',
                      ]);
                      setEditing(false);
                      await loadBoard();
                    })
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>
      {creating && (
        <BoardDialog
          onClose={() => setCreating(false)}
          busy={busy}
          onCreate={(title, description) =>
            void run(async () => {
              const reply = await command('kanban.create', { title, description }, [
                'kanban.create',
              ]);
              const saved = record(reply['data']);
              await loadBoards();
              setBoardId(String(saved['id']));
              setCreating(false);
            })
          }
          onGenerate={(title, list) =>
            void run(async () => {
              const reply = await command('kanban.generate', { title, description: list }, [
                'kanban.generate',
              ]);
              const saved = record(reply['data']);
              await loadBoards();
              setBoardId(String(saved['id']));
              setCreating(false);
            })
          }
        />
      )}
      {move && (
        <TransitionDialog
          busy={busy}
          title={String(move.task['title'])}
          stage={move.stage}
          note={note}
          onNote={setNote}
          onClose={() => setMove(null)}
          onConfirm={() =>
            void run(async () => {
              await command(
                'kanban.task.transition',
                {
                  boardId,
                  taskId: move.task['id'],
                  to: move.stage,
                  actor: 'desktop-user',
                  comment: note,
                },
                ['kanban.task.transition'],
              );
              setMove(null);
              await loadBoard();
            })
          }
        />
      )}
    </section>
  );
}
function TransitionDialog({
  busy,
  title,
  stage,
  note,
  onNote,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  title: string;
  stage: string;
  note: string;
  onNote: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-label="Move managed task" onCancel={onClose}>
      <header>
        <h2>Move to {stage}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel task move"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <p>{title}</p>
      <p>
        This board uses a managed workflow. The engine checks dependencies and verification before
        allowing the move.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <label>
          Reason
          <textarea
            aria-label="Task transition reason"
            required
            value={note}
            onChange={(event) => onNote(event.target.value)}
            rows={3}
          />
        </label>
        <button type="submit" className="button primary" disabled={busy || !note.trim()}>
          <Check size={14} />
          Move task
        </button>
      </form>
    </dialog>
  );
}
