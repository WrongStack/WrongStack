/**
 * Ctrl/Cmd+K palette — jump to any surface without reaching for the nav.
 *
 * Deliberately not `cmdk`: HQ has twelve destinations and a substring match is
 * the whole requirement. Keyboard handling lives here rather than in the shell
 * so the list and its selection index can never disagree.
 */
import { CornerDownLeft, Search } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HqViewId } from '../../data/store/index.js';
import { cn } from '../../lib/utils.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.js';
import { searchHqViews } from './views.js';

export function CommandPalette({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (view: HqViewId) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchHqViews(query), [query]);

  // Reset on every open so the palette never remembers a stale search.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
  }, [open]);

  // Clamp after filtering, or Enter could fire on a row that no longer exists.
  useEffect(() => {
    setCursor((current) => (current >= results.length ? 0 : current));
  }, [results.length]);

  const commit = (view: HqViewId): void => {
    onSelect(view);
    onOpenChange(false);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((current) =>
        results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = results[cursor];
      if (selected !== undefined) commit(selected.id);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="HQ command palette"
        showCloseButton={false}
        className="top-[18%] max-w-xl translate-y-0 gap-0 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">HQ command palette</DialogTitle>
        <DialogDescription className="sr-only">Search and jump to an HQ surface.</DialogDescription>

        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search HQ views"
            placeholder="Search views…"
            data-testid="command-palette-input"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          />
        </div>

        <div className="max-h-80 overflow-y-auto p-1" data-testid="command-palette-results">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No surface matches “{query}”.
            </p>
          ) : (
            results.map((view, index) => {
              const Icon = view.icon;
              const selected = index === cursor;
              return (
                <button
                  key={view.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid="command-palette-item"
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => commit(view.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                    selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs font-medium">{view.label}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {view.description}
                    </span>
                  </span>
                  {selected && <CornerDownLeft className="ml-auto size-3 text-muted-foreground" />}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
