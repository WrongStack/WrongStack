import { toErrorMessage } from '@wrongstack/core/utils/error';
import { useCallback, useEffect, useRef, useState } from 'react';
import { surfaceFetch } from '../host';
import type { useAppTranslation } from '../lib/i18n';
import { resolveSymbolForActivity, touchClientGraphCache } from './CodeMapActivityHelpers';
import { EMPTY_GRAPH, MAX_CLIENT_GRAPH_CACHE, MAX_SYMBOL_RESOLVE_INFLIGHT } from './CodeMapConfig';
import type { FileActivity, useCodemapActivityStore } from './codemap-activity-store';
import { useCodemapIndexStore } from './codemap-index-store';
import { type CodeMapGraphResponse, type CodeMapScope, scopeKey, scopeUrl } from './codemap-model';

type ResolveActivitySymbol = ReturnType<
  typeof useCodemapActivityStore.getState
>['resolveActivitySymbol'];

/**
 * Graph loading for Code Atlas: the LRU client cache, the single load path for
 * scope changes and index invalidation (background refresh keeps the current
 * map on screen), lazy tree-branch fetches, and symbol resolution for live
 * tool activity.
 */
export function useCodeMapGraphLoader({
  scope,
  currentScopeKey,
  t,
  pendingSelection,
  setSelectedId,
  activeOperations,
  resolveActivitySymbol,
}: {
  scope: CodeMapScope;
  currentScopeKey: string;
  t: ReturnType<typeof useAppTranslation>['t'];
  pendingSelection: React.MutableRefObject<string | null>;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  activeOperations: FileActivity[];
  resolveActivitySymbol: ResolveActivitySymbol;
}) {
  const [graph, setGraph] = useState<CodeMapGraphResponse>(EMPTY_GRAPH);
  /** Latest rendered graph, read by the load effect without re-running it. */
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingBranches, setLoadingBranches] = useState<Set<string>>(new Set());
  const [cacheRevision, setCacheRevision] = useState(0);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const lastReloadGeneration = useRef(0);
  const cache = useRef(new Map<string, CodeMapGraphResponse>());
  // Scopes cached before the last index update: still shown, refetched on their next request.
  const stale = useRef(new Set<string>());
  const symbolResolveInflight = useRef(new Set<string>());

  const fetchGraph = useCallback(
    async (targetScope: CodeMapScope, force = false): Promise<CodeMapGraphResponse> => {
      const key = scopeKey(targetScope);
      const existing = cache.current.get(key);
      if (existing && !force && !stale.current.has(key)) {
        // LRU touch on hit so hot scopes survive eviction.
        touchClientGraphCache(cache.current, key, existing, MAX_CLIENT_GRAPH_CACHE);
        return existing;
      }
      // The host carries the request to the project's engine (the WebUI's same-origin
      // cookie, the desktop's engine connection). A 401/403 means no valid session —
      // which is NOT a missing index — so surface a truthful error instead of the
      // misleading index guidance.
      const response = await surfaceFetch(scopeUrl(targetScope));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Authentication required — open this dashboard from its token URL.');
        }
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      // A 200 whose body is HTML is the SPA fallback, not a graph — surface
      // the friendly server-unavailable message instead of a parse exception.
      const nextGraph = (await response.json().catch(() => {
        throw new Error(
          t('activity:codeMap.snapshotUnavailable', {
            defaultValue: 'CodeMap graph unavailable — start the WebUI server to load it.',
          }),
        );
      })) as CodeMapGraphResponse;
      touchClientGraphCache(cache.current, key, nextGraph, MAX_CLIENT_GRAPH_CACHE);
      stale.current.delete(key);
      setCacheRevision((revision) => revision + 1);
      return nextGraph;
    },
    [t],
  );

  /** Refresh the loaded packages' file lists in place; a package that is gone drops out. */
  const refreshStalePackages = useCallback(
    async (cancelled: () => boolean): Promise<void> => {
      for (const key of [...stale.current]) {
        if (cancelled()) return;
        if (!key.startsWith('files:')) continue;
        await fetchGraph({ level: 'files', package: key.slice('files:'.length) }, true).catch(
          () => {
            cache.current.delete(key);
            stale.current.delete(key);
            setCacheRevision((revision) => revision + 1);
          },
        );
      }
    },
    [fetchGraph],
  );

  const indexGeneration = useCodemapIndexStore((state) => state.generation);
  const lastSeenIndexGeneration = useRef(0);

  // Single load path for scope changes and index invalidation — avoids racing
  // two parallel fetches that both call setGraph when an index run finishes.
  useEffect(() => {
    let cancelled = false;
    const reloadRequested = reloadGeneration > lastReloadGeneration.current;
    if (reloadRequested) lastReloadGeneration.current = reloadGeneration;
    const forceRefresh = reloadRequested || indexGeneration > lastSeenIndexGeneration.current;
    if (forceRefresh) {
      lastSeenIndexGeneration.current = indexGeneration;
      // An explicit reload starts over; an index update keeps what the tree shows (expanded
      // packages read their file lists from this cache) and refreshes it below.
      if (reloadRequested) {
        cache.current.clear();
        stale.current.clear();
      } else for (const key of cache.current.keys()) stale.current.add(key);
      setCacheRevision((revision) => revision + 1);
    }
    // An index update refreshes in the background: the map the user is
    // reading stays on screen, expanded packages/directories/files stay
    // expanded, and the selection survives if its node still exists. Every
    // agent edit publishes a generation, so collapsing the tree and flashing
    // the loading state here made the map unusable while an agent worked.
    const background = forceRefresh && graphRef.current !== EMPTY_GRAPH;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    void fetchGraph(scope, forceRefresh)
      .then((nextGraph) => {
        if (cancelled) return;
        setGraph(nextGraph);
        if (forceRefresh && !reloadRequested) void refreshStalePackages(() => cancelled);
        if (background) {
          setSelectedId((current) =>
            current && nextGraph.nodes.some((node) => node.id === current) ? current : null,
          );
          setError(null);
        } else if (!forceRefresh) {
          const requested = pendingSelection.current;
          pendingSelection.current = null;
          setSelectedId(
            requested && nextGraph.nodes.some((node) => node.id === requested) ? requested : null,
          );
        }
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(toErrorMessage(cause));
        // A failed background refresh keeps the last good map on screen.
        if (!background) setGraph(EMPTY_GRAPH);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentScopeKey, fetchGraph, indexGeneration, refreshStalePackages, reloadGeneration, scope]);

  /** Clear the cache and reload the current scope (error-retry button). */
  const retry = useCallback((): void => {
    setReloadGeneration((generation) => generation + 1);
  }, []);

  const ensureBranch = useCallback(
    async (targetScope: CodeMapScope): Promise<void> => {
      const key = scopeKey(targetScope);
      if ((cache.current.has(key) && !stale.current.has(key)) || loadingBranches.has(key)) return;
      setLoadingBranches((current) => new Set(current).add(key));
      try {
        await fetchGraph(targetScope);
      } finally {
        setLoadingBranches((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [fetchGraph, loadingBranches],
  );

  useEffect(() => {
    let cancelled = false;
    let started = 0;
    for (const activity of activeOperations) {
      if (started >= MAX_SYMBOL_RESOLVE_INFLIGHT) break;
      if (activity.symbol || !activity.toolUseId || activity.filePath.startsWith('(')) continue;
      const filePath = activity.filePath;
      if (symbolResolveInflight.current.has(filePath)) continue;
      symbolResolveInflight.current.add(filePath);
      started += 1;
      void fetchGraph({ level: 'symbols', file: filePath })
        .then((symbolGraph) => {
          if (cancelled) return;
          const symbol = resolveSymbolForActivity(activity, symbolGraph.nodes);
          if (!symbol) return;
          resolveActivitySymbol(activity.toolUseId!, filePath, {
            id: symbol.id,
            name: symbol.label,
            ...(symbol.symbolKind ? { kind: symbol.symbolKind } : {}),
            ...(symbol.line ? { line: symbol.line } : {}),
          });
        })
        .catch(() => undefined)
        .finally(() => {
          symbolResolveInflight.current.delete(filePath);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [activeOperations, fetchGraph, resolveActivitySymbol]);

  const rootGraph =
    cache.current.get('packages') ?? (scope.level === 'packages' ? graph : EMPTY_GRAPH);
  const packageGraph = useCallback(
    (packageName: string): CodeMapGraphResponse | undefined =>
      cache.current.get(scopeKey({ level: 'files', package: packageName })),
    [cacheRevision],
  );
  const graphForFile = useCallback(
    (filePath: string): CodeMapGraphResponse | undefined =>
      cache.current.get(scopeKey({ level: 'symbols', file: filePath })),
    [cacheRevision],
  );

  return {
    graph,
    loading,
    error,
    retry,
    loadingBranches,
    cacheRevision,
    cache,
    ensureBranch,
    rootGraph,
    packageGraph,
    graphForFile,
  };
}
