import { useRef } from 'react';
import { cn } from '@/lib/utils';

// ── Small building blocks ─────────────────────────────────────────────

export function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  tone,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  tone?: 'primary' | 'danger' | undefined;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={cn(
        'flex items-center justify-center gap-1.5 h-8 rounded-md border text-[11px] font-medium transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        tone === 'primary'
          ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
          : tone === 'danger'
            ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
            : 'border-border bg-card hover:bg-accent text-foreground/80',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export function StatBox({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border/60 bg-card/65 p-2 shadow-sm">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums truncate">{value}</span>
      {sub && <span className="text-[9px] text-muted-foreground/70 truncate">{sub}</span>}
    </div>
  );
}

/** Compact switch row sized for the 300px panel. */
export function QuickToggle({
  label,
  value,
  onChange,
  title,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
  title?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1" title={title}>
      <span className="text-xs text-foreground/80">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={onChange}
        className={cn(
          'shrink-0 relative inline-flex h-4 w-7 rounded-full border transition-colors',
          value ? 'bg-primary border-primary' : 'bg-muted border-input hover:bg-muted/80',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-2.5 w-2.5 rounded-full bg-background shadow transition-transform',
            value && 'translate-x-3',
          )}
        />
      </button>
    </div>
  );
}

/**
 * Compact segmented switch for a knob with more than two positions, sized for
 * the 300px panel. A radio group: arrow keys move the choice, and only the
 * selected segment is in the tab order.
 */
export function QuickSegmented<T extends string>({
  label,
  title,
  value,
  options,
  onChange,
}: {
  label: string;
  title?: string | undefined;
  value: T;
  options: ReadonlyArray<{
    value: T;
    label: string;
    title?: string | undefined;
    tone?: 'danger' | undefined;
  }>;
  onChange: (next: T) => void;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const optionRefs = useRef(new Map<T, HTMLButtonElement>());
  const move = (delta: number) => {
    const next = options[(index + delta + options.length) % options.length];
    if (!next || next.value === value) return;
    // The arrow key changes the checked radio; focus must travel with it,
    // otherwise the old radio keeps focus after its tabIndex drops to -1.
    onChange(next.value);
    optionRefs.current.get(next.value)?.focus();
  };
  return (
    <div className="flex items-center justify-between gap-2 py-1" title={title}>
      <span className="text-xs text-foreground/80">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex shrink-0 rounded-md border border-input bg-muted p-0.5"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
          }
        }}
      >
        {options.map((o) => {
          const active = o.value === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a segmented pill; native radios cannot take this styling, and the group handles arrow keys itself.
            <button
              key={o.value}
              ref={(node) => {
                if (node) optionRefs.current.set(o.value, node);
                else optionRefs.current.delete(o.value);
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              title={o.title ?? o.label}
              onClick={() => {
                if (!active) onChange(o.value);
              }}
              className={cn(
                'h-5 rounded px-2 text-[10px] font-medium leading-none transition-colors',
                active
                  ? o.tone === 'danger'
                    ? 'bg-destructive text-destructive-foreground shadow-sm'
                    : 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
