import { Check, ChevronDown, Cpu, RotateCcw, Star, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { AnchoredPopover } from './ui/anchored-popover';

/**
 * ModelPicker — a compact searchable {provider/model} combobox used across the
 * SDD surfaces (per-task drawer, run-config wizard, board header). Inline only;
 * no native dialogs. Emits the chosen model + provider, or `undefined` (via the
 * reset row) to fall back to the run/leader default.
 */
export function ModelPicker({
  value,
  provider,
  candidates,
  placeholder,
  resetLabel,
  onPick,
  onReset,
  className,
}: {
  value?: string | undefined;
  provider?: string | undefined;
  candidates: ModelCandidate[];
  placeholder?: string;
  resetLabel?: string;
  onPick: (model: string, provider: string) => void;
  onReset?: (() => void) | undefined;
  className?: string;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLFieldSetElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupId = useId();
  const closeWithFocus = () => {
    setOpen(false);
    ref.current?.querySelector('button')?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !panelRef.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? candidates.filter((c) =>
          `${c.provider}/${c.model} ${c.label} ${c.providerType ?? ''}`.toLowerCase().includes(q),
        )
      : candidates;
    return list.slice(0, 60);
  }, [candidates, query]);

  return (
    <fieldset
      ref={ref}
      aria-label={placeholder ?? t('activity:model.runDefault')}
      className={cn('relative m-0 min-w-0 border-0 p-0', className)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          closeWithFocus();
        }
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5 text-left text-xs transition-colors hover:border-primary/45 hover:bg-muted/80"
      >
        <Cpu className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span
          className={cn(
            'min-w-0 flex-1 break-words',
            value ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {value
            ? provider
              ? `${provider}/${value}`
              : value
            : (placeholder ?? t('activity:model.runDefault'))}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <AnchoredPopover
          anchorRef={ref}
          panelRef={panelRef}
          initialFocusRef={inputRef}
          width="anchor"
          id={popupId}
          className="ws-picker-popover flex min-w-0 flex-col overflow-hidden border-border/80 p-0"
        >
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/70 bg-muted/20 px-2 py-1.5">
            <input
              ref={inputRef}
              value={query}
              aria-label={t('activity:model.filterModelsAria')}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('activity:model.filterPlaceholder')}
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
          <div className="min-h-0 max-h-60 overflow-y-auto py-1">
            {onReset && (
              <button
                type="button"
                onClick={() => {
                  onReset();
                  closeWithFocus();
                }}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" /> {resetLabel ?? t('activity:model.useRunDefault')}
              </button>
            )}
            {filtered.map((c) => {
              const selected = c.model === value && (!provider || c.provider === provider);
              return (
                <button
                  key={`${c.provider}/${c.model}`}
                  type="button"
                  onClick={() => {
                    onPick(c.model, c.provider);
                    closeWithFocus();
                  }}
                  className={cn(
                    'flex w-full items-start gap-1.5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                    selected ? 'bg-primary/8 text-primary' : 'text-foreground',
                  )}
                >
                  {selected ? (
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="break-words">{c.label}</span>
                      {c.isFavorite && (
                        <Star className="h-3 w-3 fill-warning text-warning shrink-0" />
                      )}
                    </span>
                    {c.description && (
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {c.description}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 shrink-0 font-mono text-[9px] text-muted-foreground">
                    {c.provider}
                    {c.providerType && c.providerType !== c.provider ? ` · ${c.providerType}` : ''}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                {candidates.length === 0
                  ? t('activity:model.loading')
                  : t('activity:model.noMatch')}
              </div>
            )}
          </div>
        </AnchoredPopover>
      )}
    </fieldset>
  );
}
