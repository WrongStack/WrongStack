import { useCallback, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useGoalRunStore } from '@/stores';
import { cn } from '@/lib/utils';
import { Columns3, Plus, Rows3 } from 'lucide-react';
import { TaskCard, type TaskItem } from './TaskCard';
import type { PhaseItem } from './PhasePanel';
import { promptModal } from './ConfirmModal';

type BoardLayout = 'phase' | 'status';

type BoardTask = TaskItem & { phaseId: string };

const STATUS_COLUMNS: Array<{ key: TaskItem['status']; match: TaskItem['status'][] }> = [
  { key: 'pending', match: ['pending', 'blocked'] },
  { key: 'in_progress', match: ['in_progress'] },
  { key: 'review', match: ['review'] },
  { key: 'failed', match: ['failed'] },
  { key: 'completed', match: ['completed'] },
];

const PHASE_STATUS_BADGE: Record<PhaseItem['status'], string> = {
  pending: 'bg-muted text-muted-foreground',
  ready: 'bg-info/15 text-info',
  running: 'bg-primary/15 text-primary',
  paused: 'bg-warning/15 text-warning',
  completed: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
  skipped: 'bg-muted text-muted-foreground',
};

/**
 * BoardView — the interactive kanban over the live Goal graph.
 *
 * Two toggleable layouts:
 *   • "phase"  — one column per phase, cards are tasks; drag a card to another
 *                phase column to move it (goal.moveTask).
 *   • "status" — Pending/In-Progress/Review/Failed/Done columns with one swimlane
 *                per phase; drag a card to another status column to change it.
 *
 * Cards expose manual agent assignment + retry; in-progress cards show the live
 * worker. Drag-drop uses the native HTML5 DnD API (no extra dependency).
 */
export function BoardView(): React.ReactElement {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const phases = useGoalRunStore((s) => s.phases);
  const multiBoard = useGoalRunStore((s) => s.multiBoard);
  const [layout, setLayout] = useState<BoardLayout>('phase');
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  /** Active phase tab index when multiBoard is true. */
  const [activePhaseIdx, setActivePhaseIdx] = useState(0);
  // Clamp active index when phases change.
  const safePhaseIdx = Math.min(activePhaseIdx, Math.max(0, phases.length - 1));
  const activePhase = multiBoard ? phases[safePhaseIdx] : undefined;

  const tasks = useMemo<BoardTask[]>(
    () => phases.flatMap((p) => (p.tasks ?? []).map((t) => ({ ...t, phaseId: p.id }))),
    [phases],
  );

  // Candidate agents for manual (re)assignment: the worker identities already
  // present on the board (auto-assigned scientist names), deduped.
  const agents = useMemo(
    () => [...new Set(tasks.map((t) => t.assignee).filter((a): a is string => Boolean(a)))],
    [tasks],
  );

  const send = useCallback(
    (msg: Parameters<NonNullable<typeof client>['send']>[0]) => client?.send?.(msg),
    [client],
  );

  const onStatusChange = useCallback(
    (taskId: string, status: TaskItem['status']) =>
      send({ type: 'goal.taskStatus', payload: { taskId, status } }),
    [send],
  );
  const onRetry = useCallback(
    (taskId: string) => send({ type: 'goal.retryTask', payload: { taskId } }),
    [send],
  );
  const onAssign = useCallback(
    (taskId: string, agentName: string) =>
      send({ type: 'goal.assignTask', payload: { taskId, agentName: agentName || undefined } }),
    [send],
  );
  const onAddTask = useCallback(
    (phaseId: string) => {
      void promptModal({
        title: t('activity:board.newTaskTitle'),
        placeholder: t('activity:board.newTaskPlaceholder'),
        confirmLabel: t('activity:board.addTask'),
      }).then((title) => {
        if (title) send({ type: 'goal.addTask', payload: { phaseId, title } });
      });
    },
    [send],
  );

  const dropToPhase = useCallback(
    (toPhaseId: string) => {
      if (dragId) send({ type: 'goal.moveTask', payload: { taskId: dragId, toPhaseId } });
      setDragId(null);
      setHoverKey(null);
    },
    [dragId, send],
  );
  const dropToStatus = useCallback(
    (status: TaskItem['status']) => {
      if (dragId) send({ type: 'goal.taskStatus', payload: { taskId: dragId, status } });
      setDragId(null);
      setHoverKey(null);
    },
    [dragId, send],
  );

  const callbacks = { onStatusChange, onRetry, agents, onAssign } as const;

  function draggable(taskId: string) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragId(taskId);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => {
        setDragId(null);
        setHoverKey(null);
      },
    };
  }
  function dropZone(key: string, onDrop: () => void) {
    return {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (hoverKey !== key) setHoverKey(key);
      },
      onDragLeave: () => setHoverKey((k) => (k === key ? null : k)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        onDrop();
      },
      'data-hover': hoverKey === key || undefined,
    };
  }

  if (phases.length === 0) {
    return (
      <div className="flex h-full min-h-0 min-w-0 items-center justify-center text-muted-foreground">
        <p className="text-sm">{t('activity:board.empty')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {t('activity:board.summary', { phases: phases.length, tasks: tasks.length })}
        </span>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <button
            type="button"
            onClick={() => setLayout('phase')}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              layout === 'phase'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Columns3 className="h-3.5 w-3.5" /> {t('activity:board.phases')}
          </button>
          <button
            type="button"
            onClick={() => setLayout('status')}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              layout === 'status'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Rows3 className="h-3.5 w-3.5" /> {t('activity:board.statusTab')}
          </button>
        </div>
      </div>

      {/* Board */}
      {multiBoard && activePhase ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Phase tabs */}
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
            {phases.map((phase, idx) => (
              <button
                key={phase.id}
                type="button"
                onClick={() => setActivePhaseIdx(idx)}
                className={cn(
                  'shrink-0 rounded-t px-3 py-1.5 text-xs font-medium transition-colors',
                  idx === safePhaseIdx
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <span className="truncate">{phase.name}</span>
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  {phase.completedTasks}/{phase.taskCount}
                </span>
              </button>
            ))}
          </div>
          {/* Single-phase board */}
          <SinglePhaseBoard
            phase={activePhase}
            allTasks={tasks}
            layout={layout}
            dragId={dragId}
            hoverKey={hoverKey}
            callbacks={callbacks}
            draggable={draggable}
            dropZone={dropZone}
            dropToPhase={dropToPhase}
            dropToStatus={dropToStatus}
            onAddTask={onAddTask}
          />
        </div>
      ) : (
        /* All-phase board — existing phase-column or status-swimlane layout */
        <AllPhaseBoard
          phases={phases}
          allTasks={tasks}
          layout={layout}
          dragId={dragId}
          hoverKey={hoverKey}
          callbacks={callbacks}
          draggable={draggable}
          dropZone={dropZone}
          dropToPhase={dropToPhase}
          dropToStatus={dropToStatus}
          onAddTask={onAddTask}
        />
      )}
    </div>
  );
}

// ── Helper prop type ──────────────────────────────────────────────────
interface CardCallbacks {
  onStatusChange: (taskId: string, status: TaskItem['status']) => void;
  onRetry: (taskId: string) => void;
  agents: string[];
  onAssign: (taskId: string, agentName: string) => void;
}

// ── Sub-components ─────────────────────────────────────────────────────

/** Single-phase kanban column (used both in all-phase and multi-board views). */
function PhaseColumn({
  phase,
  phaseTasks,
  callbacks,
  draggable,
  dropZone,
  dropToPhase,
  onAddTask,
  dragId,
  hoverKey,
}: {
  phase: PhaseItem;
  phaseTasks: BoardTask[];
  callbacks: CardCallbacks;
  draggable: (taskId: string) => Record<string, unknown>;
  dropZone: (key: string, onDrop: () => void) => Record<string, unknown>;
  dropToPhase: (phaseId: string) => void;
  onAddTask: (phaseId: string) => void;
  dragId: string | null;
  hoverKey: string | null;
}): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <div
      {...dropZone(`phase:${phase.id}`, () => dropToPhase(phase.id))}
      className={cn(
        'flex min-h-0 w-80 shrink-0 flex-col rounded-lg border bg-muted/30 transition-colors',
        hoverKey === `phase:${phase.id}` ? 'border-primary/60 bg-primary/5' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{phase.name}</span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium capitalize',
                PHASE_STATUS_BADGE[phase.status],
              )}
            >
              {phase.status}
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {phase.completedTasks}/{phase.taskCount} · {phase.progressPercent}%
          </span>
        </div>
        <button
          type="button"
          onClick={() => onAddTask(phase.id)}
          title={t('activity:board.addTask')}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2">
        {phaseTasks.length === 0 ? (
          <p className="px-1 py-4 text-center text-[11px] text-muted-foreground">
            {t('activity:board.dropHere')}
          </p>
        ) : (
          phaseTasks.map((task) => (
            <div
              key={task.id}
              {...draggable(task.id)}
              className={cn(dragId === task.id && 'opacity-50')}
            >
              <TaskCard task={task} {...callbacks} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** All-phase phase-column layout. */
function AllPhaseBoard({
  phases,
  allTasks,
  layout,
  dragId,
  hoverKey,
  callbacks,
  draggable,
  dropZone,
  dropToPhase,
  dropToStatus,
  onAddTask,
}: {
  phases: PhaseItem[];
  allTasks: BoardTask[];
  layout: BoardLayout;
  dragId: string | null;
  hoverKey: string | null;
  callbacks: CardCallbacks;
  draggable: (taskId: string) => Record<string, unknown>;
  dropZone: (key: string, onDrop: () => void) => Record<string, unknown>;
  dropToPhase: (phaseId: string) => void;
  dropToStatus: (status: TaskItem['status']) => void;
  onAddTask: (phaseId: string) => void;
}): React.ReactElement {
  return (
    <>
      {layout === 'phase' ? (
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-3">
          {phases.map((phase) => {
            const phaseTasks = allTasks.filter((t) => t.phaseId === phase.id);
            return (
              <PhaseColumn
                key={phase.id}
                phase={phase}
                phaseTasks={phaseTasks}
                callbacks={callbacks}
                draggable={draggable}
                dropZone={dropZone}
                dropToPhase={dropToPhase}
                onAddTask={onAddTask}
                dragId={dragId}
                hoverKey={hoverKey}
              />
            );
          })}
        </div>
      ) : (
        <StatusSwimlaneBoard
          phases={phases}
          allTasks={allTasks}
          dragId={dragId}
          hoverKey={hoverKey}
          callbacks={callbacks}
          draggable={draggable}
          dropZone={dropZone}
          dropToStatus={dropToStatus}
        />
      )}
    </>
  );
}

/** Single-phase board for multi-board mode. */
function SinglePhaseBoard({
  phase,
  allTasks,
  layout,
  dragId,
  hoverKey,
  callbacks,
  draggable,
  dropZone,
  dropToPhase,
  dropToStatus,
  onAddTask,
}: {
  phase: PhaseItem;
  allTasks: BoardTask[];
  layout: BoardLayout;
  dragId: string | null;
  hoverKey: string | null;
  callbacks: CardCallbacks;
  draggable: (taskId: string) => Record<string, unknown>;
  dropZone: (key: string, onDrop: () => void) => Record<string, unknown>;
  dropToPhase: (phaseId: string) => void;
  dropToStatus: (status: TaskItem['status']) => void;
  onAddTask: (phaseId: string) => void;
}): React.ReactElement {
  const phaseTasks = allTasks.filter((t) => t.phaseId === phase.id);
  const { t } = useAppTranslation();

  if (layout === 'phase') {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-3">
        <PhaseColumn
          phase={phase}
          phaseTasks={phaseTasks}
          callbacks={callbacks}
          draggable={draggable}
          dropZone={dropZone}
          dropToPhase={dropToPhase}
          onAddTask={onAddTask}
          dragId={dragId}
          hoverKey={hoverKey}
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3">
      <div
        className="grid min-w-[900px] gap-2"
        style={{ gridTemplateColumns: `9rem repeat(${STATUS_COLUMNS.length}, minmax(0, 1fr))` }}
      >
        <div />
        {STATUS_COLUMNS.map((col) => (
          <div
            key={col.key}
            className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {t(`activity:board.status.${col.key}`)}
          </div>
        ))}
        <FragmentRow key={phase.id}>
          <div className="flex items-center pr-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{phase.name}</div>
              <span
                className={cn(
                  'mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] capitalize',
                  PHASE_STATUS_BADGE[phase.status],
                )}
              >
                {phase.status}
              </span>
            </div>
          </div>
          {STATUS_COLUMNS.map((col) => {
            const cellTasks = phaseTasks.filter((t) => col.match.includes(t.status));
            const key = `cell:${phase.id}:${col.key}`;
            return (
              <div
                key={col.key}
                {...dropZone(key, () => dropToStatus(col.key))}
                className={cn(
                  'min-h-[4rem] space-y-2 rounded-md border p-1.5 transition-colors',
                  hoverKey === key ? 'border-primary/60 bg-primary/5' : 'border-border bg-muted/20',
                )}
              >
                {cellTasks.map((task) => (
                  <div
                    key={task.id}
                    {...draggable(task.id)}
                    className={cn(dragId === task.id && 'opacity-50')}
                  >
                    <TaskCard task={task} compact {...callbacks} />
                  </div>
                ))}
              </div>
            );
          })}
        </FragmentRow>
      </div>
    </div>
  );
}

/** Status-swimlane board (all phases in one grid). */
function StatusSwimlaneBoard({
  phases,
  allTasks,
  dragId,
  hoverKey,
  callbacks,
  draggable,
  dropZone,
  dropToStatus,
}: {
  phases: PhaseItem[];
  allTasks: BoardTask[];
  dragId: string | null;
  hoverKey: string | null;
  callbacks: CardCallbacks;
  draggable: (taskId: string) => Record<string, unknown>;
  dropZone: (key: string, onDrop: () => void) => Record<string, unknown>;
  dropToStatus: (status: TaskItem['status']) => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <div
      className="grid min-w-[900px] gap-2"
      style={{ gridTemplateColumns: `9rem repeat(${STATUS_COLUMNS.length}, minmax(0, 1fr))` }}
    >
      <div />
      {STATUS_COLUMNS.map((col) => (
        <div
          key={col.key}
          className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {t(`activity:board.status.${col.key}`)}
        </div>
      ))}
      {phases.map((phase) => (
        <FragmentRow key={phase.id}>
          <div className="flex items-center pr-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{phase.name}</div>
              <span
                className={cn(
                  'mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] capitalize',
                  PHASE_STATUS_BADGE[phase.status],
                )}
              >
                {phase.status}
              </span>
            </div>
          </div>
          {STATUS_COLUMNS.map((col) => {
            const cellTasks = allTasks.filter(
              (t) => t.phaseId === phase.id && col.match.includes(t.status),
            );
            const key = `cell:${phase.id}:${col.key}`;
            return (
              <div
                key={col.key}
                {...dropZone(key, () => dropToStatus(col.key))}
                className={cn(
                  'min-h-[4rem] space-y-2 rounded-md border p-1.5 transition-colors',
                  hoverKey === key ? 'border-primary/60 bg-primary/5' : 'border-border bg-muted/20',
                )}
              >
                {cellTasks.map((task) => (
                  <div
                    key={task.id}
                    {...draggable(task.id)}
                    className={cn(dragId === task.id && 'opacity-50')}
                  >
                    <TaskCard task={task} compact {...callbacks} />
                  </div>
                ))}
              </div>
            );
          })}
        </FragmentRow>
      ))}
    </div>
  );
}

/** Grid rows are flattened cells; this just groups a row's children inline. */
function FragmentRow({ children }: { children: React.ReactNode }): React.ReactElement {
  return <>{children}</>;
}
