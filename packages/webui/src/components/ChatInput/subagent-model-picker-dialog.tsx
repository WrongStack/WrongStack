import { ArrowRight, Cpu, Filter, Search, Star, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CatalogModelLite,
  type ModelCandidate,
  buildModelCandidates,
  isModelInFavorites,
} from '@/components/QuickModelSwitcher.filter';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';

/**
 * The same flat searchable provider/model picker as `QuickModelSwitcher` (the
 * main chat's Cmd/Ctrl+M dialog), but scoped to a single subagent lane.
 *
 * Mirrors the main chat UX: search box at the top, favorites toggle, optional
 * provider filter, keyboard nav (↑↓ / Enter / Esc), and rich rows that show
 * the model name, context window, effort vocabulary, and a "current" badge.
 * Plus an "Inherit — routing / session" footer row so a lane previously pinned
 * elsewhere round-trips without being rewritten to a bare model id.
 *
 * Unlike `QuickModelSwitcher`, this picker does not write directly to the
 * session model. It only resolves a (provider, model) pair and hands it back
 * via `onPick`; the caller (the composer popover) decides what to do with it.
 */

export interface SubagentModelPickerDialogProps {
  /** Which lane this dialog edits — used in the title + to highlight the
   *  currently-pinned row, but never sent on the wire. */
  laneIndex: number;
  /** The lane currently saved in the plan, or undefined for an empty lane. */
  currentLane: {
    provider?: string;
    model?: string;
    /** Legacy `tier:` or `profile:` pin from another surface. When set, the
     *  dialog shows a sticky banner explaining that picking a model will
     *  replace this tier/profile with a concrete provider/model. */
    tier?: string;
    fallbackProfile?: string;
  };
  /** The session model — surfaced as the "active" badge on that row when a
   *  lane is pinned to it. */
  sessionProvider?: string | undefined;
  sessionModel?: string | undefined;
  /** Bumped when the dialog opens. The candidate fetch only fires while
   *  `open === true`; this gates the WS round-trip. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (pick: { provider: string; model: string } | null) => void;
}

interface SavedProviderLite {
  id: string;
}

interface CatalogRow extends CatalogModelLite {
  id: string;
}

export function SubagentModelPickerDialog({
  laneIndex,
  currentLane,
  sessionProvider,
  sessionModel,
  open,
  onOpenChange,
  onPick,
}: SubagentModelPickerDialogProps) {
  const { t } = useAppTranslation();
  const { listSavedProviders, listProviderModels } = useWebSocket();
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const favoriteModels = useLocalPrefs((s) => s.favoriteModels);
  const disabledModels = useLocalPrefs((s) => s.disabledModels);

  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selected, setSelected] = useState(0);
  const [saved, setSaved] = useState<SavedProviderLite[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, CatalogRow[]>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state every time the dialog re-opens, so a stale query from a
  // previous session doesn't carry over.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setProviderFilter(null);
    setFavoritesOnly(false);
    setSelected(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Wire WS listeners for the duration the dialog is mounted; the listeners
  // are cheap, and we want a late response (open → close → open) to populate
  // state for the next open instead of being dropped.
  useEffect(() => {
    if (!open) return undefined;
    const client = getWSClient(wsUrl);
    const offSaved = client.on('providers.saved', (msg: WSServerMessage) => {
      const p = msg.payload as { providers?: SavedProviderLite[] };
      setSaved(p.providers ?? []);
    });
    const offModels = client.on('provider.models', (msg: WSServerMessage) => {
      const p = msg.payload as { provider: string; models?: CatalogRow[] };
      setModelsByProvider((prev) => ({ ...prev, [p.provider]: p.models ?? [] }));
    });
    listSavedProviders();
    return () => {
      offSaved();
      offModels();
    };
  }, [open, wsUrl, listSavedProviders]);

  // Lazy-load each saved provider's catalogue.
  useEffect(() => {
    if (!open) return;
    for (const sp of saved) {
      if (!modelsByProvider[sp.id]) listProviderModels(sp.id);
    }
  }, [open, saved, modelsByProvider, listProviderModels]);

  const providerList = useMemo(
    () => [...new Set(saved.map((sp) => sp.id))].sort((a, b) => a.localeCompare(b)),
    [saved],
  );

  const candidates: ModelCandidate[] = useMemo(
    () =>
      buildModelCandidates(
        saved,
        modelsByProvider,
        query,
        currentLane.provider ?? sessionProvider,
        currentLane.model ?? sessionModel,
        providerFilter,
        favoritesOnly,
        favoriteModels ?? [],
        disabledModels ?? [],
      ),
    [
      saved,
      modelsByProvider,
      query,
      currentLane.provider,
      currentLane.model,
      sessionProvider,
      sessionModel,
      providerFilter,
      favoritesOnly,
      favoriteModels,
      disabledModels,
    ],
  );

  useEffect(() => {
    if (selected >= candidates.length) setSelected(0);
  }, [candidates.length, selected]);

  const commit = (idx: number) => {
    const pick = candidates[idx];
    if (!pick) return;
    onPick({ provider: pick.provider, model: pick.model });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onOpenChange(false);
      }}
    >
      <DialogContent
        className="max-w-xl gap-0 p-0 overflow-hidden pt-[10dvh]"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">
          {`Pick a model for subagent lane ${laneIndex + 1}`}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Search across every provider/model you've connected, then pick one to pin to this lane.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected((i) => Math.min(candidates.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                commit(selected);
              }
            }}
            placeholder="Search provider or model…"
            aria-label={`Search models for lane ${laneIndex + 1}`}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground min-w-0"
          />

          <button
            type="button"
            onClick={() => {
              setFavoritesOnly((v) => !v);
              setSelected(0);
            }}
            title="Show favorites only"
            aria-label="Show favorites only"
            aria-pressed={favoritesOnly}
            className={cn(
              'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors border shrink-0',
              favoritesOnly
                ? 'bg-warning/15 border-warning/40 text-warning font-medium'
                : 'bg-transparent border-border/70 text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            <Star
              className={cn(
                'h-3.5 w-3.5',
                favoritesOnly ? 'fill-warning text-warning' : 'text-muted-foreground',
              )}
            />
            <span className="text-[11px] whitespace-nowrap">Favorites</span>
          </button>

          {providerList.length > 1 && (
            <div className="flex items-center gap-1.5 min-w-0">
              <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <select
                value={providerFilter ?? ''}
                onChange={(e) => {
                  setProviderFilter(e.target.value || null);
                  setSelected(0);
                }}
                aria-label="Filter by provider"
                className="bg-transparent text-xs text-muted-foreground outline-none cursor-pointer border-0 min-w-0 truncate"
              >
                <option value="">All providers</option>
                {providerList.map((pid) => (
                  <option key={pid} value={pid}>
                    {pid}
                  </option>
                ))}
              </select>
            </div>
          )}

          <span className="text-[10px] text-muted-foreground font-mono shrink-0">
            ↑↓ · Enter · Esc
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Legacy tier/profile lanes carry no provider/model. Surfacing the
            pin as a sticky banner so the user knows picking a model will
            replace the tier/profile with a concrete provider/model pair. */}
        {(currentLane.tier || currentLane.fallbackProfile) && (
          <div className="border-b bg-warning/5 px-3 py-1.5 text-[11px] text-warning">
            Lane #{laneIndex + 1} is currently pinned to{' '}
            <span className="font-mono">
              {currentLane.tier ? `tier:${currentLane.tier}` : null}
              {currentLane.tier && currentLane.fallbackProfile ? ' · ' : null}
              {currentLane.fallbackProfile ? `profile:${currentLane.fallbackProfile}` : null}
            </span>
            . Picking a model replaces this pin.
          </div>
        )}

        <div className="max-h-[50dvh] overflow-y-auto py-1">
          {/* Footer row: clear the lane. The plain <select> used to keep this
              value as a passthrough; the dialog exposes it as a button so it
              reads as the obvious "off" choice. */}
          <button
            type="button"
            onClick={() => {
              onPick(null);
              onOpenChange(false);
            }}
            className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/40 text-muted-foreground"
          >
            <Cpu className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span>Inherit — routing / session</span>
              <span className="block text-[10px] font-mono">
                leave the lane empty; routing decides
              </span>
            </span>
          </button>

          {candidates.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {saved.length === 0
                ? 'No providers connected yet.'
                : Object.keys(modelsByProvider).length === 0
                  ? 'Loading models…'
                  : favoritesOnly
                    ? !favoriteModels?.length
                      ? 'No favorites configured.'
                      : 'No favorites match the search.'
                    : 'No matches.'}
            </div>
          ) : (
            candidates.map((c, idx) => {
              const isActiveLane =
                c.provider === currentLane.provider && c.model === currentLane.model;
              const isActiveSession =
                sessionProvider &&
                sessionModel &&
                c.provider === sessionProvider &&
                c.model === sessionModel;
              const isFavorite = isModelInFavorites(c.provider, c.model, favoriteModels);
              return (
                <button
                  type="button"
                  data-lane-candidate="true"
                  key={`${c.provider}:${c.model}`}
                  onClick={() => commit(idx)}
                  onMouseEnter={() => setSelected(idx)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                    idx === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
                    isActiveLane && 'font-medium',
                  )}
                >
                  <Cpu
                    className={cn(
                      'h-4 w-4 shrink-0',
                      isActiveLane ? 'text-primary' : 'text-muted-foreground',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 break-words">
                      <span className="text-muted-foreground">{c.provider}</span>
                      <span className="text-muted-foreground/65">·</span>
                      <span>{c.modelName}</span>
                      {isFavorite && (
                        <span title="Favorite model">
                          <Star className="h-3 w-3 fill-warning text-warning shrink-0" />
                        </span>
                      )}
                    </div>
                    {(c.contextWindow || c.reasoningEffortLevels) && (
                      <div className="text-[10px] text-muted-foreground font-mono break-words">
                        {c.model}
                        {c.contextWindow ? ` · ctx ${c.contextWindow.toLocaleString()}` : ''}
                        {c.reasoningEffortLevels
                          ? ` · effort ${c.reasoningEffortLevels.join('/')}`
                          : ''}
                      </div>
                    )}
                  </div>
                  {isActiveLane ? (
                    <span className="text-[10px] uppercase tracking-wide text-primary font-semibold">
                      on this lane
                    </span>
                  ) : isActiveSession ? (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                      session model
                    </span>
                  ) : (
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
