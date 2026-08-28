import type { KanbanBoardPresence, KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import { Copy, History, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHorizontalScroll } from '@/hooks/useHorizontalScroll';
import { useAppTranslation } from '@/i18n';
import { auditKanbanBoard } from '@/lib/kanban-cleaner';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useFleetStore, useSessionStore } from '@/stores';
import { useKanbanStore } from '@/stores/kanban-store';
import { useActiveSessionId } from '@/stores/session-lanes';
import { BoardPresence, SupervisorBar } from './KanbanBoardChrome.js';
import { KanbanBoardSidebar } from './KanbanBoardSidebar';
import {
  collectActiveSessionIds,
  isKanbanBoardActive,
  parseRunLink,
  runningBoardCostTotal,
} from './KanbanBoardState';
import { KanbanBoundaryEditor } from './KanbanBoundaryEditor';
import { KanbanCleanerAlert } from './KanbanCleanerAlert';
import { KanbanColumnView } from './KanbanColumnView';
import { KanbanContractGraphDashboard } from './KanbanContractGraphDashboard';
import { KanbanDecompositionApprovalCard } from './KanbanDecompositionPanel';
import { KanbanQueueHealthBar } from './KanbanQueueHealthBar';
import { RunControlBar, StartAsBar } from './KanbanRunControls.js';
import { KanbanTaskInspector } from './KanbanTaskInspector';
import { KanbanTaskTree } from './KanbanTaskTree';
import { KanbanVerificationDashboard } from './KanbanVerificationDashboard';
import { type KanbanViewMode, KanbanViewModeTabs } from './KanbanViewModeTabs';
import { KanbanWorkbench } from './KanbanWorkbench';
import { useKanbanRegistrySessionIds } from './useKanbanRegistrySessionIds';

export const TASK_ACTIVITY_LOAD_LIMIT = 5_000;
const BOARD_PAGE_SIZE = 12;

export { deriveTaskCardIntelligence, type TaskCardIntelligence } from './KanbanColumnView';

export function KanbanView({ onClose }: { onClose?: (() => void) | undefined }) {
  const { t } = useAppTranslation();
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const activeSessionId = useActiveSessionId();
  const sessionRecordId = useSessionStore((s) => s.session?.id ?? null);
  const sessionId = activeSessionId ?? sessionRecordId;
  const fleetAgents = useFleetStore((s) => s.agents);
  const {
    boards,
    boardTotal,
    activeBoardTotal,
    orphanedBoardTotal,
    activeBoardId,
    activeBoard,
    loading,
    error,
    queueHealth,
    supervisorSnapshot,
    workbench,
    boardHistory,
    setActiveBoardId,
    setError,
    fetchBoardHistory,
  } = useKanbanStore();
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [boardPage, setBoardPage] = useState(1);
  const registrySessionIds = useKanbanRegistrySessionIds();
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const boardScrollRef = useRef<HTMLDivElement>(null);
  useHorizontalScroll(boardScrollRef);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [taskActivity, setTaskActivity] = useState<KanbanEvent[]>([]);
  const [taskActivityPresence, setTaskActivityPresence] = useState<
    KanbanBoardPresence[] | undefined
  >();
  const [taskActivityLoading, setTaskActivityLoading] = useState(false);
  const [taskActivityError, setTaskActivityError] = useState<string | null>(null);
  const [taskActivityRefresh, setTaskActivityRefresh] = useState(0);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<KanbanViewMode>('board');
  const pendingWorkbenchTaskRef = useRef<{ boardId: string; taskId: string } | null>(null);
  const [confirmDeleteBoard, setConfirmDeleteBoard] = useState(false);
  // The board the armed delete belongs to. A click can only delete when the
  // armed board is still the active one — otherwise a board switch that
  // happens between the state reset and its passive effect would let a stale
  // "Confirm?" button delete the newly selected board.
  const armedDeleteBoardIdRef = useRef<string | null>(null);
  const autoSelectedSessionRef = useRef<string | null>(null);
  // A sidebar page change clears the selection on purpose; suppressing the
  // auto-select until the user explicitly picks a board stops the board[0]
  // fallback from yanking them to a board on the newly shown page.
  const skipBoardAutoSelectRef = useRef(false);

  // Two-step delete: the second click on the header trash actually deletes.
  // Disarm on a timeout so an armed button can't fire on a later stray click.
  useEffect(() => {
    if (!confirmDeleteBoard) return;
    const timer = window.setTimeout(() => {
      setConfirmDeleteBoard(false);
      armedDeleteBoardIdRef.current = null;
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteBoard]);
  // Switching boards while the button is armed must not delete the old one.
  useEffect(() => {
    setConfirmDeleteBoard(false);
    armedDeleteBoardIdRef.current = null;
  }, [activeBoardId]);

  const ws = useMemo(() => getWSClient(wsUrl), [wsUrl]);
  const selectedTask = activeBoard?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  // Preserve reference identity while the CONTENTS are unchanged.
  // `fleetAgents` is a fresh Map on every subagent event (fleet-store
  // allocates unconditionally), so this memo recomputes constantly while
  // agents stream — and every recompute used to return a brand-new array.
  // The 8s board-list poll below keys its effect on this value; with a new
  // identity per event the interval was torn down and recreated before it
  // ever fired, so `kanban.list` never ran at exactly the moment new
  // mirror boards appear.
  const activeSessionIdsRef = useRef<string[]>([]);
  const activeSessionIds = useMemo(() => {
    const next = collectActiveSessionIds({
      sessionId,
      registrySessionIds,
      agents: fleetAgents.values(),
    });
    const prev = activeSessionIdsRef.current;
    if (prev.length === next.length && prev.every((id, index) => id === next[index])) {
      return prev;
    }
    activeSessionIdsRef.current = next;
    return next;
  }, [fleetAgents, registrySessionIds, sessionId]);
  const activeBoards = boards.filter((board) => isKanbanBoardActive(board, activeSessionIds));
  const orphanedBoards = boards.filter((board) => !isKanbanBoardActive(board, activeSessionIds));
  const boardAudit = useMemo(
    () =>
      activeBoard
        ? auditKanbanBoard(activeBoard, {
            now: Date.now(),
            requireDueDate: activeBoard.lifecycle?.mode === 'managed',
          })
        : null,
    [activeBoard],
  );

  const runningCostTotal = useMemo(() => runningBoardCostTotal(activeBoard), [activeBoard]);

  const sendKanban = (type: `kanban.${string}`, payload: Record<string, unknown> = {}) => {
    useKanbanStore.getState().sendKanban(type, payload);
    // Name the tab doing the work. Boards are addressed by `boardId` so their
    // contents never crossed tabs, but every activity entry and presence ping
    // was stamped with whichever session the runtime was on — tab 3 moving a
    // card was recorded as tab 1's work.
    ws.send({ type, payload: sessionId ? { ...payload, sessionId } : payload });
  };

  // Raw send for run-control messages (sdd.board.* / goal.*) — these steer
  // the live run, which mirrors back into this board; no kanban response.
  const sendRaw = (type: string, payload: Record<string, unknown> = {}) => {
    (ws.send as (m: { type: string; payload?: unknown }) => void)({ type, payload });
  };

  const runLink = useMemo(() => parseRunLink(activeBoard), [activeBoard]);

  const refreshBoards = (page = boardPage) =>
    sendKanban('kanban.list', {
      page,
      pageSize: BOARD_PAGE_SIZE,
      activeSessionIds,
    });

  useEffect(() => {
    refreshBoards();
    sendKanban('kanban.workbench', { limitPerLane: 8, alertLimit: 8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // A page change clears the selection on purpose; don't re-pick boards[0]
    // (or re-pin the session board) until the user explicitly chooses.
    if (skipBoardAutoSelectRef.current) return;
    const sessionBoard = sessionId
      ? boards.find((candidate) => candidate.tags?.includes(`session:${sessionId}`))
      : undefined;
    const shouldSelectSession =
      Boolean(sessionId && sessionBoard) && autoSelectedSessionRef.current !== sessionId;
    const target = shouldSelectSession ? sessionBoard : !activeBoardId ? boards[0] : undefined;
    if (target?.id) {
      if (shouldSelectSession) autoSelectedSessionRef.current = sessionId;
      setActiveBoardId(target.id);
      sendKanban('kanban.get', { boardId: target.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, activeBoardId, sessionId, setActiveBoardId]);

  useEffect(() => {
    if (
      activeBoard &&
      selectedTaskId &&
      !activeBoard.tasks.some((task) => task.id === selectedTaskId)
    ) {
      setSelectedTaskId(null);
    }
  }, [activeBoard, selectedTaskId]);

  useEffect(() => {
    const pending = pendingWorkbenchTaskRef.current;
    if (!pending || activeBoard?.id !== pending.boardId) return;
    if (activeBoard.tasks.some((task) => task.id === pending.taskId)) {
      setSelectedTaskId(pending.taskId);
      setViewMode('board');
    }
    pendingWorkbenchTaskRef.current = null;
  }, [activeBoard]);

  useEffect(() => {
    if (activeBoardId) {
      sendKanban('kanban.health', { boardId: activeBoardId });
      sendKanban('kanban.supervisor.status', { boardId: activeBoardId });
      fetchBoardHistory(activeBoardId);
    }
  }, [activeBoardId, fetchBoardHistory]);

  // ── Live polling — fallback refresh every 5s while active ──
  // The primary update path is now push-based: the server broadcasts kanban.get
  // via a file watcher whenever the board JSON changes on disk. This poll
  // exists only as a safety net for edge cases the watcher may miss.
  // Reduced from 3s to 5s to cut redundant WS traffic.
  useEffect(() => {
    if (!activeBoardId) return;
    const interval = setInterval(() => {
      ws.send({ type: 'kanban.get', payload: { boardId: activeBoardId } });
      ws.send({ type: 'kanban.health', payload: { boardId: activeBoardId } });
    }, 5000);
    return () => clearInterval(interval);
  }, [activeBoardId, ws]);

  // ── Board-list poll — fallback every 8s ──
  // Primary path is push-based (file watcher broadcasts kanban.get). Re-list
  // less aggressively since push covers the active board.
  useEffect(() => {
    const interval = setInterval(() => {
      ws.send({
        type: 'kanban.list',
        payload: { page: boardPage, pageSize: BOARD_PAGE_SIZE, activeSessionIds },
      });
    }, 8000);
    return () => clearInterval(interval);
  }, [activeSessionIds, boardPage, ws]);

  useEffect(() => {
    const interval = setInterval(() => {
      ws.send({ type: 'kanban.workbench', payload: { limitPerLane: 8, alertLimit: 8 } });
    }, 15_000);
    return () => clearInterval(interval);
  }, [ws]);

  const changeBoardPage = (page: number) => {
    setBoardPage(page);
    setActiveBoardId(null);
    skipBoardAutoSelectRef.current = true;
    refreshBoards(page);
  };

  useEffect(() => {
    setTaskActivityPresence(undefined);
  }, [activeBoardId, selectedTaskId]);

  useEffect(() => {
    if (!activeBoardId || !selectedTaskId) {
      return;
    }
    const boardId = activeBoardId;
    const taskId = selectedTaskId;
    setTaskActivityLoading(true);
    setTaskActivityError(null);
    const off = ws.on('kanban.task.activity', (message) => {
      const payload = message.payload as {
        success?: boolean;
        error?: string;
        data?: {
          boardId?: string;
          taskId?: string;
          events?: KanbanEvent[];
          presence?: KanbanBoardPresence[];
        };
      };
      if (payload.success === false) {
        setTaskActivityError(payload.error ?? 'Task activity could not be loaded.');
        setTaskActivityLoading(false);
        return;
      }
      if (payload.data?.boardId !== boardId || payload.data.taskId !== taskId) return;
      setTaskActivity(payload.data.events ?? []);
      setTaskActivityPresence(payload.data.presence ?? []);
      setTaskActivityLoading(false);
    });
    ws.send({
      type: 'kanban.task.activity',
      payload: { boardId, taskId, limit: TASK_ACTIVITY_LOAD_LIMIT },
    });
    return off;
  }, [activeBoardId, selectedTaskId, selectedTask?.updatedAt, taskActivityRefresh, ws]);

  // File reads/writes are appended without mutating the card itself. Refresh
  // the open ledger when the server announces new task-scoped telemetry.
  useEffect(() => {
    if (!activeBoardId || !selectedTaskId) return;
    const onMessage = ws.on.bind(ws) as (
      type: string,
      listener: (message: { payload: unknown }) => void,
    ) => () => void;
    return onMessage('kanban.task.activity.changed', (message) => {
      const payload = message.payload as { boardId?: string; taskId?: string };
      if (payload.boardId === activeBoardId && payload.taskId === selectedTaskId) {
        setTaskActivityRefresh((value) => value + 1);
      }
    });
  }, [activeBoardId, selectedTaskId, ws]);

  const createBoard = () => {
    const title = newBoardTitle.trim();
    if (!title) return;
    setNewBoardTitle('');
    sendKanban('kanban.create', {
      title,
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
  };

  const createTask = () => {
    if (!activeBoard) return;
    const title = newTaskTitle.trim();
    if (!title) return;
    setNewTaskTitle('');
    sendKanban('kanban.task.add', {
      boardId: activeBoard.id,
      title,
      columnId: activeBoard.columns[0]?.id ?? 'backlog',
      activityNote: 'Task created manually in WebUI.',
    });
  };

  const deleteBoard = () => {
    if (!activeBoard) return;
    sendKanban('kanban.delete', { boardId: activeBoard.id });
  };

  const duplicateBoard = () => {
    if (!activeBoard) return;
    sendKanban('kanban.duplicate', {
      boardId: activeBoard.id,
      title: `${activeBoard.title} Copy`,
    });
  };

  const deleteTask = (task: KanbanTask) => {
    if (!activeBoard) return;
    sendKanban('kanban.task.remove', { boardId: activeBoard.id, taskId: task.id });
  };

  const moveTask = (taskId: string, columnId: string) => {
    if (!activeBoard) return;
    const task = activeBoard.tasks.find((candidate) => candidate.id === taskId);
    const from = activeBoard.columns.find((column) => column.id === task?.columnId)?.title;
    const to = activeBoard.columns.find((column) => column.id === columnId)?.title ?? columnId;
    sendKanban('kanban.task.move', {
      boardId: activeBoard.id,
      taskId,
      columnId,
      activityNote: `Moved in WebUI${from ? ` from ${from}` : ''} to ${to}.`,
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground md:flex-row">
      <KanbanBoardSidebar
        boardTotal={boardTotal}
        activeBoardTotal={activeBoardTotal}
        orphanedBoardTotal={orphanedBoardTotal}
        activeBoardId={activeBoardId}
        activeBoards={activeBoards}
        orphanedBoards={orphanedBoards}
        boardPage={boardPage}
        boardPageSize={BOARD_PAGE_SIZE}
        loading={loading}
        newBoardTitle={newBoardTitle}
        onClose={onClose}
        onRefresh={() => refreshBoards()}
        onNewBoardTitleChange={setNewBoardTitle}
        onCreateBoard={createBoard}
        onBoardSelect={(boardId) => {
          skipBoardAutoSelectRef.current = false;
          setActiveBoardId(boardId);
          sendKanban('kanban.get', { boardId });
        }}
        onBoardPageChange={changeBoardPage}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-4">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <h1 className="truncate text-sm font-semibold">
              {activeBoard?.title ?? 'No board selected'}
            </h1>
            <div className="truncate text-[11px] text-muted-foreground">
              {activeBoard
                ? `${activeBoard.columns.length} columns / ${activeBoard.tasks.length} tasks`
                : 'Create or select a board'}
            </div>
          </div>
          {activeBoard && (
            <>
              <input
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createTask();
                }}
                placeholder={t('activity:kanban.newTask')}
                className="h-8 w-[calc(100%-2.5rem)] min-w-0 flex-none rounded-md border bg-background px-2 text-sm outline-none focus:border-primary sm:w-56"
              />
              <button
                type="button"
                title={t('activity:kanban.addTask')}
                onClick={createTask}
                className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                title={t('activity:kanban.duplicateBoard')}
                onClick={duplicateBoard}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Copy size={16} />
              </button>
              <button
                type="button"
                aria-pressed={showHistory}
                title={t('activity:kanban.boardHistory')}
                onClick={() => {
                  if (!showHistory && activeBoardId) fetchBoardHistory(activeBoardId);
                  setShowHistory(!showHistory);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground"
              >
                <History size={16} />
              </button>
              <button
                type="button"
                aria-pressed={confirmDeleteBoard}
                title={
                  confirmDeleteBoard
                    ? t('activity:kanban.confirmDeleteBoard')
                    : t('activity:kanban.deleteBoard')
                }
                onClick={() => {
                  if (confirmDeleteBoard && armedDeleteBoardIdRef.current === activeBoard?.id) {
                    setConfirmDeleteBoard(false);
                    armedDeleteBoardIdRef.current = null;
                    deleteBoard();
                  } else {
                    armedDeleteBoardIdRef.current = activeBoard?.id ?? null;
                    setConfirmDeleteBoard(true);
                  }
                }}
                className={cn(
                  'hidden h-8 items-center justify-center rounded-md border transition-colors sm:flex',
                  confirmDeleteBoard
                    ? 'w-16 gap-1 border-destructive/40 bg-destructive/15 text-[11px] font-semibold text-destructive'
                    : 'w-16 text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                )}
              >
                {confirmDeleteBoard ? t('activity:kanban.confirmDelete') : <Trash2 size={16} />}
              </button>
            </>
          )}
        </header>

        {activeBoard && <BoardPresence presence={activeBoard.presence} />}
        {activeBoard && (
          <div className="shrink-0 border-b px-3 py-2 sm:px-4">
            <KanbanBoundaryEditor
              title={t('activity:kanban.boardBoundary')}
              value={activeBoard.boundary}
              onSave={(boundary) => {
                sendKanban('kanban.update', { boardId: activeBoard.id, boundary });
              }}
            />
          </div>
        )}
        {activeBoard && runLink && <RunControlBar runLink={runLink} sendRaw={sendRaw} />}
        {activeBoard && !runLink && activeBoard.tasks.length > 0 && (
          <StartAsBar boardId={activeBoard.id} sendKanban={sendKanban} />
        )}
        {activeBoard && (
          <SupervisorBar
            board={activeBoard}
            snapshot={supervisorSnapshot}
            sendKanban={sendKanban}
          />
        )}
        {boardAudit && <KanbanCleanerAlert audit={boardAudit} onSelectTask={setSelectedTaskId} />}
        {activeBoard && (
          <KanbanDecompositionApprovalCard
            board={activeBoard}
            sendKanban={sendKanban}
            onSelectTask={setSelectedTaskId}
          />
        )}
        <KanbanViewModeTabs
          viewMode={viewMode}
          onViewModeChange={(nextMode) => {
            setViewMode(nextMode);
            if (nextMode === 'focus') {
              sendKanban('kanban.workbench', { limitPerLane: 8, alertLimit: 8 });
            }
          }}
        />

        {error && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 text-sm text-destructive">
            <X size={15} />
            <span className="min-w-0 flex-1 truncate">{error}</span>
            <button
              type="button"
              aria-label={t('common:action.close')}
              onClick={() => setError(null)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-destructive/20"
            >
              <X size={15} />
            </button>
          </div>
        )}

        <div
          ref={boardScrollRef}
          className="kanban-scroll-area min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-contain"
        >
          {showHistory ? (
            <div className="h-full overflow-y-auto p-4">
              <div className="mx-auto max-w-2xl">
                <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
                  {t('activity:kanban.boardHistory')}
                </h3>
                {boardHistory.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('activity:kanban.noHistory')}</p>
                ) : (
                  <ol className="space-y-2">
                    {[...boardHistory].reverse().map((entry) => (
                      <li key={entry.id} className="rounded-md border bg-card p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {entry.type === 'board.created' && '🎉 '}
                            {entry.type === 'board.updated' && '✏️ '}
                            {entry.type === 'board.deleted' && '🗑️ '}
                            {entry.type === 'board.duplicated' && '📋 '}
                            {entry.type === 'board.lifecycle.adopted' && '🔄 '}
                            {entry.type.replace(/^board\./, '')}
                          </span>
                          <time className="text-xs text-muted-foreground">
                            {new Date(entry.ts).toLocaleString()}
                          </time>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {entry.boardTitle}
                          {entry.actor ? ` · ${entry.actor}` : ''}
                        </div>
                        {entry.note ? (
                          <div className="mt-1 text-xs italic text-muted-foreground">
                            {entry.note}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ) : viewMode === 'focus' ? (
            <KanbanWorkbench
              snapshot={workbench}
              loading={loading}
              error={error}
              onRetry={() => sendKanban('kanban.workbench', { limitPerLane: 8, alertLimit: 8 })}
              onSelectTask={(boardId, taskId) => {
                pendingWorkbenchTaskRef.current = { boardId, taskId };
                setActiveBoardId(boardId);
                sendKanban('kanban.get', { boardId });
              }}
            />
          ) : activeBoard ? (
            <>
              {queueHealth && (
                <KanbanQueueHealthBar
                  queueHealth={queueHealth}
                  runningCostTotal={runningCostTotal}
                />
              )}
              {viewMode === 'tree' ? (
                <KanbanTaskTree
                  board={activeBoard}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={setSelectedTaskId}
                />
              ) : viewMode === 'contracts' ? (
                <KanbanContractGraphDashboard
                  board={activeBoard}
                  onSelectTask={setSelectedTaskId}
                />
              ) : viewMode === 'dashboard' ? (
                <KanbanVerificationDashboard board={activeBoard} onSelectTask={setSelectedTaskId} />
              ) : (
                <div className="flex h-full min-w-max gap-3 p-4">
                  {[...activeBoard.columns]
                    .sort((a, b) => a.order - b.order)
                    .map((column) => (
                      <KanbanColumnView
                        key={column.id}
                        board={activeBoard}
                        column={column}
                        selectedTaskId={selectedTaskId}
                        dragTaskId={dragTaskId}
                        setDragTaskId={setDragTaskId}
                        onSelectTask={setSelectedTaskId}
                        onDeleteTask={deleteTask}
                        onMoveTask={moveTask}
                      />
                    ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('activity:kanban.noBoardSelected')}
            </div>
          )}
        </div>
      </main>

      {/*
        Keyed on the task ID so the inspector remounts only when the SELECTED
        task changes. Its form-hydration effect depends on `boards` and `task`
        by object identity, and the store hands out a fresh `activeBoard` on
        every `{board}` push plus a fresh `boards` array on every kanban
        result — so with a 5 s poll running unconditionally, the effect
        re-fired every five seconds and wiped `description`, `changeReason`,
        `newNote` and `newCheck` mid-typing. Authoring a multi-sentence
        description was impossible. `SddBoardView` mounts its drawer the same
        way (`key={selectedTask.id}`).
      */}
      <KanbanTaskInspector
        key={selectedTask?.id ?? 'none'}
        boards={boards}
        board={activeBoard}
        task={selectedTask}
        runLink={runLink}
        onClose={() => setSelectedTaskId(null)}
        onSelectTask={setSelectedTaskId}
        sendKanban={sendKanban}
        sendRaw={sendRaw}
        activityEvents={taskActivity}
        activityPresence={taskActivityPresence}
        activityLoading={taskActivityLoading}
        activityError={taskActivityError}
        activitySessionId={activeBoard?.tags?.find((tag) => tag.startsWith('session:'))?.slice(8)}
        refreshActivity={() => setTaskActivityRefresh((value) => value + 1)}
      />
    </div>
  );
}
