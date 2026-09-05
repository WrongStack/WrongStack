import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { useConfigStore } from '@/stores';
import type { SageEntry, SageGraphEdge, SageStats, SageStatus } from '@/types';
import { collectMemoryTags, filterMemories, selectRelatedMemories } from './selectors';
import type { MemoryDraft } from './shared';
import { draftFromMemory, emptyDraft, normalizeAnchors, splitList } from './shared';

const PAGE_SIZE = 100;

export function useMemoryManagerState() {
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
  } = useWebSocket();
  const wsConnected = useConfigStore((state) => state.wsConnected);

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
   * Per-channel score breakdown for the active search query. Populated
   * by `searchSageBreakdown` whenever the user types a query into the
   * memory search box. The MemoryManager renders this as a row of
   * cards above the regular list — the operator sees which channel
   * matched and how much each one contributed.
   */
  const [searchBreakdown, setSearchBreakdown] = useState<{
    hits: import('@/types/sage').WSSearchBreakdownHit[];
    channel: 'breakdown' | 'lexical' | undefined;
    loading: boolean;
    error: string | null;
  }>({ hits: [], channel: undefined, loading: false, error: null });
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SageStatus>('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [audienceOnly, setAudienceOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [libraryView, setLibraryView] = useState<'active' | 'deleted' | 'review'>('active');
  const showDeleted = libraryView === 'deleted';
  const showReview = libraryView === 'review';
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);

  const hasLoadedRef = useRef(false);
  const searchBreakdownHitsRef = useRef<import('@/types/sage').WSSearchBreakdownHit[]>([]);
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
      null,
    [graphMemories, memories, searchBreakdown.hits],
  );

  const selectedMemory = useMemo(
    () => (selectedId === null ? null : resolveMemory(selectedId)),
    [resolveMemory, selectedId],
  );

  const loadPage = useCallback(
    (cursor: string | null) => {
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
          const page = message.payload.memories ?? [];
          setMemories((current) => (isAppend ? [...current, ...page] : page));
          setPageCursor(message.payload.nextCursor ?? null);
          setHasMore(Boolean(message.payload.nextCursor));
          const counts = message.payload.statusCounts ?? {};
          setStatusCounts(counts);
          const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
          if (message.payload.stats) {
            setStats(message.payload.stats);
          } else {
            setStats((prev) => ({
              total,
              byStatus: counts,
              byKind: prev?.byKind ?? {},
              edges: prev?.edges ?? 0,
            }));
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
      listSageMemoriesPage(
        {
          limit: PAGE_SIZE,
          ...(showDeleted ? { statuses: ['deleted'] } : {}),
          ...(cursor ? { cursor } : {}),
          ...(searchQuery.trim() ? { query: searchQuery.trim() } : {}),
          ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
        },
        { echoToChat: false },
      );
    },
    [client, kindFilter, listSageMemoriesPage, searchQuery, showDeleted],
  );

  const loadMemories = useCallback(() => {
    setPageCursor(null);
    setHasMore(false);
    loadPage(null);
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || !pageCursor) return;
    loadPage(pageCursor);
  }, [loadPage, loadingMore, pageCursor]);

  useEffect(() => {
    mountedRef.current = true;
    loadMemories();
    return () => {
      mountedRef.current = false;
      listGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      listCleanupRef.current?.();
      mutationCleanupRef.current?.();
      searchBreakdownCleanupRef.current?.();
    };
  }, [loadMemories]);

  // Trigger the per-channel search breakdown when the user types a
  // query. The hook races the response against a generation counter
  // so an in-flight request from a previous query never clobbers a
  // newer one. Empty query → reset to the empty state.
  useEffect(() => {
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
          hits?: import('@/types/sage').WSSearchBreakdownHit[];
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
  }, [searchQuery, client, searchSageBreakdown]);

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

  const confirmDiscard = useCallback(() => {
    if (!dirty || (!editing && !creating)) return true;
    return window.confirm('Discard the unsaved memory changes?');
  }, [creating, dirty, editing]);

  const openCreate = useCallback(() => {
    if (!confirmDiscard()) return;
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
      if (!confirmDiscard()) return;
      setSelectedId(id);
      setCreating(false);
      setEditing(false);
      setMutationError(null);
    },
    [confirmDiscard],
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

  const cancelEditor = useCallback(() => {
    if (!confirmDiscard()) return;
    setEditing(false);
    setCreating(false);
    setMutationError(null);
  }, [confirmDiscard]);

  const runMutation = useCallback(
    (
      type: 'memory.sage.remember' | 'memory.sage.update',
      send: () => void,
      action: 'create' | 'update',
    ) => {
      if (!draft.text.trim()) {
        setMutationError('Memory content is required.');
        return;
      }
      const generation = ++mutationGenerationRef.current;
      mutationCleanupRef.current?.();
      setBusyAction(action);
      setMutationError(null);
      setNotice(null);

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

      const onResponse = (message: {
        payload: { memory?: SageEntry | undefined; error?: string | undefined };
      }) => {
        if (generation !== mutationGenerationRef.current || !mountedRef.current) {
          cleanup();
          return;
        }
        cleanup();
        setBusyAction(null);
        if (message.payload.error || !message.payload.memory) {
          setMutationError(message.payload.error ?? 'The server returned no memory record.');
          return;
        }
        const saved = message.payload.memory;
        setMemories((current) => {
          const without = current.filter((memory) => memory.id !== saved.id);
          return [saved, ...without];
        });
        setSelectedId(saved.id);
        setCreating(false);
        setEditing(false);
        setNotice(
          action === 'create'
            ? t('activity:memoryManager.memoryCaptured')
            : t('activity:memoryManager.memoryUpdated'),
        );
        loadMemories();
      };

      if (type === 'memory.sage.remember') {
        off = client.on('memory.sage.remember', onResponse);
      } else {
        off = client.on('memory.sage.update', onResponse);
      }
      timeout = setTimeout(() => {
        if (generation !== mutationGenerationRef.current || !mountedRef.current) return;
        cleanup();
        setBusyAction(null);
        setMutationError(
          t('activity:memoryManager.mutationTimeout', {
            verb:
              action === 'create'
                ? t('activity:memoryManager.createAction')
                : t('common:action.save'),
          }),
        );
      }, 20_000);
      mutationCleanupRef.current = cleanup;
      send();
    },
    [client, draft.text, loadMemories, t],
  );

  const submitCreate = useCallback(() => {
    runMutation(
      'memory.sage.remember',
      () =>
        rememberSage(
          {
            text: draft.text.trim(),
            kind: draft.kind,
            scope: draft.scope,
            tags: splitList(draft.tags),
            importance: draft.importance,
            confidence: draft.confidence,
            freshness: draft.freshness,
            anchors: normalizeAnchors(draft.anchors),
            ...(splitList(draft.audienceRoles).length ||
            splitList(draft.audienceTaskTypes).length ||
            splitList(draft.audienceModes).length
              ? {
                  audience: {
                    roles: splitList(draft.audienceRoles),
                    taskTypes: splitList(draft.audienceTaskTypes),
                    modes: splitList(draft.audienceModes),
                  },
                }
              : {}),
            supersedes: splitList(draft.supersedes),
            contradicts: splitList(draft.contradicts),
          },
          { echoToChat: false },
        ),
      'create',
    );
  }, [draft, rememberSage, runMutation]);

  const submitUpdate = useCallback(() => {
    if (!selectedMemory) return;
    runMutation(
      'memory.sage.update',
      () =>
        updateSage(
          selectedMemory.id,
          {
            text: draft.text.trim(),
            kind: draft.kind,
            status: draft.status,
            tags: splitList(draft.tags),
            importance: draft.importance,
            confidence: draft.confidence,
            freshness: draft.freshness,
            anchors: normalizeAnchors(draft.anchors),
            ...(splitList(draft.audienceRoles).length ||
            splitList(draft.audienceTaskTypes).length ||
            splitList(draft.audienceModes).length
              ? {
                  audience: {
                    roles: splitList(draft.audienceRoles),
                    taskTypes: splitList(draft.audienceTaskTypes),
                    modes: splitList(draft.audienceModes),
                  },
                }
              : {}),
            supersedes: splitList(draft.supersedes),
            contradicts: splitList(draft.contradicts),
          },
          { echoToChat: false },
        ),
      'update',
    );
  }, [draft, runMutation, selectedMemory, updateSage]);

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
    deleteSage(deletingId, 'Deleted from the WebUI Memory Manager.');
  }, [client, deleteSage, deletingId, loadMemories]);

  const sendWithAck = useCallback(
    (
      type: 'memory.sage.candidateResolve' | 'memory.sage.recover' | 'memory.sage.update',
      send: () => void,
      onResponse: (payload: { error?: string | undefined; memory?: SageEntry | undefined }) => void,
    ) => {
      const generation = ++mutationGenerationRef.current;
      mutationCleanupRef.current?.();
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

      off = client.on(type, (message) => {
        if (generation !== mutationGenerationRef.current || !mountedRef.current) {
          cleanup();
          return;
        }
        cleanup();
        onResponse(message.payload);
      });

      timeout = setTimeout(() => {
        if (generation !== mutationGenerationRef.current || !mountedRef.current) return;
        cleanup();
        setMutationError(
          'The memory store did not respond. Check the WebSocket connection and try again.',
        );
      }, 20_000);

      mutationCleanupRef.current = cleanup;
      send();
    },
    [client],
  );

  const filteredMemories = useMemo(
    () =>
      filterMemories(memories, {
        searchQuery,
        statusFilter,
        kindFilter,
        tagFilter,
        audienceOnly,
      }),
    [audienceOnly, kindFilter, memories, searchQuery, statusFilter, tagFilter],
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
  };
}
