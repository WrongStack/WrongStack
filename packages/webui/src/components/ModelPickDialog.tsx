import { Search, Star } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { type ModelCandidate, useProviderModels } from '@/hooks/useProviderModels';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';

export type { ModelCandidate } from '@/hooks/useProviderModels';

export interface ModelPickDialogProps {
  open: boolean;
  /** Dialog title — say what the model is FOR ("Add council voter"). */
  title: string;
  /** Optional subtitle/hint under the title. */
  hint?: string | undefined;
  /** Called with the chosen candidate. Return `true` to KEEP the dialog open (multi-add flows). */
  onPick: (candidate: ModelCandidate) => boolean | undefined | void;
  onClose: () => void;
}

/**
 * Reusable provider+model picker — the WebUI counterpart of the TUI's
 * shared /model overlay in 'pick' mode. Searchable, keyboard-navigable
 * (↑/↓ + Enter), grouped by provider, fed by the same saved-provider
 * catalog every other picker uses. Callers just receive the selection;
 * nothing here switches the session model.
 */
export function ModelPickDialog({
  open,
  title,
  hint,
  onPick,
  onClose,
}: ModelPickDialogProps): ReactElement {
  const { t } = useAppTranslation();
  const candidates = useProviderModels(open);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      `${c.provider}/${c.model} ${c.label}`.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (candidate: ModelCandidate | undefined): void => {
    if (!candidate) return;
    const keepOpen = onPick(candidate) === true;
    if (!keepOpen) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-background px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(filtered[cursor]);
              }
            }}
            placeholder={`Search ${candidates.length} models…`}
            className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="max-h-72 space-y-0.5 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {candidates.length === 0 ? 'Loading models…' : `No models match "${query}"`}
            </p>
          ) : (
            filtered.map((c, i) => {
              const prevProvider = filtered[i - 1]?.provider;
              return (
                <div key={`${c.provider}/${c.model}`}>
                  {c.provider !== prevProvider && (
                    <div className="sticky top-0 bg-card px-1 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {c.provider}
                    </div>
                  )}
                  <button
                    type="button"
                    data-cursor={i === cursor}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pick(c)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
                      i === cursor ? 'bg-primary/15 text-foreground' : 'hover:bg-muted/60',
                    )}
                  >
                    <span className="truncate font-mono">{c.model}</span>
                    {c.label !== c.model && (
                      <span className="truncate text-muted-foreground">{c.label}</span>
                    )}
                    {c.isFavorite && (
                      <Star className="h-3 w-3 fill-warning text-warning shrink-0 ml-auto" />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          {t('activity:modelPickDialog.navigateEnterSelectEscClose')}
        </p>
      </DialogContent>
    </Dialog>
  );
}
