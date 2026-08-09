/**
 * SessionInspectView — read-only inspection/summary of an inactive session.
 *
 * Displays a visual replay-style summary: metadata, tool breakdown, file
 * changes, and a chronological event timeline. Does NOT open or resume the
 * session — purely a read-only inspection.
 */
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Cpu,
  FileCode2,
  History,
  Loader2,
  MessageSquareText,
  RotateCw,
  Search,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config-store';
import {
  ensureInspectHandlerInstalled,
  useSessionInspectStore,
} from '@/stores/session-inspect-store';
import { useUIStore } from '@/stores/ui-store';
import {
  formatCompactNumber,
  formatRelative,
  formatSessionDuration,
} from './SidePanel/SessionList';

// ── Helpers ────────────────────────────────────────────────────────────

const EVENT_ICON_MAP: Record<string, typeof Activity> = {
  session_start: Activity,
  session_resumed: RotateCw,
  user_input: MessageSquareText,
  llm_request: Cpu,
  llm_response: Cpu,
  tool_use: Wrench,
  tool_call_start: Wrench,
  tool_call_end: Wrench,
  tool_result: Wrench,
  compaction: RotateCw,
  context_snapshot: History,
  error: XCircle,
  session_end: CheckCircle2,
  message_appended: MessageSquareText,
  message_updated: MessageSquareText,
  messages_replaced: MessageSquareText,
  messages_dropped: MessageSquareText,
  file_event: FileCode2,
  mode_changed: Activity,
  task_created: Activity,
  task_updated: Activity,
  task_completed: CheckCircle2,
  task_failed: XCircle,
  agent_spawned: Activity,
  agent_stopped: Activity,
  agent_error: XCircle,
  provider_retry: RotateCw,
  provider_error: AlertTriangle,
};

function eventColor(type: string): string {
  switch (type) {
    case 'error':
    case 'task_failed':
    case 'agent_error':
      return 'text-destructive border-destructive/30 bg-destructive/5';
    case 'tool_call_end':
    case 'tool_use':
    case 'tool_call_start':
      return 'text-primary border-primary/30 bg-primary/5';
    case 'file_event':
      return 'text-success border-success/30 bg-success/5';
    case 'compaction':
      return 'text-warning border-warning/30 bg-warning/5';
    case 'user_input':
      return 'text-foreground border-border';
    default:
      return 'text-muted-foreground border-border';
  }
}

function outcomeBadge(
  outcome: string | undefined,
  t: (key: string) => string,
): { label: string; cls: string } {
  switch (outcome) {
    case 'completed':
      return {
        label: t('activity:sessionInspect.outcomeCompleted'),
        cls: 'border-success/30 bg-success/10 text-success',
      };
    case 'error':
      return {
        label: t('activity:sessionInspect.outcomeError'),
        cls: 'border-destructive/30 bg-destructive/10 text-destructive',
      };
    case 'timeout':
      return {
        label: t('activity:sessionInspect.outcomeTimeout'),
        cls: 'border-warning/30 bg-warning/10 text-warning',
      };
    case 'aborted':
      return {
        label: t('activity:sessionInspect.outcomeAborted'),
        cls: 'border-muted-foreground/30 bg-muted text-muted-foreground',
      };
    default:
      return {
        label: t('activity:sessionInspect.outcomeUnknown'),
        cls: 'border-border bg-muted text-muted-foreground',
      };
  }
}

const operationLabel: Record<string, string> = {
  create: 'Created',
  read: 'Read',
  update: 'Modified',
  delete: 'Deleted',
  rename: 'Renamed',
};

// ── Component ──────────────────────────────────────────────────────────

export function SessionInspectView() {
  const { t } = useAppTranslation();
  const inspectSessionId = useUIStore((s) => s.inspectSessionId);
  const clearInspectSession = useUIStore((s) => s.clearInspectSession);
  const { inspectSession } = useWebSocket();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { payload, loading, error, clear: clearPayload } = useSessionInspectStore();

  const [eventFilter, setEventFilter] = useState('');
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);

  // Ensure the ws handler is installed before sending the request.
  useEffect(() => {
    ensureInspectHandlerInstalled();
  }, []);

  // Request inspect data when the view mounts or session ID changes.
  useEffect(() => {
    if (!inspectSessionId) return;
    useSessionInspectStore.getState().setLoading(true);
    inspectSession(inspectSessionId);
  }, [inspectSessionId, inspectSession]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => clearPayload();
  }, [clearPayload]);

  const handleBack = useCallback(() => {
    clearInspectSession();
  }, [clearInspectSession]);

  const handleRefresh = useCallback(() => {
    if (!inspectSessionId) return;
    useSessionInspectStore.getState().setLoading(true);
    inspectSession(inspectSessionId);
  }, [inspectSessionId, inspectSession]);

  // Hooks below MUST run on every render — they are intentionally placed
  // before any early-return branches so React sees a stable hook count
  // (fixes minified React error #310 when `payload` is null on first paint).
  const filteredEvents = useMemo(
    () =>
      eventFilter
        ? (payload?.events.filter(
            (e) =>
              e.label.toLowerCase().includes(eventFilter.toLowerCase()) ||
              e.type.toLowerCase().includes(eventFilter.toLowerCase()),
          ) ?? [])
        : (payload?.events ?? []),
    [payload, eventFilter],
  );

  const sortedTools = useMemo(
    () => (payload ? Object.entries(payload.toolBreakdown).sort(([, a], [, b]) => b - a) : []),
    [payload],
  );

  // ═══════════ LOADING ═══════════════════════════════════════════════
  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[hsl(var(--surface-2)/0.45)]">
        <div className="flex items-center gap-3 px-5 py-4 border border-border/60 bg-card text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          {t('activity:sessionInspect.loadingSessionInspection')}
        </div>
      </div>
    );
  }

  // ═══════════ ERROR ═════════════════════════════════════════════════
  if (error) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-[hsl(var(--surface-2)/0.45)] p-6">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium text-destructive">{error}</p>
        <button
          type="button"
          onClick={handleBack}
          className="mt-2 inline-flex items-center gap-1.5 border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('activity:sessionInspect.backToSessions')}
        </button>
      </div>
    );
  }

  // ═══════════ EMPTY STATE ══════════════════════════════════════════
  if (!inspectSessionId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-[hsl(var(--surface-2)/0.45)]">
        <div className="flex max-w-sm flex-col items-center gap-3 p-6 text-center">
          <Search className="h-9 w-9 text-muted-foreground opacity-30" />
          <p className="text-sm font-medium text-foreground">
            {t('activity:sessionInspect.noSessionSelected')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('activity:sessionInspect.selectASessionFromTheSessions')}
          </p>
        </div>
      </div>
    );
  }

  if (!payload) return null;

  // ═══════════ DATA ══════════════════════════════════════════════════
  const badge = outcomeBadge(payload.outcome, t);
  const displayName = payload.name || payload.title || 'Untitled';

  // ═══════════ RENDER ════════════════════════════════════════════════
  return (
    <div className="flex h-full min-h-0 flex-col bg-[hsl(var(--surface-2)/0.45)] overflow-y-auto overscroll-contain">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 shrink-0 border-b border-border/70 bg-card/90 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={handleBack}
              className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('activity:sessionInspect.backToSessions')}
            </button>
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight" title={displayName}>
                {displayName}
              </h1>
              {payload.outcome ? (
                <span
                  className={cn(
                    'inline-flex items-center border px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                    badge.cls,
                  )}
                >
                  {badge.label}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className="font-mono">
                {payload.provider}/{payload.model}
              </span>
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3 w-3" />
                {formatRelative(payload.startedAt)}
              </span>
              <span>
                {formatSessionDuration({
                  id: payload.id,
                  title: payload.title,
                  startedAt: payload.startedAt,
                  endedAt: payload.endedAt,
                  model: payload.model,
                  provider: payload.provider,
                  tokenTotal: payload.tokenTotal,
                  isCurrent: false,
                })}
              </span>
              <span className="font-mono text-[10px]">ID: {payload.id.slice(0, 12)}…</span>
            </div>
            {payload.lastUserMessage ? (
              <p
                className="mt-2 truncate text-xs text-muted-foreground"
                title={payload.lastUserMessage}
              >
                "{payload.lastUserMessage}"
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={!wsConnected}
            className="inline-flex h-8 items-center gap-1 border border-border/70 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:bg-muted disabled:opacity-40"
            title={t('activity:sessionInspect.refresh')}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t('activity:sessionInspect.refresh')}
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
        {/* ── Stats grid ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <StatCard
            icon={Cpu}
            label={t('activity:sessionInspect.tokens')}
            value={formatCompactNumber(payload.tokenTotal)}
          />
          <StatCard
            icon={MessageSquareText}
            label={t('activity:sessionInspect.messages')}
            value={formatCompactNumber(payload.messageCount)}
          />
          <StatCard
            icon={Activity}
            label={t('activity:sessionInspect.iterations')}
            value={formatCompactNumber(payload.iterationCount)}
          />
          <StatCard
            icon={Wrench}
            label={t('activity:sessionInspect.toolCalls')}
            value={formatCompactNumber(payload.toolCallCount)}
            errorCount={payload.toolErrorCount > 0 ? payload.toolErrorCount : undefined}
          />
          <StatCard
            icon={FileCode2}
            label={t('activity:sessionInspect.files')}
            value={formatCompactNumber(payload.fileChangeCount)}
          />
          <StatCard
            icon={RotateCw}
            label={t('activity:sessionInspect.compactions')}
            value={formatCompactNumber(payload.compactionCount)}
          />
          <StatCard
            icon={History}
            label={t('activity:sessionInspect.events')}
            value={formatCompactNumber(payload.events.length)}
          />
        </div>

        {/* ── Two-column body ─────────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          {/* ── Left: Event timeline ───────────────────────────────── */}
          <section className="min-w-0 border border-border/70 bg-card/70">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">
                  {t('activity:sessionInspect.eventTimeline')}
                </h2>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {filteredEvents.length} / {payload.events.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    value={eventFilter}
                    onChange={(e) => setEventFilter(e.target.value)}
                    placeholder={t('activity:sessionInspect.filterEvents')}
                    className="h-7 w-36 border border-border/60 bg-background pl-7 pr-2 text-[11px] outline-none focus:border-primary"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setTimelineCollapsed(!timelineCollapsed)}
                  className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
                >
                  {timelineCollapsed ? 'Expand' : 'Collapse'}
                </button>
              </div>
            </div>
            {!timelineCollapsed && (
              <div className="divide-y divide-border/60">
                {filteredEvents.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                    {t('activity:sessionInspect.noEventsMatchTheFilter')}
                  </div>
                ) : (
                  filteredEvents.map((evt, idx) => {
                    const Icon = EVENT_ICON_MAP[evt.type] ?? Activity;
                    return (
                      <div
                        key={`${evt.ts}-${idx}`}
                        className={cn(
                          'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 px-3 py-2 text-xs',
                          eventColor(evt.type),
                        )}
                      >
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{evt.label}</div>
                          {evt.detail ? (
                            <div className="truncate font-mono text-[10px] opacity-70">
                              {evt.detail}
                            </div>
                          ) : null}
                        </div>
                        <time
                          dateTime={evt.ts}
                          className="whitespace-nowrap font-mono text-[10px] opacity-60"
                        >
                          {new Date(evt.ts).toLocaleTimeString()}
                        </time>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </section>

          {/* ── Right: Tool breakdown + File changes ───────────────── */}
          <aside className="flex flex-col gap-4">
            {/* Tool breakdown */}
            {sortedTools.length > 0 ? (
              <section className="border border-border/70 bg-card/70">
                <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5">
                  <Wrench className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">
                    {t('activity:sessionInspect.toolBreakdown')}
                  </h2>
                </div>
                <div className="divide-y divide-border/60">
                  {sortedTools.map(([name, count]) => (
                    <div key={name} className="flex items-center justify-between px-4 py-2 text-xs">
                      <span className="truncate font-medium">{name}</span>
                      <span className="ml-2 shrink-0 font-mono font-semibold tabular-nums">
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* File changes */}
            {payload.fileEvents.length > 0 ? (
              <section className="border border-border/70 bg-card/70">
                <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2.5">
                  <FileCode2 className="h-4 w-4 text-success" />
                  <h2 className="text-sm font-semibold">
                    {t('activity:sessionInspect.fileChanges')}
                  </h2>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {payload.fileEvents.length}
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {payload.fileEvents.map((fe, idx) => (
                    <div
                      key={`${fe.filePath}-${idx}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 px-4 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-mono font-medium" title={fe.filePath}>
                          {fe.filePath}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          {fe.toolName}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 inline-flex items-center border px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                          fe.operation === 'delete'
                            ? 'border-destructive/30 bg-destructive/10 text-destructive'
                            : fe.operation === 'create'
                              ? 'border-success/30 bg-success/10 text-success'
                              : 'border-border bg-muted text-muted-foreground',
                        )}
                      >
                        {operationLabel[fe.operation] ?? fe.operation}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  errorCount,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  errorCount?: number | undefined;
}) {
  return (
    <div className="border border-border/70 bg-card/70 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-lg font-semibold tabular-nums">{value}</span>
        {errorCount !== undefined && errorCount > 0 ? (
          <span className="font-mono text-xs text-destructive">({errorCount} err)</span>
        ) : null}
      </div>
    </div>
  );
}
