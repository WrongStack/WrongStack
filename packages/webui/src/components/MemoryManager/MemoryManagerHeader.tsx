import { ArrowLeft, BrainCircuit, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores';

export function MemoryManagerHeader({
  wsConnected,
  refreshing,
  onRefresh,
  onCreate,
}: {
  wsConnected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onCreate: () => void;
}) {
  const { t } = useAppTranslation();
  const setCurrentView = useUIStore((state) => state.setCurrentView);

  return (
    <header className="relative shrink-0 overflow-hidden border-b border-border/70 bg-card/72 px-4 py-3 backdrop-blur-xl sm:px-5">
      <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_right,hsl(var(--info)/0.11),transparent_68%)]" />
      <div className="relative flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCurrentView('chat')}
          aria-label={t('activity:memoryManager.backToChat')}
          title={t('activity:memoryManager.backToChat')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="flex size-10 items-center justify-center border border-info/40 bg-info/10 text-info shadow-[0_0_20px_hsl(var(--info)/0.12)]">
          <BrainCircuit className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-bold sm:text-lg">
              {t('activity:memoryManager.sageHeading')}
            </h1>
            <span className="border border-success/35 bg-success/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase text-success">
              {t('activity:memoryManager.projectKnowledge')}
            </span>
          </div>
          <p className="mt-0.5 max-w-2xl text-[10px] text-muted-foreground sm:text-xs">
            {t('activity:memoryManager.sageSubtitle')}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={cn(
              'hidden items-center gap-1.5 border px-2 py-1 font-mono text-[9px] uppercase sm:flex',
              wsConnected ? 'border-success/30 text-success' : 'border-warning/30 text-warning',
            )}
          >
            <span className="size-1.5 bg-current" />{' '}
            {wsConnected
              ? t('activity:memoryManager.liveStore')
              : t('activity:memoryManager.reconnecting')}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={t('activity:memoryManager.refreshAria')}
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            <span className="hidden sm:inline">{t('common:action.refresh')}</span>
          </Button>
          <Button size="sm" onClick={onCreate}>
            <Plus className="size-3.5" /> {t('activity:memoryManager.newMemory')}
          </Button>
        </div>
      </div>
    </header>
  );
}
