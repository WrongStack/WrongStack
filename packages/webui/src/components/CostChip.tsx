import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useChatStore, useSessionStore } from '@/stores';
import { useEffect, useRef, useState } from 'react';

/**
 * Clickable cost figure in the topbar. Tap to drop a small popover with a
 * per-turn breakdown sourced from `ChatMessage.runSummary` (attached by the
 * run.result handler). Helps the cost-conscious user trace where the
 * dollars actually went without spelunking through transcripts.
 *
 * We only render the popover after the user clicks — the cost chip itself
 * is identical to the plain span it replaces, so the topbar layout stays
 * unchanged.
 */
export function CostChip() {
  const { t } = useAppTranslation();
  const cost = useSessionStore((s) => s.cost);
  const inputCost = useSessionStore((s) => s.inputCost);
  const outputCost = useSessionStore((s) => s.outputCost);
  const cacheReadCost = useSessionStore((s) => s.cacheReadCost);
  const messages = useChatStore((s) => s.messages);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** Top expensive turns. We only consider messages with a runSummary —
   *  the run.result handler attaches one per completed turn. costDelta is
   *  the delta computed in that handler (session cost at end minus at
   *  start of this turn). Falls back to nothing if no data yet. */
  const turns = (() => {
    const rows: Array<{
      id: string;
      preview: string;
      cost: number;
      tools: number;
      ms: number;
      ts: number;
    }> = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.runSummary && m.runSummary.costDelta > 0) {
        rows.push({
          id: m.id,
          preview: m.content.slice(0, 80).replace(/\s+/g, ' ').trim() || '(empty)',
          cost: m.runSummary.costDelta,
          tools: m.runSummary.tools,
          ms: m.runSummary.durationMs,
          ts: m.timestamp,
        });
      }
    }
    rows.sort((a, b) => b.cost - a.cost);
    return rows.slice(0, 5);
  })();

  const fmt$ = (v: number) =>
    v >= 0.01
      ? `$${v.toFixed(4)}`
      : v > 0
        ? `$${v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
        : '$0';

  const haveRates = inputCost > 0 || outputCost > 0;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn('font-medium text-success hover:underline tabular-nums')}
        title={t('activity:cost.clickTitle')}
      >
        ${cost.toFixed(4)}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-80 rounded-md border bg-popover shadow-lg p-3 text-foreground">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
              {t('activity:cost.heading')}
            </span>
            <span className="font-mono tabular-nums text-sm font-semibold text-success">
              {fmt$(cost)}
            </span>
          </div>
          {haveRates ? (
            <div className="text-[11px] text-muted-foreground font-mono mb-3 border-b pb-2">
              <div className="flex justify-between">
                <span>{t('activity:costChip.input1m')}</span>
                <span>${inputCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('activity:costChip.output1m')}</span>
                <span>${outputCost.toFixed(2)}</span>
              </div>
              {cacheReadCost > 0 && (
                <div className="flex justify-between">
                  <span>{t('activity:costChip.cache1m')}</span>
                  <span>${cacheReadCost.toFixed(2)}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground italic mb-3 border-b pb-2">
              {t('activity:cost.noPricing')}
            </div>
          )}
          {turns.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">{t('activity:cost.noTurns')}</div>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80 mb-1">
                {t('activity:cost.topExpensive', { count: turns.length })}
              </div>
              <ul className="space-y-1">
                {turns.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => {
                        const el = document.querySelector(`[data-message-id="${t.id}"]`);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        setOpen(false);
                      }}
                      className="w-full text-left rounded px-2 py-1.5 hover:bg-accent/40 transition-colors"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs truncate">{t.preview}</span>
                        <span className="text-xs font-mono tabular-nums text-success shrink-0">
                          {fmt$(t.cost)}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                        {t.tools} tool{t.tools === 1 ? '' : 's'} · {(t.ms / 1000).toFixed(1)}s
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
