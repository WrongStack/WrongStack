import type * as React from 'react';
import type { BadgeTone } from '../ui/badge.js';
import { cn } from '../../lib/utils.js';

const TONE_ON: Partial<Record<BadgeTone, string>> = {
  error: 'border-destructive bg-destructive/15 text-destructive',
  warn: 'border-warning bg-warning/15 text-warning',
  info: 'border-info bg-info/15 text-info',
  active: 'border-success bg-success/15 text-success',
};

/**
 * A toggleable filter pill. `aria-pressed` carries the state — colour alone
 * would leave the selection invisible to a screen reader and ambiguous in
 * forced-colors mode.
 */
export function FilterChip({
  selected,
  label,
  tone = 'info',
  onClick,
}: {
  selected: boolean;
  label: React.ReactNode;
  tone?: BadgeTone;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid="filter-chip"
      data-selected={selected}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'border px-1.5 py-0.5 text-[11px] transition-colors',
        selected
          ? (TONE_ON[tone] ?? 'border-primary bg-primary/15 text-primary')
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
