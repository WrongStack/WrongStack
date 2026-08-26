import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useAppTranslation } from '@/i18n';
import { toast } from '@/components/Toaster';
import { useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { memorySessionSnapshots } from '@/stores/session-store';
import type { WSServerMessage } from '@/types';
import { ArrowRight, Cpu, Filter, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { buildModelCandidates } from './QuickModelSwitcher.filter';

interface SavedProvider {
  id: string;
  apiKeys: Array<{ label: string; isActive: boolean }>;
}
interface CatalogModel {
  id: string;
  name: string;
  description?: string | undefined;
  contextWindow?: number | undefined;
}

/**
 * Ctrl/Cmd+M — flat searchable provider/model picker. Drops a 3-click
 * trip through Settings down to one shortcut. Pulls the list of *saved*
 * providers (the ones that actually have a registered key) and lazy-loads
 * each provider's models when the overlay opens. The active model is
 * highlighted; Enter switches via the existing model.switch WS handler
 * (which atomically swaps provider+model on the backend).
 */
export function QuickModelSwitcher() {
  const { t } = useAppTranslation();
  const open = useUIStore((s) => s.modelSwitcherOpen);
  const setOpen = useUIStore((s) => s.setModelSwitcherOpen);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [saved, setSaved] = useState<SavedProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, CatalogModel[]>>({});
  const [switchingTarget, setSwitchingTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const wsUrl = useConfigStore((s) => s.wsUrl);
  const currentProvider = useConfigStore((s) => s.provider);
  const currentModel = useConfigStore((s) => s.model);
  const paletteOpen = useUIStore((s) => s.paletteOpen);
  // Destructure the stable action callbacks from useWebSocket() so we
  // can list them as effect deps without re-firing on every render.
  // useWebSocket() returns a fresh object literal each call — putting
  // that object itself in a dep array makes the effect run on every
  // render, which would reset `query` to '' and clear the user's input
  // mid-keystroke (the "filter doesn't work" symptom).
  const { listSavedProviders, listProviderModels, switchModel } = useWebSocket();

  // Ctrl/Cmd+M opens. Skip when the command palette is already open so
  // the two overlays don't fight for focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'm' && !e.shiftKey && !e.altKey) {
        if (paletteOpen) return;
        e.preventDefault();
        setOpen(!open);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, paletteOpen]);

  // Wire up WS listeners + fetch on open. We listen unconditionally so a
  // late response (e.g. the user opened then closed before models arrived)
  // still populates state for the next open.
  useEffect(() => {
    const client = getWSClient(wsUrl);
    const offSaved = client.on('providers.saved', (msg: WSServerMessage) => {
      const p = msg.payload as { providers: SavedProvider[] };
      setSaved(p.providers ?? []);
    });
    const offModels = client.on('provider.models', (msg: WSServerMessage) => {
      const p = msg.payload as { provider: string; models: CatalogModel[] };
      setModelsByProvider((prev) => ({ ...prev, [p.provider]: p.models }));
    });
    return () => {
      offSaved();
      offModels();
    };
  }, [wsUrl]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setProviderFilter(null);
    setSelected(0);
    listSavedProviders();
    // Auto-focus the search input after the dialog paints. requestAnimationFrame
    // because the input ref isn't mounted on the same tick we flip `open`.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, listSavedProviders]);

  // Lazy-load models per saved provider once we know what's saved.
  useEffect(() => {
    if (!open) return;
    for (const sp of saved) {
      if (!modelsByProvider[sp.id]) {
        listProviderModels(sp.id);
      }
    }
  }, [open, saved, modelsByProvider, listProviderModels]);

  /** Derive unique provider IDs (sorted) from the saved list for the
   *  filter dropdown. */
  const providerList = useMemo(
    () => [...new Set(saved.map((sp) => sp.id))].sort((a, b) => a.localeCompare(b)),
    [saved],
  );

  /** Flatten into a single list of {provider, model} candidates, then apply
   *  the search filter and optional provider filter. The active row floats
   *  to the top so the user can see what they're currently on. */
  const candidates = useMemo(
    () =>
      buildModelCandidates(
        saved,
        modelsByProvider,
        query,
        currentProvider,
        currentModel,
        providerFilter,
      ),
    [saved, modelsByProvider, query, currentProvider, currentModel, providerFilter],
  );

  useEffect(() => {
    if (selected >= candidates.length) setSelected(0);
  }, [candidates.length, selected]);

  const commit = async (idx: number) => {
    const pick = candidates[idx];
    if (!pick || switchingTarget) return;
    if (pick.isCurrent) {
      setOpen(false);
      return;
    }
    const target = `${pick.provider} / ${pick.model}`;
    setSwitchingTarget(target);
    const result = await switchModel(pick.provider, pick.model);
    if (result.success) {
      const cur = useSessionStore.getState().session;
      if (cur) {
        useSessionStore.getState().setSession({
          ...cur,
          provider: pick.provider,
          model: pick.model,
        });
        const snap = memorySessionSnapshots.get(cur.id);
        if (snap) {
          snap.provider = pick.provider;
          snap.model = pick.model;
          if (snap.session) {
            snap.session.provider = pick.provider;
            snap.session.model = pick.model;
          }
        }
      }
    }
    // Suppress toast notifications if the dialog was closed while switching
    if (openRef.current) {
      if (result.success) {
        toast.success(
          t(
            result.runActive
              ? 'settings:toast.modelSwitchedRunActive'
              : 'settings:toast.modelSwitchedNextRequest',
            { from: `${currentProvider} / ${currentModel}`, to: target },
          ),
        );
        setOpen(false);
      } else {
        toast.error(result.message);
      }
    }
    setSwitchingTarget(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setSwitchingTarget(null);
          setOpen(false);
        }
      }}
    >
      <DialogContent
        className="max-w-xl gap-0 p-0 overflow-hidden pt-[15dvh]"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
        aria-busy={switchingTarget !== null}
      >
        <DialogTitle className="sr-only">{t('activity:modelSwitcher.heading')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('activity:modelSwitcher.filterPlaceholder')}
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
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
                void commit(selected);
              }
            }}
            placeholder={t('activity:modelSwitcher.filterPlaceholder')}
            aria-label={t('activity:modelSwitcher.filterPlaceholder')}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          {providerList.length > 1 && (
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <select
                value={providerFilter ?? ''}
                onChange={(e) => {
                  setProviderFilter(e.target.value || null);
                  setSelected(0);
                }}
                aria-label={t('activity:modelSwitcher.providerFilter')}
                className="bg-transparent text-xs text-muted-foreground outline-none cursor-pointer border-0 max-w-[100px] truncate"
              >
                <option value="">{t('activity:modelSwitcher.providerFilterAll')}</option>
                {providerList.map((pid) => (
                  <option key={pid} value={pid}>
                    {pid}
                  </option>
                ))}
              </select>
            </div>
          )}
          <span className="text-[10px] text-muted-foreground font-mono">
            {switchingTarget
              ? t('settings:toast.switchingToTarget', { target: switchingTarget })
              : '↑↓ · Enter · Esc'}
          </span>
        </div>
        <div className="max-h-[50dvh] overflow-y-auto py-1">
          {candidates.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {saved.length === 0
                ? t('activity:modelSwitcher.noSavedProviders')
                : Object.keys(modelsByProvider).length === 0
                  ? t('activity:model.loading')
                  : t('activity:modelSwitcher.noMatch')}
            </div>
          ) : (
            candidates.map((c, idx) => (
              <button
                type="button"
                key={`${c.provider}:${c.model}`}
                onClick={() => void commit(idx)}
                disabled={switchingTarget !== null}
                onMouseEnter={() => setSelected(idx)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                  idx === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
                  c.isCurrent && 'font-medium',
                )}
              >
                <Cpu
                  className={cn(
                    'h-4 w-4 shrink-0',
                    c.isCurrent ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <span className="text-muted-foreground">{c.provider}</span>
                    <span className="mx-1 text-muted-foreground/65">·</span>
                    <span>{c.modelName}</span>
                  </div>
                  {c.contextWindow && (
                    <div className="text-[10px] text-muted-foreground font-mono">
                      {c.model} · ctx {c.contextWindow.toLocaleString()}
                    </div>
                  )}
                </div>
                {c.isCurrent ? (
                  <span className="text-[10px] uppercase tracking-wide text-primary font-semibold">
                    {t('activity:modelSwitcher.active')}
                  </span>
                ) : (
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
