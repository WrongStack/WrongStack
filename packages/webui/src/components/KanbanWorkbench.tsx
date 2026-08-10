import type {
  KanbanWorkbenchItem,
  KanbanWorkbenchLane,
  KanbanWorkbenchSnapshot,
} from '@wrongstack/kanban';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  GitBranch,
  Layers3,
  ShieldAlert,
} from 'lucide-react';

const LANE_COPY: Record<
  KanbanWorkbenchLane,
  { title: string; subtitle: string; icon: typeof Clock3; tone: string }
> = {
  now: {
    title: 'NOW',
    subtitle: 'Actively executing',
    icon: Clock3,
    tone: 'border-amber-500/30 bg-amber-500/5',
  },
  next: {
    title: 'NEXT',
    subtitle: 'Ready or queued',
    icon: CircleDot,
    tone: 'border-blue-500/30 bg-blue-500/5',
  },
  blocked: {
    title: 'BLOCKED',
    subtitle: 'Needs intervention',
    icon: ShieldAlert,
    tone: 'border-red-500/30 bg-red-500/5',
  },
  review: {
    title: 'REVIEW',
    subtitle: 'Needs proof or acceptance',
    icon: CheckCircle2,
    tone: 'border-violet-500/30 bg-violet-500/5',
  },
};

export function KanbanWorkbench({
  snapshot,
  loading,
  error,
  onRetry,
  onSelectTask,
}: {
  snapshot: KanbanWorkbenchSnapshot | null;
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  onSelectTask: (boardId: string, taskId: string) => void;
}) {
  if (!snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <Layers3 size={28} strokeWidth={1.5} aria-hidden="true" />
        <div>
          {loading
            ? 'Loading project workbench…'
            : error
              ? `Project workbench could not be loaded: ${error}`
              : 'Project workbench has not been loaded yet.'}
        </div>
        {!loading ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Retry workbench
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="h-full min-w-[760px] overflow-auto p-4">
      <section className="overflow-hidden rounded-xl border bg-gradient-to-br from-primary/10 via-background to-background">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b p-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              <Layers3 size={15} /> Project workbench
            </div>
            <h2 className="mt-1 text-xl font-semibold">One truthful view of every active board</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Session mirrors remain tactical; managed cards remain durable. This view only projects
              their shared execution state and never creates a second source of truth.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <Metric label="BOARDS" value={snapshot.boardCount} />
            <Metric label="ACTIVE" value={snapshot.totals.active} />
            <Metric label="ALERTS" value={snapshot.alertTotal} warning={snapshot.alertTotal > 0} />
          </div>
        </div>

        <div className="grid grid-cols-5 gap-0 overflow-x-auto p-4">
          {snapshot.flow.map((step, index) => (
            <div className="relative min-w-32 px-2 text-center" key={step.id}>
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full border bg-background text-sm font-bold">
                {step.count}
              </div>
              <div className="mt-2 text-xs font-semibold">{step.label}</div>
              <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
                {step.explanation}
              </div>
              {index < snapshot.flow.length - 1 ? (
                <ArrowRight
                  className="absolute -right-2 top-2.5 text-muted-foreground/50"
                  size={14}
                />
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {snapshot.alertTotal > 0 ? (
        <section className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            <AlertTriangle size={14} /> Attention required · {snapshot.alertTotal}
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {snapshot.alerts.map((alert) => (
              <button
                type="button"
                key={alert.id}
                disabled={!alert.boardId || !alert.taskId}
                onClick={() => {
                  if (alert.boardId && alert.taskId) onSelectTask(alert.boardId, alert.taskId);
                }}
                className="rounded-lg border bg-background/70 p-2 text-left disabled:cursor-default"
              >
                <div className="text-xs font-medium">{alert.title}</div>
                <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                  {alert.detail}
                </div>
              </button>
            ))}
          </div>
          {snapshot.alertsOmitted > 0 ? (
            <div className="mt-2 text-[10px] text-muted-foreground">
              +{snapshot.alertsOmitted} more alerts hidden by the bounded view
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mt-3 grid gap-3 xl:grid-cols-4">
        {(Object.keys(LANE_COPY) as KanbanWorkbenchLane[]).map((lane) => {
          const copy = LANE_COPY[lane];
          const laneSnapshot = snapshot.lanes[lane];
          const Icon = copy.icon;
          return (
            <div key={lane} className={`min-w-0 rounded-xl border p-3 ${copy.tone}`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-bold tracking-wider">
                    <Icon size={13} /> {copy.title}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">{copy.subtitle}</div>
                </div>
                <span className="rounded-full border bg-background px-2 py-0.5 text-xs font-semibold">
                  {laneSnapshot.total}
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {laneSnapshot.items.length > 0 ? (
                  laneSnapshot.items.map((item) => (
                    <WorkbenchCard
                      key={`${item.boardId}:${item.taskId}`}
                      item={item}
                      onSelect={onSelectTask}
                    />
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                    No work in this lane
                  </div>
                )}
              </div>
              {laneSnapshot.omitted > 0 ? (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  +{laneSnapshot.omitted} more cards hidden to keep focus
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function WorkbenchCard({
  item,
  onSelect,
}: {
  item: KanbanWorkbenchItem;
  onSelect: (boardId: string, taskId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.boardId, item.taskId)}
      className="w-full rounded-lg border bg-background p-2.5 text-left shadow-sm transition hover:border-primary/40 hover:shadow"
    >
      <div className="flex items-start justify-between gap-2">
        <strong className="line-clamp-2 text-xs leading-4">{item.title}</strong>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
          {item.source}
        </span>
      </div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground">{item.boardTitle}</div>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="rounded border px-1 py-0.5">{item.priority}</span>
        {item.childProgress ? (
          <span className="flex items-center gap-1">
            <GitBranch size={10} /> {item.childProgress.completed}/{item.childProgress.total}{' '}
            children
          </span>
        ) : null}
      </div>
      <div className="mt-2 text-[10px] leading-4 text-foreground/80">{item.reason}</div>
      {item.contractStatus ? (
        <div
          className={`mt-2 rounded border px-1.5 py-1 text-[9px] font-semibold uppercase ${
            item.contractStatus.startReady
              ? 'border-blue-500/30 bg-blue-500/5 text-blue-600 dark:text-blue-400'
              : 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400'
          }`}
        >
          {item.contractStatus.startReady
            ? 'Contract · start ready'
            : `Contract · ${item.contractStatus.setupGaps} setup gaps`}{' '}
          ·{' '}
          {item.contractStatus.closed
            ? 'closed'
            : `${item.contractStatus.completionOpen} completion open`}
        </div>
      ) : null}
    </button>
  );
}

function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: number;
  warning?: boolean;
}) {
  return (
    <div className="min-w-16 rounded-lg border bg-background/70 px-2 py-1.5">
      <div className={warning ? 'font-bold text-amber-500' : 'font-bold'}>{value}</div>
      <div className="text-[9px] text-muted-foreground">{label}</div>
    </div>
  );
}
