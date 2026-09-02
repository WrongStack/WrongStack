import { cn } from '@/lib/utils';
import type { ChronicleStatus } from '@/types/chronicle';
import { useAppTranslation } from '@/i18n';

export function ChroniclePipelineStrip({ status }: { status: ChronicleStatus }) {
  const { t } = useAppTranslation();
  return (
    <section
      className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border/60 bg-primary/[0.025] px-4 py-1.5 font-mono text-[9px] text-muted-foreground"
      title={status.chronicleDirectory}
    >
      <span className="font-sans font-semibold uppercase tracking-wider text-primary">
        {t('activity:chroniclePipelineStrip.chronicleOwnership')}
      </span>
      <span>
        collect <b className="text-foreground">{status.pipeline.collection}</b>
      </span>
      <span>
        process <b className="text-foreground">{status.pipeline.processing}</b>
      </span>
      <span>
        serve <b className="text-foreground">{status.pipeline.serving}</b>
      </span>
      <span>
        PID <b className="text-foreground">{status.pid}</b> · {status.clients} clients
      </span>
      <span>
        watcher{' '}
        <b className={cn(status.watcher.active ? 'text-success' : 'text-warning')}>
          {status.watcher.active ? 'active' : 'inactive'}
        </b>{' '}
        · {status.watcher.watchedFiles} files
      </span>
      <span>
        store <b className="text-foreground">{shortPath(status.pipeline.storage)}</b>
      </span>
      {status.mode === 'inline' && (
        <span className="font-sans font-semibold text-warning">
          {t('activity:chroniclePipelineStrip.inlineFallback')}
        </span>
      )}
    </section>
  );
}

function shortPath(value: string) {
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(-3).join('/');
}
