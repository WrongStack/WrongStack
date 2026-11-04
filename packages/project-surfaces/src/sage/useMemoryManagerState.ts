import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { surfaceConfirm as confirmModal, useSurfaceHost } from '../host';
import { useAppTranslation } from '../lib/i18n';
import type { SageEntry, SageGraphEdge, SageStats, SageStatus } from './model-types';
import { resolveSearchMemory } from './rankedSearch.js';
import { collectMemoryTags, filterMemories, selectRelatedMemories } from './selectors';
import type { MemoryDraft } from './shared';
import { draftFromMemory, emptyDraft } from './shared';
import type { SharedMemorySearch } from './sharedSearch.js';
import { useDebouncedListQuery } from './useDebouncedListQuery.js';
import { useMemoryMutations } from './useMemoryMutations.js';
import { useSendWithAck } from './useSendWithAck.js';

const PAGE_SIZE = 100;

export function useMemoryManagerState(sharedSearch?: SharedMemorySearch) {
  const { t } = useAppTranslation();
  const {
    client,
    listSageMemoriesPage,
    listMemoryCandidates,
    rememberSage,
    updateSage,
    deleteSage,
    getSageGraph,
    recoverSage,
    resolveMemoryCandidate,
    searchSageBreakdown,
    sageDoctor,
  } = useSurfaceHost().useSageSocket();
  const wsConnected = useSurfaceHost().useConnected();

  const [memories, setMemories] = useState<SageEntry[]>([]);
  const [stats, setStats] = useState<SageStats | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [graphEdges, setGraphEdges] = useState<SageGraphEdge[]>([]);
  const [graphMemories, setGraphMemories] = useState<SageEntry[]>([]);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft);
  const [baselineDraft, setBaselineDraft] = useState<MemoryDraft>(emptyDraft);
  const [busyAction, setBusyAction] = useState<'create' | 'update' | 'delete' | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /**
   * When true, the pending delete also marks the record `neverInject`, so
   * context injection never loads it again. Off by default: a normal delete is
   * already recoverable, and this is a strictly stronger, one-way claim that
   * the memory is factually WRONG rather than merely out of date.
   */
  const [neverInject, setNeverInject] = useState(false);
  /**
   * Per-channel score breakdown for the active search query. Populated
   * by `searchSageBreakdown` whenever the user types a query into the
   * memory search box. The MemoryManager renders this as a row of
   * cards above the regular list — the operator sees which channel
   * matched and how much each one contributed.
   */
  const [searchBreakdown, setSearchBreakdown] = useState<{
    hits: import('./types').WSSearchBreakdownHit[];
    channel: 'breakdown' | 'lexical' | undefined;
    loading: boolean;
    error: string | null;
  }>({ hits: [], channel: undefined, loading: false, error: null });
  const [localQuery, setLocalQuery] = useState('');
  const [localStatus, setLocalStatus] = useState<'all' | SageStatus>('all');
  const [localKind, setLocalKind] = useState('all');
  const searchQuery = sharedSearch?.query ?? localQuery;
  const setSearchQuery = sharedSearch?.setQuery ?? setLocalQuery;
  const statusFilter = sharedSearch?.statusFilter ?? localStatus;
  const setStatusFilter = sharedSearch?.setStatusFilter ?? setLocalStatus;
  const kindFilter = sharedSearch?.kindFilter ?? localKind;
  const setKindFilter = sharedSearch?.setKindFilter ?? setLocalKind;
  const listQuery = useDebouncedListQuery(searchQuery);
  const [resolvedMemory, setResolvedMemory] = useState<SageEntry | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const resolveController = useRef<AbortController | null>(null);
  const resolvedMemoryRef = useRef<SageEntry | null>(null);
  const [audienceOnly, setAudienceOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [libraryView, setLibraryView] = useState<'active' | 'deleted' | 'review' | 'health'>(
    'active',
  );
  const showDeleted = libraryView === 'deleted';
  const showReview = libraryView === 'review';
  /**
   * The status the loaded rows are actually filtered by.
   *
   * The Deleted tab pins the *server-side* filter to `deleted` (see
   * `loadPage`), so the client-side filter has to agree with it. Applying the
   * separate status dropdown on top of the pinned filter hid every deleted
   * record whenever a leftover status filter (e.g. "stale") was active, while
   * the tab label still advertised the deleted count.
   */
  const effectiveStatusFilter: 'all' | SageStatus = showDeleted ? 'deleted' : statusFilter;
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);

  const hasLoadedRef = useRef(false);
  /** Store-wide stats only change on mutation: filter reloads skip them once loaded. */
  const statsLoadedRef = useRef(false);
  const searchBreakdownHitsRef = useRef<import('./types').WSSearchBreakdownHit[]>([]);
  const searchBreakdownGenerationRef = useRef(0);
  const searchBreakdownCleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const listGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const listCleanupRef = useRef<(() => void) | null>(null);
  const mutationCleanupRef = useRef<(() => void) | null>(null);

  const knownFilePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const memory of memories) {
      for (const anchor of memory.anchors ?? []) {
        if (anchor.type === 'file' && anchor.path) {
          paths.add(anchor.path);
        }
      }
    }
    return paths;
  }, [memories]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(baselineDraft),
    [baselineDraft, draft],
  );
  /**
   * Resolve a memory record by id across every surface the operator can
   * open one from. The paginated library list is primary, but search
   * breakdown hits and graph neighbors reference memories that may sit
   * outside the currently loaded page — without these fallbacks,
   * clicking such a result sets `selectedId` while `selectedMemory`
   * stays null and the detail panel never opens.
   */
  const resolveMemory = useCallback(
    (id: string): SageEntry | null =>
      memories.find((memory) => memory.id === id) ??
      searchBreakdown.hits.find((hit) => hit.memory.id === id)?.memory ??
      graphMemories.find((memory) => memory.id === id) ??
      (resolvedMemory?.id === id ? resolvedMemory : null),
    [graphMemories, memories, searchBreakdown.hits, resolvedMemory],
  );

  const selectedMemory = useMemo(
    () => (selectedId === null ? null : resolveMemory(selectedId)),
    [resolveMemory, selectedId],
  );

  const loadPage = useCallback(
    (cursor: string | null, includeStats: boolean) => {
      const isAppend = cursor !== null;
      const generation = ++listGenerationRef.current;
      listCleanupRef.current?.();
      setLoadError(null);
      if (isAppend) {
        setLoadingMore(true);
      } else {
        setRefreshing(true);
        if (!hasLoadedRef.current) setInitialLoading(true);
      }

      let off = () => {};
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        off();
        if (listCleanupRef.current === cleanup) listCleanupRef.current = null;
      };

      off = client.on('memory.sage.listPage', (message) => {
        if (generation !== listGenerationRef.current || !mountedRef.current) {
          cleanup();
          return;
        }
        cleanup();
        if (message.payload.error) {
          setLoadError(message.payload.error);
        } else {
          const page: SageEntry[] = message.payload.memories ?? [];
          setMemories((current) => (isAppend ? [...current, ...page] : page));
          setPageCursor(message.payload.nextCursor ?? null);
          setHasMore(Boolean(message.payload.nextCursor));
          const counts: Record<string, number> = message.payload.statusCounts ?? {};
          setStatusCounts(counts);
          const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
          if (message.payload.stats) {
            statsLoadedRef.current = true;
            setStats(message.payload.stats);
          } else {
            // A stats-less page (filter/search reload) leaves the store-wide
            // figures untouched; only synthesize them when none exist yet.
            setStats((prev) => prev ?? { total, byStatus: counts, byKind: {}, edges: 0 });
          }
          hasLoadedRef.current = true;
          if (!isAppend) {
            setSelectedId((current) => {
              if (!current) return null;
              if (page.some((memory) => memory.id === current)) return current;
              // Preserve selections backed by the search breakdown
              // panel — those memories legitimately live outside the
              // loaded page, and list responses racing a click would
              // otherwise wipe the just-opened detail.
              if (searchBreakdownHitsRef.current.some((hit) => hit.memory.id === current)) {
                return current;
              }
              if (resolvedMemoryRef.current?.id === current) return current;
              return null;
            });
          }
        }
        setInitialLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      });

      timeout = setTimeout(() => {
        if (generation !== listGenerationRef.current || !mountedRef.current) return;
        cleanup();
        setLoadError(
          'The memory store did not respond. Check the WebSocket connection and try again.',
        );
        setInitialLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }, 20_000);

      listCleanupRef.current = cleanup;
      // The status filter is applied by the server so it spans every page,
      // not just the rows already loaded. The Deleted tab pins `deleted`.
      const statuses = showDeleted
        ? ['deleted']
        : statusFilter !== 'all'
          ? [statusFilter]
          : undefined;
      listSageMemoriesPage(
        {
          limit: PAGE_SIZE,
          ...(statuses ? { statuses } : {}),
          ...(cursor ? { cursor } : {}),
          ...(listQuery ? { query: listQuery } : {}),
          ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
          ...(includeStats ? {} : { includeStats: false }),
        },
        { echoToChat: false },
      );
    },
    [client, kindFilter, listSageMemoriesPage, listQuery, showDeleted, statusFilter],
  );

  /** Full reload: initial load, explicit refresh, reconnect and post-mutation. */
  const loadMemories = useCallback(() => {
    setPageCursor(null);
    setHasMore(false);
    loadPage(null, true);
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || !pageCursor) return;
    loadPage(pageCursor, false);
  }, [loadPage, loadingMore, pageCursor]);

  /** Filter/search-driven reload: stats are only fetched until first received. */
  const reloadForFilters = useCallback(() => {
    setPageCursor(null);
    setHasMore(false);
    loadPage(null, !statsLoadedRef.current);
  }, [loadPage]);

  /**
   * Teardown that must run ONLY on unmount.
   *
   * It used to share an effect with the filter-driven reload, whose dependency
   * (`reloadForFilters`) changes on every status/kind/search change. The
   * cleanup therefore ran on each of those changes too, and it both bumped
   * `mutationGenerationRef` and tore down `mutationCleanupRef` — so a SAGE
   * mutation that was already in flight was silently discarded: its reply was
   * never handled, `setBusyAction(null)` never ran, and the editor stayed
   * disabled forever even though the server had already saved the memory.
   */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      listCleanupRef.current?.();
      mutationCleanupRef.current?.();
      searchBreakdownCleanupRef.current?.();
      resolveController.current?.abort();
    };
  }, []);

  /**
   * Filter/search-driven reload. Kept separate from the unmount teardown so a
   * list reload never supersedes an in-flight mutation.
   */
  useEffect(() => {
    reloadForFilters();
  }, [reloadForFilters]);

  // Trigger the per-channel search breakdown when the user types a
  // query. The hook races the response against a generation counter
  // so an in-flight request from a previous query never clobbers a
  // newer one. Empty query → reset to the empty state.
  useEffect(() => {
    if (sharedSearch) return;
    const query = searchQuery.trim();
    searchBreakdownCleanupRef.current?.();
    if (query.length === 0) {
      setSearchBreakdown({ hits: [], channel: undefined, loading: false, error: null });
      return;
    }
    const generation = ++searchBreakdownGenerationRef.current;
    setSearchBreakdown((prev) => ({ ...prev, loading: true, error: null }));
    let off = () => {};
    const cleanup = () => {
      if (searchBreakdownCleanupRef.current === cleanup) {
        searchBreakdownCleanupRef.current = null;
      }
      off();
    };
    searchBreakdownCleanupRef.current = cleanup;
    off = client.on(
      'memory.sage.searchBreakdown',
      (message: {
        payload: {
          hits?: import('./types').WSSearchBreakdownHit[];
          source?: 'breakdown' | 'lexical';
          error?: string;
        };
      }) => {
        if (generation !== searchBreakdownGenerationRef.current || !mountedRef.current) {
          cleanup();
          return;
        }
        cleanup();
        if (message.payload.error) {
          setSearchBreakdown({
            hits: [],
            channel: undefined,
            loading: false,
            error: message.payload.error,
          });
          return;
        }
        setSearchBreakdown({
          hits: message.payload.hits ?? [],
          channel: message.payload.source,
          loading: false,
          error: null,
        });
      },
    );
    searchSageBreakdown({ query, limit: 20 });
  }, [searchQuery, client, searchSageBreakdown, Boolean(sharedSearch)]);

  // Async handlers (e.g. the listPage response) need the latest search
  // hits without `loadPage` depending on them — a state dep would
  // recreate `loadPage` on every search response and re-trigger list
  // reloads for each keystroke.
  useEffect(() => {
    searchBreakdownHitsRef.current = searchBreakdown.hits;
  }, [searchBreakdown.hits]);

  useEffect(() => {
    setGraphEdges([]);
    setGraphMemories([]);
    setGraphError(null);
    if (!selectedId) {
      setGraphLoading(false);
      return;
    }
    const query = selectedId;
    setGraphLoading(true);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const off = client.on('memory.sage.graph', (message) => {
      if (message.payload.query !== query) return;
      if (timeout !== null) clearTimeout(timeout);
      setGraphEdges(message.payload.edges ?? []);
      setGraphMemories(message.payload.memories ?? []);
      setGraphError(message.payload.error ?? null);
      setGraphLoading(false);
    });
    timeout = setTimeout(() => {
      setGraphError('Relationship graph did not respond in time.');
      setGraphLoading(false);
    }, 15_000);
    getSageGraph(query, { maxDepth: 1, limit: 120 }, { echoToChat: false });
    return () => {
      if (timeout !== null) clearTimeout(timeout);
      off();
    };
  }, [client, getSageGraph, selectedId]);

  const wasConnectedRef = useRef(wsConnected);
  useEffect(() => {
    if (wsConnected && !wasConnectedRef.current && hasLoadedRef.current) loadMemories();
    wasConnectedRef.current = wsConnected;
  }, [loadMemories, wsConnected]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const confirmDiscard = useCallback(async () => {
    if (!dirty || (!editing && !creating)) return true;
    return confirmModal({
      title: t('activity:memoryManager.discardTitle', { defaultValue: 'Discard Unsaved Changes?' }),
      message: t('activity:memoryManager.discardConfirm', {
        defaultValue: 'Discard the unsaved memory changes? This cannot be undone.',
      }),
      confirmLabel: t('common:action.discard', { defaultValue: 'Discard' }),
      danger: true,
    });
  }, [creating, dirty, editing, t]);

  const openCreate = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    const next = emptyDraft();
    setDraft(next);
    setBaselineDraft(next);
    setCreating(true);
    setEditing(false);
    setSelectedId(null);
    setMutationError(null);
  }, [confirmDiscard]);

  const openMemory = useCallback(
    (id: string) => {
      const applySelection = () => {
        setSelectedId(id);
        setCreating(false);
        setEditing(false);
        setMutationError(null);
      };
      // Fast path: with nothing to discard, the selection must land in the
      // same click. `confirmDiscard` is async, so awaiting it unconditionally
      // deferred every selection by a microtask — clicking a list row or a
      // search-breakdown hit then opened the detail panel too late.
      if (!dirty || (!editing && !creating)) {
        applySelection();
        return;
      }
      void confirmDiscard().then((accepted) => {
        if (accepted) applySelection();
      });
    },
    [confirmDiscard, creating, dirty, editing],
  );

  /** Ranked results and vector links may point outside the loaded library page. */
  const openSearchMemory = useCallback(
    async (id: string): Promise<boolean> => {
      resolveController.current?.abort();
      const controller = new AbortController();
      resolveController.current = controller;
      setResolveError(null);
      try {
        const { memory } = await resolveSearchMemory(id, controller.signal);
        if (controller.signal.aborted) return false;
        resolvedMemoryRef.current = memory;
        setResolvedMemory(memory);
        openMemory(id);
        return true;
      } catch (error) {
        if (!controller.signal.aborted) {
          setResolveError(error instanceof Error ? error.message : String(error));
        }
        return false;
      }
    },
    [openMemory],
  );

  const openEdit = useCallback(
    (id?: string) => {
      const target = id !== undefined ? resolveMemory(id) : selectedMemory;
      if (!target || target.status === 'deleted') return;
      if (id !== undefined) setSelectedId(id);
      const next = draftFromMemory(target);
      setDraft(next);
      setBaselineDraft(next);
      setEditing(true);
      setCreating(false);
      setMutationError(null);
    },
    [resolveMemory, selectedMemory],
  );

  const cancelEditor = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    setEditing(false);
    setCreating(false);
    setMutationError(null);
  }, [confirmDiscard]);
  const { submitCreate, submitUpdate } = useMemoryMutations({
    draft,
    setMutationError,
    mutationGenerationRef,
    mutationCleanupRef,
    setBusyAction,
    setNotice,
    mountedRef,
    setMemories,
    setSelectedId,
    setCreating,
    setEditing,
    t,
    loadMemories,
    client,
    rememberSage,
    selectedMemory,
    updateSage,
  });

  /**
   * Open the delete confirmation for `id`. Resets `neverInject` on the way in
   * so a previous "factually wrong" choice can never leak into a later,
   * unrelated delete of a merely-outdated memory.
   */
  const openDeleteDialog = useCallback((id: string) => {
    setNeverInject(false);
    setDeletingId(id);
  }, []);

  /**
   * Dismiss the delete confirmation. Ignored mid-flight so an in-progress
   * delete cannot be orphaned by the dialog closing underneath it.
   */
  const cancelDelete = useCallback(() => {
    if (busyAction === 'delete') return;
    setNeverInject(false);
    setDeletingId(null);
  }, [busyAction]);

  const confirmDelete = useCallback(() => {
    if (!deletingId) return;
    const generation = ++mutationGenerationRef.current;
    mutationCleanupRef.current?.();
    setBusyAction('delete');
    setMutationError(null);

    let off = () => {};
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      off();
      if (mutationCleanupRef.current === cleanup) mutationCleanupRef.current = null;
    };

    off = client.on('memory.sage.delete', (message) => {
      if (generation !== mutationGenerationRef.current || !mountedRef.current) {
        cleanup();
        return;
      }
      cleanup();
      setBusyAction(null);
      if (!message.payload.success) {
        setMutationError(message.payload.message || 'Delete failed.');
        return;
      }
      setDeletingId(null);
      setSelectedId(null);
      setEditing(false);
      setNotice('Memory deleted and relationship edges cleaned up.');
      loadMemories();
    });
    timeout = setTimeout(() => {
      if (generation !== mutationGenerationRef.current || !mountedRef.current) return;
      cleanup();
      setBusyAction(null);
      setMutationError('Delete timed out. The memory may still exist; refresh to confirm.');
    }, 20_000);
    mutationCleanupRef.current = cleanup;
    deleteSage(deletingId, 'Deleted from the WebUI Memory Manager.', { neverInject });
  }, [client, deleteSage, deletingId, loadMemories, neverInject]);

  const sendWithAck = useSendWithAck({
    client,
    mutationGenerationRef,
    mutationCleanupRef,
    mountedRef,
    setMutationError,
  });

  const filteredMemories = useMemo(
    () =>
      filterMemories(memories, {
        searchQuery,
        statusFilter: effectiveStatusFilter,
        kindFilter,
        tagFilter,
        audienceOnly,
      }),
    [audienceOnly, effectiveStatusFilter, kindFilter, memories, searchQuery, tagFilter],
  );

  const allTags = useMemo(() => collectMemoryTags(memories), [memories]);
  const relatedMemories = useMemo(() => selectRelatedMemories(selectedMemory), [selectedMemory]);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setStatusFilter('all');
    setKindFilter('all');
    setAudienceOnly(false);
    setTagFilter(null);
  }, []);

  const hasFilters = Boolean(
    searchQuery || statusFilter !== 'all' || kindFilter !== 'all' || tagFilter || audienceOnly,
  );
  const detailOpen = creating || Boolean(selectedMemory);
  const drawerActive = drawerOpen && Boolean(currentFilePath);

  return {
    client,
    wsConnected,
    memories,
    stats,
    initialLoading,
    refreshing,
    loadError,
    mutationError,
    setMutationError,
    notice,
    setNotice,
    selectedId,
    setSelectedId,
    selectedMemory,
    resolveMemory,
    openSearchMemory,
    resolveError,
    graphEdges,
    graphMemories,
    graphError,
    graphLoading,
    editing,
    creating,
    draft,
    setDraft,
    busyAction,
    deletingId,
    setDeletingId,
    openDeleteDialog,
    cancelDelete,
    neverInject,
    setNeverInject,
    searchQuery,
    setSearchQuery,
    searchBreakdown,
    clearSearchBreakdown: () => {
      searchBreakdownGenerationRef.current += 1;
      searchBreakdownCleanupRef.current?.();
      setSearchBreakdown({ hits: [], channel: undefined, loading: false, error: null });
    },
    statusFilter,
    setStatusFilter,
    kindFilter,
    setKindFilter,
    audienceOnly,
    setAudienceOnly,
    tagFilter,
    setTagFilter,
    libraryView,
    setLibraryView,
    showDeleted,
    showReview,
    hasMore,
    loadingMore,
    statusCounts,
    drawerOpen,
    setDrawerOpen,
    currentFilePath,
    setCurrentFilePath,
    knownFilePaths,
    filteredMemories,
    allTags,
    relatedMemories,
    hasFilters,
    detailOpen,
    drawerActive,
    loadMemories,
    loadMore,
    openCreate,
    openMemory,
    openEdit,
    cancelEditor,
    submitCreate,
    submitUpdate,
    confirmDelete,
    sendWithAck,
    clearFilters,
    resolveMemoryCandidate,
    updateSage,
    recoverSage,
    listMemoryCandidates,
    sageDoctor,
  };
}
