import { BrainCircuit, Check, Plus } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { Button } from '../ui/button';

export function MemoryManagerEmpty({ onCapture }: { onCapture: () => void }) {
  const { t } = useAppTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="relative flex size-20 items-center justify-center rounded-3xl border border-info/25 bg-info/5 text-info">
        <BrainCircuit className="size-8" />
        <span className="absolute inset-2 rounded-2xl border border-info/10" />
      </div>
      <h2 className="mt-5 text-lg font-bold">{t('activity:memoryManager.emptyTitle')}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {t('activity:memoryManager.emptyBody')}
      </p>
      <div className="mt-6 grid w-full max-w-lg gap-2 sm:grid-cols-3">
        <div className="ws-panel border border-border/70 bg-card/45 p-3">
          <Check className="mx-auto size-4 text-success" />
          <p className="mt-2 text-[10px] font-bold uppercase">
            {t('activity:memoryManager.emptyVerifiedAnchors')}
          </p>
        </div>
        <div className="ws-panel border border-border/70 bg-card/45 p-3">
          <BrainCircuit className="mx-auto size-4 text-info" />
          <p className="mt-2 text-[10px] font-bold uppercase">
            {t('activity:memoryManager.emptyTypedRelations')}
          </p>
        </div>
        <div className="ws-panel border border-border/70 bg-card/45 p-3">
          <Plus className="mx-auto size-4 text-warning" />
          <p className="mt-2 text-[10px] font-bold uppercase">
            {t('activity:memoryManager.emptyAgentRecall')}
          </p>
        </div>
      </div>
      <Button onClick={onCapture}>
        <Plus className="size-4" /> {t('activity:memoryManager.captureButton')}
      </Button>
    </div>
  );
}
