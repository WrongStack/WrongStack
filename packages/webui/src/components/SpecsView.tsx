import { useCallback, useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import { openMainView } from '@/lib/view-navigation';
import { useSpecsStore, type SpecDetail, type SpecListItem } from '@/stores';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, FileText, LayoutList, Network, Play, X } from 'lucide-react';
import { Button } from './ui/button';
import { DependencyGraph } from './DependencyGraph';

/** Convert a spec's topological columns into AutoPhase phase templates. */
function detailToPhases(detail: SpecDetail): unknown[] {
  return detail.columns.map((col) => ({
    name: col.label,
    description: '',
    priority: 'medium',
    estimateHours: col.tasks.length,
    parallelizable: false,
    taskTemplates: col.tasks.map((t) => ({
      title: t.title,
      description: t.description,
      type: t.type,
      priority: t.priority,
      estimateHours: 1,
    })),
  }));
}

/**
 * SpecsView — FORGE-style Specifications page. Lists persisted SDD specs with
 * progress bars; expanding one fetches and shows its task graph as a List or a
 * topological Dependency Graph (phase columns + dependency refs).
 */
export function SpecsView({ onClose }: { onClose: () => void }): React.ReactElement {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const specs = useSpecsStore((s) => s.specs);
  const detail = useSpecsStore((s) => s.detail);
  const expandedSpecId = useSpecsStore((s) => s.expandedSpecId);
  const setExpanded = useSpecsStore((s) => s.setExpanded);
  const [mode, setMode] = useState<'list' | 'graph'>('graph');

  // Launch the spec's tasks as a live AutoPhase run (phases = topological
  // columns), then jump to the Phases board to watch the agents work.
  const runSpec = useCallback(
    (spec: SpecListItem) => {
      if (!detail || detail.specId !== spec.id) return;
      client?.send?.({
        type: 'autophase.start',
        payload: { title: spec.title, phases: detailToPhases(detail), autonomous: true },
      });
      openMainView('autophase');
    },
    [detail, client],
  );

  // Pull the spec list on mount.
  useEffect(() => {
    client?.send?.({ type: 'specs.list' });
  }, [client]);

  const toggle = useCallback(
    (spec: SpecListItem) => {
      if (expandedSpecId === spec.id) {
        setExpanded(null);
      } else {
        setExpanded(spec.id);
        client?.send?.({ type: 'specs.get', payload: { specId: spec.id } });
      }
    },
    [expandedSpecId, setExpanded, client],
  );

  const allTasks = detail?.columns.flatMap((c) => c.tasks) ?? [];
  const counts = {
    done: allTasks.filter((t) => t.status === 'completed').length,
    running: allTasks.filter((t) => t.status === 'in_progress').length,
    pending: allTasks.filter((t) => t.status === 'pending' || t.displayStatus === 'queued').length,
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between border-b bg-card px-4 py-2">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-warning" />
          <div>
            <h1 className="text-lg font-semibold">{t('activity:specs.heading')}</h1>
            <p className="text-xs text-muted-foreground">
              {t('activity:specs.subtitle')}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {specs.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {t('activity:specs.empty', { command: '/sdd' })}
          </div>
        ) : (
          <div className="space-y-3">
            {specs.map((spec) => {
              const expanded = expandedSpecId === spec.id;
              const pct = spec.total > 0 ? Math.round((spec.completed / spec.total) * 100) : 0;
              return (
                <div key={spec.id} className="rounded-lg border border-border bg-card/60">
                  <button
                    type="button"
                    onClick={() => toggle(spec)}
                    className="flex w-full items-start gap-3 p-4 text-left"
                  >
                    <span className="mt-1 text-muted-foreground">
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                    <FileText className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{spec.displayId}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                          {spec.status}
                        </span>
                      </div>
                      <h2 className="mt-1 text-base font-semibold">{spec.title}</h2>
                      {/* Progress */}
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-success transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          {spec.completed}/{spec.total}
                        </span>
                      </div>
                    </div>
                  </button>

                  {expanded && (
                    <div className="border-t border-border p-4">
                      {/* Tasks header + List/Graph toggle */}
                      <div className="mb-3 flex items-center justify-between">
                        <div className="text-sm font-medium">
                          {t('activity:specs.tasks', { count: detail?.total ?? spec.total })}
                          {detail && (
                            <span className="ml-3 text-xs font-normal text-muted-foreground">
                              <span className="text-success">{t('activity:specs.doneCount', { count: counts.done })}</span>{' '}
                              <span className="text-primary">{t('activity:specs.runningCount', { count: counts.running })}</span>{' '}
                              <span>{t('activity:specs.pendingCount', { count: counts.pending })}</span>
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={!detail || detail.specId !== spec.id}
                          onClick={() => runSpec(spec)}
                          title={t('activity:specs.runTitle')}
                          className="inline-flex items-center gap-1 rounded-md bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning transition-colors hover:bg-warning/25 disabled:opacity-40"
                        >
                          <Play className="h-3.5 w-3.5" /> {t('activity:specs.run')}
                        </button>
                        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                          <button
                            type="button"
                            onClick={() => setMode('list')}
                            className={cn(
                              'inline-flex items-center gap-1 rounded px-2 py-1 text-xs',
                              mode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground',
                            )}
                          >
                            <LayoutList className="h-3.5 w-3.5" /> {t('activity:specs.list')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setMode('graph')}
                            className={cn(
                              'inline-flex items-center gap-1 rounded px-2 py-1 text-xs',
                              mode === 'graph' ? 'bg-primary/15 text-primary' : 'text-muted-foreground',
                            )}
                          >
                            <Network className="h-3.5 w-3.5" /> {t('activity:specs.graph')}
                          </button>
                        </div>
                        </div>
                      </div>

                      {!detail || detail.specId !== spec.id ? (
                        <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                          {t('activity:specs.loadingTasks')}
                        </div>
                      ) : mode === 'graph' ? (
                        <DependencyGraph columns={detail.columns} />
                      ) : (
                        <div className="space-y-1.5">
                          {allTasks.map((t) => (
                            <div
                              key={t.id}
                              className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
                            >
                              <span className="font-mono text-xs text-muted-foreground">{t.shortId}</span>
                              <span className="flex-1 text-sm">{t.title}</span>
                              <span className="text-xs capitalize text-muted-foreground">
                                {t.displayStatus.replace('_', ' ')}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
