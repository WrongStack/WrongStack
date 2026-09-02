import { ArrowDownToLine, ArrowUpFromLine, BrainCircuit, Clock3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { useAppTranslation } from '@/i18n';

export function ContextMemoryMonitor() {
  const { t } = useAppTranslation();
  const memories = useMemoryInjectorTraceStore((state) => state.contextMemories);
  const transitions = useMemoryInjectorTraceStore((state) => state.transitions);
  const records = Object.values(memories).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const active = records.filter((memory) => memory.state === 'active');
  const pending = records.filter((memory) => memory.state === 'injected');
  const exited = records.filter((memory) => memory.state === 'exited');

  return (
    <section
      className="rounded-md border border-primary/20 bg-primary/[0.025]"
      aria-label={t('activity:ctxMonitor.contextMemoryMonitor')}
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <BrainCircuit className="size-4 text-primary" />
        <h2 className="text-xs font-semibold">{t('activity:ctxMonitor.contextMemoryMonitor')}</h2>
        <span className="text-[10px] text-muted-foreground">
          {t('activity:ctxMonitor.exactProviderBoundPresence')}
        </span>
        <div className="ml-auto flex gap-2 font-mono text-[10px]">
          <span className="text-success">{active.length} ctx</span>
          <span className="text-warning">{pending.length} pending</span>
          <span className="text-muted-foreground">{exited.length} left</span>
        </div>
      </header>

      {records.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {t('activity:ctxMonitor.noSageHasEnteredThisSession')}
        </p>
      ) : (
        <div className="grid gap-3 p-3 xl:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              {t('activity:ctxMonitor.memoryPresence')}
            </p>
            {records.slice(0, 20).map((memory) => (
              <article
                key={memory.id}
                className={cn(
                  'border px-3 py-2 text-[10px]',
                  memory.state === 'exited'
                    ? 'border-border/50 bg-muted/20 opacity-65'
                    : 'border-primary/25 bg-background/55',
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'border px-1.5 py-0.5 font-bold uppercase',
                      memory.state === 'exited'
                        ? 'border-border text-muted-foreground'
                        : memory.state === 'active'
                          ? 'border-success/35 text-success'
                          : 'border-warning/35 text-warning',
                    )}
                  >
                    {memory.state}
                  </span>
                  <span className="font-mono font-bold text-primary">{memory.id}</span>
                  <span className="font-mono text-muted-foreground">
                    {memory.kind} · {memory.persistence}
                  </span>
                  <span className="ml-auto font-mono text-muted-foreground">
                    score {memory.score.toFixed(2)} · conf {memory.confidence.toFixed(2)} · fresh{' '}
                    {memory.freshness.toFixed(2)}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-foreground">{memory.text}</p>
                <p className="mt-1 text-muted-foreground">
                  why: {memory.activationReasons.join(' · ') || 'context snapshot'}
                </p>
                {(memory.anchors.length > 0 || memory.tags.length > 0) && (
                  <p
                    className="mt-1 truncate font-mono text-muted-foreground"
                    title={[...memory.anchors, ...memory.tags.map((tag) => `#${tag}`)].join(' · ')}
                  >
                    {[...memory.anchors, ...memory.tags.map((tag) => `#${tag}`)].join(' · ')}
                  </p>
                )}
              </article>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              {t('activity:ctxMonitor.cameWent')}
            </p>
            {transitions.slice(0, 30).map((transition) => (
              <div
                key={transition.id}
                className="flex gap-2 border-b border-border/40 py-1.5 text-[10px] last:border-b-0"
              >
                {transition.action === 'exited' ? (
                  <ArrowUpFromLine className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ArrowDownToLine className="mt-0.5 size-3 shrink-0 text-success" />
                )}
                <div className="min-w-0">
                  <p className="font-mono">
                    <span
                      className={
                        transition.action === 'exited' ? 'text-muted-foreground' : 'text-success'
                      }
                    >
                      {transition.action}
                    </span>{' '}
                    {transition.memoryId}
                  </p>
                  <p className="truncate text-muted-foreground">{transition.reason}</p>
                </div>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
                  <Clock3 className="size-2.5" /> {new Date(transition.at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
