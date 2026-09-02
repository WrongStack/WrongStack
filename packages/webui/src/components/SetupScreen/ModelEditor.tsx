import { useAppTranslation } from '@/i18n';
import { getWSClient } from '@/lib/ws-client';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores';
import type { ProviderCatalogModelMatch } from '@/types/system';
import { Check, Loader2, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export interface ModelEntry {
  id: string;
  name?: string | undefined;
  maxOutput?: number | undefined;
  capabilities?:
    | {
        maxContext?: number | undefined;
        tools?: boolean | undefined;
        vision?: boolean | undefined;
        reasoning?: boolean | undefined;
        streaming?: boolean | undefined;
        jsonMode?: boolean | undefined;
      }
    | undefined;
}

export function ModelEditor({
  models,
  onChange,
}: {
  models: ModelEntry[];
  onChange: (models: ModelEntry[]) => void;
}) {
  const { t } = useAppTranslation();
  const [showAdd, setShowAdd] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ProviderCatalogModelMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customId, setCustomId] = useState('');
  const searchRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const customInputRef = useRef<HTMLInputElement>(null);
  const wsUrl = useConfigStore((s) => s.wsUrl);

  const search = useCallback(
    (rawQuery: string) => {
      if (!rawQuery.trim()) {
        setMatches([]);
        return;
      }
      setSearching(true);
      const client = getWSClient(wsUrl);
      const off = client.on('provider.models.search_result', (msg: unknown) => {
        const p = (msg as { payload?: { query?: string; matches?: ProviderCatalogModelMatch[] } })
          .payload;
        if (!p || p.query !== rawQuery.trim()) return;
        setMatches(p.matches ?? []);
        setSearching(false);
      });
      client.searchProviderModels(rawQuery.trim(), 8);
      // Timeout cleanup if server never responds
      setTimeout(() => {
        off?.();
        setSearching(false);
      }, 5000);
    },
    [wsUrl],
  );

  useEffect(() => {
    if (searchRef.current) clearTimeout(searchRef.current);
    if (!query.trim()) {
      setMatches([]);
      return;
    }
    searchRef.current = setTimeout(() => search(query), 250);
    return () => {
      if (searchRef.current) clearTimeout(searchRef.current);
    };
  }, [query, search]);

  const addModel = useCallback(
    (id: string, match?: ProviderCatalogModelMatch) => {
      if (!id || models.some((m) => m.id === id)) return;
      const entry: ModelEntry = {
        id,
        name: match?.name ?? match?.modelId ?? id,
        ...(match?.maxOutput ? { maxOutput: match.maxOutput } : {}),
        capabilities: {
          ...(match?.contextWindow ? { maxContext: match.contextWindow } : {}),
          ...(match?.capabilities.includes('tools') ? { tools: true } : {}),
          ...(match?.capabilities.includes('vision') ? { vision: true } : {}),
          ...(match?.capabilities.includes('reasoning') ? { reasoning: true } : {}),
        },
      };
      onChange([...models, entry]);
      setQuery('');
      setMatches([]);
      setShowAdd(false);
    },
    [models, onChange],
  );

  const removeModel = useCallback(
    (id: string) => {
      onChange(models.filter((m) => m.id !== id));
    },
    [models, onChange],
  );

  const confirmCustom = useCallback(() => {
    const id = customId.trim();
    if (!id) return;
    addModel(id);
    setCustomId('');
    setShowCustom(false);
  }, [customId, addModel]);

  return (
    <div className="space-y-2">
      <span className="text-[11px] font-medium text-muted-foreground block">
        {t('setup:screen.custom.models')}
      </span>

      {/* Model list chips */}
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {models.map((model) => (
            <div
              key={model.id}
              className={cn(
                'group inline-flex items-center gap-1 px-2 py-1 text-xs rounded',
                'bg-accent/10 text-accent border border-accent/20',
              )}
              title={
                model.name && model.name !== model.id
                  ? `${model.name}\n${model.capabilities?.maxContext ? `maxContext: ${model.capabilities.maxContext}` : ''}${model.maxOutput ? `\nmaxOutput: ${model.maxOutput}` : ''}`
                  : undefined
              }
            >
              <span className="truncate max-w-[120px]">
                {model.name && model.name !== model.id ? model.name : model.id}
              </span>
              <button
                type="button"
                onClick={() => removeModel(model.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Search / Add row */}
      {showAdd ? (
        <div className="space-y-2 p-3 rounded border border-border/60 bg-muted/20">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={t('setup:screen.custom.modelSearchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="text-sm pl-8"
              autoFocus
            />
            {searching && (
              <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Catalog match results */}
          {matches.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {matches.map((match) => (
                <button
                  key={`${match.providerId}\u0000${match.modelId}`}
                  type="button"
                  onClick={() => addModel(match.modelId, match)}
                  className={cn(
                    'w-full flex items-start gap-2 p-2 text-left text-xs rounded transition-colors',
                    'hover:bg-accent/10 border border-transparent hover:border-accent/30',
                  )}
                >
                  <Check className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium block truncate">{match.name}</span>
                    <span className="text-muted-foreground block">
                      {match.providerName} · {match.modelId}
                      {match.contextWindow
                        ? ` · ${(match.contextWindow / 1000).toFixed(0)}K ctx`
                        : ''}
                      {match.maxOutput ? ` · ${match.maxOutput.toLocaleString()} out` : ''}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* No matches / custom ID */}
          {!searching && query.trim() && matches.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-2">
              {t('setup:screen.custom.noCatalogMatch')}
              <button
                type="button"
                onClick={() => {
                  setShowCustom(true);
                  setTimeout(() => customInputRef.current?.focus(), 50);
                }}
                className="ml-1 text-accent underline underline-offset-2 hover:text-accent/80"
              >
                {t('setup:screen.custom.useCustomId')}
              </button>
            </div>
          )}

          {/* Custom ID input */}
          {showCustom && (
            <div className="flex items-center gap-2">
              <Input
                ref={customInputRef}
                placeholder={t('setup:screen.custom.customModelIdPlaceholder')}
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                className="text-sm flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmCustom();
                }}
              />
              <Button type="button" size="sm" onClick={confirmCustom} disabled={!customId.trim()}>
                <Check className="h-3.5 w-3.5 mr-1" />
                {t('setup:screen.custom.add')}
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAdd(false);
                setQuery('');
                setMatches([]);
                setShowCustom(false);
                setCustomId('');
              }}
              className="text-xs"
            >
              {t('setup:screen.custom.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowAdd(true)}
          className="text-xs"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t('setup:screen.custom.addModel')}
        </Button>
      )}

      {/* Summary metadata tooltip */}
      {models.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {models.length}{' '}
          {models.length === 1
            ? t('setup:screen.custom.modelSingular')
            : t('setup:screen.custom.modelPlural')}
        </p>
      )}
    </div>
  );
}
