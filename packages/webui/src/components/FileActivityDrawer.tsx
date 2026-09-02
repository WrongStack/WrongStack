import { computeLineDiff } from '@wrongstack/tools/tool-diff';
import {
  Activity,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Copy,
  FileClock,
  FileCode,
  FileDiff,
  GitBranch,
  ListTree,
  Loader2,
  RefreshCw,
  ShieldAlert,
  TerminalSquare,
  Users,
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
  useFileStore,
  useKanbanStore,
  useSddBoardStore,
} from '@/stores';
import type { ChronicleEventView, ChronicleFileLineageRow, WSServerMessage } from '@/types';
import { DiffView } from './DiffView';
import { MemoryDrawer } from './MemoryManager/MemoryDrawer';

type DrawerTab = 'overview' | 'changes' | 'skeleton' | 'context' | 'memory' | 'logs';

interface ActivityRecord {
  id: string;
  at: number;
  action: string;
  actor: string;
  source: string;
  summary: string;
  sessionId?: string | undefined;
  agentId?: string | undefined;
  taskId?: string | undefined;
  boardId?: string | undefined;
  tool?: string | undefined;
  status?: string | undefined;
  raw?: unknown;
}

interface FileActivityAnalysis {
  level: 'quiet' | 'active' | 'churn';
  mutationCount: number;
  sessionCount: number;
  actorCount: number;
  taskCount: number;
}

/** Full-history rollup of a file's mutation lineage, sourced from the Chronicle
 *  metrics store (indexed by path) rather than a bounded event scan. */
interface FileLineageSummary {
  mutations: number;
  sessions: number;
  tasks: number;
  boards: number;
  tools: string[];
  models: string[];
  firstAt?: string | undefined;
  lastAt?: string | undefined;
}

export function summarizeLineage(rows: ChronicleFileLineageRow[]): FileLineageSummary {
  const sessions = new Set<string>();
  const tasks = new Set<string>();
  const boards = new Set<string>();
  const tools = new Set<string>();
  const models = new Set<string>();
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (const row of rows) {
    if (row.sessionId) sessions.add(row.sessionId);
    if (row.taskId) tasks.add(row.taskId);
    if (row.boardId) boards.add(row.boardId);
    if (row.toolName) tools.add(row.toolName);
    if (row.modelId) models.add(row.modelId);
    if (!firstAt || row.occurredAt < firstAt) firstAt = row.occurredAt;
    if (!lastAt || row.occurredAt > lastAt) lastAt = row.occurredAt;
  }
  return {
    mutations: rows.length,
    sessions: sessions.size,
    tasks: tasks.size,
    boards: boards.size,
    tools: [...tools],
    models: [...models],
    firstAt,
    lastAt,
  };
}

const MIN_DRAWER_HEIGHT = 150;
const DEFAULT_DRAWER_HEIGHT = 224;
const COLLAPSED_HEIGHT = 38;
const MUTATION_PATTERN = /(write|edit|update|create|delete|rename|modified|changed)/i;

export function normalizeTrackedPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

export function pathsReferToSameFile(left: string, right: string): boolean {
  const a = normalizeTrackedPath(left);
  const b = normalizeTrackedPath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function analyzeFileActivity(
  records: Array<Pick<ActivityRecord, 'at' | 'action' | 'actor' | 'sessionId' | 'taskId'>>,
  now = Date.now(),
): FileActivityAnalysis {
  const recent = records.filter((record) => now - record.at <= 30 * 60_000);
  const mutations = recent.filter((record) => MUTATION_PATTERN.test(record.action));
  const sessionCount = new Set(recent.map((record) => record.sessionId).filter(Boolean)).size;
  const actorCount = new Set(recent.map((record) => record.actor).filter(Boolean)).size;
  const taskCount = new Set(recent.map((record) => record.taskId).filter(Boolean)).size;
  const level =
    mutations.length >= 8 || (mutations.length >= 4 && actorCount >= 3)
      ? 'churn'
      : mutations.length > 0
        ? 'active'
        : 'quiet';
  return { level, mutationCount: mutations.length, sessionCount, actorCount, taskCount };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventTime(event: ChronicleEventView): number {
  const parsed = Date.parse(event.occurredAt ?? event.observedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function chronicleRecord(event: ChronicleEventView): ActivityRecord {
  const attributes = event.attributes ?? {};
  const action = asString(attributes['operation']) ?? event.eventType;
  const agentId = event.scope['agentId'];
  const provider = event.runtime?.providerId;
  const model = event.runtime?.modelId;
  return {
    id: event.eventId,
    at: eventTime(event),
    action,
    actor: agentId ?? provider ?? asString(attributes['actor']) ?? 'external',
    source: asString(attributes['source']) ?? event.tags?.['collector'] ?? 'chronicle',
    summary: [event.eventType, provider && model ? `${provider}/${model}` : provider, event.outcome]
      .filter(Boolean)
      .join(' · '),
    sessionId: event.scope['sessionId'],
    agentId,
    taskId: event.scope['taskId'] ?? asString(attributes['taskId']),
    boardId: asString(attributes['boardId']) ?? event.scope['boardId'],
    tool: asString(attributes['toolName']),
    status: event.outcome,
    raw: event,
  };
}

function liveRecord(activity: FileActivity): ActivityRecord {
  return {
    id: activity.id ?? `${activity.filePath}:${activity.timestamp}:${activity.type}`,
    at: activity.timestamp,
    action: activity.type,
    actor: activity.agentName ?? activity.agent ?? activity.agentId ?? 'external',
    source: activity.source ?? 'live',
    summary: activity.summary,
    sessionId: activity.sessionId,
    agentId: activity.agentId,
    tool: activity.toolName,
    status: activity.status,
    raw: activity,
  };
}

function uniqueRecords(records: ActivityRecord[]): ActivityRecord[] {
  const seen = new Set<string>();
  return records
    .sort((a, b) => b.at - a.at)
    .filter((record) => {
      const key = `${record.id}:${record.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function byteCount(text: string): number {
  return new TextEncoder().encode(text).length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function compactId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function changeCounts(
  oldText: string,
  newText: string,
): { added: number; removed: number; large: boolean } {
  const rows = computeLineDiff(oldText, newText);
  if (!rows) return { added: 0, removed: 0, large: true };
  return {
    added: rows.filter((row) => row.kind === 'add').length,
    removed: rows.filter((row) => row.kind === 'del').length,
    large: false,
  };
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

function HeaderMetric({ label }: { label: string }) {
  return (
    <span className="hidden whitespace-nowrap font-mono text-[9px] text-muted-foreground sm:inline">
      {label}
    </span>
  );
}

function OverviewTab({
  analysis,
  lifetime,
  records,
  sessions,
  agents,
  tasks,
  taskLabel,
}: {
  analysis: FileActivityAnalysis;
  lifetime: FileLineageSummary;
  records: ActivityRecord[];
  sessions: string[];
  agents: string[];
  tasks: string[];
  taskLabel: (id: string) => string;
}) {
  const { t } = useAppTranslation();
  const cards = [
    {
      label: t('activity:fileActivity.mutations30m'),
      value: analysis.mutationCount,
      icon: <FileDiff />,
    },
    { label: t('activity:fileActivity.sessions'), value: sessions.length, icon: <Users /> },
    { label: t('activity:fileActivity.actors'), value: agents.length, icon: <Bot /> },
    { label: t('activity:fileActivity.linkedWork'), value: tasks.length, icon: <ListTree /> },
  ];
  return (
    <div className="grid min-h-full grid-cols-1 gap-2 p-2 lg:grid-cols-[minmax(360px,.9fr)_minmax(420px,1.35fr)]">
      <div className="space-y-2">
        <div className="grid grid-cols-4 gap-1.5">
          {cards.map((card) => (
            <div
              key={card.label}
              className="rounded-md border border-border/70 bg-background/45 px-2 py-1.5"
            >
              <div className="flex items-center gap-1 text-[9px] text-muted-foreground [&>svg]:h-3 [&>svg]:w-3">
                {card.icon}
                <span className="truncate">{card.label}</span>
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold">{card.value}</div>
            </div>
          ))}
        </div>
        {lifetime.mutations > 0 && <LifetimeLineage lifetime={lifetime} />}
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border px-2.5 py-2 text-[10px]',
            analysis.level === 'churn'
              ? 'border-destructive/25 bg-destructive/[0.055]'
              : 'border-border/70 bg-background/45',
          )}
        >
          <ShieldAlert
            className={cn(
              'mt-0.5 h-3.5 w-3.5 shrink-0',
              analysis.level === 'churn' ? 'text-destructive' : 'text-primary',
            )}
          />
          <div>
            <div className="font-semibold">
              {t(`activity:fileActivity.analysisTitle.${analysis.level}`)}
            </div>
            <p className="mt-0.5 text-muted-foreground">
              {t(`activity:fileActivity.analysisBody.${analysis.level}`, {
                mutations: analysis.mutationCount,
                actors: analysis.actorCount,
                sessions: analysis.sessionCount,
              })}
            </p>
          </div>
        </div>
        {tasks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[9px]">
            <span className="text-muted-foreground">{t('activity:fileActivity.workLinks')}:</span>
            {tasks.slice(0, 4).map((id) => (
              <span
                key={id}
                className="max-w-[180px] truncate rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-primary"
                title={id}
              >
                {taskLabel(id)}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="min-w-0 rounded-md border border-border/70 bg-background/35">
        <div className="border-b border-border/60 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('activity:fileActivity.recentActivity')}
        </div>
        <div className="divide-y divide-border/40">
          {records.length === 0 ? (
            <EmptyRow text={t('activity:fileActivity.noEvidence')} />
          ) : (
            records
              .slice(0, 5)
              .map((record) => <ActivityRow key={`${record.id}:${record.at}`} record={record} />)
          )}
        </div>
      </div>
    </div>
  );
}

function LifetimeLineage({ lifetime }: { lifetime: FileLineageSummary }) {
  const { t } = useAppTranslation();
  const stats: Array<{ value: number; label: string }> = [
    { value: lifetime.mutations, label: t('activity:fileActivity.lifetimeChanges') },
    { value: lifetime.sessions, label: t('activity:fileActivity.lifetimeSessions') },
    { value: lifetime.tasks, label: t('activity:fileActivity.lifetimeTasks') },
    { value: lifetime.boards, label: t('activity:fileActivity.lifetimeBoards') },
  ];
  const since = lifetime.firstAt ? new Date(lifetime.firstAt).toLocaleDateString() : undefined;
  return (
    <div className="rounded-md border border-primary/15 bg-primary/[0.03] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-primary [&>svg]:h-3 [&>svg]:w-3">
        <FileClock />
        {t('activity:fileActivity.lifetimeTitle')}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
        {stats.map((stat) => (
          <span key={stat.label}>
            <b className="text-foreground">{stat.value.toLocaleString()}</b> {stat.label}
          </span>
        ))}
        {since && <span>{t('activity:fileActivity.lifetimeSince', { date: since })}</span>}
      </div>
      {lifetime.tools.length > 0 && (
        <div
          className="mt-1 truncate font-mono text-[8px] text-muted-foreground"
          title={lifetime.tools.join(', ')}
        >
          {t('activity:fileActivity.lifetimeTools', {
            tools: lifetime.tools.slice(0, 6).join(', '),
          })}
        </div>
      )}
    </div>
  );
}

function ContextTab({
  sessions,
  agents,
  tasks,
  records,
  taskLabel,
  boardTitle,
}: {
  sessions: string[];
  agents: string[];
  tasks: string[];
  records: ActivityRecord[];
  taskLabel: (id: string) => string;
  boardTitle?: string | undefined;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="grid min-h-full grid-cols-1 divide-y divide-border/50 md:grid-cols-3 md:divide-x md:divide-y-0">
      <ContextColumn
        icon={<Users />}
        title={t('activity:fileActivity.sessions')}
        empty={t('activity:fileActivity.noSessions')}
      >
        {sessions.map((id) => (
          <ContextItem
            key={id}
            title={compactId(id)}
            subtitle={`${records.filter((record) => record.sessionId === id).length} ${t('activity:fileActivity.events')}`}
            raw={id}
          />
        ))}
      </ContextColumn>
      <ContextColumn
        icon={<Bot />}
        title={t('activity:fileActivity.actors')}
        empty={t('activity:fileActivity.noActors')}
      >
        {agents.map((name) => (
          <ContextItem
            key={name}
            title={name}
            subtitle={`${records.filter((record) => record.actor === name).length} ${t('activity:fileActivity.events')}`}
          />
        ))}
      </ContextColumn>
      <ContextColumn
        icon={<ListTree />}
        title={t('activity:fileActivity.workLinks')}
        empty={t('activity:fileActivity.noWorkLinks')}
      >
        {tasks.map((id) => (
          <ContextItem
            key={id}
            title={taskLabel(id)}
            subtitle={boardTitle ?? t('activity:fileActivity.taskOrTodo')}
            raw={id}
          />
        ))}
      </ContextColumn>
    </div>
  );
}

function ContextColumn({
  icon,
  title,
  empty,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section className="min-w-0 p-2">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground [&>svg]:h-3 [&>svg]:w-3">
        {icon}
        {title}
      </h3>
      <div className="space-y-1">{hasChildren ? children : <EmptyRow text={empty} />}</div>
    </section>
  );
}

function ContextItem({
  title,
  subtitle,
  raw,
}: {
  title: string;
  subtitle: string;
  raw?: string | undefined;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-background/45 px-2 py-1.5" title={raw}>
      <div className="truncate text-[10px] font-medium">{title}</div>
      <div className="mt-0.5 truncate font-mono text-[8px] text-muted-foreground">{subtitle}</div>
    </div>
  );
}

function LogsTab({ records, loading }: { records: ActivityRecord[]; loading: boolean }) {
  const { t } = useAppTranslation();
  if (loading && records.length === 0)
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[10px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('activity:fileActivity.loadingEvidence')}
      </div>
    );
  if (records.length === 0) return <EmptyRow text={t('activity:fileActivity.noEvidence')} />;
  return (
    <div className="divide-y divide-border/40">
      {records.map((record) => (
        <ActivityRow key={`${record.id}:${record.at}`} record={record} raw />
      ))}
    </div>
  );
}

function ActivityRow({ record, raw = false }: { record: ActivityRecord; raw?: boolean }) {
  const time = new Date(record.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const row = (
    <div className="grid grid-cols-[62px_74px_minmax(90px,.7fr)_minmax(160px,1.5fr)] items-center gap-2 text-[9px]">
      <span className="font-mono text-muted-foreground">{time}</span>
      <span
        className={cn(
          'w-fit rounded px-1.5 py-0.5 font-mono',
          MUTATION_PATTERN.test(record.action)
            ? 'bg-warning/10 text-warning'
            : 'bg-primary/10 text-primary',
        )}
      >
        {record.action}
      </span>
      <span className="truncate" title={record.agentId}>
        {record.actor}
      </span>
      <span className="truncate text-muted-foreground" title={record.summary}>
        {record.summary}
      </span>
    </div>
  );
  if (!raw) return <div className="px-2.5 py-1.5">{row}</div>;
  return (
    <details className="group cursor-pointer px-2.5 py-1.5">
      <summary className="list-none [&::-webkit-details-marker]:hidden">{row}</summary>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded border border-border/60 bg-background/60 p-2 font-mono text-[8px] leading-relaxed text-muted-foreground">
        {JSON.stringify(record.raw, null, 2)}
      </pre>
    </details>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-3 py-3 text-center text-[10px] text-muted-foreground">{text}</div>;
}

function SkeletonTab({ file }: { file: OpenFile }) {
  const wsUrl = useConfigStore((state) => state.wsUrl);
  const jumpToLine = useFileStore((state) => state.jumpToLine);
  const client = useMemo(() => getWSClient(wsUrl), [wsUrl]);
  const [skeleton, setSkeleton] = useState<string>('');
  const [stats, setStats] = useState<{
    originalLines: number;
    skeletonLines: number;
    tokenSavingsPercent: number;
    symbolCount: number;
  } | null>(null);
  const [lang, setLang] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [collapseImports, setCollapseImports] = useState(false);
  const [includeDocs, setIncludeDocs] = useState(true);

  const fetchSkeleton = useCallback(() => {
    setLoading(true);
    setError(null);
    client.send({
      type: 'files.skeleton',
      payload: {
        filePath: file.path,
        content: file.content,
        options: {
          collapseImports,
          includeDocs,
        },
      },
    });
  }, [client, file.path, file.content, collapseImports, includeDocs]);

  useEffect(() => {
    const off = client.on('files.skeleton_result', (message: WSServerMessage) => {
      if (message.type !== 'files.skeleton_result') return;
      if (message.payload.filePath !== file.path) return;
      setLoading(false);
      if (message.payload.error) {
        setError(message.payload.error);
        return;
      }
      setSkeleton(message.payload.skeleton);
      if (message.payload.stats) setStats(message.payload.stats);
      if (message.payload.lang) setLang(message.payload.lang);
    });

    fetchSkeleton();
    return () => {
      off();
    };
  }, [client, file.path, fetchSkeleton]);

  const handleCopy = async () => {
    if (!skeleton) return;
    try {
      await navigator.clipboard.writeText(skeleton);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const renderInteractiveLine = (line: string, idx: number) => {
    const match = line.match(/(?:\/\*\s*L(\d+)(?:-L\d+)?\s*\*\/|#\s*L(\d+)(?:-L\d+)?)/);
    const targetLineNum = match ? parseInt(match[1] || match[2] || '0', 10) : null;

    if (targetLineNum && targetLineNum > 0) {
      return (
        <div
          key={idx}
          className="group flex items-center justify-between gap-2 rounded px-1.5 py-0.5 hover:bg-primary/10 transition-colors"
        >
          <span className="truncate">{line}</span>
          <button
            type="button"
            onClick={() => jumpToLine(targetLineNum)}
            className="shrink-0 cursor-pointer rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-primary opacity-75 group-hover:opacity-100 hover:bg-primary hover:text-primary-foreground transition-all"
            title={`Jump to line ${targetLineNum} in editor`}
          >
            Jump to L{targetLineNum} →
          </button>
        </div>
      );
    }

    return (
      <div key={idx} className="px-1.5 py-0.5 whitespace-pre">
        {line}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-[140px] flex-col p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-primary">
            <FileCode className="h-3 w-3" />
            {lang || 'AST'}
          </span>
          {stats && (
            <>
              <span className="rounded bg-success/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-success">
                -{stats.tokenSavingsPercent}% Tokens
              </span>
              <span className="text-[10px] text-muted-foreground">
                {stats.originalLines} → {stats.skeletonLines} lines
              </span>
              <span className="text-[10px] text-muted-foreground">
                ({stats.symbolCount} symbols)
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 text-[10px]">
          <label className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              checked={collapseImports}
              onChange={(e) => setCollapseImports(e.target.checked)}
              className="rounded border-border"
            />
            <span>Collapse imports</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              checked={includeDocs}
              onChange={(e) => setIncludeDocs(e.target.checked)}
              className="rounded border-border"
            />
            <span>Include docs</span>
          </label>
          <button
            type="button"
            onClick={fetchSkeleton}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Refresh Skeleton"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!skeleton}
            className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-1 text-[10px] font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded border border-border/60 bg-muted/20 p-2 font-mono text-[11px] leading-relaxed">
        {loading && !skeleton ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-primary" />
            <span>Extracting AST Skeleton…</span>
          </div>
        ) : error ? (
          <div className="p-4 text-warning">{error}</div>
        ) : (
          <div className="font-mono select-text">
            {skeleton.split('\n').map((line, idx) => renderInteractiveLine(line, idx))}
          </div>
        )}
      </div>
    </div>
  );
}
