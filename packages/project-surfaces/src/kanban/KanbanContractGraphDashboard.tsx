import type { KanbanBoard, KanbanContractNodeKind } from '@wrongstack/kanban';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  GitBranch,
  Maximize2,
  Network,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';
import { ProgressRing } from '../ui/progress-ring';
import {
  buildBoardContractGraphView,
  summarizeBoardContractHealth,
} from './KanbanContractGraphView';

const KIND_LEGEND: Array<{
  kind: KanbanContractNodeKind;
  labelKey: string;
  color: string;
}> = [
  { kind: 'objective', labelKey: 'activity:kanbanText.kind.objective', color: 'bg-blue-500' },
  { kind: 'component', labelKey: 'activity:kanbanText.kind.component', color: 'bg-slate-500' },
  { kind: 'artifact', labelKey: 'activity:kanbanText.kind.artifact', color: 'bg-slate-400' },
  { kind: 'risk', labelKey: 'activity:kanbanText.kind.risk', color: 'bg-amber-500' },
  { kind: 'guardrail', labelKey: 'activity:kanbanText.kind.guardrail', color: 'bg-emerald-500' },
  { kind: 'verification', labelKey: 'activity:kanbanText.evidence', color: 'bg-violet-500' },
];

function HealthStat({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof ShieldCheck;
  label: string;
  value: string | number;
  detail: string;
  tone: 'primary' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/80 p-3 shadow-sm backdrop-blur-sm">
      <div
        className={cn(
          'absolute -right-5 -top-6 h-16 w-16 rounded-full blur-2xl transition-opacity group-hover:opacity-90',
          tone === 'primary' && 'bg-primary/25',
          tone === 'success' && 'bg-success/25',
          tone === 'warning' && 'bg-warning/25',
          tone === 'danger' && 'bg-destructive/25',
        )}
      />
      <div className="relative flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {label}
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{detail}</div>
        </div>
        <span className="rounded-lg border bg-background/70 p-2 text-muted-foreground shadow-sm">
          <Icon size={15} />
        </span>
      </div>
    </div>
  );
}

function BoardContractCanvas({
  graph,
  nodeOwner,
  onSelectTask,
  expanded,
  onExpand,
}: {
  graph: ReturnType<typeof buildBoardContractGraphView>;
  nodeOwner: ReadonlyMap<string, string>;
  onSelectTask: (taskId: string) => void;
  expanded: boolean;
  onExpand?: (() => void) | undefined;
}) {
  const { t } = useAppTranslation();
  return (
    <div
      data-contract-board-canvas={expanded ? 'expanded' : 'embedded'}
      className={cn(
        'relative overflow-hidden bg-viz-surface',
        expanded
          ? 'h-full min-h-0 w-full'
          : 'h-[72vh] min-h-[680px] max-h-[880px] rounded-2xl border ws-dialog shadow-black/10',
      )}
    >
      <div className="pointer-events-none absolute left-4 top-3 z-10 rounded-lg border border-white/10 bg-black/40 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-100">
          <Network size={13} className="text-cyan-300" />{' '}
          {t('activity:kanbanText.liveDependencyField')}
        </div>
        <div className="mt-0.5 text-[9px] text-slate-400">
          {t('activity:kanbanText.dragCanvasHint')}
        </div>
      </div>
      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          className="absolute right-4 top-3 z-10 inline-flex items-center gap-2 rounded-lg border border-cyan-300/25 bg-slate-950/85 px-3 py-2 text-[11px] font-semibold text-cyan-200 ws-dialog backdrop-blur transition-colors hover:border-cyan-300/50 hover:bg-slate-900"
          aria-label={t('activity:kanban.contractGraph.expandBoardAria')}
        >
          <Maximize2 size={13} /> {t('activity:kanbanText.expandMap')}
        </button>
      )}
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        fitView
        fitViewOptions={{ padding: expanded ? 0.1 : 0.16, maxZoom: expanded ? 1.15 : 1.05 }}
        minZoom={0.1}
        maxZoom={1.7}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        onNodeClick={(_event, node) => {
          const taskId = node.id.startsWith('task:') ? node.id.slice(5) : nodeOwner.get(node.id);
          if (taskId) onSelectTask(taskId);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#22314a" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => String(node.data.color ?? '#64748b')}
          maskColor="rgba(2, 6, 23, 0.72)"
          className="!border !border-white/10 !bg-slate-950/80"
        />
        <Controls
          showInteractive={false}
          className="!overflow-hidden !rounded-lg !border !border-white/10 !bg-slate-950/80 !ws-dialog [&_button]:!border-slate-700 [&_button]:!bg-slate-900 [&_button]:!fill-slate-200"
        />
      </ReactFlow>
    </div>
  );
}

export function KanbanContractGraphDashboard({
  board,
  onSelectTask,
}: {
  board: KanbanBoard;
  onSelectTask: (taskId: string) => void;
}) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const health = useMemo(() => summarizeBoardContractHealth(board), [board.id, board.revision]);
  const graph = useMemo(() => buildBoardContractGraphView(board, t), [board.id, board.revision, t]);
  const nodeOwner = useMemo(
    () => new Map(board.contractGraph?.nodes.map((node) => [node.id, node.taskId]) ?? []),
    [board.id, board.revision],
  );
  const strict = health.enforcement === 'strict';
  const fullyClosed = health.openTasks === 0 && health.totalTasks > 0;

  return (
    <div className="h-full overflow-y-auto bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.08),transparent_34%),radial-gradient(circle_at_top_right,hsl(var(--info)/0.08),transparent_28%)] p-4">
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-card via-card to-primary/5 p-4 shadow-lg shadow-primary/5">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 left-1/3 h-56 w-56 rounded-full bg-info/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="relative hidden h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary shadow-inner sm:flex">
              <Radar size={28} />
              <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-success shadow-[0_0_10px_hsl(var(--success))]" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold tracking-tight">
                  {t('activity:kanbanText.contractMap')}
                </h2>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider',
                    strict
                      ? 'border-success/30 bg-success/10 text-success'
                      : 'border-warning/30 bg-warning/10 text-warning',
                  )}
                >
                  {health.enforcement}
                </span>
                {fullyClosed && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
                    <Sparkles size={11} /> {t('activity:kanbanText.allContractsClosed')}
                  </span>
                )}
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                {t('activity:kanbanText.contractMapDescription')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 rounded-xl border border-border/70 bg-background/60 px-4 py-2 backdrop-blur">
            <ProgressRing pct={health.closurePct} />
            <div>
              <div className="text-xs font-semibold">{t('activity:kanbanText.safetyClosure')}</div>
              <div className="text-[11px] text-muted-foreground">
                {t('activity:kanbanText.taskContractsClosed', {
                  closed: health.closedTasks,
                  total: health.totalTasks,
                })}
              </div>
              <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                <CircleDot size={10} />{' '}
                {t('activity:kanbanText.coveragePct', { pct: Math.round(health.coveragePct) })}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">
        <HealthStat
          icon={Network}
          label={t('activity:kanbanText.mappedTasks')}
          value={`${health.contractedTasks}/${health.totalTasks}`}
          detail={t('activity:kanbanText.contractCoverage', {
            pct: Math.round(health.coveragePct),
          })}
          tone="primary"
        />
        <HealthStat
          icon={CircleDot}
          label={t('activity:kanbanText.startReady')}
          value={`${health.readyTasks}/${health.totalTasks}`}
          detail={t('activity:kanbanText.setupGaps', { count: health.readinessIssues })}
          tone={health.readyTasks === health.totalTasks ? 'success' : 'warning'}
        />
        <HealthStat
          icon={ShieldCheck}
          label={t('activity:kanbanText.closed')}
          value={health.closedTasks}
          detail={t('activity:kanbanText.objectivesProven')}
          tone="success"
        />
        <HealthStat
          icon={ShieldAlert}
          label={t('activity:kanbanText.openIssues')}
          value={health.openIssues}
          detail={t('activity:kanbanText.tasksNeedAttention', { count: health.openTasks })}
          tone={health.openIssues > 0 ? 'danger' : 'success'}
        />
        <HealthStat
          icon={GitBranch}
          label={t('activity:kanbanText.evidence')}
          value={health.evidenceNodes}
          detail={t('activity:kanbanText.blockingNodes', { count: health.blockingNodes })}
          tone={health.evidenceNodes > 0 ? 'primary' : 'warning'}
        />
      </section>

      <section className="mt-3 grid min-h-[560px] gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <BoardContractCanvas
          graph={graph}
          nodeOwner={nodeOwner}
          onSelectTask={onSelectTask}
          expanded={false}
          onExpand={() => setExpanded(true)}
        />

        <aside className="space-y-3">
          <div className="rounded-xl border bg-card/80 shadow-sm">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs font-semibold">
              <AlertTriangle
                size={14}
                className={health.openTasks ? 'text-warning' : 'text-success'}
              />
              {t('activity:kanbanText.taskContractStatus')}
            </div>
            <div className="max-h-72 divide-y overflow-y-auto">
              {[...health.tasks]
                .sort((left, right) => Number(left.closed) - Number(right.closed))
                .map((task) => (
                  <button
                    key={task.taskId}
                    type="button"
                    onClick={() => onSelectTask(task.taskId)}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/40"
                  >
                    {task.closed ? (
                      <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                    ) : task.ready ? (
                      <CircleDot size={14} className="mt-0.5 shrink-0 text-primary" />
                    ) : (
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{task.title}</span>
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {task.contracted
                          ? `${
                              task.ready
                                ? t('activity:kanbanText.startReadyLower')
                                : t('activity:kanbanText.setupGaps', {
                                    count: task.readinessIssueCount,
                                  })
                            } · ${t('activity:kanbanText.completionOpen', { count: task.issueCount })}`
                          : t('activity:kanbanText.noContractNodes')}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          </div>

          <div className="rounded-xl border bg-card/80 p-3 shadow-sm">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t('activity:kanbanText.contractVocabulary')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {KIND_LEGEND.map((entry) => (
                <div key={entry.kind} className="flex items-center gap-2 text-[10px]">
                  <span className={cn('h-2.5 w-2.5 rounded-sm shadow-sm', entry.color)} />
                  <span className="min-w-0 truncate">{t(entry.labelKey)}</span>
                  <span className="ml-auto font-mono text-muted-foreground">
                    {health.nodesByKind[entry.kind]}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {!strict && (
            <div className="rounded-xl border border-warning/30 bg-warning/5 p-3 text-[11px] leading-5 text-warning">
              <div className="flex items-center gap-2 font-semibold">
                <ShieldAlert size={14} /> {t('activity:kanbanText.strictNotActive')}
              </div>
              <p className="mt-1 text-muted-foreground">{t('activity:kanbanText.strictAdvice')}</p>
            </div>
          )}
        </aside>
      </section>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          aria-describedby="board-contract-map-modal-description"
          className="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden border-white/10 bg-viz-surface p-0 text-slate-100 sm:p-0"
        >
          <div className="shrink-0 border-b border-white/10 bg-slate-950/90 px-5 py-4 pr-14 text-slate-100">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Network size={17} className="text-cyan-300" />{' '}
              {t('activity:kanbanText.contractMapTitle', { title: board.title })}
            </DialogTitle>
            <DialogDescription
              id="board-contract-map-modal-description"
              className="mt-1 text-xs text-slate-400"
            >
              {t('activity:kanbanText.boardMapDescription')}
            </DialogDescription>
          </div>
          <div className="min-h-0 flex-1">
            <BoardContractCanvas
              graph={graph}
              nodeOwner={nodeOwner}
              onSelectTask={onSelectTask}
              expanded
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
