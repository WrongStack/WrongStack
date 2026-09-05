import {
  Activity,
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  CircleDot,
  FileClock,
  FileCode,
  FileDiff,
  GitBranch,
  ListTree,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  type FileActivity,
  type OpenFile,
  useCodemapActivityStore,
  useConfigStore,
  useKanbanStore,
  useSddBoardStore,
} from '@/stores';
import type { ChronicleEventView, ChronicleFileLineageRow, WSServerMessage } from '@/types';
import { DiffView } from './DiffView';
import { ContextTab } from './FileActivityDrawer/ContextTab';
import { LogsTab } from './FileActivityDrawer/LogsTab';
import { OverviewTab } from './FileActivityDrawer/OverviewTab';
import { SkeletonTab } from './FileActivityDrawer/SkeletonTab';
import {
  analyzeFileActivity,
  byteCount,
  COLLAPSED_HEIGHT,
  changeCounts,
  chronicleRecord,
  countLines,
  DEFAULT_DRAWER_HEIGHT,
  type DrawerTab,
  formatBytes,
  liveRecord,
  MIN_DRAWER_HEIGHT,
  pathsReferToSameFile,
  summarizeLineage,
  uniqueRecords,
} from './FileActivityDrawer/types';
import { MemoryDrawer } from './MemoryManager/MemoryDrawer';

export {
  type ActivityRecord,
  analyzeFileActivity,
  type DrawerTab,
  type FileActivityAnalysis,
  type FileLineageSummary,
  normalizeTrackedPath,
  pathsReferToSameFile,
  summarizeLineage,
} from './FileActivityDrawer/types';

function HeaderMetric({ label }: { label: string }) {
  return (
    <span className="hidden whitespace-nowrap font-mono text-[9px] text-muted-foreground sm:inline">
      {label}
    </span>
  );
}

export function FileActivityDrawer({ file }: { file: OpenFile }) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(true);
  const [drawerHeight, setDrawerHeight] = useState(DEFAULT_DRAWER_HEIGHT);
  const [tab, setTab] = useState<DrawerTab>('overview');
  const [chronicleEvents, setChronicleEvents] = useState<ChronicleEventView[]>([]);
  const [lineage, setLineage] = useState<ChronicleFileLineageRow[]>([]);
  const [chronicleLoading, setChronicleLoading] = useState(false);
  const [chronicleError, setChronicleError] = useState<string | null>(null);
  const [gitBase, setGitBase] = useState<{
    text: string;
    available: boolean;
    error?: string;
  } | null>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const wsUrl = useConfigStore((state) => state.wsUrl);
  const history = useCodemapActivityStore((state) => state.history);
  const activeOperations = useCodemapActivityStore((state) => state.activeOperations);
  const activeBoard = useKanbanStore((state) => state.activeBoard);
  const sddSnapshot = useSddBoardStore((state) => state.snapshot);

  const client = useMemo(() => getWSClient(wsUrl), [wsUrl]);

  const requestEvidence = useCallback(() => {
    setChronicleError(null);
    setChronicleLoading(true);
    if (typeof client.getGitDiff === 'function') client.getGitDiff(file.path);
    const supports =
      typeof client.supportsCapability === 'function'
        ? client.supportsCapability.bind(client)
        : null;
    if (supports?.('chronicle.query')) {
      client.send({
        type: 'chronicle.query',
        payload: { query: { path: file.path, resourceKind: 'file', order: 'desc', limit: 150 } },
      });
    } else {
      setChronicleLoading(false);
    }
    // Full-history lineage rollup from the metrics store (indexed by path) —
    // cheap regardless of journal size, unlike the bounded query scan above.
    if (supports?.('chronicle.metrics')) {
      client.send({
        type: 'chronicle.metrics',
        payload: { view: 'files', path: file.path, limit: 1000 },
      });
    }
  }, [client, file.path]);

  useEffect(() => {
    setChronicleEvents([]);
    setLineage([]);
    setGitBase(null);
    const offChronicle = client.on('chronicle.query_result', (message: WSServerMessage) => {
      if (message.type !== 'chronicle.query_result') return;
      const matching = message.payload.events.filter(
        (event) => event.resource?.path && pathsReferToSameFile(event.resource.path, file.path),
      );
      if (message.payload.events.length > 0 && matching.length === 0) return;
      setChronicleEvents(matching);
      setChronicleLoading(false);
    });
    const offMetrics = client.on('chronicle.metrics_result', (message: WSServerMessage) => {
      if (message.type !== 'chronicle.metrics_result' || message.payload.view !== 'files') return;
      // The server filtered by path; keep a defensive same-file guard in case a
      // stale response for a previously-open file arrives after a fast switch.
      setLineage(message.payload.data.filter((row) => pathsReferToSameFile(row.path, file.path)));
    });
    const offChronicleError = client.on('chronicle.error', (message: WSServerMessage) => {
      if (message.type !== 'chronicle.error') return;
      setChronicleError(message.payload.message);
      setChronicleLoading(false);
    });
    const offGit = client.on('git.diff', (message: WSServerMessage) => {
      if (message.type !== 'git.diff' || !pathsReferToSameFile(message.payload.path, file.path))
        return;
      const payload = message.payload;
      if (payload.error || payload.binary || payload.tooLarge) {
        setGitBase({ text: file.savedContent, available: false, error: payload.error });
        return;
      }
      setGitBase({ text: payload.oldText ?? '', available: true });
    });
    requestEvidence();
    return () => {
      offChronicle();
      offMetrics();
      offChronicleError();
      offGit();
    };
  }, [client, file.path, file.savedContent, requestEvidence]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - event.clientY;
      const max = Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * 0.62));
      setDrawerHeight(
        Math.min(max, Math.max(MIN_DRAWER_HEIGHT, resizeRef.current.startHeight + delta)),
      );
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const liveActivities = useMemo(() => {
    const collected: FileActivity[] = [];
    for (const [path, entries] of history) {
      if (pathsReferToSameFile(path, file.path)) collected.push(...entries);
    }
    for (const entries of activeOperations.values()) {
      collected.push(...entries.filter((entry) => pathsReferToSameFile(entry.filePath, file.path)));
    }
    return collected;
  }, [activeOperations, file.path, history]);

  const records = useMemo(
    () =>
      uniqueRecords([...liveActivities.map(liveRecord), ...chronicleEvents.map(chronicleRecord)]),
    [chronicleEvents, liveActivities],
  );
  const analysis = useMemo(() => analyzeFileActivity(records), [records]);
  const lifetime = useMemo(() => summarizeLineage(lineage), [lineage]);
  const baseText = gitBase?.text ?? file.savedContent;
  const delta = useMemo(() => changeCounts(baseText, file.content), [baseText, file.content]);
  const sessions = useMemo(
    () => [
      ...new Set(
        records.map((record) => record.sessionId).filter((value): value is string => !!value),
      ),
    ],
    [records],
  );
  const agents = useMemo(
    () => [...new Set(records.map((record) => record.actor).filter(Boolean))],
    [records],
  );
  const taskIds = useMemo(
    () => [
      ...new Set(
        records.map((record) => record.taskId).filter((value): value is string => !!value),
      ),
    ],
    [records],
  );

  const taskLabel = useCallback(
    (taskId: string) => {
      const kanbanTask = activeBoard?.tasks.find((task) => task.id === taskId);
      const sddTask = sddSnapshot?.tasks.find(
        (task) => task.id === taskId || task.shortId === taskId,
      );
      return kanbanTask?.title ?? sddTask?.title ?? taskId;
    },
    [activeBoard, sddSnapshot],
  );

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!expanded) setExpanded(true);
    resizeRef.current = {
      startY: event.clientY,
      startHeight: expanded ? drawerHeight : MIN_DRAWER_HEIGHT,
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  const tabs: Array<{ id: DrawerTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: t('activity:fileActivity.overview'), icon: <Activity /> },
    { id: 'changes', label: t('activity:fileActivity.changes'), icon: <FileDiff /> },
    { id: 'skeleton', label: 'Skeleton', icon: <FileCode /> },
    { id: 'context', label: t('activity:fileActivity.context'), icon: <ListTree /> },
    { id: 'logs', label: t('activity:fileActivity.logs'), icon: <TerminalSquare /> },
    { id: 'memory', label: t('activity:fileActivity.memory'), icon: <BrainCircuit /> },
  ];

  return (
    <section
      className="flex shrink-0 flex-col overflow-hidden border-t border-border bg-card/95 shadow-[0_-10px_30px_hsl(var(--background)/0.24)] backdrop-blur"
      style={{ height: expanded ? drawerHeight : COLLAPSED_HEIGHT }}
      data-testid="file-activity-drawer"
    >
      <button
        type="button"
        aria-label={t('activity:fileActivity.resizeHint')}
        className="group relative block h-2 w-full cursor-ns-resize touch-none"
        onPointerDown={beginResize}
        onDoubleClick={() => {
          setExpanded(true);
          setDrawerHeight(DEFAULT_DRAWER_HEIGHT);
        }}
        title={t('activity:fileActivity.resizeHint')}
      >
        <span className="absolute left-1/2 top-0.5 h-1 w-10 -translate-x-1/2 rounded-full bg-border transition-colors group-hover:bg-primary/60" />
      </button>

      <header className="flex h-[30px] min-w-0 items-center gap-2 border-b border-border/70 px-2.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-semibold hover:bg-muted"
          aria-expanded={expanded}
        >
          <FileClock className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate">{t('activity:fileActivity.title')}</span>
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
        </button>
        <span className="hidden h-3 w-px bg-border sm:block" />
        <HeaderMetric label={`${countLines(file.content)} ${t('activity:fileActivity.lines')}`} />
        <HeaderMetric label={formatBytes(byteCount(file.content))} />
        {!delta.large && (delta.added > 0 || delta.removed > 0) && (
          <span className="hidden items-center gap-1 font-mono text-[10px] md:flex">
            <span className="text-success">+{delta.added}</span>
            <span className="text-destructive">−{delta.removed}</span>
          </span>
        )}
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
            analysis.level === 'churn' && 'bg-destructive/10 text-destructive',
            analysis.level === 'active' && 'bg-warning/10 text-warning',
            analysis.level === 'quiet' && 'bg-success/10 text-success',
          )}
        >
          <CircleDot className="h-2.5 w-2.5" />
          {t(`activity:fileActivity.level.${analysis.level}`)}
        </span>
        <span className="hidden text-[9px] text-muted-foreground lg:inline">
          {t('activity:fileActivity.evidenceCount', { count: records.length })}
        </span>
        {expanded && (
          <button
            type="button"
            onClick={requestEvidence}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('activity:fileActivity.refresh')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', chronicleLoading && 'animate-spin')} />
          </button>
        )}
      </header>

      {expanded && (
        <div className="flex min-h-0 flex-1 flex-col">
          <nav className="flex shrink-0 items-center gap-0.5 border-b border-border/60 bg-muted/20 px-2">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 border-b-2 px-2 text-[10px] transition-colors [&>svg]:h-3 [&>svg]:w-3',
                  tab === item.id
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
            {chronicleError && (
              <span className="ml-auto truncate px-2 text-[9px] text-warning">
                {chronicleError}
              </span>
            )}
          </nav>

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'overview' && (
              <OverviewTab
                analysis={analysis}
                lifetime={lifetime}
                records={records}
                sessions={sessions}
                agents={agents}
                tasks={taskIds}
                taskLabel={taskLabel}
              />
            )}
            {tab === 'changes' && (
              <div className="h-full min-h-[120px] p-2">
                <div className="mb-1.5 flex items-center gap-2 text-[9px] text-muted-foreground">
                  <GitBranch className="h-3 w-3" />
                  <span>
                    {gitBase?.available
                      ? t('activity:fileActivity.gitToBuffer')
                      : t('activity:fileActivity.savedToBuffer')}
                  </span>
                  {file.dirty && (
                    <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                      {t('activity:fileActivity.unsaved')}
                    </span>
                  )}
                  {gitBase?.error && <span className="truncate text-warning">{gitBase.error}</span>}
                </div>
                <div className="h-[calc(100%-24px)] min-h-[90px]">
                  <DiffView oldText={baseText} newText={file.content} caption={file.path} fill />
                </div>
              </div>
            )}
            {tab === 'skeleton' && <SkeletonTab file={file} />}
            {tab === 'context' && (
              <ContextTab
                sessions={sessions}
                agents={agents}
                tasks={taskIds}
                records={records}
                taskLabel={taskLabel}
                boardTitle={activeBoard?.title ?? sddSnapshot?.title}
              />
            )}
            {tab === 'logs' && <LogsTab records={records} loading={chronicleLoading} />}
            {tab === 'memory' && (
              <div className="h-full min-h-[120px]">
                <MemoryDrawer filePath={file.path} open onClose={() => setTab('overview')} />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
