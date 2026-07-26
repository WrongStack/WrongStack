import type {
  KanbanBoard,
  KanbanBoardPresence,
  KanbanEvent,
  KanbanManualActivityKind,
  KanbanManualActivityOutcome,
  KanbanModelRoutingMode,
  KanbanTask,
} from '@wrongstack/kanban';
import {
  ChevronDown,
  Columns3,
  Copy,
  Maximize2,
  Minimize2,
  MoveRight,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHorizontalScroll } from '@/hooks/useHorizontalScroll';
import { useKanbanMeta } from '@/hooks/useKanbanMeta';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { auditKanbanBoard } from '@/lib/kanban-cleaner';
import { kanbanMetadataText } from '@/lib/kanban-metadata';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useFleetStore, useKanbanStore, useSessionStore } from '@/stores';
import { ChipMultiSelect } from './ChipMultiSelect';
import { AgentRunPanel } from './KanbanAgentRunPanel.js';
import { BoardPresence, SupervisorBar } from './KanbanBoardChrome.js';
import {
  collectActiveSessionIds,
  collectLiveAgentIdentities,
  isKanbanBoardActive,
  parseRunLink,
  runningBoardCostTotal,
} from './KanbanBoardState';
import { KanbanBoardSidebar } from './KanbanBoardSidebar';
import { KanbanBoundaryEditor } from './KanbanBoundaryEditor';
import { KanbanCleanerAlert } from './KanbanCleanerAlert';
import {
  KanbanDecompositionApprovalCard,
  KanbanDecompositionPanel,
} from './KanbanDecompositionPanel';
import { KanbanTaskCompletionChecks } from './KanbanTaskCompletionChecks';
import { KanbanTaskActivityRecorder } from './KanbanTaskActivityRecorder';
import { KanbanColumnView } from './KanbanColumnView';
import { KanbanQueueHealthBar } from './KanbanQueueHealthBar';
import { RunControlBar, type RunLink, RunTaskControls, StartAsBar } from './KanbanRunControls.js';
import { columnTitle, Field, Metric, SelectField } from './KanbanTaskFields.js';
import { KNOWN_CAPABILITIES, KNOWN_ROLES } from './KanbanTaskOptions';
import { KanbanTaskTree } from './KanbanTaskTree';
import { KanbanVerificationDashboard } from './KanbanVerificationDashboard';
import { ModelPicker } from './ModelPicker';
import { TaskActivityTimeline } from './TaskActivityTimeline';
import { TaskExecutionAttempts } from './TaskExecutionAttempts';
import { TaskIntelligencePanel } from './TaskIntelligencePanel';
import { TaskRiskPanel } from './TaskRiskPanel';
import { TaskVerificationSection } from './TaskVerificationSection';

export const TASK_ACTIVITY_LOAD_LIMIT = 5_000;
const BOARD_PAGE_SIZE = 12;

export { deriveTaskCardIntelligence, type TaskCardIntelligence } from './KanbanColumnView';

export function KanbanView({ onClose }: { onClose?: (() => void) | undefined }) {
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const sessionId = useSessionStore((s) => s.session?.id ?? null);
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
    setLoading,
    setActiveBoardId,
  } = useKanbanStore();
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [boardPage, setBoardPage] = useState(1);
  const [registrySessionIds, setRegistrySessionIds] = useState<string[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const boardScrollRef = useRef<HTMLDivElement>(null);
  useHorizontalScroll(boardScrollRef);
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskActivity, setTaskActivity] = useState<KanbanEvent[]>([]);
  const [taskActivityPresence, setTaskActivityPresence] = useState<
    KanbanBoardPresence[] | undefined
  >();
  const [taskActivityLoading, setTaskActivityLoading] = useState(false);
  const [taskActivityError, setTaskActivityError] = useState<string | null>(null);
  const [taskActivityRefresh, setTaskActivityRefresh] = useState(0);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'board' | 'tree' | 'dashboard'>('board');
  const autoSelectedSessionRef = useRef<string | null>(null);

  const ws = useMemo(() => getWSClient(wsUrl), [wsUrl]);
  const selectedTask = activeBoard?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const liveAgentIdentities = useMemo(
    () => collectLiveAgentIdentities(fleetAgents.values()),
    [fleetAgents],
  );
  const activeSessionIds = useMemo(
    () =>
      collectActiveSessionIds({
        sessionId,
        registrySessionIds,
        agents: fleetAgents.values(),
      }),
    [fleetAgents, registrySessionIds, sessionId],
  );
  const activeBoards = boards.filter((board) => isKanbanBoardActive(board, activeSessionIds));
  const orphanedBoards = boards.filter((board) => !isKanbanBoardActive(board, activeSessionIds));
  const boardAudit = useMemo(
    () =>
      activeBoard
        ? auditKanbanBoard(activeBoard, {
            now: Date.now(),
            liveAgentIdentities,
            requireDueDate: activeBoard.lifecycle?.mode === 'managed',
          })
        : null,
    [activeBoard, liveAgentIdentities],
  );

  const runningCostTotal = useMemo(() => runningBoardCostTotal(activeBoard), [activeBoard]);

  const sendKanban = (type: `kanban.${string}`, payload: Record<string, unknown> = {}) => {
    setLoading(true);
    ws.send({ type, payload });
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
  const refreshBoard = (boardId = activeBoardId) => {
    if (boardId) sendKanban('kanban.get', { boardId });
  };

  useEffect(() => {
    refreshBoards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The cross-process registry is the authoritative source for other open
  // terminals. Fleet telemetry and board presence remain fallbacks for clients
  // that do not expose the HTTP registry.
  useEffect(() => {
    let cancelled = false;
    const refreshRegistry = async () => {
      try {
        const response = await fetch('/api/sessions');
        if (!response.ok) return;
        const data = (await response.json()) as unknown;
        if (!Array.isArray(data) || cancelled) return;
        const ids = data
          .filter(
            (entry): entry is { sessionId: string; status?: string } =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              typeof (entry as { sessionId?: unknown }).sessionId === 'string' &&
              (entry as { status?: unknown }).status !== 'lost',
          )
          .map((entry) => entry.sessionId)
          .sort();
        setRegistrySessionIds((current) =>
          current.length === ids.length && current.every((id, index) => id === ids[index])
            ? current
            : ids,
        );
      } catch {
        // Standalone/static WebUI builds may not expose /api/sessions.
      }
    };
    void refreshRegistry();
    const interval = window.setInterval(refreshRegistry, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
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
    if (activeBoardId) {
      sendKanban('kanban.health', { boardId: activeBoardId });
      sendKanban('kanban.supervisor.status', { boardId: activeBoardId });
    }
  }, [activeBoardId]);

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

  const changeBoardPage = (page: number) => {
    setBoardPage(page);
    setActiveBoardId(null);
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
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
  };

  const createColumn = () => {
    if (!activeBoard) return;
    const title = newColumnTitle.trim();
    if (!title) return;
    setNewColumnTitle('');
    sendKanban('kanban.column.add', { boardId: activeBoard.id, title });
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
  };

  const deleteBoard = () => {
    if (!activeBoard) return;
    sendKanban('kanban.delete', { boardId: activeBoard.id });
    window.setTimeout(refreshBoards, 150);
  };

  const duplicateBoard = () => {
    if (!activeBoard) return;
    sendKanban('kanban.duplicate', {
      boardId: activeBoard.id,
      title: `${activeBoard.title} Copy`,
    });
    window.setTimeout(refreshBoards, 150);
  };

  const deleteTask = (task: KanbanTask) => {
    if (!activeBoard) return;
    sendKanban('kanban.task.remove', { boardId: activeBoard.id, taskId: task.id });
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
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
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
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
          setActiveBoardId(boardId);
          sendKanban('kanban.get', { boardId });
        }}
        onBoardPageChange={changeBoardPage}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-4">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <div className="truncate text-sm font-semibold">
              {activeBoard?.title ?? 'No board selected'}
            </div>
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
                placeholder="New task"
                className="h-8 w-[calc(100%-2.5rem)] min-w-0 flex-none rounded-md border bg-background px-2 text-sm outline-none focus:border-primary sm:w-56"
              />
              <button
                type="button"
                title="Add task"
                onClick={createTask}
                className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Plus size={16} />
              </button>
              <input
                value={newColumnTitle}
                onChange={(e) => setNewColumnTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createColumn();
                }}
                placeholder="New column"
                className="h-8 w-[calc(100%-2.5rem)] min-w-0 flex-none rounded-md border bg-background px-2 text-sm outline-none focus:border-primary sm:w-44"
              />
              <button
                type="button"
                title="Add column"
                onClick={createColumn}
                className="hidden h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground sm:flex"
              >
                <Columns3 size={16} />
              </button>
              <button
                type="button"
                title="Duplicate board"
                onClick={duplicateBoard}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Copy size={16} />
              </button>
              <button
                type="button"
                title="Delete board"
                onClick={deleteBoard}
                className="hidden h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:flex"
              >
                <Trash2 size={16} />
              </button>
            </>
          )}
        </header>

        {activeBoard && <BoardPresence presence={activeBoard.presence} />}
        {activeBoard && (
          <div className="shrink-0 border-b px-3 py-2 sm:px-4">
            <KanbanBoundaryEditor
              title="Board boundary"
              value={activeBoard.boundary}
              onSave={(boundary) => {
                sendKanban('kanban.update', { boardId: activeBoard.id, boundary });
                window.setTimeout(() => refreshBoard(activeBoard.id), 150);
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
        {activeBoard && (
          <div className="flex shrink-0 items-center gap-1 border-b px-4 py-1.5">
            {(
              [
                ['board', 'Board'],
                ['tree', 'Tree'],
                ['dashboard', 'Verification'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                  viewMode === mode
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 text-sm text-destructive">
            <X size={15} />
            <span className="truncate">{error}</span>
          </div>
        )}

        <div
          ref={boardScrollRef}
          className="kanban-scroll-area min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-contain"
        >
          {activeBoard ? (
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
              No kanban board selected.
            </div>
          )}
        </div>
      </main>

      <TaskInspector
        boards={boards}
        board={activeBoard}
        task={selectedTask}
        runLink={runLink}
        onClose={() => setSelectedTaskId(null)}
        onSelectTask={setSelectedTaskId}
        sendKanban={sendKanban}
        sendRaw={sendRaw}
        refreshBoard={refreshBoard}
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

function TaskInspector({
  boards,
  board,
  task,
  runLink,
  onClose,
  onSelectTask,
  sendKanban,
  sendRaw,
  refreshBoard,
  activityEvents,
  activityPresence,
  activityLoading,
  activityError,
  activitySessionId,
  refreshActivity,
}: {
  boards: Array<{ id: string; title: string }>;
  board: KanbanBoard | null;
  task: KanbanTask | null;
  runLink: RunLink | null;
  onClose: () => void;
  onSelectTask: (id: string) => void;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
  sendRaw: (type: string, payload?: Record<string, unknown>) => void;
  refreshBoard: (boardId?: string | null) => void;
  activityEvents: KanbanEvent[];
  activityPresence?: KanbanBoardPresence[] | undefined;
  activityLoading: boolean;
  activityError: string | null;
  activitySessionId?: string | undefined;
  refreshActivity: () => void;
}) {
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [routingMode, setRoutingMode] = useState<KanbanModelRoutingMode>('session');
  const [fallbackProfile, setFallbackProfile] = useState('');
  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [allowedCapabilities, setAllowedCapabilities] = useState<string[]>([]);
  const [targetBoardId, setTargetBoardId] = useState('');
  // Real provider/model catalogue — the user's saved providers and their live
  // model lists. Only fetches while a task is selected (the panel is open).
  const modelCandidates = useProviderModels(Boolean(task));
  // Real registered tools + the live session provider/model (the dispatch
  // fallback so nothing has to be typed by hand).
  const meta = useKanbanMeta(Boolean(task));
  const sessionProvider = kanbanMetadataText(meta.sessionProvider);
  const sessionModel = kanbanMetadataText(meta.sessionModel);
  // Scroll-position hook must be called unconditionally — calling it inside
  // JSX within the {task ? … : …} ternary violates the Rules of Hooks
  // (React error 310) when task toggles between null and non-null.
  const inspectorScrollRef = useScrollPosition<HTMLDivElement>(
    'kanban-task-inspector',
    Boolean(task),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [status, setStatus] = useState<KanbanTask['status']>('pending');
  const [transitionComment, setTransitionComment] = useState('');
  const [transitionAction, setTransitionAction] = useState('');
  const [transitionAttachmentUrl, setTransitionAttachmentUrl] = useState('');
  const [priority, setPriority] = useState<KanbanTask['priority']>('medium');
  const [taskType, setTaskType] = useState<NonNullable<KanbanTask['type']>>('chore');
  const [labelsText, setLabelsText] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [chainMembers, setChainMembers] = useState<string[]>([]);
  const [enforceChainDependencies, setEnforceChainDependencies] = useState(false);
  const [estimatedHours, setEstimatedHours] = useState('');
  const [actualHours, setActualHours] = useState('');
  const [retryPolicy, setRetryPolicy] = useState<NonNullable<KanbanTask['retryPolicy']>>('off');
  const [costCeilingUsd, setCostCeilingUsd] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('');
  const [newCheck, setNewCheck] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newActivityDetails, setNewActivityDetails] = useState('');
  const [newActivityKind, setNewActivityKind] = useState<KanbanManualActivityKind>('observation');
  const [newActivityOutcome, setNewActivityOutcome] =
    useState<KanbanManualActivityOutcome>('unknown');
  const [changeReason, setChangeReason] = useState('');

  useEffect(() => {
    const assignmentProvider = kanbanMetadataText(task?.assignment?.provider);
    const assignmentModel = kanbanMetadataText(task?.assignment?.model);
    setAgentId(
      kanbanMetadataText(task?.assignment?.agentId) ??
        kanbanMetadataText(task?.assignedAgent) ??
        '',
    );
    setName(kanbanMetadataText(task?.assignment?.name) ?? '');
    setRole(kanbanMetadataText(task?.assignment?.role) ?? '');
    setProvider(assignmentProvider ?? '');
    setModel(assignmentModel ?? '');
    setRoutingMode(
      task?.assignment?.modelRouting ??
        (assignmentProvider || assignmentModel ? 'fixed' : 'session'),
    );
    setFallbackProfile(kanbanMetadataText(task?.assignment?.fallbackProfile) ?? '');
    setFallbackModels(task?.assignment?.fallbackModels ?? []);
    setSkills(task?.assignment?.skills ?? []);
    setTools(task?.assignment?.tools ?? []);
    setAllowedCapabilities(task?.assignment?.allowedCapabilities ?? []);
    setTargetBoardId(boards.find((candidate) => candidate.id !== board?.id)?.id ?? '');
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
    setDueDate(task?.dueDate ?? '');
    setStatus(task?.status ?? 'pending');
    setTransitionComment('');
    setTransitionAction('');
    setTransitionAttachmentUrl('');
    setPriority(task?.priority ?? 'medium');
    setTaskType(task?.type ?? 'chore');
    setLabelsText(task?.labels?.join(', ') ?? '');
    setDependsOn(task?.dependsOn ?? []);
    setChainMembers(
      task?.chain && board
        ? board.tasks
            .filter((candidate) => candidate.chain?.chainId === task.chain?.chainId)
            .sort((a, b) => (a.chain?.order ?? 0) - (b.chain?.order ?? 0))
            .map((candidate) => candidate.id)
        : task
          ? [task.id]
          : [],
    );
    setEnforceChainDependencies(false);
    setEstimatedHours(task?.estimatedHours?.toString() ?? '');
    setActualHours(task?.actualHours?.toString() ?? '');
    setRetryPolicy(task?.retryPolicy ?? task?.assignment?.retryPolicy ?? 'off');
    setCostCeilingUsd((task?.costCeilingUsd ?? task?.assignment?.costCeilingUsd)?.toString() ?? '');
    setMaxAttempts(task?.assignment?.maxAttempts?.toString() ?? '');
    setNewCheck('');
    setNewNote('');
    setNewActivityDetails('');
    setNewActivityKind('observation');
    setNewActivityOutcome('unknown');
    setChangeReason('');
  }, [board?.id, boards, task]);

  const payload = (action: 'assign' | 'dispatch') => ({
    boardId: board?.id,
    taskId: task?.id,
    ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(role.trim() ? { role: role.trim() } : {}),
    modelRouting: routingMode,
    ...(routingMode === 'fixed' && provider.trim() ? { provider: provider.trim() } : {}),
    ...(routingMode === 'fixed' && model.trim() ? { model: model.trim() } : {}),
    ...(routingMode === 'fallback_profile' && fallbackProfile.trim()
      ? { fallbackProfile: fallbackProfile.trim() }
      : {}),
    fallbackModels,
    skills,
    tools,
    allowedCapabilities,
    ...(maxAttempts ? { maxAttempts: Number(maxAttempts) } : {}),
    ...(costCeilingUsd ? { costCeilingUsd: Number(costCeilingUsd) } : {}),
    retryPolicy,
    activityNote:
      changeReason.trim() ||
      `${action === 'dispatch' ? 'Dispatched' : 'Assigned'} from WebUI to ${name.trim() || agentId.trim() || role.trim() || 'the configured agent route'}.`,
  });

  const saveDetails = () => {
    if (!board || !task || !title.trim()) return;
    sendKanban('kanban.task.update', {
      boardId: board.id,
      taskId: task.id,
      title: title.trim(),
      description,
      dueDate: dueDate || null,
      ...(board.lifecycle?.mode !== 'managed' ? { status } : {}),
      priority,
      type: taskType,
      labels: labelsText
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean),
      dependsOn,
      ...(task.chain && chainMembers.length <= 1 ? { chain: null } : {}),
      estimatedHours: estimatedHours ? Number(estimatedHours) : 0,
      actualHours: actualHours ? Number(actualHours) : 0,
      retryPolicy,
      costCeilingUsd: costCeilingUsd ? Number(costCeilingUsd) : null,
      activityNote: changeReason.trim() || 'Task contract edited in WebUI.',
    });
    if (chainMembers.length > 1) {
      sendKanban('kanban.task.chain', {
        boardId: board.id,
        taskIds: chainMembers,
        enforceDependencies: enforceChainDependencies,
      });
    }
    window.setTimeout(() => refreshBoard(board.id), 180);
    setChangeReason('');
  };

  const managedStageOrder = ['backlog', 'todo', 'running', 'review', 'done'] as const;
  const currentManagedStage = task?.lifecycle?.currentStage;
  const managedStageIndex = currentManagedStage
    ? managedStageOrder.indexOf(currentManagedStage)
    : -1;
  const nextManagedStage =
    managedStageIndex >= 0 && managedStageIndex < managedStageOrder.length - 1
      ? managedStageOrder[managedStageIndex + 1]
      : undefined;

  const advanceManagedTask = () => {
    if (!board || !task || !nextManagedStage || !transitionComment.trim()) return;
    sendKanban('kanban.task.transition', {
      boardId: board.id,
      taskId: task.id,
      to: nextManagedStage,
      actor: agentId.trim() || name.trim() || task.assignee || task.assignedAgent || 'webui-agent',
      comment: transitionComment.trim(),
      ...(transitionAction.trim() ? { action: transitionAction.trim() } : {}),
      ...(transitionAttachmentUrl.trim()
        ? {
            attachment: {
              url: transitionAttachmentUrl.trim(),
              type: 'url',
              title: `Evidence for ${task.title}`,
            },
          }
        : {}),
    });
    window.setTimeout(() => refreshBoard(board.id), 180);
  };

  const addCheck = () => {
    if (!board || !task || !newCheck.trim()) return;
    sendKanban('kanban.task.check.add', {
      boardId: board.id,
      taskId: task.id,
      description: newCheck.trim(),
      checkType: 'manual',
    });
    setNewCheck('');
  };

  const recordActivity = () => {
    if (!board || !task || !newNote.trim()) return;
    sendKanban('kanban.task.activity.add', {
      boardId: board.id,
      taskId: task.id,
      kind: newActivityKind,
      outcome: newActivityOutcome,
      summary: newNote.trim(),
      ...(newActivityDetails.trim() ? { details: newActivityDetails.trim() } : {}),
      actor: name.trim() || agentId.trim() || 'webui-operator',
    });
    setNewNote('');
    setNewActivityDetails('');
    window.setTimeout(refreshActivity, 150);
  };

  const assign = () => {
    if (!board || !task) return;
    sendKanban('kanban.task.assign', payload('assign'));
    setChangeReason('');
    window.setTimeout(() => refreshBoard(board.id), 150);
  };

  const dispatch = () => {
    if (!board || !task) return;
    sendKanban('kanban.task.dispatch', payload('dispatch'));
    setChangeReason('');
    window.setTimeout(() => refreshBoard(board.id), 200);
  };

  const copyTask = () => {
    if (!board || !task || !targetBoardId) return;
    sendKanban('kanban.task.copy', { boardId: board.id, taskId: task.id, targetBoardId });
  };

  const transferTask = () => {
    if (!board || !task || !targetBoardId) return;
    sendKanban('kanban.task.transfer', { boardId: board.id, taskId: task.id, targetBoardId });
  };

  // The inspector is contextual UI, not a permanent empty sidebar. Keep all
  // hooks above unconditional, then render nothing until the user selects a task.
  if (!task) return null;

  return (
    <aside
      aria-label="Task inspector"
      data-expanded={expanded ? 'true' : 'false'}
      className={cn(
        'flex max-h-[42dvh] w-full shrink-0 flex-col border-t bg-card/40 transition-[width] duration-200 ease-out md:max-h-none md:border-l md:border-t-0',
        expanded
          ? 'fixed inset-0 z-50 h-dvh max-h-none w-screen border-0 bg-card transition-none md:w-screen md:border-0'
          : 'md:w-[420px] xl:w-[480px]',
      )}
    >
      <div className={cn('flex h-12 items-center gap-2 border-b px-3', expanded && 'px-5')}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Task</div>
          <div className="truncate text-[11px] text-muted-foreground">{task.id.slice(0, 8)}</div>
        </div>
        <button
          type="button"
          title={expanded ? 'Collapse task details' : 'Expand task details'}
          aria-label={expanded ? 'Collapse task details' : 'Expand task details'}
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          title="Close"
          onClick={() => {
            setExpanded(false);
            onClose();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
      {task ? (
        <div
          ref={inspectorScrollRef}
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain p-3',
            expanded && 'px-5 py-4 xl:px-7',
          )}
        >
          <div className="space-y-3 rounded-md border bg-background p-2.5">
            <KanbanBoundaryEditor
              title="Task boundary"
              value={task.boundary}
              inherited={board?.boundary}
              onSave={(boundary) => {
                if (!board) return;
                sendKanban('kanban.task.update', {
                  boardId: board.id,
                  taskId: task.id,
                  boundary,
                  activityNote: 'Task boundary edited in WebUI.',
                });
                window.setTimeout(() => refreshBoard(board.id), 150);
              }}
            />
            <Field label="Title" value={title} onChange={setTitle} />
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Description / working context
              </span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={5}
                className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs leading-5 outline-none focus:border-primary"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {board?.lifecycle?.mode === 'managed' ? (
                <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Managed stage
                  </div>
                  <div className="mt-1 text-xs font-semibold capitalize">
                    {task.lifecycle?.currentStage ?? 'Backlog'}
                  </div>
                </div>
              ) : (
                <SelectField
                  label="Status"
                  value={status}
                  options={[
                    'pending',
                    'ready',
                    'in_progress',
                    'blocked',
                    'review',
                    'completed',
                    'failed',
                    'archived',
                  ]}
                  onChange={(value) => setStatus(value as KanbanTask['status'])}
                />
              )}
              <SelectField
                label="Priority"
                value={priority}
                options={['critical', 'high', 'medium', 'low']}
                onChange={(value) => setPriority(value as KanbanTask['priority'])}
              />
              <SelectField
                label="Type"
                value={taskType}
                options={['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore']}
                onChange={(value) => setTaskType(value as NonNullable<KanbanTask['type']>)}
              />
              <Field label="Labels (comma separated)" value={labelsText} onChange={setLabelsText} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Due date (ISO or YYYY-MM-DD)" value={dueDate} onChange={setDueDate} />
              <Field label="Estimated hours" value={estimatedHours} onChange={setEstimatedHours} />
              <Field label="Actual hours" value={actualHours} onChange={setActualHours} />
            </div>
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Dependencies
              </span>
              <ChipMultiSelect
                options={(board?.tasks ?? [])
                  .filter((candidate) => candidate.id !== task.id)
                  .map((candidate) => ({
                    value: candidate.id,
                    label: candidate.title,
                    description: candidate.status,
                  }))}
                selected={dependsOn}
                onChange={setDependsOn}
                placeholder="Select blocking tasks…"
              />
            </div>
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Task chain (selection order)
              </span>
              <ChipMultiSelect
                options={(board?.tasks ?? []).map((candidate) => ({
                  value: candidate.id,
                  label: candidate.title,
                  description: candidate.status,
                }))}
                selected={chainMembers}
                onChange={(next) =>
                  setChainMembers(next.includes(task.id) ? next : [task.id, ...next])
                }
                placeholder="Add tasks to a sequential chain…"
              />
              <label className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={enforceChainDependencies}
                  onChange={(event) => setEnforceChainDependencies(event.target.checked)}
                />
                Enforce chain order as dependencies
              </label>
            </div>
            <Field
              label="Change / assignment reason (persisted to activity)"
              value={changeReason}
              onChange={setChangeReason}
            />
            <button
              type="button"
              onClick={saveDetails}
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm text-primary-foreground hover:bg-primary/90"
            >
              <Save size={15} /> Save task contract
            </button>
            {board?.lifecycle?.mode === 'managed' && nextManagedStage && (
              <section
                aria-label="Managed lifecycle transition"
                className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                      Kanban Agent transition
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {currentManagedStage} → {nextManagedStage}; no stages can be skipped.
                    </div>
                  </div>
                  <ShieldCheck size={16} className="text-primary" />
                </div>
                <Field
                  label="Completed action / reviewer action"
                  value={transitionAction}
                  onChange={setTransitionAction}
                />
                <Field
                  label="Truthful progress comment (required)"
                  value={transitionComment}
                  onChange={setTransitionComment}
                />
                <Field
                  label="Evidence attachment URL"
                  value={transitionAttachmentUrl}
                  onChange={setTransitionAttachmentUrl}
                />
                <button
                  type="button"
                  disabled={!transitionComment.trim()}
                  onClick={advanceManagedTask}
                  className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <MoveRight size={15} /> Advance to {nextManagedStage}
                </button>
              </section>
            )}
          </div>

          {board && (
            <>
              <TaskIntelligencePanel
                board={board}
                task={task}
                events={activityEvents}
                presence={activityPresence}
                sessionId={activitySessionId}
                sessionProvider={sessionProvider}
                sessionModel={sessionModel}
              />
              <TaskExecutionAttempts
                task={task}
                events={activityEvents}
                sessionId={activitySessionId}
              />
              <TaskRiskPanel board={board} task={task} events={activityEvents} />
            </>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="Source" value={task.origin?.system ?? 'manual'} />
            <Metric label="Task ID" value={task.id.slice(0, 8)} />
            <Metric label="Run" value={task.assignment?.status ?? 'unassigned'} />
            <Metric label="Column" value={columnTitle(board, task.columnId)} />
          </div>

          {task.assignment && <AgentRunPanel assignment={task.assignment} />}

          {runLink && task.origin?.taskId && (
            <RunTaskControls
              runLink={runLink}
              runTaskId={task.origin.taskId}
              modelCandidates={modelCandidates}
              sendRaw={sendRaw}
            />
          )}

          {!runLink && (
            <>
              <div className="mt-4 space-y-3">
                <SelectField
                  label="Primary model source"
                  value={routingMode}
                  options={['session', 'fixed', 'fallback_profile']}
                  onChange={(value) => setRoutingMode(value as KanbanModelRoutingMode)}
                />
                {routingMode === 'session' && (
                  <div className="rounded-md border bg-info/5 px-2 py-1.5 text-[11px] text-muted-foreground">
                    Uses the live session model: {sessionProvider ? `${sessionProvider}/` : ''}
                    {sessionModel || 'not available'}.
                  </div>
                )}
                {routingMode === 'fixed' && (
                  <div>
                    <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                      Fixed provider / model
                    </span>
                    <ModelPicker
                      value={model || undefined}
                      provider={provider || undefined}
                      candidates={modelCandidates}
                      placeholder="Select exact provider / model…"
                      onPick={(nextModel, nextProvider) => {
                        setModel(nextModel);
                        setProvider(nextProvider);
                      }}
                    />
                  </div>
                )}
                {routingMode === 'fallback_profile' && (
                  <SelectField
                    label="Fallback profile (first model is primary)"
                    value={fallbackProfile}
                    options={Object.keys(meta.fallbackProfiles)}
                    placeholder="Select configured profile…"
                    onChange={setFallbackProfile}
                  />
                )}

                {/* Fallback models — real multi-pick from the same live catalogue. */}
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    Fallback models
                  </span>
                  <ChipMultiSelect
                    options={modelCandidates.map((c) => ({
                      value: `${c.provider}/${c.model}`,
                      label: c.label,
                      description: c.description,
                      tag: c.provider,
                    }))}
                    selected={fallbackModels}
                    onChange={setFallbackModels}
                    placeholder="Add fallback model…"
                    emptyLabel="No models — add a provider in Settings"
                  />
                </div>

                <SelectField
                  label="Role"
                  value={role}
                  options={KNOWN_ROLES}
                  placeholder="Select a role…"
                  onChange={setRole}
                />

                <div>
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    Agentic skills{' '}
                    <span className="text-muted-foreground/70">· force-loaded into the worker</span>
                  </span>
                  <ChipMultiSelect
                    options={meta.skills.map((skill) => ({
                      value: skill.name,
                      label: skill.name,
                      description: skill.description,
                      tag: skill.source,
                    }))}
                    selected={skills}
                    onChange={setSkills}
                    placeholder="Assign required skills…"
                    emptyLabel="No skills registered"
                  />
                </div>

                {/* Tools — real registered tools from the running agent. */}
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    Tools{' '}
                    <span className="text-muted-foreground/70">· blank = full default toolset</span>
                  </span>
                  <ChipMultiSelect
                    options={meta.tools.map((tool) => ({
                      value: tool.name,
                      label: tool.name,
                      description: tool.description,
                    }))}
                    selected={tools}
                    onChange={setTools}
                    placeholder="Restrict to specific tools…"
                    emptyLabel="Tool list unavailable on this server"
                  />
                </div>

                {/* Advanced — optional name override + capability grants. */}
                <div className="rounded-md border bg-background/60">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((v) => !v)}
                    className="flex w-full items-center justify-between px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    Advanced
                    <ChevronDown
                      size={13}
                      className={cn('transition-transform', showAdvanced && 'rotate-180')}
                    />
                  </button>
                  {showAdvanced && (
                    <div className="space-y-3 border-t p-2">
                      <Field label="Agent name (optional)" value={name} onChange={setName} />
                      <div className="grid grid-cols-2 gap-2">
                        <SelectField
                          label="Retry policy"
                          value={retryPolicy}
                          options={['off', 'incremental', 'exponential']}
                          onChange={(value) =>
                            setRetryPolicy(value as NonNullable<KanbanTask['retryPolicy']>)
                          }
                        />
                        <Field label="Max attempts" value={maxAttempts} onChange={setMaxAttempts} />
                        <Field
                          label="Cost ceiling USD"
                          value={costCeilingUsd}
                          onChange={setCostCeilingUsd}
                        />
                      </div>
                      <div>
                        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                          Capabilities{' '}
                          <span className="text-muted-foreground/70">· blank = safe defaults</span>
                        </span>
                        <ChipMultiSelect
                          options={KNOWN_CAPABILITIES}
                          selected={allowedCapabilities}
                          onChange={setAllowedCapabilities}
                          placeholder="Grant a capability…"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={assign}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted"
                >
                  <UserPlus size={15} />
                  Assign
                </button>
                <button
                  type="button"
                  onClick={dispatch}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary text-sm text-primary-foreground hover:bg-primary/90"
                >
                  <Send size={15} />
                  Dispatch
                </button>
              </div>
            </>
          )}

          {boards.length > 1 && !runLink ? (
            <div className="mt-4 space-y-2 rounded-md border bg-background p-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Target board
                </span>
                <select
                  value={targetBoardId}
                  onChange={(event) => setTargetBoardId(event.target.value)}
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
                >
                  {boards
                    .filter((candidate) => candidate.id !== board?.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={copyTask}
                  disabled={!targetBoardId}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Copy size={15} />
                  Copy
                </button>
                <button
                  type="button"
                  onClick={transferTask}
                  disabled={!targetBoardId}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted disabled:opacity-50"
                >
                  <MoveRight size={15} />
                  Transfer
                </button>
              </div>
            </div>
          ) : null}

          <KanbanTaskCompletionChecks
            board={board}
            task={task}
            newCheck={newCheck}
            onNewCheckChange={setNewCheck}
            onAddCheck={addCheck}
            sendKanban={sendKanban}
          />

          {board && (
            <TaskVerificationSection boardId={board.id} task={task} sendKanban={sendKanban} />
          )}

          {board && (
            <KanbanDecompositionPanel
              board={board}
              task={task}
              sendKanban={sendKanban}
              onSelectTask={onSelectTask}
            />
          )}

          <TaskActivityTimeline
            task={task}
            events={activityEvents}
            sessionId={activitySessionId}
            loading={activityLoading}
            error={activityError}
            onRefresh={refreshActivity}
          />

          <KanbanTaskActivityRecorder
            activityKind={newActivityKind}
            activityOutcome={newActivityOutcome}
            note={newNote}
            details={newActivityDetails}
            onActivityKindChange={setNewActivityKind}
            onActivityOutcomeChange={setNewActivityOutcome}
            onNoteChange={setNewNote}
            onDetailsChange={setNewActivityDetails}
            onRecordActivity={recordActivity}
          />
        </div>
      ) : null}
    </aside>
  );
}
