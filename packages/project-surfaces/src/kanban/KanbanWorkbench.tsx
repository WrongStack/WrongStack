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
import { useAppTranslation } from '../lib/i18n';
import { enumLabel, TASK_PRIORITY_KEYS } from './kanban-labels';

const LANE_COPY: Record<
  KanbanWorkbenchLane,
  { titleKey: string; subtitleKey: string; icon: typeof Clock3; tone: string }
> = {
  now: {
    titleKey: 'activity:kanban.workbench.now.title',
    subtitleKey: 'activity:kanban.workbench.now.subtitle',
    icon: Clock3,
    tone: 'border-amber-500/30 bg-amber-500/5',
  },
  next: {
    titleKey: 'activity:kanban.workbench.next.title',
    subtitleKey: 'activity:kanban.workbench.next.subtitle',
    icon: CircleDot,
    tone: 'border-blue-500/30 bg-blue-500/5',
  },
  blocked: {
    titleKey: 'activity:kanban.workbench.blocked.title',
    subtitleKey: 'activity:kanban.workbench.blocked.subtitle',
    icon: ShieldAlert,
    tone: 'border-red-500/30 bg-red-500/5',
  },
  review: {
    titleKey: 'activity:kanban.workbench.review.title',
    subtitleKey: 'activity:kanban.workbench.review.subtitle',
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
  const { t } = useAppTranslation();

  if (!snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <Layers3 size={28} strokeWidth={1.5} aria-hidden="true" />
        <div>
          {loading
            ? t('activity:kanban.workbench.loading')
            : error
              ? t('activity:kanban.workbench.loadError', { error })
              : t('activity:kanban.workbench.notLoaded')}
        </div>
        {!loading ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            {t('activity:kanban.workbench.retry')}
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
              <Layers3 size={15} /> {t('activity:kanban.workbench.headerLabel')}
            </div>
            <h2 className="mt-1 text-xl font-semibold">
              {t('activity:kanban.workbench.headline')}
            </h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              {t('activity:kanban.workbench.description')}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <Metric
              label={t('activity:kanban.workbench.metricBoards')}
              value={snapshot.boardCount}
            />
            <Metric
              label={t('activity:kanban.workbench.metricActive')}
              value={snapshot.totals.active}
            />
            <Metric
              label={t('activity:kanban.workbench.metricAlerts')}
              value={snapshot.alertTotal}
              warning={snapshot.alertTotal > 0}
            />
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
            <AlertTriangle size={14} />{' '}
            {t('activity:kanban.workbench.attentionRequired', { count: snapshot.alertTotal })}
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
              +{t('activity:kanban.workbench.moreAlertsHidden', { count: snapshot.alertsOmitted })}
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
                    <Icon size={13} /> {t(copy.titleKey)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {t(copy.subtitleKey)}
                  </div>
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
                    {t('activity:kanban.workbench.noWorkInLane')}
                  </div>
                )}
              </div>
              {laneSnapshot.omitted > 0 ? (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  +{t('activity:kanban.workbench.moreCardsHidden', { count: laneSnapshot.omitted })}
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
  const { t } = useAppTranslation();
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
        <span className="rounded border px-1 py-0.5">
          {enumLabel(t, TASK_PRIORITY_KEYS, item.priority)}
        </span>
        {item.childProgress ? (
          <span className="flex items-center gap-1">
            <GitBranch size={10} />{' '}
            {t('activity:kanbanText.childProgress', {
              completed: item.childProgress.completed,
              total: item.childProgress.total,
            })}
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
            ? t('activity:kanbanText.contractStartReady')
            : t('activity:kanbanText.contractSetupGaps', {
                count: item.contractStatus.setupGaps,
              })}{' '}
          ·{' '}
          {item.contractStatus.closed
            ? t('activity:kanbanText.closedLower')
            : t('activity:kanbanText.completionOpen', {
                count: item.contractStatus.completionOpen,
              })}
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
