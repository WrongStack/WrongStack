import { useAppTranslation } from '@/i18n';
import { Activity, GitBranch, LogIn, LogOut, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  type MemoryLifecycleAction,
  useMemoryLifecycleStore,
} from '@/stores/memory-lifecycle-store';

export function MemoryLifecycleTrace() {
  const { t } = useAppTranslation();
  const items = useMemoryLifecycleStore((state) => state.items);
  const clear = useMemoryLifecycleStore((state) => state.clear);

  return (
    <section
      className="shrink-0 border-b border-border/60 bg-info/[0.025]"
      aria-label={t('activity:memoryManager.lifecycleAria')}
    >
      <div className="flex h-8 items-center gap-2 px-4">
        <Activity className="size-3.5 text-info" />
        <span className="text-[10px] font-bold uppercase tracking-wide text-info">
          {t('activity:memoryManager.lifecycleHeading')}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {items.length === 0
            ? t('activity:memoryManager.statusWaiting')
            : t('activity:memoryManager.statusLive', { count: items.length })}
        </span>
        {items.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[10px]"
            onClick={clear}
          >
            <Trash2 className="size-3" /> {t('common:action.clear')}
          </Button>
        )}
      </div>
      {items.length > 0 ? (
        <div className="max-h-20 overflow-y-auto border-t border-border/40">
          {items.slice(0, 8).map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 border-b border-border/30 px-4 py-1 text-[10px] last:border-b-0"
            >
              <LifecycleIcon action={item.action} />
              <span className={cn('font-mono font-semibold', actionColor(item.action))}>
                {item.label}
              </span>
              {item.detail && (
                <span className="min-w-0 truncate text-muted-foreground" title={item.detail}>
                  {item.detail}
                </span>
              )}
              <time className="ml-auto shrink-0 text-muted-foreground">
                {new Date(item.at).toLocaleTimeString()}
              </time>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LifecycleIcon({ action }: { action: MemoryLifecycleAction }) {
  const className = cn('size-3 shrink-0', actionColor(action));
  if (action === 'entered' || action === 'recovered') return <LogIn className={className} />;
  if (action === 'exited') return <LogOut className={className} />;
  if (action === 'related') return <GitBranch className={className} />;
  return <RefreshCw className={className} />;
}

function actionColor(action: MemoryLifecycleAction): string {
  if (action === 'entered' || action === 'recovered') return 'text-success';
  if (action === 'exited') return 'text-destructive';
  if (action === 'related') return 'text-primary';
  return 'text-info';
}
