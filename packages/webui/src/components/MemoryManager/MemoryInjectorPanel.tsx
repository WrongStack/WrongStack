import { Activity, Brain, Clock, PanelRightClose, Tag } from 'lucide-react';
import { memo, useEffect } from 'react';
import { useAppTranslation } from '@/i18n';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { cn } from '@/lib/utils';

interface MemoryInjectorPanelProps {
  open: boolean;
  onClose: () => void;
}

function formatTime(at: string): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return at;
  }
}

function stateColor(state: string): string {
  switch (state) {
    case 'active':
      return 'text-success border-success/30 bg-success/[0.06]';
    case 'injected':
      return 'text-primary border-primary/30 bg-primary/[0.06]';
    case 'exited':
      return 'text-muted-foreground border-border/40 bg-muted/20';
    default:
      return 'text-muted-foreground border-border/40 bg-muted/20';
  }
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'fact':
      return 'text-primary';
    case 'decision':
      return 'text-accent2';
    case 'convention':
      return 'text-ring';
    case 'warning':
    case 'anti_pattern':
      return 'text-warning';
    case 'bug_root_cause':
      return 'text-destructive';
    case 'preference':
      return 'text-accent';
    default:
      return 'text-muted-foreground';
  }
}

function importanceLabel(importance: number): string {
  if (importance >= 0.9) return 'crit';
  if (importance >= 0.6) return 'high';
  if (importance >= 0.3) return 'med';
  return 'low';
}

/**
 * Slide-out floating panel showing all SAGE memory injection activity.
 * Replaces the inline SageMemoryCard rendering in chat history.
 *
 * Sections:
 *  - Summary bar (matched / injected / filtered / active)
 *  - Active context memories (cards with kind, text, tags, anchors)
 *  - Recent injection traces (per-tool-call history)
 *
 * Data source: `useMemoryInjectorTraceStore` — the same store that the
 * old status-bar widget read from.
 */
export const MemoryInjectorPanel = memo(function MemoryInjectorPanel({
  open,
  onClose,
}: MemoryInjectorPanelProps) {
  const { t } = useAppTranslation();
  const traces = useMemoryInjectorTraceStore((s) => s.traces);
  const contextMemories = useMemoryInjectorTraceStore((s) => s.contextMemories);
  const transitions = useMemoryInjectorTraceStore((s) => s.transitions);
  const clear = useMemoryInjectorTraceStore((s) => s.clear);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const latest = traces[0];
  const records = Object.values(contextMemories);
  const activeRecords = records.filter((m) => m.state !== 'exited');
  const exitedCount = records.length - activeRecords.length;
  const filteredTotal = latest
    ? Object.values(latest.rejected).reduce((sum, count) => sum + count, 0)
    : 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-background/50 backdrop-blur-[1px] transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <aside
        className={cn(
          'fixed right-0 top-0 z-50 h-full w-full max-w-md border-l border-border/60 bg-card/95 backdrop-blur-xl shadow-2xl',
          'transition-transform duration-300 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
        role="dialog"
        aria-label={t('activity:sageMemory.injectedHeading', 'Memory Context')}
        data-testid="memory-injector-panel"
      >
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3 shrink-0">
            <div className="flex items-center gap-2">
              <Brain className="size-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">
                {t('activity:sageMemory.injectedHeading', 'Memory Context')}
              </h2>
              {activeRecords.length > 0 && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary tabular-nums">
                  {activeRecords.length} active
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {traces.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  title={t('activity:memoryManager.clearTracesTitle')}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                title={t('activity:memoryManager.closePanelTitle')}
              >
                <PanelRightClose className="size-4" />
              </button>
            </div>
          </div>

          {/* Summary bar */}
          {latest && (
            <div className="shrink-0 border-b border-border/40 bg-muted/20 px-4 py-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] tabular-nums">
                <span className="flex items-center gap-1">
                  <Activity className="size-3 text-muted-foreground" />
                  <span className="font-mono text-foreground">{latest.candidates}</span>
                  <span className="text-muted-foreground">
                    {t('activity:memoryManager.traceMatched')}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="font-mono text-success">{latest.injected.length}</span>
                  <span className="text-muted-foreground">
                    {t('activity:memoryManager.traceInjected')}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="font-mono text-warning">{filteredTotal}</span>
                  <span className="text-muted-foreground">
                    {t('activity:memoryManager.traceFiltered')}
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="font-mono text-ring">{activeRecords.length}</span>
                  <span className="text-muted-foreground">
                    {t('activity:memoryManager.traceActive')}
                  </span>
                </span>
                {exitedCount > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-muted-foreground">{exitedCount}</span>
                    <span className="text-muted-foreground">
                      {t('activity:memoryManager.traceExited')}
                    </span>
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/80">
                <Clock className="size-3" />
                <span>{formatTime(latest.at)}</span>
                <span className="opacity-40">·</span>
                <span className="font-mono">{latest.trigger}</span>
                {latest.toolName && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="font-mono">{latest.toolName}</span>
                  </>
                )}
                <span className="opacity-40">·</span>
                <span>ctx {Math.round(latest.contextPressure * 100)}%</span>
              </div>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto overscroll-contain">
            {/* Active memories */}
            {activeRecords.length > 0 ? (
              <div className="space-y-0">
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/40">
                  {t('activity:memoryManager.injectorActiveInContext')}
                </div>
                {activeRecords.map((memory) => (
                  <div
                    key={memory.id}
                    className="border-b border-border/30 px-4 py-3 hover:bg-muted/15 transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex flex-wrap items-center gap-1 shrink-0">
                        <span
                          className={cn(
                            'rounded border px-1 py-0.5 text-[9px] font-bold uppercase',
                            kindColor(memory.kind),
                          )}
                        >
                          {memory.kind}
                        </span>
                        <span
                          className={cn(
                            'rounded border px-1 py-0.5 text-[9px] font-bold uppercase',
                            stateColor(memory.state),
                          )}
                        >
                          {importanceLabel(memory.importance)}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-foreground/90 break-words">
                      {memory.isPlaceholder ? (
                        <span className="italic text-muted-foreground">{memory.text}</span>
                      ) : (
                        memory.text
                      )}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/70">
                      <span className="font-mono">{memory.id.slice(0, 16)}…</span>
                      <span className="flex items-center gap-0.5">
                        <span className="opacity-60">{t('activity:memoryManager.traceScore')}</span>
                        <span className="font-mono text-foreground/60">
                          {memory.score.toFixed(2)}
                        </span>
                      </span>
                      {memory.trigger && <span className="font-mono">{memory.trigger}</span>}
                      <span>{formatTime(memory.lastSeenAt)}</span>
                    </div>
                    {memory.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Tag className="size-2.5 text-muted-foreground/50" />
                        {memory.tags.slice(0, 6).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-muted/40 px-1 py-0.5 text-[9px] text-muted-foreground/80"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {memory.anchors.length > 0 && (
                      <div className="mt-1 text-[10px] text-muted-foreground/60 font-mono truncate">
                        ↳ {memory.anchors.slice(0, 2).join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-[12px] text-muted-foreground/60">
                {traces.length === 0
                  ? 'No memory injections yet. Memories will appear here when the agent reads files or searches code.'
                  : 'No memories currently active in provider context.'}
              </div>
            )}

            {/* Recent traces */}
            {traces.length > 0 && (
              <div>
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-t border-border/40 border-b">
                  {t('activity:memoryManager.injectorInjectionHistory')}
                </div>
                {traces.slice(0, 20).map((trace) => {
                  const traceFiltered = Object.values(trace.rejected).reduce(
                    (sum, count) => sum + count,
                    0,
                  );
                  return (
                    <div key={trace.runId} className="border-b border-border/30 px-4 py-2.5">
                      <div className="flex items-center gap-2 text-[11px] tabular-nums">
                        <Clock className="size-3 text-muted-foreground/60" />
                        <span className="text-muted-foreground">{formatTime(trace.at)}</span>
                        <span className="opacity-30">·</span>
                        <span className="font-mono text-foreground/80">{trace.trigger}</span>
                        {trace.toolName && (
                          <>
                            <span className="opacity-30">·</span>
                            <span className="font-mono text-muted-foreground">
                              {trace.toolName}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-3 text-[10px] tabular-nums text-muted-foreground/70">
                        <span className="text-success">{trace.injected.length} injected</span>
                        <span className="text-warning">{traceFiltered} filtered</span>
                        <span>{trace.candidates} candidates</span>
                        <span>ctx {Math.round(trace.contextPressure * 100)}%</span>
                        {trace.outcome === 'error' && (
                          <span className="text-destructive">
                            {t('activity:memoryManager.traceError')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Recent transitions */}
            {transitions.length > 0 && (
              <div>
                <div className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-t border-border/40 border-b">
                  {t('activity:memoryManager.injectorContextTransitions')}
                </div>
                {transitions.slice(0, 15).map((tr) => (
                  <div
                    key={tr.id}
                    className="border-b border-border/20 px-4 py-1.5 flex items-center gap-2 text-[10px] tabular-nums"
                  >
                    <span className="text-muted-foreground/60">{formatTime(tr.at)}</span>
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[9px] font-bold uppercase',
                        tr.action === 'injected' && 'bg-primary/10 text-primary',
                        tr.action === 'entered' && 'bg-success/10 text-success',
                        tr.action === 'exited' && 'bg-muted/40 text-muted-foreground',
                      )}
                    >
                      {tr.action}
                    </span>
                    <span className="font-mono text-muted-foreground truncate">
                      {tr.memoryId.slice(0, 14)}…
                    </span>
                    <span className="text-muted-foreground/50 truncate ml-auto">{tr.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
});
