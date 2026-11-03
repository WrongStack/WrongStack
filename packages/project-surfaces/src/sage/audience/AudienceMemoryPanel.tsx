import { Download, Filter, Plus, RefreshCw, Search, Tag, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSurfaceHost } from '../../host';
import { useAppTranslation } from '../../lib/i18n';
import { usePagination } from '../../lib/usePagination';
import { cn } from '../../lib/utils';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Pagination } from '../../ui/pagination';
import type { SageEntry } from '../model-types';
/**
 * AudienceMemoryPanel — browse and manage audience-scoped project memories.
 *
 * The panel deliberately stays focused on routing: it summarizes selectors,
 * searches across every audience dimension, and provides safe create/import/
 * un-scope/delete workflows without duplicating the full Memory Manager editor.
 */
import { MEMORY_KINDS, memoryPreview } from '../shared';
import type { MemoryAudience } from './audience-memory-card.js';
import {
  AudienceMemoryCard,
  AudienceMemorySkeleton,
  AudienceStat,
  EmptyAudienceMemory,
} from './audience-memory-card.js';
import type { CreateEntry } from './audience-memory-dialogs.js';
import {
  CreateAudienceMemoryDialog,
  ImportAudienceMemoryDialog,
} from './audience-memory-dialogs.js';

type Feedback = { tone: 'error' | 'success'; text: string };

interface ImportedEntry {
  text: string;
  kind?: string | undefined;
  tags?: string[] | undefined;
  audience: MemoryAudience;
  importance?: number | undefined;
  confidence?: number | undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeAudience(value: unknown): MemoryAudience | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const audience: MemoryAudience = {
    roles: cleanStringArray(source['roles']),
    taskTypes: cleanStringArray(source['taskTypes']),
    modes: cleanStringArray(source['modes']),
  };
  return audience.roles || audience.taskTypes || audience.modes ? audience : undefined;
}

function parseImport(raw: string): { entries: ImportedEntry[]; skipped: number } {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Input must be a JSON array.');

  const entries: ImportedEntry[] = [];
  let skipped = 0;
  for (const value of parsed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      skipped++;
      continue;
    }
    const source = value as Record<string, unknown>;
    const text = typeof source['text'] === 'string' ? source['text'].trim() : '';
    const audience = normalizeAudience(source['audience']);
    if (!text || !audience) {
      skipped++;
      continue;
    }
    const kind =
      typeof source['kind'] === 'string' && MEMORY_KINDS.some((value) => value === source['kind'])
        ? source['kind']
        : undefined;
    const tags = cleanStringArray(source['tags']);
    entries.push({
      text,
      audience,
      kind,
      tags,
      importance: typeof source['importance'] === 'number' ? source['importance'] : undefined,
      confidence: typeof source['confidence'] === 'number' ? source['confidence'] : undefined,
    });
  }
  return { entries, skipped };
}

function includesQuery(memory: SageEntry, query: string): boolean {
  if (!query) return true;
  const audience = memory.audience;
  return [
    memory.text,
    memory.kind,
    memory.status,
    ...(audience?.roles ?? []),
    ...(audience?.taskTypes ?? []),
    ...(audience?.modes ?? []),
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase());
}

function uniqueAudienceValues(memories: SageEntry[], key: keyof MemoryAudience): string[] {
  return [
    ...new Set(
      memories
        .flatMap((memory) => memory.audience?.[key] ?? [])
        .filter((value) => value.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function AudienceMemoryPanel() {
  const { t } = useAppTranslation();
  const ws = useSurfaceHost().useSageSocket();
  const [memories, setMemories] = useState<SageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setFeedback(null);
    ws.listSageMemories({ echoToChat: false });
  }, [ws.listSageMemories]);

  useEffect(() => {
    const client = ws.client;
    const unsubList = client.on('memory.sage.list', (msg) => {
      const payload = msg.payload as { memories?: SageEntry[]; error?: string };
      if (payload.error) setFeedback({ tone: 'error', text: payload.error });
      else setMemories(payload.memories ?? []);
      setLoading(false);
    });
    const unsubRemember = client.on('memory.sage.remember', (msg) => {
      const payload = msg.payload as { memory?: SageEntry; error?: string };
      setCreating(false);
      if (payload.error) {
        setFeedback({ tone: 'error', text: payload.error });
        return;
      }
      if (payload.memory) {
        setMemories((current) => [
          payload.memory!,
          ...current.filter((memory) => memory.id !== payload.memory!.id),
        ]);
        setShowCreate(false);
      }
    });
    const unsubUpdate = client.on('memory.sage.update', (msg) => {
      const payload = msg.payload as { memory?: SageEntry; error?: string };
      if (payload.error) {
        setFeedback({ tone: 'error', text: payload.error });
      } else if (payload.memory) {
        setMemories((current) =>
          current.map((memory) => (memory.id === payload.memory!.id ? payload.memory! : memory)),
        );
        if (!payload.memory.audience) {
          setFeedback({
            tone: 'success',
            text: t('activity:audienceMem.scopeRemoved'),
          });
        }
      }
    });
    const unsubDelete = client.on('memory.sage.delete', (msg) => {
      const payload = msg.payload as { success?: boolean; message?: string };
      const pendingId = deletingIdRef.current;
      if (payload.success && pendingId) {
        setMemories((current) => current.filter((memory) => memory.id !== pendingId));
        setFeedback({ tone: 'success', text: t('activity:audienceMem.deleted') });
        setDeletingId(null);
        setDeleting(false);
        deletingIdRef.current = null;
      } else if (payload.success) {
        refresh();
      } else {
        setFeedback({ tone: 'error', text: payload.message ?? 'Could not delete the memory.' });
        setDeleting(false);
        deletingIdRef.current = null;
      }
    });

    refresh();
    return () => {
      unsubList();
      unsubRemember();
      unsubUpdate();
      unsubDelete();
    };
  }, [refresh, ws.client]);

  const scoped = useMemo(
    () =>
      memories.filter((memory) => {
        const audience = memory.audience;
        return Boolean(
          audience &&
            (audience.roles?.length || audience.taskTypes?.length || audience.modes?.length),
        );
      }),
    [memories],
  );
  const normalizedQuery = query.trim();
  const filtered = useMemo(
    () => scoped.filter((memory) => includesQuery(memory, normalizedQuery)),
    [normalizedQuery, scoped],
  );
  const memoryPage = usePagination(filtered, 16, normalizedQuery);
  const roles = useMemo(() => uniqueAudienceValues(scoped, 'roles'), [scoped]);
  const taskTypes = useMemo(() => uniqueAudienceValues(scoped, 'taskTypes'), [scoped]);
  const modes = useMemo(() => uniqueAudienceValues(scoped, 'modes'), [scoped]);

  const handleClearScope = (id: string) => {
    setFeedback(null);
    ws.updateSage(id, { audience: undefined }, { echoToChat: false });
  };

  const confirmDelete = () => {
    if (!deletingId) return;
    deletingIdRef.current = deletingId;
    setDeleting(true);
    setFeedback(null);
    ws.deleteSage(deletingId, 'Removed from the audience memory panel.');
  };

  const handleExport = async () => {
    const data = scoped.map((memory) => ({
      id: memory.id,
      text: memory.text,
      kind: memory.kind,
      status: memory.status,
      audience: memory.audience,
      tags: memory.tags,
      importance: memory.importance,
      confidence: memory.confidence,
    }));
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setFeedback({
        tone: 'success',
        text: t('activity:audienceMem.copiedAsJson', { count: data.length }),
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : t('activity:audienceMem.copyFailed'),
      });
    }
  };

  const handleCreate = (entry: CreateEntry) => {
    setFeedback(null);
    setCreating(true);
    ws.rememberSage(
      {
        text: entry.text,
        kind: entry.kind,
        audience: {
          roles: entry.roles.length > 0 ? entry.roles : undefined,
          taskTypes: entry.taskTypes.length > 0 ? entry.taskTypes : undefined,
          modes: entry.modes.length > 0 ? entry.modes : undefined,
        },
      },
      { echoToChat: false },
    );
  };

  const handleImport = (raw: string) => {
    try {
      const { entries, skipped } = parseImport(raw);
      if (entries.length === 0) {
        setFeedback({
          tone: 'error',
          text: t('activity:audienceMem.noValidInJson'),
        });
        return false;
      }
      for (const entry of entries) {
        ws.rememberSage(entry, { echoToChat: false });
      }
      setFeedback({
        tone: 'success',
        text:
          t('activity:audienceMem.queuedForImport', { count: entries.length }) +
          (skipped ? t('activity:audienceMem.skippedSuffix', { count: skipped }) : '.'),
      });
      setShowImport(false);
      return true;
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : t('activity:customRoster.invalidJson'),
      });
      return false;
    }
  };

  return (
    <>
      <section
        className="flex h-full min-h-0 flex-col bg-card/20"
        aria-labelledby="audience-memory-title"
      >
        <div className="shrink-0 border-b border-border/60 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
                  <Tag className="size-3.5" />
                </span>
                <div className="min-w-0">
                  <h2 id="audience-memory-title" className="truncate text-sm font-semibold">
                    {t('activity:audienceMem.heading')}
                  </h2>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {t('activity:audienceMem.subheading')}
                  </p>
                </div>
              </div>
            </div>
            <Button
              variant="default"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="size-3" />
              {t('common:action.add')}
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60">
            <AudienceStat value={scoped.length} label={t('activity:audienceMem.statMemories')} />
            <AudienceStat value={roles.length} label={t('activity:audienceMem.statRoles')} />
            <AudienceStat value={taskTypes.length} label={t('activity:audienceMem.statTasks')} />
            <AudienceStat value={modes.length} label={t('activity:audienceMem.statModes')} />
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('activity:audienceMem.searchTextRoleTaskOrMode')}
                aria-label={t('activity:audienceMem.searchAudienceMemories')}
                className="h-8 pl-8 pr-8 text-xs"
              />
              {query && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => setQuery('')}
                  aria-label={t('activity:audienceMem.clearAudienceMemorySearch')}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={refresh}
              aria-label={t('activity:audienceMem.refreshAudienceMemories')}
              title={t('activity:audienceMem.refresh')}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => setShowImport(true)}
              aria-label={t('activity:audienceMem.importAudienceMemories')}
              title={t('activity:audienceMem.importJson')}
            >
              <Upload className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => void handleExport()}
              aria-label={t('activity:audienceMem.copyAudienceMemoriesAsJson')}
              title={t('activity:audienceMem.copyJson')}
              disabled={scoped.length === 0}
            >
              <Download className="size-3.5" />
            </Button>
          </div>
        </div>

        {feedback && (
          <div
            role={feedback.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'mx-3 mt-3 flex shrink-0 items-start justify-between gap-2 rounded-md border px-2.5 py-2 text-[11px]',
              feedback.tone === 'error'
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-success/30 bg-success/5 text-success',
            )}
          >
            <span>{feedback.text}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="shrink-0 rounded-sm opacity-70 hover:opacity-100"
              aria-label={t('activity:audienceMem.dismissMessage')}
            >
              <X className="size-3" />
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {!loading && scoped.length > 0 && (
            <div className="flex shrink-0 items-center justify-between px-3 pb-1.5 pt-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <Filter className="size-3" />
                {normalizedQuery
                  ? `${filtered.length} of ${scoped.length}`
                  : `${scoped.length} scoped`}
              </span>
              {normalizedQuery && (
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setQuery('')}
                >
                  {t('activity:audienceMem.clearFilter')}
                </button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {loading ? (
              <AudienceMemorySkeleton />
            ) : scoped.length === 0 ? (
              <EmptyAudienceMemory onAdd={() => setShowCreate(true)} />
            ) : filtered.length === 0 ? (
              <div className="flex h-full min-h-32 flex-col items-center justify-center px-4 text-center">
                <Search className="mb-2 size-5 text-muted-foreground/60" />
                <p className="text-xs font-medium">{t('activity:audienceMem.noMatching')}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {t('activity:audienceMem.noMatchingHint')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 h-7 text-xs"
                  onClick={() => setQuery('')}
                >
                  {t('activity:audienceMemoryPanel.clearSearch')}
                </Button>
              </div>
            ) : (
              <ul className="space-y-2">
                {memoryPage.pageItems.map((memory) => (
                  <AudienceMemoryCard
                    key={memory.id}
                    memory={memory}
                    onFilter={setQuery}
                    onClearScope={() => handleClearScope(memory.id)}
                    onDelete={() => setDeletingId(memory.id)}
                  />
                ))}
              </ul>
            )}
            <Pagination
              page={memoryPage.page}
              pageSize={memoryPage.pageSize}
              totalItems={memoryPage.totalItems}
              onPageChange={memoryPage.setPage}
              compact
              itemLabel="memories"
            />
          </div>
        </div>
      </section>

      <CreateAudienceMemoryDialog
        open={showCreate}
        busy={creating}
        onOpenChange={(open) => {
          if (!creating) setShowCreate(open);
        }}
        onCreate={handleCreate}
      />
      <ImportAudienceMemoryDialog
        open={showImport}
        onOpenChange={setShowImport}
        onImport={handleImport}
      />
      <Dialog
        open={Boolean(deletingId)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeletingId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('activity:audienceMem.deleteTitle')}</DialogTitle>
            <DialogDescription>{t('activity:audienceMem.deleteBody')}</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border/70 bg-background/45 p-3 text-xs text-muted-foreground">
            {memoryPreview(memories.find((memory) => memory.id === deletingId)?.text ?? '', 180)}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingId(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              <Trash2 className="size-4" />
              {deleting ? 'Deleting…' : 'Delete memory'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
