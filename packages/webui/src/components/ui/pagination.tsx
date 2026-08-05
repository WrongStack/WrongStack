import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';

interface PaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  className?: string | undefined;
  compact?: boolean | undefined;
  itemLabel?: string | undefined;
}

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  className,
  compact = false,
  itemLabel = 'items',
}: PaginationProps) {
  const { t } = useAppTranslation();
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  if (totalItems <= pageSize) return null;

  const first = (safePage - 1) * pageSize + 1;
  const last = Math.min(totalItems, safePage * pageSize);

  return (
    <nav
      aria-label={`${itemLabel} pagination`}
      className={cn(
        'flex shrink-0 items-center justify-between gap-2 border-t border-border/75 bg-card/80 px-2 py-2',
        className,
      )}
    >
      <button
        type="button"
        aria-label={t('activity:pagination.previousPage')}
        disabled={safePage <= 1}
        onClick={() => onPageChange(safePage - 1)}
        className="inline-flex h-8 items-center gap-1 border border-border/75 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        {!compact && <span>{t('activity:pagination.previous')}</span>}
      </button>
      <span className="min-w-0 truncate text-center font-mono text-[10px] tabular-nums text-muted-foreground">
        {compact ? `${safePage} / ${totalPages}` : `${first}–${last} of ${totalItems} ${itemLabel}`}
      </span>
      <button
        type="button"
        aria-label={t('activity:pagination.nextPage')}
        disabled={safePage >= totalPages}
        onClick={() => onPageChange(safePage + 1)}
        className="inline-flex h-8 items-center gap-1 border border-border/75 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
      >
        {!compact && <span>{t('activity:pagination.next')}</span>}
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </nav>
  );
}
