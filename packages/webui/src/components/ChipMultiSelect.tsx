import { Check, ChevronDown, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';

export interface ChipOption {
  value: string;
  label: string;
  description?: string | undefined;
  /** Optional right-aligned tag (e.g. provider name). */
  tag?: string | undefined;
}

/**
 * ChipMultiSelect — a compact searchable multi-select. Selected values render
 * as removable chips; the dropdown lists real options to toggle. Used for
 * fallback models, tools, and capabilities so nothing is hand-typed.
 */
export function ChipMultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  emptyLabel,
}: {
  options: ChipOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyLabel?: string;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const labelFor = useMemo(() => {
    const map = new Map(options.map((o) => [o.value, o.label]));
    return (value: string) => map.get(value) ?? value;
  }, [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => `${o.value} ${o.label} ${o.tag ?? ''}`.toLowerCase().includes(q))
      : options;
    return list.slice(0, 80);
  }, [options, query]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div ref={ref} className="relative">
      {selected.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {selected.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]"
            >
              <span className="max-w-[150px] truncate">{labelFor(value)}</span>
              <button
                type="button"
                onClick={() => toggle(value)}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${labelFor(value)}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5 text-left text-xs transition-colors hover:border-primary/45 hover:bg-muted/80"
      >
        <Plus className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {placeholder ?? 'Add…'}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full min-w-[240px] overflow-hidden rounded-md border border-border/80 bg-popover shadow-xl">
          <div className="flex items-center gap-1.5 border-b border-border/70 bg-muted/20 px-2 py-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('activity:chipMultiSelect.filter')}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.map((o) => {
              const isSelected = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className={cn(
                    'flex w-full items-start gap-1.5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                    isSelected ? 'bg-primary/8 text-primary' : 'text-foreground',
                  )}
                >
                  {isSelected ? (
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.label}</span>
                    {o.description && (
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {o.description}
                      </span>
                    )}
                  </span>
                  {o.tag && (
                    <span className="mt-0.5 shrink-0 font-mono text-[9px] text-muted-foreground">
                      {o.tag}
                    </span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                {options.length === 0 ? (emptyLabel ?? 'Nothing available') : 'No match'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
