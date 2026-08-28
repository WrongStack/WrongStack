/**
 * `<ModelCatalogPicker>` — server-side catalog search for adding models from
 * models.dev (ME-4). Uses the existing `provider.models.search` WS message
 * so the 3.45MB catalog is never shipped to the browser.
 */
import { Loader2, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import type { WrongStackWebSocketClient } from '../../lib/ws-client';
import type { WSServerMessage } from '../../types';

interface CatalogMatch {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  description?: string | undefined;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

interface ModelCatalogPickerProps {
  ws: WrongStackWebSocketClient;
  onSelect: (modelId: string, modelsDev: Record<string, unknown>) => void;
  onClose: () => void;
}

export function ModelCatalogPicker({ ws, onSelect, onClose }: ModelCatalogPickerProps) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest query actually sent to the server; stale replies are ignored.
  const inflightQueryRef = useRef('');

  // Listen for search results
  useEffect(() => {
    const off = ws.on('provider.models.search_result', (msg: WSServerMessage) => {
      if (msg.type !== 'provider.models.search_result') return;
      const payload = msg.payload as { query?: string; matches?: CatalogMatch[] };
      // Correlate with the in-flight query — a slow reply to a previous
      // search must not overwrite results for the current one.
      if (payload.query !== undefined && payload.query !== inflightQueryRef.current) return;
      setResults(payload.matches ?? []);
      setLoading(false);
    });
    return off;
  }, [ws]);

  // Debounced search
  const fireSearch = useCallback(
    (q: string) => {
      if (!q.trim()) {
        setResults([]);
        inflightQueryRef.current = '';
        return;
      }
      inflightQueryRef.current = q;
      setLoading(true);
      ws.searchProviderModels(q, 8);
    },
    [ws],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fireSearch(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fireSearch]);

  const handlePick = useCallback(
    (match: CatalogMatch) => {
      // Build the modelsDev object from the catalog match — prefills all fields
      const modelsDev: Record<string, unknown> = {
        name: match.name,
        ...(match.description ? { description: match.description } : {}),
        ...(match.releaseDate ? { release_date: match.releaseDate } : {}),
        ...(match.contextWindow || match.maxOutput
          ? {
              limit: {
                ...(match.contextWindow ? { context: match.contextWindow } : {}),
                ...(match.maxOutput ? { output: match.maxOutput } : {}),
              },
            }
          : {}),
        ...(match.inputCost || match.outputCost
          ? {
              cost: {
                ...(match.inputCost ? { input: match.inputCost } : {}),
                ...(match.outputCost ? { output: match.outputCost } : {}),
              },
            }
          : {}),
        ...(match.capabilities.length > 0
          ? {
              tool_call: match.capabilities.includes('tools'),
              reasoning: match.capabilities.includes('reasoning'),
              ...(match.capabilities.includes('vision')
                ? { modalities: { input: ['text', 'image'] } }
                : {}),
            }
          : {}),
      };
      onSelect(match.modelId, modelsDev);
    },
    [onSelect],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label={t('common:action.close')}
      />
      <div className="relative max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {t('settings:providerModels.catalogSearchTitle')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings:providerModels.catalogSearchPlaceholder')}
            className="h-10 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : results.length > 0 ? (
          <div className="space-y-1.5">
            {results.map((match) => (
              <button
                key={`${match.providerId}:${match.modelId}`}
                type="button"
                onClick={() => handlePick(match)}
                className="block w-full rounded-md border border-border/60 p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {match.modelId}
                    </span>
                    {match.name !== match.modelId && (
                      <span className="ml-2 text-xs text-muted-foreground">{match.name}</span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {match.providerName}
                  </span>
                </div>
                {match.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {match.description}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {match.contextWindow ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {match.contextWindow >= 1_000_000
                        ? `${(match.contextWindow / 1_000_000).toFixed(1)}M ctx`
                        : `${Math.round(match.contextWindow / 1000)}K ctx`}
                    </span>
                  ) : null}
                  {match.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        ) : query.trim() ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('settings:providerModels.noResults')}
          </p>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('settings:providerModels.typeToSearch')}
          </p>
        )}
      </div>
    </div>
  );
}
