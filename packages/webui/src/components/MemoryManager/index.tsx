import {
  AlertTriangle,
  ArrowLeft,
  BrainCircuit,
  Check,
  PanelRight,
  PanelRightOpen,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore, useUIStore } from '@/stores';
import type { SageEntry, SageGraphEdge, SageStats, SageStatus } from '@/types';
import { DeleteMemoryDialog } from './DeleteMemoryDialog';
import { MemoryDetail } from './MemoryDetail';
import { MemoryDrawer } from './MemoryDrawer';
import { MemoryEditor } from './MemoryEditor';
import { MemoryFilters } from './MemoryFilters';
import { MemoryList } from './MemoryList';
import { MemoryManagerEmpty } from './MemoryManagerEmpty';
import { collectMemoryTags, filterMemories, selectRelatedMemories } from './selectors';
import type { MemoryDraft } from './shared';
import { draftFromMemory, emptyDraft, MetricCard, normalizeAnchors, splitList } from './shared';

export function MemoryManager() {
  const { t } = useAppTranslation();
  const {
    client,
    listSageMemoriesPage,
    rememberSage,
    updateSage,
    deleteSage,
    getSageGraph,
    recoverSage,
    resolveMemoryCandidate,
  } = useWebSocket();
  const wsConnected = useConfigStore((state) => state.wsConnected);
  const setCurrentView = useUIStore((state) => state.setCurrentView);
  const memoryListRef = useScrollPosition<HTMLDivElement>('memory');

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
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | SageStatus>('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [audienceOnly, setAudienceOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // Paginated "Active" vs "Deleted" views. The default view excludes deleted
  // memories (which accumulate as a soft-delete audit trail and can number in
  // the thousands); the Deleted tab requests them explicitly, one page at a time.
  const [showDeleted, setShowDeleted] = useState(false);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const PAGE_SIZE = 100;
  // PR #4 file-drawer state. `currentFilePath` is set externally (e.g. from
  // the file editor) — when non-null and `drawerOpen=true`, the right-hand
  // panel renders `MemoryDrawer` instead of `MemoryDetail`. This keeps the
  // MemoryManager responsive to any caller that wants to surface file-scoped
  // memories without forcing the MemoryManager to know about file context.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);

  const hasLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  const listGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const listCleanupRef = useRef<(() => void) | null>(null);
  const mutationCleanupRef = useRef<(() => void) | null>(null);

  // Derive the set of file paths anchored by any loaded memory. Drives the
  // `<datalist>` for the file-drawer selector: every entry is a known good
  // path; free-typed values that don't match leave the existing selection
  // alone so the user can keep editing without losing context.
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
  const selectedMemory = useMemo(
    () => memories.find((memory) => memory.id === selectedId) ?? null,
    [memories, selectedId],
  );

  /**
   * Load one page of memories from the paginated backend endpoint.
   * - `cursor` omitted → fresh load (replaces the list); provided → append.
   * The "Deleted" tab requests `statuses: ['deleted']`; the default view lets
   * the backend exclude deleted memories entirely.
   */
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
          // Derive the stats banner from the whole-store status counts so it stays
          // accurate even though we only hold one page in memory.
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
            setSelectedId((current) =>
              current && page.some((memory) => memory.id === current) ? current : null,
            );
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
        },
        { echoToChat: false },
      );
    },
    [client, listSageMemoriesPage, showDeleted],
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
    };
  }, [loadMemories]);

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
      // When an explicit id is given (drawer "Update"), resolve the target
      // record directly instead of reading `selectedMemory` from this
      // closure — the previous code called `setSelectedId(id)` and then
      // `openEdit()` in the same tick, so the editor drafted the *old*
      // selection and `submitUpdate` later wrote that draft to the *new*
      // record's id (silent wrong-record overwrite).
      const target =
        id !== undefined ? (memories.find((memory) => memory.id === id) ?? null) : selectedMemory;
      if (!target || target.status === 'deleted') return;
      if (id !== undefined) setSelectedId(id);
      const next = draftFromMemory(target);
      setDraft(next);
      setBaselineDraft(next);
      setEditing(true);
      setCreating(false);
      setMutationError(null);
    },
    [memories, selectedMemory],
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

  /**
   * Settle a fire-and-forget WS action from the server's acknowledgement
   * instead of a fixed timer. `updateSage`/`resolveMemoryCandidate`/
   * `recoverSage` all return `void` (they only send), so `await`-ing them
   * can never observe a server error. This registers a typed response
   * listener guarded by the mutation generation counter; the listener is
   * removed on response, timeout, or unmount (via `mutationCleanupRef`).
   */
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

  // The drawer takes precedence over the detail view: when a file is open
  // and the drawer is toggled, it consumes the right-hand column. Toggling
  // back to `drawerOpen=false` restores the detail panel.
  const drawerActive = drawerOpen && Boolean(currentFilePath);

  if (initialLoading && memories.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background" aria-busy="true">
        <div className="border-b border-border/70 bg-card/70 px-5 py-4">
          <div className="h-3 w-28 animate-pulse bg-muted" />
          <div className="mt-3 h-7 w-56 animate-pulse bg-muted" />
        </div>
        <div className="grid flex-1 gap-px bg-border/60 md:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.35fr)]">
          <div className="space-y-px bg-background p-4">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} className="h-24 animate-pulse border border-border/60 bg-card/45" />
            ))}
          </div>
          <div className="hidden bg-background p-6 md:block">
            <div className="h-full animate-pulse border border-border/60 bg-card/35" />
          </div>
        </div>
        <span className="sr-only" role="status">
          {t('activity:memoryManager.loadingSageContent')}
        </span>
      </div>
    );
  }

  if (loadError && memories.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background p-6">
        <div className="max-w-md border border-destructive/35 bg-card p-6 shadow-2xl">
          <span className="flex size-11 items-center justify-center border border-destructive/35 bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </span>
          <h2 className="mt-4 text-lg font-bold">{t('activity:memoryManager.storeUnavailable')}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{loadError}</p>
          <div className="mt-5 flex gap-2">
            <Button onClick={loadMemories}>
              <RefreshCw className="size-4" /> {t('common:action.retry')}
            </Button>
            <Button variant="outline" onClick={() => setCurrentView('chat')}>
              <ArrowLeft className="size-4" /> {t('activity:memoryManager.backToChat')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="relative shrink-0 overflow-hidden border-b border-border/70 bg-card/72 px-4 py-3 backdrop-blur-xl sm:px-5">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_right,hsl(var(--info)/0.11),transparent_68%)]" />
        <div className="relative flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCurrentView('chat')}
            aria-label={t('activity:memoryManager.backToChat')}
            title={t('activity:memoryManager.backToChat')}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <span className="flex size-10 items-center justify-center border border-info/40 bg-info/10 text-info shadow-[0_0_20px_hsl(var(--info)/0.12)]">
            <BrainCircuit className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-bold sm:text-lg">
                {t('activity:memoryManager.sageHeading')}
              </h1>
              <span className="border border-success/35 bg-success/10 px-2 py-0.5 font-mono text-[9px] font-bold uppercase text-success">
                {t('activity:memoryManager.projectKnowledge')}
              </span>
            </div>
            <p className="mt-0.5 max-w-2xl text-[10px] text-muted-foreground sm:text-xs">
              {t('activity:memoryManager.sageSubtitle')}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn(
                'hidden items-center gap-1.5 border px-2 py-1 font-mono text-[9px] uppercase sm:flex',
                wsConnected ? 'border-success/30 text-success' : 'border-warning/30 text-warning',
              )}
            >
              <span className="size-1.5 bg-current" />{' '}
              {wsConnected
                ? t('activity:memoryManager.liveStore')
                : t('activity:memoryManager.reconnecting')}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={loadMemories}
              disabled={refreshing}
              aria-label={t('activity:memoryManager.refreshAria')}
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
              <span className="hidden sm:inline">{t('common:action.refresh')}</span>
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-3.5" /> {t('activity:memoryManager.newMemory')}
            </Button>
          </div>
        </div>
      </header>

      <div className="grid shrink-0 grid-cols-2 gap-px border-b border-border/70 bg-border/60 sm:grid-cols-4">
        <MetricCard
          label={t('activity:memoryManager.tabMemories')}
          value={stats?.total ?? memories.length}
          hint={`${filteredMemories.length} visible`}
        />
        <MetricCard
          label={t('activity:memoryManager.tabActive')}
          value={
            stats?.byStatus.active ?? memories.filter((memory) => memory.status === 'active').length
          }
          hint="retrievable"
          tone="success"
        />
        <MetricCard
          label={t('activity:memoryManager.tabNeedsReview')}
          value={(stats?.byStatus.stale ?? 0) + (stats?.byStatus.contradicted ?? 0)}
          hint={t('activity:memoryManager.staleConflicts')}
          tone="warning"
        />
        <div className="hidden sm:block">
          <MetricCard
            label={t('activity:memoryManager.tabGraphEdges')}
            value={stats?.edges ?? 0}
            hint={`${allTags.length} tags`}
            tone="info"
          />
        </div>
      </div>

      {(() => {
        const scopedCount = memories.filter((m) => m.audience).length;
        if (scopedCount === 0) return null;
        const roles = new Set<string>();
        for (const m of memories) {
          if (!m.audience) continue;
          for (const r of m.audience.roles ?? []) roles.add(r);
          for (const r of m.audience.taskTypes ?? []) roles.add(r);
          for (const r of m.audience.modes ?? []) roles.add(r);
        }
        return (
          <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-primary/5 px-4 py-1.5">
            <BrainCircuit className="size-3.5 text-primary" />
            <span className="text-[11px] font-medium text-primary">
              {scopedCount} audience-scoped memory{scopedCount !== 1 ? 'ies' : ''}
            </span>
            {roles.size > 0 && (
              <span className="text-[10px] text-muted-foreground">
                ({[...roles].sort().join(', ')})
              </span>
            )}
          </div>
        );
      })()}

      {(notice || loadError || mutationError) && (
        <div className="shrink-0 border-b border-border/70 px-4 py-2" aria-live="polite">
          {notice && (
            <div role="status" className="flex items-center gap-2 text-xs text-success">
              <Check className="size-3.5" /> {notice}
            </div>
          )}
          {loadError && (
            <div role="alert" className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle className="size-3.5" /> {loadError} Existing content remains available.
            </div>
          )}
          {mutationError && !editing && !creating && (
            <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="size-3.5" /> {mutationError}
            </div>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.35fr)]">
        <section
          className={cn(
            'min-h-0 border-r border-border/70 bg-card/25',
            detailOpen ? 'hidden md:flex md:flex-col' : 'flex flex-col',
          )}
          aria-label={t('activity:memoryManager.libraryAria')}
        >
          {/* Active / Deleted view tabs. The Deleted tab is a separate paginated
              query so the soft-delete audit trail never floods the main list. */}
          <div
            className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 pt-1"
            role="tablist"
            aria-label={t('activity:memoryManager.viewAria')}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={!showDeleted}
              onClick={() => {
                if (!showDeleted) return;
                setShowDeleted(false);
              }}
              className={cn(
                'h-7 rounded-b-none border-b-2 px-3 text-[11px]',
                !showDeleted
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              {t('activity:memoryManager.tabActive')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={showDeleted}
              onClick={() => {
                if (showDeleted) return;
                setShowDeleted(true);
              }}
              className={cn(
                'h-7 rounded-b-none border-b-2 px-3 text-[11px]',
                showDeleted
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              {t('activity:memoryManager.tabDeleted')}
              {typeof statusCounts['deleted'] === 'number' ? ` (${statusCounts['deleted']})` : ''}
            </Button>
          </div>

          <MemoryFilters
            searchQuery={searchQuery}
            statusFilter={statusFilter}
            kindFilter={kindFilter}
            audienceOnly={audienceOnly}
            tagFilter={tagFilter}
            hasFilters={hasFilters}
            allTags={allTags}
            stats={stats}
            onSearchChange={setSearchQuery}
            onStatusFilterChange={setStatusFilter}
            onKindFilterChange={setKindFilter}
            onToggleAudienceOnly={() => setAudienceOnly((v) => !v)}
            onTagFilterChange={setTagFilter}
            onClearFilters={clearFilters}
          />
          <MemoryList
            memoryListRef={memoryListRef}
            memories={memories}
            filteredMemories={filteredMemories}
            selectedId={selectedId}
            onSelectMemory={openMemory}
            onOpenCreate={openCreate}
            onClearFilters={clearFilters}
          />
          {hasMore ? (
            <div className="shrink-0 border-t border-border/60 p-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
                className="h-7 w-full text-[11px]"
              >
                {loadingMore ? t('common:action.loading') : `Load more (${memories.length} loaded)`}
              </Button>
            </div>
          ) : null}
        </section>

        <section
          className={cn(
            'min-h-0 bg-background',
            detailOpen ? 'flex flex-col' : 'hidden md:flex md:flex-col',
          )}
          aria-label={t('activity:memoryManager.detailAria')}
        >
          {/* File drawer toolbar — lives in the right rail so it doesn't
              consume vertical space in the memory list above. Only rendered
              when at least one memory in the current page has a file anchor
              (the drawer is meaningless without one). */}
          {memories.some((memory) =>
            (memory.anchors ?? []).some((anchor) => anchor.type === 'file' && anchor.path),
          ) && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-card/30 px-3 py-1.5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('activity:memoryManager.fileDrawerLabel')}
              </span>
              <input
                type="text"
                list="memory-drawer-file-list"
                value={currentFilePath ?? ''}
                onChange={(e) => {
                  const next = e.target.value.trim() || null;
                  // Only auto-open the drawer when the typed value exactly
                  // matches a known anchor path. Free-typed non-matching
                  // values leave `currentFilePath` untouched so the user
                  // keeps their previous valid selection while editing.
                  if (next && knownFilePaths.has(next)) {
                    setCurrentFilePath(next);
                    setDrawerOpen(true);
                  } else if (!next) {
                    setCurrentFilePath(null);
                  } else {
                    setCurrentFilePath(next);
                  }
                }}
                placeholder={t('activity:memoryManager.selectFilePlaceholder')}
                className="min-w-0 max-w-[260px] flex-1 truncate rounded-sm border border-border/60 bg-background px-1.5 py-0.5 text-[10px] font-mono"
                aria-label={t('activity:memoryManager.fileForDrawerAria')}
                data-testid="memory-drawer-file-select"
              />
              <datalist id="memory-drawer-file-list">
                {[...knownFilePaths].sort().map((path) => (
                  <option key={path} value={path} />
                ))}
              </datalist>
              <Button
                type="button"
                size="sm"
                variant={drawerActive ? 'default' : 'outline'}
                onClick={() => {
                  if (!currentFilePath) return;
                  setDrawerOpen((prev) => !prev);
                }}
                disabled={!currentFilePath}
                className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                aria-pressed={drawerActive}
                title={
                  drawerActive
                    ? t('activity:memoryManager.hideFileDrawer')
                    : t('activity:memoryManager.showFileDrawer')
                }
              >
                {drawerActive ? (
                  <PanelRightOpen className="size-3" />
                ) : (
                  <PanelRight className="size-3" />
                )}
                {drawerActive
                  ? t('activity:memoryManager.hideDrawer')
                  : t('activity:memoryManager.showDrawer')}
              </Button>
            </div>
          )}
          {creating ? (
            <MemoryEditor
              mode="create"
              draft={draft}
              busy={busyAction === 'create'}
              error={mutationError}
              onChange={setDraft}
              onCancel={cancelEditor}
              onSubmit={submitCreate}
            />
          ) : selectedMemory ? (
            editing ? (
              <MemoryEditor
                mode="edit"
                draft={draft}
                busy={busyAction === 'update'}
                error={mutationError}
                onChange={setDraft}
                onCancel={cancelEditor}
                onSubmit={submitUpdate}
              />
            ) : drawerActive ? (
              <MemoryDrawer
                filePath={currentFilePath}
                open={drawerActive}
                onClose={() => setDrawerOpen(false)}
                onShowMemory={(id) => setSelectedId(id)}
                onAcceptDeletion={(candidateId, memoryId) => {
                  // PR #1: resolve candidate as accept → server deletes the
                  // source memory + marks the candidate accepted (audit-logged).
                  // Settle on the server ack (not a fixed timer) so failures
                  // surface in the panel and the reload can't race the write.
                  sendWithAck(
                    'memory.sage.candidateResolve',
                    () => resolveMemoryCandidate({ candidateId, action: 'accept' }),
                    (payload) => {
                      if (payload.error) {
                        setMutationError(payload.error);
                        return;
                      }
                      setNotice(
                        `Accepted hygiene review for ${memoryId.slice(0, 12)}… ` +
                          `(candidate ${candidateId.slice(0, 12)}…).`,
                      );
                      loadMemories();
                    },
                  );
                }}
                onKeep={(candidateId, memoryId) => {
                  // PR #1: reject candidate → server keeps the memory and
                  // marks the candidate rejected. Reload after the ack so
                  // the list reflects the resolved candidate.
                  sendWithAck(
                    'memory.sage.candidateResolve',
                    () => resolveMemoryCandidate({ candidateId, action: 'reject' }),
                    (payload) => {
                      if (payload.error) {
                        setMutationError(payload.error);
                        return;
                      }
                      setNotice(
                        `Kept ${memoryId.slice(0, 12)}… ` +
                          `(candidate ${candidateId.slice(0, 12)}… rejected).`,
                      );
                      loadMemories();
                    },
                  );
                }}
                onUpdate={(memoryId) => {
                  // Re-use the existing memory-editor flow. Passing the id
                  // lets `openEdit` draft from the target record instead of
                  // the pre-commit `selectedMemory` closure.
                  openEdit(memoryId);
                }}
                onMarkPermanent={(memoryId) => {
                  // `updateSage` is a fire-and-forget send; the server
                  // replies on `memory.sage.update`. Settle on that ack so
                  // a failed promote shows an error instead of a false
                  // success notice.
                  sendWithAck(
                    'memory.sage.update',
                    () => updateSage(memoryId, { persistence: 'permanent' }),
                    (payload) => {
                      if (payload.error || !payload.memory) {
                        setMutationError(payload.error ?? 'The server returned no memory record.');
                        return;
                      }
                      setNotice(`Memory ${memoryId.slice(0, 12)}… promoted to permanent.`);
                      loadMemories();
                    },
                  );
                }}
                onRecover={(memoryId) => {
                  // PR #1: restore `deleted` memory to active status. The
                  // server replies with `memory.sage.recover` carrying the
                  // restored entry (or `noop: true` if it was already
                  // active). Settle on that ack, then reload.
                  sendWithAck(
                    'memory.sage.recover',
                    () => recoverSage({ id: memoryId, reason: 'recovered via file drawer' }),
                    (payload) => {
                      if (payload.error) {
                        setMutationError(payload.error);
                        return;
                      }
                      setNotice(`Recovered ${memoryId.slice(0, 12)}…`);
                      loadMemories();
                    },
                  );
                }}
              />
            ) : (
              <MemoryDetail
                memory={selectedMemory}
                allMemories={[...memories, ...graphMemories]}
                relatedMemories={relatedMemories}
                graphEdges={graphEdges}
                graphLoading={graphLoading}
                graphError={graphError}
                onClose={() => setSelectedId(null)}
                onOpenMemory={openMemory}
                onEdit={openEdit}
                onDelete={() => setDeletingId(selectedMemory.id)}
                onTagSelect={(tag) => {
                  setTagFilter(tag);
                  setSelectedId(null);
                }}
                onNotice={setNotice}
              />
            )
          ) : (
            <MemoryManagerEmpty onCapture={openCreate} />
          )}
        </section>
      </div>

      <DeleteMemoryDialog
        busyAction={busyAction}
        deletingId={deletingId}
        memories={memories}
        onCancel={() => setDeletingId(null)}
        onConfirm={confirmDelete}
        onOpenChange={(open) => {
          if (!open && busyAction !== 'delete') setDeletingId(null);
        }}
      />
    </div>
  );
}
