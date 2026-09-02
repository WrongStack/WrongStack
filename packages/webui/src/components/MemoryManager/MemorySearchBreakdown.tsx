/**
 * Memory search breakdown — the WebUI's "WHY was this returned?" view.
 *
 * The MemoryManager's search input calls `searchSageBreakdown` and
 * renders the results with a per-channel score panel. Each card
 * surfaces the lexical score, the vector score (when present), the
 * RRF-style final score, and a `source` color-code (lexical / vector /
 * both). Operators see at a glance which channel found the memory and
 * how much each one contributed.
 *
 * The breakdown shape comes from `@wrongstack/sage` via the
 * `memory.sage.searchBreakdown` WebSocket message — same data the
 * CLI's `/memory race` command renders, just in a panel instead of a
 * text block.
 */
import { useAppTranslation } from '@/i18n';
import { Brain, Hash, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WSSearchBreakdownHit } from '@/types/sage';
import { cn } from '@/lib/utils';

interface MemorySearchBreakdownProps {
  query: string;
  /** `breakdown` = rich variant succeeded; `lexical` = fallback synthesized. */
  channel: 'breakdown' | 'lexical' | undefined;
  hits: WSSearchBreakdownHit[];
  loading: boolean;
  error: string | null;
  onOpenMemory: (id: string) => void;
  onClear: () => void;
}

export function MemorySearchBreakdown({
  query,
  channel,
  hits,
  loading,
  error,
  onOpenMemory,
  onClear,
}: MemorySearchBreakdownProps): ReactNode {
  const { t } = useAppTranslation();
  if (!query) return null;
  return (
    <section
      aria-label={t('activity:memoryManager.searchBreakdownAria')}
      className="border-b border-border/60 bg-card/35"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border/55 px-3 py-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <Sparkles className="size-3 text-info" />
          <span className="font-mono uppercase tracking-[0.1em]">
            {t('activity:memoryManager.searchBreakdownTitle', { query })}
          </span>
          {channel === 'breakdown' && (
            <span className="border border-info/40 bg-info/8 px-1.5 py-0.5 font-mono text-[9px] uppercase text-info">
              {t('activity:memoryManager.searchBreakdownDual')}
            </span>
          )}
          {channel === 'lexical' && (
            <span className="border border-border/60 px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
              {t('activity:memoryManager.searchBreakdownLexicalOnly')}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="font-mono text-[10px] uppercase text-muted-foreground hover:text-foreground"
        >
          {t('common:action.close')}
        </button>
      </header>
      {loading && (
        <p className="px-3 py-3 text-[10px] text-muted-foreground">
          {t('activity:memoryManager.searchBreakdownLoading')}
        </p>
      )}
      {error && (
        <p
          className="border-t border-border/55 px-3 py-2 text-[10px] text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
      {!loading && !error && hits.length === 0 && (
        <p className="px-3 py-3 text-[10px] text-muted-foreground">
          {t('activity:memoryManager.searchBreakdownEmpty')}
        </p>
      )}
      <ul className="divide-y divide-border/55">
        {hits.map((hit) => (
          <BreakdownRow key={hit.memory.id} hit={hit} onOpenMemory={onOpenMemory} />
        ))}
      </ul>
    </section>
  );
}

function BreakdownRow({
  hit,
  onOpenMemory,
}: {
  hit: WSSearchBreakdownHit;
  onOpenMemory: (id: string) => void;
}): ReactNode {
  const { t } = useAppTranslation();
  const lexPct = formatPct(hit.lexicalScore);
  const vecPct = formatPct(hit.vectorScore);
  const finalPct = formatPct(hit.finalScore);
  const { accent, label } = sourceStyling(hit.source);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenMemory(hit.memory.id)}
        className="group flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left hover:bg-info/5"
      >
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center border font-mono text-[9px] uppercase',
            accent,
          )}
          title={t('activity:memoryManager.searchBreakdownSourceLabel', { source: label })}
        >
          {hit.source === 'vector' ? (
            <Sparkles className="size-3.5" />
          ) : hit.source === 'both' ? (
            <Brain className="size-3.5" />
          ) : (
            <Hash className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[11px] leading-5 text-foreground/90">{hit.memory.text}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="uppercase text-[9px] text-muted-foreground/80">L</span>
              <span className="tabular-nums text-foreground/80">{lexPct}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="uppercase text-[9px] text-muted-foreground/80">V</span>
              <span
                className={cn(
                  'tabular-nums',
                  hit.vectorScore === null ? 'text-muted-foreground/50' : 'text-foreground/80',
                )}
              >
                {vecPct}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span className="uppercase text-[9px] text-muted-foreground/80">RRF</span>
              <span className="tabular-nums font-bold text-foreground">{finalPct}</span>
            </span>
            <span className="ml-auto uppercase text-[9px]">{label}</span>
          </div>
        </div>
      </button>
    </li>
  );
}

function formatPct(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}

function sourceStyling(source: 'lexical' | 'vector' | 'both'): {
  accent: string;
  label: string;
} {
  switch (source) {
    case 'vector':
      return {
        accent: 'border-accent/40 bg-accent/10 text-accent',
        label: 'vector',
      };
    case 'both':
      return {
        accent: 'border-info/40 bg-info/10 text-info',
        label: 'both',
      };
    case 'lexical':
    default:
      return {
        accent: 'border-border/60 bg-background text-muted-foreground',
        label: 'lexical',
      };
  }
}
