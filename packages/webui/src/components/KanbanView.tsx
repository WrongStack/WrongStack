import type {
  KanbanBoard,
  KanbanBoardPresence,
  KanbanColumn,
  KanbanEvent,
  KanbanManualActivityKind,
  KanbanManualActivityOutcome,
  KanbanModelRoutingMode,
  KanbanSupervisorSnapshot,
  KanbanTask,
} from '@wrongstack/kanban';
import {
  Activity,
  ArrowLeft,
  CircleUserRound,
  Clock3,
  Check,
  ChevronDown,
  Columns3,
  Copy,
  Maximize2,
  Minimize2,
  MoveRight,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useKanbanMeta } from '@/hooks/useKanbanMeta';
import { useHorizontalScroll } from '@/hooks/useHorizontalScroll';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { type ModelCandidate, useProviderModels } from '@/hooks/useProviderModels';
import { auditKanbanBoard } from '@/lib/kanban-cleaner';
import { kanbanMetadataText } from '@/lib/kanban-metadata';
import { verificationStateOf, type TaskVerificationState } from '@/lib/kanban-verification';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  useConfigStore,
  useFleetStore,
  useKanbanStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { ChipMultiSelect, type ChipOption } from './ChipMultiSelect';
import { KanbanCleanerAlert } from './KanbanCleanerAlert';
import { KanbanBoundaryEditor } from './KanbanBoundaryEditor';
import {
  KanbanDecompositionApprovalCard,
  KanbanDecompositionPanel,
} from './KanbanDecompositionPanel';
import { KanbanTaskTree } from './KanbanTaskTree';
import { KanbanVerificationDashboard } from './KanbanVerificationDashboard';
import { ModelPicker } from './ModelPicker';
import { TaskActivityTimeline } from './TaskActivityTimeline';
import { TaskExecutionAttempts } from './TaskExecutionAttempts';
import { TaskIntelligencePanel } from './TaskIntelligencePanel';
import { TaskVerificationSection } from './TaskVerificationSection';
import { analyzeTaskRisk, TaskRiskPanel } from './TaskRiskPanel';
import { Pagination } from './ui/pagination';

/** A kanban board that mirrors a live Goal/SDD run, detected from its tags. */
interface RunLink {
  engine: 'sdd' | 'goal';
  runId?: string | undefined;
}

export const TASK_ACTIVITY_LOAD_LIMIT = 5_000;
const BOARD_PAGE_SIZE = 12;

function relativeLastSeen(lastSeenAt: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(lastSeenAt));
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function BoardPresence({ presence = [] }: { presence?: KanbanBoardPresence[] | undefined }) {
  if (presence.length === 0) return null;
  return (
    <section
      aria-label="Board presence"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/50 px-4 py-2"
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Live board users
      </span>
      {presence.map((entry) => (
        <span
          key={entry.id}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs shadow-sm"
          title={`Session ${entry.sessionId} · last seen ${entry.lastSeenAt}`}
        >
          <span
            role="img"
            aria-label={entry.active ? 'active' : 'inactive'}
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              entry.active ? 'bg-success' : 'bg-muted-foreground/50',
            )}
          />
          <CircleUserRound size={13} aria-hidden="true" />
          <span className="max-w-32 truncate font-medium">
            {entry.agentName ?? entry.agentId}
          </span>
          <span className="max-w-32 truncate text-muted-foreground">{entry.sessionId}</span>
          <Clock3 size={12} className="text-muted-foreground" aria-hidden="true" />
          <time dateTime={entry.lastSeenAt} className="tabular-nums text-muted-foreground">
            {relativeLastSeen(entry.lastSeenAt)}
          </time>
        </span>
      ))}
    </section>
  );
}

function SupervisorBar({
  board,
  snapshot,
  sendKanban,
}: {
  board: KanbanBoard;
  snapshot: KanbanSupervisorSnapshot | null;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<'deterministic' | 'agentic'>('deterministic');
  const [routingMode, setRoutingMode] = useState<KanbanModelRoutingMode>('session');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [fallbackProfile, setFallbackProfile] = useState('');
  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [intervalSeconds, setIntervalSeconds] = useState(10);
  const modelCandidates = useProviderModels(expanded && mode === 'agentic');
  const meta = useKanbanMeta(expanded && mode === 'agentic');

  useEffect(() => {
    const config = board.supervisor;
    setEnabled(config?.enabled ?? true);
    setMode(config?.mode ?? 'deterministic');
    setRoutingMode(config?.routing?.mode ?? 'session');
    setProvider(config?.routing?.provider ?? '');
    setModel(config?.routing?.model ?? '');
    setFallbackProfile(config?.routing?.fallbackProfile ?? '');
    setFallbackModels(config?.routing?.fallbackModels ?? []);
    setSkills(config?.skills ?? []);
    setIntervalSeconds(Math.max(2, Math.round((config?.intervalMs ?? 10_000) / 1000)));
  }, [board.id, board.supervisor]);

  const save = () => {
    const routing = {
      mode: routingMode,
      ...(routingMode === 'fixed' && provider ? { provider } : {}),
      ...(routingMode === 'fixed' && model ? { model } : {}),
      ...(routingMode === 'fallback_profile' && fallbackProfile ? { fallbackProfile } : {}),
      ...(fallbackModels.length ? { fallbackModels } : {}),
    };
    sendKanban('kanban.update', {
      boardId: board.id,
      supervisor: {
        enabled,
        mode,
        intervalMs: Math.max(2, intervalSeconds) * 1000,
        recoveryMode: 'auto',
        ...(mode === 'agentic' ? { routing, skills } : {}),
      },
    });
    window.setTimeout(() => sendKanban('kanban.supervisor.audit', { boardId: board.id }), 150);
  };

  const status = enabled ? (snapshot?.status ?? 'starting') : 'disabled';
  return (
    <div className="shrink-0 border-b bg-background/80">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[11px] hover:bg-muted/40"
      >
        <ShieldCheck size={13} className={status === 'healthy' ? 'text-success' : 'text-warning'} />
        <span className="font-semibold">Kanban Agent</span>
        <span className="rounded bg-muted px-1.5 py-0.5 capitalize text-muted-foreground">
          {mode} · {status}
        </span>
        {snapshot?.summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{snapshot.summary}</span>
        )}
        <span className="ml-auto text-muted-foreground">
          {snapshot?.lastAuditAt
            ? `checked ${fmtElapsed(snapshot.lastAuditAt)} ago`
            : 'not checked'}
        </span>
        <ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="grid gap-3 border-t p-3 text-xs lg:grid-cols-[220px_220px_1fr_auto]">
          <label className="flex items-center gap-2 rounded-md border bg-card px-2 py-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Watch this board</span>
          </label>
          <SelectField
            label="Supervisor engine"
            value={mode}
            options={['deterministic', 'agentic']}
            onChange={(value) => setMode(value as 'deterministic' | 'agentic')}
          />
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
              Audit interval (seconds)
            </span>
            <input
              type="number"
              min={2}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(Number(event.target.value) || 2)}
              className="h-8 w-full rounded-md border bg-background px-2 outline-none focus:border-primary"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={save}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-primary-foreground"
            >
              <Save size={13} /> Save
            </button>
            <button
              type="button"
              onClick={() => sendKanban('kanban.supervisor.audit', { boardId: board.id })}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 hover:bg-muted"
            >
              <Activity size={13} /> Audit now
            </button>
          </div>
          {mode === 'deterministic' ? (
            <div className="lg:col-span-4 rounded-md border border-success/20 bg-success/5 px-3 py-2 text-muted-foreground">
              Deterministic mode uses no provider, model, token, or billing. It repairs
              assignment/status/column drift and recovers expired leases.
            </div>
          ) : (
            <div className="grid gap-3 lg:col-span-4 lg:grid-cols-2">
              <SelectField
                label="Kanban Agent model source"
                value={routingMode}
                options={['session', 'fixed', 'fallback_profile']}
                onChange={(value) => setRoutingMode(value as KanbanModelRoutingMode)}
              />
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
              <div>
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Supervisor skills
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
                  placeholder="Force-load agentic skills…"
                />
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Extra fallback models
                </span>
                <ChipMultiSelect
                  options={modelCandidates.map((candidate) => ({
                    value: `${candidate.provider}/${candidate.model}`,
                    label: candidate.label,
                    tag: candidate.provider,
                  }))}
                  selected={fallbackModels}
                  onChange={setFallbackModels}
                  placeholder="Optional ordered fallbacks…"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function parseRunLink(board: { tags?: string[] | undefined } | null | undefined): RunLink | null {
  const tags = board?.tags ?? [];
  const engine = tags.includes('sdd') ? 'sdd' : tags.includes('goal') ? 'goal' : null;
  if (!engine) return null;
  const runId = tags.find((t) => t.startsWith('run:'))?.slice(4);
  return { engine, ...(runId ? { runId } : {}) };
}

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
  const liveAgentIdentities = useMemo(() => {
    const identities = new Set<string>();
    for (const agent of fleetAgents.values()) {
      if (agent.status !== 'running') continue;
      identities.add(agent.id);
      identities.add(agent.name);
    }
    return identities;
  }, [fleetAgents]);
  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (sessionId) ids.add(sessionId);
    for (const id of registrySessionIds) ids.add(id);
    for (const agent of fleetAgents.values()) {
      if (agent.status === 'running' && agent.sessionId) ids.add(agent.sessionId);
    }
    return [...ids];
  }, [fleetAgents, registrySessionIds, sessionId]);
  const isBoardActive = (board: (typeof boards)[number]) =>
    board.presence?.some((entry) => entry.active) === true ||
    board.tags?.some(
      (tag) => tag.startsWith('session:') && activeSessionIds.includes(tag.slice(8)),
    ) === true;
  const activeBoards = boards.filter(isBoardActive);
  const orphanedBoards = boards.filter((board) => !isBoardActive(board));
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

  const runningCostTotal = useMemo(() => {
    if (!activeBoard) return 0;
    return activeBoard.tasks
      .filter(
        (t) =>
          t.status === 'in_progress' ||
          t.assignment?.status === 'running' ||
          t.assignment?.status === 'queued',
      )
      .reduce((sum, t) => sum + (t.costCeilingUsd ?? 0), 0);
  }, [activeBoard]);

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
      <aside className="flex max-h-[45dvh] w-full shrink-0 flex-col border-b bg-card/40 md:max-h-none md:w-[280px] md:border-b-0 md:border-r">
        <div className="flex h-12 items-center gap-2 border-b px-3">
          <button
            type="button"
            title="Back"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <Columns3 size={17} className="text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">Kanban</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {boardTotal} boards · {activeBoardTotal} active · {orphanedBoardTotal} orphaned
            </div>
          </div>
          <button
            type="button"
            title="Refresh"
            onClick={() => refreshBoards()}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        <div className="flex gap-1 border-b p-2">
          <input
            value={newBoardTitle}
            onChange={(e) => setNewBoardTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createBoard();
            }}
            placeholder="New board"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            title="Create board"
            onClick={createBoard}
            className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {activeBoards.length > 0 && (
            <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-success">
              Active session · {activeBoardTotal}
            </div>
          )}
          {activeBoards.map((board) => (
            <button
              key={board.id}
              type="button"
              onClick={() => {
                setActiveBoardId(board.id);
                sendKanban('kanban.get', { boardId: board.id });
              }}
              className={cn(
                'mb-1 w-full rounded-md px-2 py-2 text-left transition-colors',
                activeBoardId === board.id
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <div className="truncate text-sm font-medium">{board.title}</div>
              <div className="mt-0.5 flex items-center justify-between text-[11px]">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  {board.taskCount} tasks
                </span>
                <span>{board.completedTaskCount} done</span>
              </div>
            </button>
          ))}
          {orphanedBoards.length > 0 && (
            <div className="mb-1 mt-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              No active session · {orphanedBoardTotal}
            </div>
          )}
          {orphanedBoards.map((board) => (
            <button
              key={board.id}
              type="button"
              onClick={() => {
                setActiveBoardId(board.id);
                sendKanban('kanban.get', { boardId: board.id });
              }}
              className={cn(
                'mb-1 w-full rounded-md px-2 py-2 text-left transition-colors',
                activeBoardId === board.id
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <div className="truncate text-sm font-medium">{board.title}</div>
              <div className="mt-0.5 flex items-center justify-between text-[11px]">
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/45" />
                  {board.taskCount} tasks
                </span>
                <span>{board.completedTaskCount} done</span>
              </div>
            </button>
          ))}
        </div>
        <Pagination
          page={boardPage}
          pageSize={BOARD_PAGE_SIZE}
          totalItems={boardTotal}
          onPageChange={changeBoardPage}
          compact
          itemLabel="boards"
        />
      </aside>

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
        {boardAudit && (
          <KanbanCleanerAlert audit={boardAudit} onSelectTask={setSelectedTaskId} />
        )}
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

        <div ref={boardScrollRef} className="kanban-scroll-area min-h-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-contain">
          {activeBoard ? (
            <>
              {queueHealth && (
                <div className="flex shrink-0 items-center gap-4 border-b px-4 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Queue health</span>
                  {queueHealth.counts.ready > 0 && (
                    <span
                      title="Claimable tasks"
                      className="inline-flex items-center gap-1 text-success"
                    >
                      {queueHealth.counts.ready} ready
                    </span>
                  )}
                  {queueHealth.counts.running > 0 && (
                    <span
                      title="Running assignments"
                      className="inline-flex items-center gap-1 text-warning"
                    >
                      {queueHealth.counts.running} running
                    </span>
                  )}
                  {queueHealth.counts.review > 0 && (
                    <span title="In review" className="inline-flex items-center gap-1 text-primary">
                      {queueHealth.counts.review} review
                    </span>
                  )}
                  {queueHealth.counts.blocked > 0 && (
                    <span
                      title="Manually blocked"
                      className="inline-flex items-center gap-1 text-destructive"
                    >
                      {queueHealth.counts.blocked} blocked
                    </span>
                  )}
                  {queueHealth.counts.failed > 0 && (
                    <span
                      title="Failed tasks"
                      className="inline-flex items-center gap-1 text-destructive"
                    >
                      {queueHealth.counts.failed} failed
                    </span>
                  )}
                  {queueHealth.dependencyBlocked.count > 0 && (
                    <span
                      title="Ready/pending tasks blocked by dependencies"
                      className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-warning"
                    >
                      {queueHealth.dependencyBlocked.count} blocked by deps
                    </span>
                  )}
                  {queueHealth.staleAssignments.count > 0 && (
                    <span
                      title="Expired lease assignments"
                      className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-destructive"
                    >
                      {queueHealth.staleAssignments.count} stale
                    </span>
                  )}
                  {queueHealth.heartbeatDue.count === 0 &&
                    queueHealth.staleAssignments.count === 0 &&
                    queueHealth.dependencyBlocked.count === 0 && (
                      <span className="text-success">healthy</span>
                    )}
                  {runningCostTotal > 0 && (
                    <span
                      title="Sum of costCeilingUsd for running/queued tasks"
                      className="inline-flex items-center gap-1 text-info"
                    >
                      ~${runningCostTotal.toFixed(2)} running cost
                    </span>
                  )}
                </div>
              )}
              {viewMode === 'tree' ? (
                <KanbanTaskTree
                  board={activeBoard}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={setSelectedTaskId}
                />
              ) : viewMode === 'dashboard' ? (
                <KanbanVerificationDashboard
                  board={activeBoard}
                  onSelectTask={setSelectedTaskId}
                />
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

function RunControlBar({
  runLink,
  sendRaw,
}: {
  runLink: RunLink;
  sendRaw: (type: string, payload?: Record<string, unknown>) => void;
}) {
  const isSdd = runLink.engine === 'sdd';
  const pfx = isSdd ? 'sdd.board' : 'goal';
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const btn =
    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-1.5">
      <span className="inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
        <Rocket size={11} /> {runLink.engine}
      </span>
      <span className="text-[11px] text-muted-foreground">Live run — steer it from here</span>
      {isSdd && (
        <button
          type="button"
          className={btn}
          title="Open the live run view (SDD Hub)"
          onClick={() => setCurrentView('sddhub')}
        >
          <Rocket size={12} /> Open live run
        </button>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button type="button" className={btn} onClick={() => sendRaw(`${pfx}.pause`)}>
          <Pause size={12} /> Pause
        </button>
        <button type="button" className={btn} onClick={() => sendRaw(`${pfx}.resume`)}>
          <Play size={12} /> Resume
        </button>
        {isSdd && (
          <button
            type="button"
            className={btn}
            onClick={() => sendRaw('sdd.board.retry_all_failed')}
          >
            <RotateCcw size={12} /> Retry failed
          </button>
        )}
        <button
          type="button"
          className={cn(btn, 'text-destructive hover:bg-destructive/10')}
          onClick={() => sendRaw(`${pfx}.stop`)}
        >
          <Square size={12} /> Stop
        </button>
      </div>
    </div>
  );
}

function StartAsBar({
  boardId,
  sendKanban,
}: {
  boardId: string;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
}) {
  const btn =
    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-1.5">
      <Rocket size={13} className="text-primary" />
      <span className="text-[11px] text-muted-foreground">Run this board as a live agent job:</span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          className={btn}
          onClick={() => sendKanban('kanban.run.start', { boardId, engine: 'goal' })}
        >
          Start as Goal
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => sendKanban('kanban.run.start', { boardId, engine: 'sdd' })}
        >
          Start as SDD
        </button>
      </div>
    </div>
  );
}

/** Run-native per-task controls shown in the inspector for run-linked boards. */
function RunTaskControls({
  runLink,
  runTaskId,
  modelCandidates,
  sendRaw,
}: {
  runLink: RunLink;
  runTaskId: string;
  modelCandidates: ModelCandidate[];
  sendRaw: (type: string, payload?: Record<string, unknown>) => void;
}) {
  const isSdd = runLink.engine === 'sdd';
  const [reassigning, setReassigning] = useState(false);
  const [reassignName, setReassignName] = useState('');
  const btn =
    'inline-flex flex-1 items-center justify-center gap-1 rounded-md border py-1.5 text-xs font-medium hover:bg-muted';
  const submitReassign = () => {
    const n = reassignName.trim();
    if (!n) return;
    sendRaw(isSdd ? 'sdd.board.reassign' : 'goal.assignTask', {
      taskId: runTaskId,
      agentName: n,
    });
    setReassigning(false);
    setReassignName('');
  };
  return (
    <div className="mt-4 rounded-md border bg-primary/5 p-2.5">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-primary">
        Run controls
      </div>
      {isSdd && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">Worker model</div>
          <ModelPicker
            candidates={modelCandidates}
            placeholder="Set model for this task…"
            onPick={(model, provider) =>
              sendRaw('sdd.board.set_task_model', { taskId: runTaskId, model, provider })
            }
          />
        </div>
      )}
      {reassigning ? (
        <div className="flex items-center gap-1.5">
          <input
            value={reassignName}
            onChange={(e) => setReassignName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitReassign();
              if (e.key === 'Escape') setReassigning(false);
            }}
            placeholder="New worker name"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={submitReassign}
            className="rounded-md bg-primary/10 px-2 py-1.5 text-primary"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => setReassigning(false)}
            className="rounded-md bg-muted px-2 py-1.5"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            onClick={() =>
              sendRaw(isSdd ? 'sdd.board.retry' : 'goal.retryTask', { taskId: runTaskId })
            }
          >
            <RotateCcw size={13} /> Retry
          </button>
          <button type="button" className={btn} onClick={() => setReassigning(true)}>
            <UserPlus size={13} /> Reassign
          </button>
          {isSdd ? (
            <button
              type="button"
              className={cn(btn, 'text-destructive hover:bg-destructive/10')}
              onClick={() => sendRaw('sdd.board.cancel_task', { taskId: runTaskId })}
            >
              <Square size={13} /> Cancel
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              onClick={() => sendRaw('goal.runTask', { taskId: runTaskId })}
            >
              <Play size={13} /> Run now
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface TaskCardIntelligence {
  owner: string;
  route: string;
  blockers: number;
  attempts: string;
  fallbackCount: number;
  activeUsers: number;
  failed: boolean;
  criticalRisks: number;
  warningRisks: number;
  /** Verification display state derived from the persisted report. */
  verification: TaskVerificationState;
  /** Completed/total resolved child tasks, or null for leaf tasks. */
  subtaskCounts: { done: number; total: number } | null;
  /** Atomicity verdict when an assessment exists. */
  atomicityVerdict: 'atomic' | 'borderline' | 'needs_decomposition' | 'composite' | null;
  /** Evidence attachments on the verification report. */
  evidenceCount: number;
  /** A decomposition proposal awaiting approval. */
  pendingDecomposition: boolean;
}

export function deriveTaskCardIntelligence(
  board: KanbanBoard,
  task: KanbanTask,
  verificationActivity?: Record<string, { startedAt: number }>,
): TaskCardIntelligence {
  const assignment = task.assignment;
  const operationalFindings = analyzeTaskRisk(board, task, []).findings.filter(
    (finding) => finding.category === 'operational',
  );
  const provider = kanbanMetadataText(assignment?.provider);
  const model = kanbanMetadataText(assignment?.model);
  return {
    owner:
      kanbanMetadataText(assignment?.name) ??
      kanbanMetadataText(assignment?.agentId) ??
      kanbanMetadataText(assignment?.role) ??
      kanbanMetadataText(task.assignee) ??
      kanbanMetadataText(task.assignedAgent) ??
      'Unassigned',
    route:
      provider || model
        ? `${provider ? `${provider}/` : ''}${model ?? 'default'}`
        : assignment?.modelRouting === 'session'
          ? 'session default'
          : 'default route',
    blockers: (task.dependsOn ?? []).filter((dependencyId) => {
      const dependency = board.tasks.find((candidate) => candidate.id === dependencyId);
      return !dependency || !['completed', 'archived'].includes(dependency.status);
    }).length,
    attempts: assignment?.attempt
      ? `${assignment.attempt}${assignment.maxAttempts ? `/${assignment.maxAttempts}` : ''}`
      : '0',
    fallbackCount:
      (assignment?.fallbackProfile ? 1 : 0) + (assignment?.fallbackModels?.length ?? 0),
    activeUsers: (board.presence ?? []).filter(
      (entry) => entry.taskId === task.id && entry.active,
    ).length,
    failed: task.status === 'failed' || assignment?.status === 'failed' || !!assignment?.error,
    criticalRisks: operationalFindings.filter((finding) => finding.severity === 'critical').length,
    warningRisks: operationalFindings.filter((finding) => finding.severity === 'warning').length,
    verification: verificationStateOf(
      task,
      verificationActivity?.[`${board.id}:${task.id}`],
    ),
    subtaskCounts: (() => {
      const childIds = task.childTaskIds ?? [];
      if (!childIds.length) return null;
      const children = childIds
        .map((childId) => board.tasks.find((candidate) => candidate.id === childId))
        .filter((child): child is KanbanTask => Boolean(child));
      if (!children.length) return null;
      return {
        done: children.filter((child) =>
          ['completed', 'review', 'archived'].includes(child.status),
        ).length,
        total: children.length,
      };
    })(),
    atomicityVerdict: task.atomicityAssessment?.verdict ?? null,
    evidenceCount: task.verificationReport?.attachments.length ?? 0,
    pendingDecomposition: task.decomposition?.status === 'proposed',
  };
}

function KanbanColumnView({
  board,
  column,
  selectedTaskId,
  dragTaskId,
  setDragTaskId,
  onSelectTask,
  onDeleteTask,
  onMoveTask,
}: {
  board: KanbanBoard;
  column: KanbanColumn;
  selectedTaskId: string | null;
  dragTaskId: string | null;
  setDragTaskId: (id: string | null) => void;
  onSelectTask: (id: string) => void;
  onDeleteTask: (task: KanbanTask) => void;
  onMoveTask: (taskId: string, columnId: string) => void;
}) {
  const verificationActivity = useKanbanStore((state) => state.verificationActivity);
  const tasks = board.tasks
    .filter((task) => task.columnId === column.id)
    .sort((a, b) => a.order - b.order);
  const empty = tasks.length === 0;
  return (
    <section
      className={cn(
        'flex h-full shrink-0 flex-col rounded-md border bg-muted/25 transition-[width] duration-200',
        empty ? 'w-[180px]' : 'w-[310px]',
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: column.color ?? 'hsl(var(--primary))' }}
        />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{column.title}</div>
        <span className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {tasks.length}
        </span>
      </div>
      <ul
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 [scrollbar-gutter:stable]"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (board.lifecycle?.mode !== 'managed' && dragTaskId) {
            onMoveTask(dragTaskId, column.id);
          }
          setDragTaskId(null);
        }}
      >
        {tasks.map((task) => {
          const intelligence = deriveTaskCardIntelligence(board, task, verificationActivity);
          return (
            <li
            key={task.id}
            draggable={board.lifecycle?.mode !== 'managed'}
            onDragStart={() => {
              if (board.lifecycle?.mode !== 'managed') setDragTaskId(task.id);
            }}
            onDragEnd={() => setDragTaskId(null)}
            className={cn(
              'relative rounded-md border bg-background p-3 shadow-sm transition-colors',
              selectedTaskId === task.id ? 'border-primary' : 'hover:border-primary/50',
            )}
          >
            <button
              type="button"
              aria-label={`Select task: ${task.title}`}
              onClick={() => onSelectTask(task.id)}
              className="absolute inset-0 cursor-pointer rounded-md"
            />
            <div className="pointer-events-none relative flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {(task.atomic || intelligence.atomicityVerdict) && (
                    <span
                      className={cn(
                        'shrink-0 rounded px-1 py-0.5 text-[10px] font-medium',
                        intelligence.atomicityVerdict === 'needs_decomposition'
                          ? 'bg-destructive/15 text-destructive'
                          : intelligence.atomicityVerdict === 'composite'
                            ? 'bg-info/15 text-info'
                            : intelligence.atomicityVerdict === 'borderline'
                              ? 'bg-warning/15 text-warning'
                              : task.atomic
                                ? 'bg-warning/15 text-warning'
                                : 'bg-muted text-muted-foreground',
                      )}
                      title={
                        intelligence.atomicityVerdict
                          ? `Atomicity: ${intelligence.atomicityVerdict}`
                          : 'Atomic task (subtree verification required)'
                      }
                    >
                      {task.atomic
                        ? 'atomic'
                        : intelligence.atomicityVerdict === 'needs_decomposition'
                          ? 'split me'
                          : intelligence.atomicityVerdict}
                    </span>
                  )}
                  <span className="line-clamp-2 text-sm font-medium leading-5">{task.title}</span>
                </div>
                {task.description && (
                  <div className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
                    {task.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                title="Delete task"
                aria-label={`Delete task: ${task.title}`}
                onClick={() => onDeleteTask(task)}
                className="pointer-events-auto relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="pointer-events-none relative mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className={priorityClass(task.priority)}>{task.priority}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                {task.status}
              </span>
              {intelligence.owner !== 'Unassigned' && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  {intelligence.owner}
                </span>
              )}
              {task.assignment && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                  {intelligence.route}
                </span>
              )}
              {task.assignment?.attempt ? (
                <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">
                  attempt {intelligence.attempts}
                </span>
              ) : null}
              {intelligence.fallbackCount > 0 && (
                <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">
                  {intelligence.fallbackCount} fallback
                </span>
              )}
              {intelligence.blockers > 0 ? (
                <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                  {intelligence.blockers} blocker
                </span>
              ) : null}
              {intelligence.activeUsers > 0 && (
                <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">
                  {intelligence.activeUsers} active
                </span>
              )}
              {intelligence.failed && (
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                  run failed
                </span>
              )}
              {intelligence.criticalRisks > 0 && (
                <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                  {intelligence.criticalRisks} critical risk
                </span>
              )}
              {intelligence.warningRisks > 0 && (
                <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                  {intelligence.warningRisks} warning
                </span>
              )}
              {task.chain && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  chain {task.chain.order + 1}
                </span>
              )}
              {task.assignment?.skills?.length ? (
                <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">
                  {task.assignment.skills.length} skills
                </span>
              ) : null}
              {intelligence.verification !== 'unverified' && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5',
                    intelligence.verification === 'passed'
                      ? 'bg-success/10 text-success'
                      : intelligence.verification === 'failed'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-warning/10 text-warning',
                  )}
                >
                  ✓ {intelligence.verification}
                </span>
              )}
              {intelligence.subtaskCounts && (
                <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">
                  {intelligence.subtaskCounts.done}/{intelligence.subtaskCounts.total} subtasks
                </span>
              )}
              {intelligence.evidenceCount > 0 && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                  {intelligence.evidenceCount} evidence
                </span>
              )}
              {intelligence.pendingDecomposition && (
                <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                  split pending approval
                </span>
              )}
            </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Constants for select fields ──
// Roles and fallback profiles are fixed WrongStack semantics (not provider data),
// so they stay static. Providers and models are loaded live from the user's saved
// configuration via useProviderModels() — never hardcoded.
const KNOWN_ROLES = [
  'architect',
  'developer',
  'reviewer',
  'tester',
  'verifier',
  'security',
  'documenter',
  'external',
  'leader',
  'shadow',
  'subagent',
] as const;

// Fixed capability vocabulary mirroring core's `ToolCapabilities` — a stable
// security enum (like roles), NOT provider data. Blank = the safe subagent
// default grant (WIDE_SUBAGENT_CAPABILITIES) applied server-side.
const KNOWN_CAPABILITIES: ChipOption[] = [
  { value: 'fs.read', label: 'Read files', description: 'fs.read' },
  { value: 'fs.write', label: 'Write files (in project)', description: 'fs.write' },
  {
    value: 'fs.write.outside-project',
    label: 'Write outside project',
    description: 'fs.write.outside-project',
  },
  { value: 'net.outbound', label: 'Outbound network', description: 'net.outbound' },
  { value: 'shell.exec', label: 'Run project commands', description: 'shell.exec' },
  { value: 'shell.restricted', label: 'Restricted shell', description: 'shell.restricted' },
  { value: 'shell.arbitrary', label: 'Arbitrary shell', description: 'shell.arbitrary' },
  { value: 'session.todo', label: 'Session todos', description: 'session.todo' },
  { value: 'tool.meta', label: 'Tool metadata', description: 'tool.meta' },
  { value: 'tool.mutate.any', label: 'Invoke any tool', description: 'tool.mutate.any' },
  { value: 'memory.read', label: 'Read memory', description: 'memory.read' },
  { value: 'memory.write', label: 'Write memory', description: 'memory.write' },
  { value: 'package.install', label: 'Install packages', description: 'package.install' },
  { value: 'subagent.spawn', label: 'Spawn subagents', description: 'subagent.spawn' },
  { value: 'config.mutate', label: 'Mutate config / trust', description: 'config.mutate' },
];

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
  const inspectorScrollRef = useScrollPosition<HTMLDivElement>('kanban-task-inspector', Boolean(task));
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
      kanbanMetadataText(task?.assignment?.agentId) ?? kanbanMetadataText(task?.assignedAgent) ?? '',
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

          <div className="mt-5">
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Completion checks
            </div>
            <div className="space-y-1.5">
              {(task.successCriteria ?? []).map((check) => (
                <div
                  key={check.id}
                  className="grid grid-cols-[auto_1fr_92px] items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs"
                >
                  <Check
                    size={13}
                    className={check.status === 'passed' ? 'text-success' : 'text-muted-foreground'}
                  />
                  <span className="min-w-0 truncate">{check.description}</span>
                  <select
                    value={check.status}
                    onChange={(event) =>
                      sendKanban('kanban.task.check.update', {
                        boardId: board?.id,
                        taskId: task.id,
                        checkId: check.id,
                        status: event.target.value,
                      })
                    }
                    className="h-7 rounded border bg-background px-1 text-[11px]"
                  >
                    {['pending', 'passed', 'failed', 'skipped'].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <div className="flex gap-1.5">
                <input
                  value={newCheck}
                  onChange={(event) => setNewCheck(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && addCheck()}
                  placeholder="Add a verifiable completion check…"
                  className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={addCheck}
                  className="h-8 rounded-md border px-2 hover:bg-muted"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>

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

          <div className="mt-4">
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Record decision / outcome
            </div>
            <div className="mb-1.5 grid grid-cols-2 gap-1.5">
              <select
                value={newActivityKind}
                onChange={(event) =>
                  setNewActivityKind(event.target.value as KanbanManualActivityKind)
                }
                aria-label="Task activity kind"
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                {['decision', 'attempt', 'result', 'blocker', 'observation'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                value={newActivityOutcome}
                onChange={(event) =>
                  setNewActivityOutcome(event.target.value as KanbanManualActivityOutcome)
                }
                aria-label="Task activity outcome"
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                {['unknown', 'succeeded', 'failed', 'partial', 'skipped'].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-1.5">
              <input
                value={newNote}
                onChange={(event) => setNewNote(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && recordActivity()}
                placeholder="What was decided, attempted, or produced?"
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={recordActivity}
                className="h-8 rounded-md border px-2 hover:bg-muted"
                aria-label="Record task decision or outcome"
              >
                <Plus size={14} />
              </button>
            </div>
            <input
              value={newActivityDetails}
              onChange={(event) => setNewActivityDetails(event.target.value)}
              placeholder="Optional evidence, rationale, command, link, or failure detail…"
              aria-label="Task activity details"
              className="mt-1.5 h-8 w-full rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
            />
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function columnTitle(board: KanbanBoard | null, columnId: string): string {
  return board?.columns.find((c) => c.id === columnId)?.title ?? columnId;
}

// Colored badge classes per real KanbanAgentRunStatus.
const RUN_STATUS_STYLE: Record<string, string> = {
  assigned: 'bg-info/10 text-info',
  queued: 'bg-info/10 text-info',
  running: 'bg-warning/10 text-warning',
  completed: 'bg-success/10 text-success',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

function fmtElapsed(fromIso?: string, toIso?: string): string | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return null;
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (Number.isNaN(to)) return null;
  const secs = Math.max(0, Math.round((to - from) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

/**
 * AgentRunPanel — the *real* runtime of the agent working this task, straight
 * from `task.assignment`. Not a hardcoded placeholder: run status, the actual
 * spawned subagent id, dispatch/finish timing, retry attempts, cost ceiling,
 * the last result and any error.
 */
function AgentRunPanel({ assignment }: { assignment: NonNullable<KanbanTask['assignment']> }) {
  const running = assignment.status === 'running';
  const elapsed = fmtElapsed(assignment.dispatchedAt, assignment.completedAt);
  const agentName = kanbanMetadataText(assignment.name) ?? kanbanMetadataText(assignment.agentId);
  const role = kanbanMetadataText(assignment.role);
  const provider = kanbanMetadataText(assignment.provider);
  const model = kanbanMetadataText(assignment.model);
  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  if (agentName) rows.push({ label: 'Agent', value: agentName });
  if (role) rows.push({ label: 'Role', value: role });
  if (assignment.modelRouting) rows.push({ label: 'Model source', value: assignment.modelRouting });
  if (provider || model) {
    rows.push({
      label: 'Model',
      value: (
        <span className="font-mono text-[11px]">
          {provider ? `${provider}/` : ''}
          {model ?? '—'}
        </span>
      ),
    });
  }
  if (assignment.subagentId) {
    rows.push({
      label: 'Subagent',
      value: <span className="font-mono text-[11px]">{assignment.subagentId}</span>,
    });
  }
  if (elapsed) {
    rows.push({ label: assignment.completedAt ? 'Duration' : 'Elapsed', value: elapsed });
  }
  if (typeof assignment.attempt === 'number') {
    rows.push({
      label: 'Attempt',
      value: `${assignment.attempt}${assignment.maxAttempts ? ` / ${assignment.maxAttempts}` : ''}`,
    });
  }
  if (assignment.costCeilingUsd) {
    rows.push({ label: 'Cost ceiling', value: `$${assignment.costCeilingUsd.toFixed(2)}` });
  }
  if (assignment.fallbackProfile) {
    rows.push({ label: 'Fallback profile', value: assignment.fallbackProfile });
  }
  if (assignment.fallbackModels?.length) {
    rows.push({ label: 'Fallbacks', value: assignment.fallbackModels.join(' → ') });
  }
  if (assignment.skills?.length)
    rows.push({ label: 'Skills', value: assignment.skills.join(', ') });
  if (assignment.tools?.length) rows.push({ label: 'Tools', value: assignment.tools.join(', ') });
  if (assignment.leaseExpiresAt) {
    rows.push({
      label: 'Lease expires',
      value: new Date(assignment.leaseExpiresAt).toLocaleString(),
    });
  }

  return (
    <div className="mt-4 rounded-md border bg-background p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Live run
        </span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize',
            RUN_STATUS_STYLE[assignment.status] ?? 'bg-muted text-muted-foreground',
          )}
        >
          {running && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          )}
          {assignment.status}
        </span>
      </div>
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {assignment.lastResult && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase text-muted-foreground">Last result</div>
          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-muted px-2 py-1 text-[11px] leading-relaxed text-foreground">
            {assignment.lastResult}
          </div>
        </div>
      )}
      {assignment.error && (
        <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {assignment.error}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-2 py-1.5">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium">{value}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function priorityClass(priority: KanbanTask['priority']): string {
  const base = 'rounded px-1.5 py-0.5';
  if (priority === 'critical') return `${base} bg-destructive/10 text-destructive`;
  if (priority === 'high') return `${base} bg-warning/10 text-warning`;
  if (priority === 'low') return `${base} bg-muted text-muted-foreground`;
  return `${base} bg-info/10 text-info`;
}
