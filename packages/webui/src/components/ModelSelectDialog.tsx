import { Layers, Search, Star } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { type ModelCandidate, useProviderModels } from '@/hooks/useProviderModels';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { PickerCardList } from './ui/PickerCardList';

/**
 * What the dialog lets the user pick: provider/model, fallback profile, or both.
 * - 'provider-model': searchable provider+model list (existing ModelPickDialog behaviour)
 * - 'fallback': fallback profile name from the named profiles
 * - 'both': tabs — first tab shows fallback profiles, second shows provider/model
 */
type ModelSelectMode = 'provider-model' | 'fallback' | 'both';

/** The value the user picked. */
type ModelSelectResult =
  | { type: 'provider-model'; provider: string; model: string; label: string }
  | { type: 'fallback-profile'; name: string }
  | { type: 'clear' };

interface ModelSelectDialogProps {
  open: boolean;
  /** What selection modes to offer. */
  mode: ModelSelectMode;
  /** Dialog title. */
  title: string;
  /** Optional hint below the title. */
  hint?: string | undefined;
  /** Fallback profiles to choose from (required when mode includes fallback). */
  fallbackProfiles?: Record<string, string[]> | undefined;
  /** Called when the user picks. Return `true` to KEEP the dialog open (multi-add). */
  onPick: (result: ModelSelectResult) => boolean | undefined | void;
  onClose: () => void;
  /** Label for the "clear" button (default: "Clear"). */
  clearLabel?: string;
}

/**
 * Unified model/provider/fallback-profile selection dialog.
 * Replaces one-off patterns with a single searchable, keyboard-navigable modal
 * that adapts to what the caller needs.
 *
 * - `mode="provider-model"` → searchable model list (same as ModelPickDialog)
 * - `mode="fallback"` → fallback profile card list
 * - `mode="both"` → tabs with profiles first, then models
 */
export function ModelSelectDialog({
  open,
  mode,
  title,
  hint,
  fallbackProfiles,
  onPick,
  onClose,
  clearLabel = 'Clear',
}: ModelSelectDialogProps): ReactElement {
  const { t } = useAppTranslation();
  const candidates = useProviderModels(open && mode !== 'fallback');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [tab, setTab] = useState<'fallback' | 'models'>('fallback');
  const listRef = useRef<HTMLDivElement | null>(null);

  const _hasFallback =
    (mode === 'fallback' || mode === 'both') &&
    fallbackProfiles &&
    Object.keys(fallbackProfiles).length > 0;

  const hasModels = mode === 'provider-model' || mode === 'both';

  // Reset state on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      if (mode === 'both') setTab('fallback');
      else if (mode === 'fallback') setTab('fallback');
      else if (mode === 'provider-model') setTab('models');
    }
  }, [open, mode]);

  // Provider/model filtering
  const filtered = useMemo(() => {
    if (!hasModels) return [];
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      `${c.provider}/${c.model} ${c.label}`.toLowerCase().includes(q),
    );
  }, [candidates, query, hasModels]);

  useEffect(() => {
    if (hasModels) setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)));
  }, [filtered.length, hasModels]);

  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pickModel = (candidate: ModelCandidate | undefined): void => {
    if (!candidate) return;
    const keepOpen =
      onPick({
        type: 'provider-model',
        provider: candidate.provider,
        model: candidate.model,
        label: `${candidate.provider}/${candidate.model}`,
      }) === true;
    if (!keepOpen) onClose();
  };

  const pickProfile = (name: string): void => {
    if (!name) {
      onPick({ type: 'clear' });
      onClose();
    } else {
      const keepOpen = onPick({ type: 'fallback-profile', name }) === true;
      if (!keepOpen) onClose();
    }
  };

  const profileEntries = useMemo(() => {
    if (!fallbackProfiles) return [];
    return Object.entries(fallbackProfiles).map(([name, chain]) => ({
      id: name,
      label: name,
      sublabel: undefined,
      detail: chain.length > 0 ? `${chain[0]}${chain.length > 1 ? ' …' : ''}` : undefined,
      detailHighlight: true,
      badges: chain.slice(0, 3),
      rightContent: undefined,
    }));
  }, [fallbackProfiles]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </DialogHeader>

        {/* Tabs for 'both' mode */}
        {mode === 'both' && (
          <div className="flex gap-1 rounded-lg border border-border/70 bg-card/60 p-0.5">
            <button
              type="button"
              onClick={() => {
                setTab('fallback');
                setQuery('');
              }}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all',
                tab === 'fallback'
                  ? 'bg-primary/10 text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Layers className="h-3 w-3 inline mr-1" />
              {t('activity:modelSelectDialog.fallbackProfiles')}
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('models');
                setQuery('');
              }}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all',
                tab === 'models'
                  ? 'bg-primary/10 text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Search className="h-3 w-3 inline mr-1" />
              Models
            </button>
          </div>
        )}

        {/* Fallback profile tab */}
        {(mode === 'fallback' || (mode === 'both' && tab === 'fallback')) && (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => pickProfile('')}
              className={cn(
                'w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all',
                'border-border hover:bg-muted',
              )}
            >
              <span className="font-medium text-sm">{clearLabel}</span>
            </button>
            {profileEntries.length > 0 ? (
              <PickerCardList
                options={profileEntries}
                selectedId=""
                onSelect={(id) => pickProfile(id)}
              />
            ) : (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t('activity:modelSelectDialog.noFallbackProfilesConfigured')}
              </p>
            )}
          </div>
        )}

        {/* Provider/model tab */}
        {(mode === 'provider-model' || (mode === 'both' && tab === 'models')) && (
          <>
            <div className="flex items-center gap-2 rounded-md border bg-background px-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus={mode === 'provider-model'}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCursor((c) => Math.min(c + 1, Math.max(0, filtered.length - 1)));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCursor((c) => Math.max(c - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    pickModel(filtered[cursor]);
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
                        onClick={() => pickModel(c)}
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
          </>
        )}

        <p className="text-[10px] text-muted-foreground">
          {mode === 'fallback'
            ? 'Click a profile to select'
            : '↑/↓ navigate · Enter select · Esc close'}
        </p>
      </DialogContent>
    </Dialog>
  );
}
