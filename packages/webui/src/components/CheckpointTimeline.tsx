import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Clock, History, Rewind } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';

// ── Types ──────────────────────────────────────────────────────────────────

interface CheckpointInfo {
  index: number;
  iteration: number;
  timestamp: string;
  /** Human-readable label — first user message, tool name, etc. */
  label: string;
  /** Message count at this point. */
  messageCount: number;
  /** Token count at this point. */
  tokens: number;
}

// ── Component ──────────────────────────────────────────────────────────────

export interface CheckpointTimelineProps {
  open: boolean;
  onClose: () => void;
  className?: string | undefined;
}

export function CheckpointTimeline({
  open,
  onClose,
  className,
}: CheckpointTimelineProps): React.ReactElement | null {
  const { t } = useAppTranslation();
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [rewinding, setRewinding] = useState(false);
  const ws = useWebSocket();
  const offRef = useRef<(() => void) | null>(null);

  // Fetch checkpoints when opened
  useEffect(() => {
    if (!open || !ws.client?.isConnected) return;

    ws.client.send?.({ type: 'session.checkpoints' });

    offRef.current =
      ws.client.on?.('session.checkpoints', (msg: unknown) => {
        const payload = (msg as { payload?: { checkpoints?: CheckpointInfo[] } })?.payload;
        if (payload?.checkpoints) setCheckpoints(payload.checkpoints);
      }) ?? null;

    return () => {
      offRef.current?.();
    };
  }, [open, ws.client]);

  const handleRewind = useCallback(
    async (index: number) => {
      setRewinding(true);
      ws.client.send?.({ type: 'session.rewind', payload: { checkpointIndex: index } });
      setTimeout(() => {
        onClose();
        setRewinding(false);
      }, 800);
    },
    [ws.client, onClose],
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className={cn('max-w-md gap-0 overflow-hidden border-border/80 bg-card p-0 pt-[10dvh] flex flex-col max-h-[75dvh]', className)}
      >
        <DialogTitle className="sr-only">{t('activity:checkpoint.heading')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('activity:checkpoint.countSuffix', { count: checkpoints.length })}
        </DialogDescription>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/70 bg-card/95 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-8 h-8 rounded-md border border-primary/20 bg-primary/10 text-primary">
              <History className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">{t('activity:checkpoint.heading')}</h2>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {t('activity:checkpoint.countSuffix', { count: checkpoints.length })}
              </span>
            </div>
          </div>
        </div>

        {/* Description bar */}
        <div className="border-b border-border/70 bg-muted/25 px-4 py-2.5 text-[10px] text-muted-foreground leading-relaxed">
          {t('activity:checkpoint.description')}
        </div>

        {/* Checkpoint timeline */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {checkpoints.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <Clock className="h-10 w-10 opacity-15" />
              <p className="text-sm font-medium">{t('activity:checkpoint.emptyTitle')}</p>
              <p className="text-xs text-center max-w-xs">{t('activity:checkpoint.emptyBody')}</p>
            </div>
          ) : (
            <div className="py-1">
              {[...checkpoints].reverse().map((cp, i) => {
                const isLatest = i === 0;
                return (
                  <button
                    key={cp.index}
                    type="button"
                    onClick={() => handleRewind(cp.index)}
                    disabled={rewinding}
                    className={cn(
                      'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors group',
                      isLatest
                        ? 'bg-primary/5 hover:bg-primary/10'
                        : 'hover:bg-accent/40',
                      rewinding && 'opacity-50 pointer-events-none',
                    )}
                  >
                    {/* Timeline dot + line */}
                    <div className="flex flex-col items-center mt-1.5">
                      <div
                        className={cn(
                          'w-2.5 h-2.5 rounded-full border-2 shrink-0 transition-colors',
                          isLatest
                            ? 'border-primary bg-primary/20 shadow-[0_0_0_3px_hsl(var(--primary)/0.25)]'
                            : 'border-muted-foreground/30 bg-background group-hover:border-primary/40',
                        )}
                      />
                      {i < checkpoints.length - 1 && (
                        <div className="w-px flex-1 min-h-[20px] bg-border/50" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground tabular-nums shrink-0">
                          #{cp.index}
                        </span>
                        <span className="text-xs font-medium truncate">{cp.label}</span>
                        {isLatest && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium shrink-0">
                            {t('activity:checkpoint.latest')}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                        <span className="tabular-nums">
                          {t('activity:checkpoint.msgSuffix', { count: cp.messageCount })}
                        </span>
                        <span className="opacity-50">·</span>
                        <span className="tabular-nums">~{cp.tokens.toLocaleString()} tok</span>
                        <span className="opacity-50">·</span>
                        <span className="tabular-nums">iter {cp.iteration}</span>
                      </div>
                    </div>

                    <span className="shrink-0 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Rewind className="h-4 w-4 text-primary" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-border/70 bg-muted/20 px-4 py-2 text-[10px] text-muted-foreground text-center shrink-0">
          {t('activity:checkpoint.footerPre')} ·{' '}
          <kbd className="px-1 py-0.5 rounded bg-muted font-mono text-[9px]">Esc</kbd>{' '}
          {t('activity:checkpoint.footerPost')}
        </div>
      </DialogContent>
    </Dialog>
  );
}
