import {
  Activity,
  Bot,
  BrainCircuit,
  ChevronRight,
  Clock3,
  Database,
  FileCode2,
  Filter,
  GitBranch,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  TerminalSquare,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePagination } from '@/hooks/usePagination';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type {
  ChronicleEventView,
  ChronicleFacetValue,
  ChronicleGraphResult,
  ChronicleProviderDailyRow,
  ChronicleQuery,
  ChronicleStatus,
  ChronicleSummary,
  ChronicleTaskOutcomeRow,
  WSServerMessage,
} from '@/types';
import { ChroniclePipelineStrip } from './ChroniclePipelineStrip';
import { Pagination } from './ui/pagination';

const facetFields = ['eventType', 'providerId', 'modelId', 'outcome', 'resourceKind'] as const;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Bounds the default/reset query to recent history so it doesn't scan the entire journal. */
function defaultQuery(): ChronicleQuery {
  return {
    limit: 300,
    order: 'desc',
    from: new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString(),
  };
}
type Signal = 'all' | 'llm' | 'agents' | 'tools' | 'files' | 'failures';
const signals: Array<{ id: Signal; labelKey: string; icon: React.ReactNode }> = [
  { id: 'all', labelKey: 'activity:chronicle.signalAllSignals', icon: <Activity /> },
  { id: 'llm', labelKey: 'activity:chronicle.signalLlm', icon: <BrainCircuit /> },
  { id: 'agents', labelKey: 'activity:chronicle.signalAgents', icon: <Bot /> },
  { id: 'tools', labelKey: 'activity:chronicle.signalTools', icon: <TerminalSquare /> },
  { id: 'files', labelKey: 'activity:chronicle.signalFiles', icon: <FileCode2 /> },
  { id: 'failures', labelKey: 'activity:chronicle.signalFailures', icon: <TriangleAlert /> },
];

export function ChronicleDashboard() {
  const { t } = useAppTranslation();
  const client = getWSClient();
  const [events, setEvents] = useState<ChronicleEventView[]>([]);
  const [selected, setSelected] = useState<ChronicleEventView | null>(null);
  const [facets, setFacets] = useState<Record<string, ChronicleFacetValue[]>>({});
  const [query, setQuery] = useState<ChronicleQuery>(defaultQuery());
  const [draft, setDraft] = useState({
    text: '',
    path: '',
    providerId: '',
    modelId: '',
    sessionId: '',
  });
  const [signal, setSignal] = useState<Signal>('all');
  const [meta, setMeta] = useState({ total: 0, scannedEvents: 0, sourceFiles: 0, invalidLines: 0 });
  const [summary, setSummary] = useState<ChronicleSummary>(emptySummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<ChronicleGraphResult | null>(null);
  const [providerDaily, setProviderDaily] = useState<ChronicleProviderDailyRow[]>([]);
  const [taskOutcomes, setTaskOutcomes] = useState<ChronicleTaskOutcomeRow[]>([]);
  const [chronicleStatus, setChronicleStatus] = useState<ChronicleStatus | null>(null);
  // Latest query for the reconnect effect below — reading `query` there
  // directly would put it in the dep array and re-issue the query on every
  // filter keystroke.
  const queryRef = useRef(query);
  queryRef.current = query;

  const run = useCallback(
    (next: ChronicleQuery) => {
      if (!client.supportsCapability('chronicle.query')) {
        setLoading(false);
        setError('Restart the backend once to activate Chronicle protocol support.');
        return;
      }
      setLoading(true);
      setError(null);
      setQuery(next);
      setFacets({});
      client.send({ type: 'chronicle.query', payload: { query: next } });
      if (client.supportsCapability('chronicle.facets')) {
        client.send({
          type: 'chronicle.facets',
          payload: { fields: [...facetFields], query: next, limit: 12 },
        });
      } else {
        for (const field of facetFields)
          client.send({ type: 'chronicle.facet', payload: { field, query: next, limit: 12 } });
      }
    },
    [client],
  );

  const requestMetrics = useCallback(() => {
    if (!client.supportsCapability('chronicle.metrics')) return;
    client.send({ type: 'chronicle.metrics', payload: { view: 'providers' } });
    client.send({ type: 'chronicle.metrics', payload: { view: 'tasks', limit: 200 } });
  }, [client]);

  const requestStatus = useCallback(() => {
    if (client.supportsCapability('chronicle.status')) {
      client.send({ type: 'chronicle.status' });
    }
  }, [client]);

  useEffect(() => {
    const offQuery = client.on('chronicle.query_result', (message: WSServerMessage) => {
      if (message.type === 'chronicle.query_result') {
        setEvents(message.payload.events);
        setMeta(message.payload);
        setSummary(message.payload.summary ?? emptySummary);
        setLoading(false);
      }
    });
    const offFacet = client.on('chronicle.facet_result', (message: WSServerMessage) => {
      if (message.type === 'chronicle.facet_result')
        setFacets((value) => ({ ...value, [message.payload.field]: message.payload.values }));
    });
    const offFacets = client.on('chronicle.facets_result', (message: WSServerMessage) => {
      if (message.type === 'chronicle.facets_result') setFacets(message.payload.values);
    });
    const offError = client.on('chronicle.error', (message: WSServerMessage) => {
      if (message.type === 'chronicle.error') {
        setError(message.payload.message);
        setLoading(false);
      }
    });
    const offGraph = client.on('chronicle.graph_result', (message: WSServerMessage) => {
      if (message.type === 'chronicle.graph_result') setGraph(message.payload);
    });
    const offMetrics = client.on('chronicle.metrics_result', (message: WSServerMessage) => {
      if (message.type !== 'chronicle.metrics_result') return;
      if (message.payload.view === 'providers') setProviderDaily(message.payload.data);
      else if (message.payload.view === 'tasks') setTaskOutcomes(message.payload.data);
    });
    const offStatus = client.on('chronicle.status_result', (message: WSServerMessage) => {
      if (message.type === 'chronicle.status_result') setChronicleStatus(message.payload);
    });
    // Re-run the operator's CURRENT query, not the default: this effect
    // re-fires on every client identity change (reconnect), and issuing
    // defaultQuery() here silently replaced a filtered result set with the
    // unfiltered one while the filter inputs still showed the operator's
    // values. On first mount the ref holds defaultQuery(), so initial-load
    // behavior is unchanged.
    run(queryRef.current);
    requestMetrics();
    requestStatus();
    return () => {
      offQuery();
      offFacet();
      offFacets();
      offError();
      offGraph();
      offMetrics();
      offStatus();
    };
  }, [client, run, requestMetrics, requestStatus]);

  const visible = useMemo(
    () => events.filter((event) => matchesSignal(event, signal)),
    [events, signal],
  );
  const eventPage = usePagination(visible, 25, signal);
  const health = useMemo(() => {
    // runtime.health.sampled is windowed into a metrics.rollup event
    // (rollup-adapter.ts) rather than persisted raw — read the latest value
    // of each metric out of the rollup's per-metric stats.
    const rollup = events.find(
      (event) =>
        event.eventType === 'metrics.rollup' &&
        (event.attributes as { signal?: string } | undefined)?.signal === 'runtime.health',
    );
    const stats = (rollup?.attributes as { stats?: Record<string, { last?: number }> } | undefined)
      ?.stats;
    if (!stats) return undefined;
    const last = (key: string) => stats[key]?.last;
    return {
      eventLoop: {
        utilization: last('eventLoop.utilization'),
        delayP95Ms: last('eventLoop.delayP95Ms'),
      },
      memory: { heapUsedBytes: last('memory.heapUsedBytes') },
      chronicle: {
        pendingEvents: last('chronicle.pendingEvents'),
        rejectedEvents: last('chronicle.rejectedEvents'),
      },
    } satisfies Health;
  }, [events]);
  const taskStats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of taskOutcomes) counts[task.status] = (counts[task.status] ?? 0) + 1;
    const terminal =
      (counts.completed ?? 0) +
      (counts.merged ?? 0) +
      (counts.failed ?? 0) +
      (counts.conflict ?? 0);
    const ok = (counts.completed ?? 0) + (counts.merged ?? 0);
    // Recent finished tasks first (those with an end), most recent by ended/started.
    const recent = [...taskOutcomes]
      .sort((a, b) =>
        (b.endedAt ?? b.startedAt ?? '').localeCompare(a.endedAt ?? a.startedAt ?? ''),
      )
      .slice(0, 8);
    return {
      counts,
      total: taskOutcomes.length,
      terminal,
      successRate: terminal > 0 ? (ok / terminal) * 100 : 100,
      recent,
    };
  }, [taskOutcomes]);
  const apply = () =>
    run({
      ...defaultQuery(),
      ...(draft.text ? { text: draft.text } : {}),
      ...(draft.path ? { path: draft.path } : {}),
      ...(draft.providerId ? { providerId: draft.providerId } : {}),
      ...(draft.modelId ? { modelId: draft.modelId } : {}),
      ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    });
  const clear = () => {
    setDraft({ text: '', path: '', providerId: '', modelId: '', sessionId: '' });
    setSignal('all');
    run(defaultQuery());
  };
  const open = (event: ChronicleEventView) => {
    setSelected(event);
    setGraph(null);
    if (client.supportsCapability('chronicle.graph'))
      client.send({
        type: 'chronicle.graph',
        payload: { seed: { eventId: event.eventId }, hops: 2, maxNodes: 250 },
      });
  };

  return (
    <div className="flex h-full min-h-0 bg-background" data-testid="chronicle-dashboard">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border/70 bg-gradient-to-r from-primary/[0.045] via-background to-background px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <BrainCircuit className="h-5 w-5 text-primary" />
                <h1 className="text-lg font-semibold tracking-tight">
                  {t('activity:chronicle.codingIntelligence')}
                </h1>
                <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[9px] font-semibold tracking-wider text-primary">
                  {t('activity:chronicle.chronicle')}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('activity:chronicle.llmAgentToolAndFileEvidence')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  error ? 'bg-destructive' : loading ? 'animate-pulse bg-warning' : 'bg-success',
                )}
              />
              <span className="text-[10px] text-muted-foreground">
                {loading ? 'Reading journal' : error ? 'Unavailable' : 'Live evidence'}
              </span>
              <button
                type="button"
                onClick={() => {
                  run(query);
                  requestMetrics();
                  requestStatus();
                }}
                className="ml-2 rounded-md border border-border bg-card p-2 hover:bg-muted"
                title={t('activity:chronicle.refreshEvidence')}
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </button>
            </div>
          </div>
        </header>

        <section className="grid grid-cols-2 border-b border-border/70 xl:grid-cols-6">
          <Insight
            icon={<BrainCircuit />}
            label={t('activity:chronicle.llmRequests')}
            value={summary.logicalRequests}
            detail={`${summary.modelAttempts} attempts · ${summary.providers} providers · ${summary.models} models`}
          />
          <Insight
            icon={<Bot />}
            label={t('activity:chronicle.agentWork')}
            value={summary.agentEvents}
            detail={`${summary.uniqueAgents} correlated agents · ${summary.decisions} decisions`}
          />
          <Insight
            icon={<TerminalSquare />}
            label={t('activity:chronicle.toolCalls')}
            value={summary.toolCalls}
            detail={`${summary.failedTools} failed · ${summary.processes} processes`}
          />
          <Insight
            icon={<FileCode2 />}
            label={t('activity:chronicle.fileEvidence')}
            value={summary.fileEvents}
            detail={`${summary.uniqueFiles} unique paths`}
          />
          <Insight
            icon={<RotateCcw />}
            label={t('activity:chronicle.retries')}
            value={summary.scheduledRetries}
            detail={`${summary.failures} failures · ${summary.fallbacks} fallbacks`}
            tone={summary.failures ? 'danger' : 'normal'}
          />
          <Insight
            icon={<Clock3 />}
            label={t('activity:chronicle.providerP95')}
            value={formatMilliseconds(summary.providerP95DurationMs)}
            detail={`${formatMilliseconds(summary.providerAvgDurationMs)} average · all matches`}
          />
        </section>

        <section className="flex flex-wrap gap-x-6 gap-y-1 border-b border-border/60 bg-primary/[0.018] px-4 py-1.5 font-mono text-[9px] text-muted-foreground">
          <span className="font-sans font-semibold uppercase tracking-wider text-primary">
            {t('activity:chronicle.tokenEconomics')}
          </span>
          <span>
            {t('activity:chronicle.freshInput')}{' '}
            <b className="text-foreground">{summary.inputTokens.toLocaleString()}</b>
          </span>
          <span>
            output <b className="text-foreground">{summary.outputTokens.toLocaleString()}</b>
          </span>
          <span>
            {t('activity:chronicle.cacheRead')}{' '}
            <b className="text-foreground">{summary.cacheReadTokens.toLocaleString()}</b>
          </span>
          <span>
            cache write{' '}
            <b className="text-foreground">{summary.cacheWriteTokens.toLocaleString()}</b>
          </span>
          <span>
            {t('activity:chronicle.cacheHit')}{' '}
            <b className="text-foreground">{cacheRatio(summary).toFixed(1)}%</b>
          </span>
          <span>
            {t('activity:chronicle.estimatedCost')}{' '}
            <b className="text-foreground">${summary.estimatedCostUsd.toFixed(4)}</b>
          </span>
        </section>

        {providerDaily.length > 0 && (
          <section className="flex items-center gap-3 overflow-x-auto border-b border-border/60 bg-muted/[0.14] px-4 py-1.5">
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('activity:chronicle.modelReliability')}
            </span>
            {providerDaily.slice(0, 6).map((row) => {
              const terminal = row.completed + row.failed;
              const rate = terminal > 0 ? (row.completed / terminal) * 100 : 100;
              return (
                <span
                  key={`${row.day}-${row.providerId}-${row.modelId}`}
                  className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-2.5 py-0.5 font-mono text-[9px]"
                  title={`${row.day} · ${row.attempts} attempts · avg ${formatMilliseconds(row.avgDurationMs)} · ${row.inputTokens.toLocaleString()} in / ${row.outputTokens.toLocaleString()} out`}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      rate >= 99 ? 'bg-success' : rate >= 90 ? 'bg-warning' : 'bg-destructive',
                    )}
                  />
                  <span className="max-w-[180px] truncate">
                    {row.providerId}/{row.modelId}
                  </span>
                  <b className="text-foreground">{rate.toFixed(0)}%</b>
                  <span className="text-muted-foreground">{row.day.slice(5)}</span>
                </span>
              );
            })}
          </section>
        )}

        {taskStats.total > 0 && (
          <section className="flex items-center gap-3 overflow-x-auto border-b border-border/60 bg-muted/[0.10] px-4 py-1.5">
            <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              <ListChecks className="h-3 w-3" />
              {t('activity:chronicle.taskOutcomes')}
            </span>
            <span
              className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-2.5 py-0.5 font-mono text-[9px]"
              title={`${taskStats.total} tasks tracked · ${taskStats.terminal} finished`}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  taskStats.successRate >= 90
                    ? 'bg-success'
                    : taskStats.successRate >= 60
                      ? 'bg-warning'
                      : 'bg-destructive',
                )}
              />
              <b className="text-foreground">{taskStats.successRate.toFixed(0)}%</b>
              <span className="text-muted-foreground">success · {taskStats.total} tasks</span>
            </span>
            {(['completed', 'merged', 'failed', 'conflict', 'started'] as const)
              .filter((status) => taskStats.counts[status])
              .map((status) => (
                <span key={status} className="shrink-0 font-mono text-[9px] text-muted-foreground">
                  {status}{' '}
                  <b
                    className={cn(
                      status === 'failed' || status === 'conflict'
                        ? 'text-destructive'
                        : 'text-foreground',
                    )}
                  >
                    {taskStats.counts[status]}
                  </b>
                </span>
              ))}
            <span className="mx-1 h-3 w-px shrink-0 bg-border" />
            {taskStats.recent.map((task) => (
              <button
                key={task.taskId}
                type="button"
                onClick={() => run({ limit: 300, order: 'desc', taskId: task.taskId })}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[9px] hover:border-primary/50"
                title={`${task.taskId}${task.boardId ? ` · board ${task.boardId}` : ''}${task.sessionId ? ` · ${task.sessionId}` : ''} · ${task.filesTouched} files${task.retries ? ` · ${task.retries} retries` : ''}${task.verificationFailures ? ` · ${task.verificationFailures} verify-fails` : ''}`}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    task.status === 'completed' || task.status === 'merged'
                      ? 'bg-success'
                      : task.status === 'failed' || task.status === 'conflict'
                        ? 'bg-destructive'
                        : 'bg-primary',
                  )}
                />
                <span className="max-w-[84px] truncate">{task.taskId}</span>
                {task.durationMs !== null && (
                  <span className="text-muted-foreground">
                    {formatMilliseconds(task.durationMs)}
                  </span>
                )}
                {task.filesTouched > 0 && (
                  <span className="flex items-center gap-0.5 text-muted-foreground">
                    <FileCode2 className="h-2.5 w-2.5" />
                    {task.filesTouched}
                  </span>
                )}
              </button>
            ))}
          </section>
        )}

        <section className="border-b border-border/70 px-4 py-3">
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-[1.35fr_1fr_1fr_1fr_1fr_auto]">
            <Field
              icon={<Search />}
              placeholder={t('activity:chronicle.searchEventEvidence')}
              value={draft.text}
              onChange={(text) => setDraft((v) => ({ ...v, text }))}
              onEnter={apply}
            />
            <Field
              placeholder={t('activity:chronicle.fileOrDirectory')}
              value={draft.path}
              onChange={(path) => setDraft((v) => ({ ...v, path }))}
              onEnter={apply}
            />
            <Field
              placeholder={t('activity:chronicle.provider')}
              value={draft.providerId}
              onChange={(providerId) => setDraft((v) => ({ ...v, providerId }))}
              onEnter={apply}
            />
            <Field
              placeholder={t('activity:chronicle.model')}
              value={draft.modelId}
              onChange={(modelId) => setDraft((v) => ({ ...v, modelId }))}
              onEnter={apply}
            />
            <Field
              placeholder={t('activity:chronicle.session')}
              value={draft.sessionId}
              onChange={(sessionId) => setDraft((v) => ({ ...v, sessionId }))}
              onEnter={apply}
            />
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={apply}
                className="rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
              >
                <Filter className="mr-1 inline h-3 w-3" />
                {t('activity:chronicle.apply')}
              </button>
              <button
                type="button"
                onClick={clear}
                className="rounded-md border border-border px-2.5 text-xs hover:bg-muted"
              >
                {t('activity:chronicle.clear')}
              </button>
            </div>
          </div>
        </section>

        <section className="flex items-center gap-1 overflow-x-auto border-b border-border/70 px-4 py-2">
          {signals.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSignal(item.id)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-colors [&>svg]:h-3.5 [&>svg]:w-3.5',
                signal === item.id
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {item.icon}
              {t(item.labelKey)}
              <span className="ml-1 rounded bg-background/70 px-1 font-mono text-[9px]">
                {signalTotal(summary, item.id, meta.total)}
              </span>
            </button>
          ))}
          <div className="ml-auto hidden items-center gap-3 pl-4 text-[9px] text-muted-foreground lg:flex">
            <span>{meta.total.toLocaleString()} matched</span>
            <span>{meta.sourceFiles} journal files</span>
            {meta.invalidLines > 0 && (
              <span className="text-warning">{meta.invalidLines} invalid lines</span>
            )}
          </div>
        </section>

        {chronicleStatus && <ChroniclePipelineStrip status={chronicleStatus} />}
        {health && <RuntimeStrip health={health} />}
        <section className="flex gap-4 overflow-x-auto border-b border-border/60 bg-muted/[0.18] px-4 py-2">
          {(['providerId', 'modelId', 'outcome'] as const).map((field) => (
            <div key={field} className="flex shrink-0 items-center gap-1">
              <span className="mr-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                {field.replace('Id', '')}
              </span>
              {(facets[field] ?? []).slice(0, 4).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => run({ ...query, [field]: item.value })}
                  className="rounded-full border border-border bg-card px-2 py-0.5 text-[9px] hover:border-primary/50"
                >
                  {item.value} <b>{item.count}</b>
                </button>
              ))}
            </div>
          ))}
        </section>

        <div className="grid grid-cols-[92px_minmax(190px,1.25fr)_110px_minmax(180px,1fr)_minmax(140px,.8fr)_24px] gap-3 border-b border-border/60 bg-muted/20 px-4 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>{t('activity:chronicle.time')}</span>
          <span>{t('activity:chronicle.signal')}</span>
          <span>{t('activity:chronicle.outcome')}</span>
          <span>{t('activity:chronicle.modelAgent')}</span>
          <span>{t('activity:chronicle.resource')}</span>
          <span />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <Empty text={error} />
          ) : !loading && visible.length === 0 ? (
            <Empty text="No coding evidence matches these filters." />
          ) : (
            <div className="divide-y divide-border/40">
              {eventPage.pageItems.map((event) => (
                <EventRow
                  key={event.eventId}
                  event={event}
                  active={selected?.eventId === event.eventId}
                  onClick={() => open(event)}
                />
              ))}
            </div>
          )}
        </div>
        <Pagination
          page={eventPage.page}
          pageSize={eventPage.pageSize}
          totalItems={eventPage.totalItems}
          onPageChange={eventPage.setPage}
          itemLabel="events"
        />
      </main>
      {selected && (
        <aside className="w-[440px] max-w-[48vw] shrink-0 overflow-auto border-l border-border bg-card/60 shadow-[-12px_0_32px_hsl(var(--background)/.35)]">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card/95 px-4 py-3 backdrop-blur">
            <div>
              <div className="text-xs font-semibold">{t('activity:chronicle.evidenceLineage')}</div>
              <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                #{selected.sequence} · {selected.eventId}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded p-1 hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <Detail event={selected} graph={graph} />
        </aside>
      )}
    </div>
  );
}

type Health = {
  eventLoop?: { utilization?: number; delayP95Ms?: number };
  memory?: { heapUsedBytes?: number };
  chronicle?: { pendingEvents?: number; rejectedEvents?: number; largestBatch?: number };
};
const emptyFamilies = {
  llm: 0,
  agent: 0,
  tool: 0,
  file: 0,
  memory: 0,
  task: 0,
  decision: 0,
  runtime: 0,
};
const emptySummary: ChronicleSummary = {
  logicalRequests: 0,
  modelAttempts: 0,
  completedAttempts: 0,
  failedAttempts: 0,
  scheduledRetries: 0,
  fallbacks: 0,
  providers: 0,
  models: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
  providerAvgDurationMs: 0,
  providerP95DurationMs: 0,
  toolCalls: 0,
  completedTools: 0,
  failedTools: 0,
  toolAvgDurationMs: 0,
  processes: 0,
  failedProcesses: 0,
  fileEvents: 0,
  uniqueFiles: 0,
  agentEvents: 0,
  uniqueAgents: 0,
  decisions: 0,
  escalations: 0,
  failures: 0,
  cancellations: 0,
  families: { ...emptyFamilies },
  failuresByFamily: { ...emptyFamilies },
};
function signalTotal(summary: ChronicleSummary, signal: Signal, total: number) {
  if (signal === 'all') return total;
  if (signal === 'llm') return summary.families.llm;
  if (signal === 'agents') return summary.families.agent;
  if (signal === 'tools') return summary.families.tool;
  if (signal === 'files') return summary.families.file;
  return summary.failures;
}
function cacheRatio(summary: ChronicleSummary) {
  const total = summary.inputTokens + summary.cacheReadTokens;
  return total ? (summary.cacheReadTokens / total) * 100 : 0;
}
function matchesSignal(event: ChronicleEventView, signal: Signal) {
  if (signal === 'all') return true;
  if (signal === 'llm') return /^(provider|token|context|compaction)\./.test(event.eventType);
  if (signal === 'agents') return /^(agent|subagent|delegate|fleet|sdd)\./.test(event.eventType);
  if (signal === 'tools') return /^(tool|process|mcp|network)\./.test(event.eventType);
  if (signal === 'files')
    return event.resource?.kind === 'file' || /^(file|worktree|storage)\./.test(event.eventType);
  return (
    event.outcome === 'failure' ||
    /(?:failed|error|retry|fallback|blocked|conflict)/i.test(event.eventType)
  );
}
function formatDuration(ns: number) {
  if (!ns) return '—';
  const ms = ns / 1e6;
  return ms < 1
    ? `${(ns / 1e3).toFixed(0)}µs`
    : ms < 1000
      ? `${ms.toFixed(1)}ms`
      : `${(ms / 1000).toFixed(1)}s`;
}
function formatMilliseconds(ms: number) {
  if (!ms) return '—';
  return ms < 1
    ? `${(ms * 1000).toFixed(0)}µs`
    : ms < 1000
      ? `${ms.toFixed(1)}ms`
      : `${(ms / 1000).toFixed(1)}s`;
}
function Field({
  placeholder,
  value,
  onChange,
  onEnter,
  icon,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 focus-within:border-primary/60">
      {icon && <span className="text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
      <input
        className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter();
        }}
      />
    </label>
  );
}
function Insight({
  icon,
  label,
  value,
  detail,
  tone = 'normal',
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  detail: string;
  tone?: 'normal' | 'danger';
}) {
  return (
    <div className="min-w-0 border-r border-border/60 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="text-primary [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-xl font-semibold tabular-nums',
          tone === 'danger' && 'text-destructive',
        )}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="mt-0.5 truncate text-[9px] text-muted-foreground">{detail}</div>
    </div>
  );
}
function RuntimeStrip({ health }: { health: Health }) {
  const { t } = useAppTranslation();
  return (
    <section className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border/60 bg-success/[0.025] px-4 py-1.5 font-mono text-[9px] text-muted-foreground">
      <span className="font-sans font-semibold uppercase tracking-wider text-success">
        {t('activity:chronicle.collectorHealthy')}
      </span>
      <span>
        ELU{' '}
        <b className="text-foreground">
          {((health.eventLoop?.utilization ?? 0) * 100).toFixed(1)}%
        </b>
      </span>
      <span>
        p95 <b className="text-foreground">{(health.eventLoop?.delayP95Ms ?? 0).toFixed(1)}ms</b>
      </span>
      <span>
        heap{' '}
        <b className="text-foreground">
          {((health.memory?.heapUsedBytes ?? 0) / 1048576).toFixed(0)}MB
        </b>
      </span>
      <span>
        queue <b className="text-foreground">{health.chronicle?.pendingEvents ?? 0}</b>
      </span>
      <span>
        dropped{' '}
        <b className={cn((health.chronicle?.rejectedEvents ?? 0) > 0 && 'text-destructive')}>
          {health.chronicle?.rejectedEvents ?? 0}
        </b>
      </span>
    </section>
  );
}
function EventRow({
  event,
  active,
  onClick,
}: {
  event: ChronicleEventView;
  active: boolean;
  onClick: () => void;
}) {
  const at = event.occurredAt ?? event.observedAt;
  const actor = event.runtime?.modelId ?? event.scope.agentId ?? event.runtime?.providerId ?? '—';
  const resource =
    event.resource?.path ?? event.resource?.id ?? event.correlation.toolCallId ?? '—';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'grid w-full grid-cols-[92px_minmax(190px,1.25fr)_110px_minmax(180px,1fr)_minmax(140px,.8fr)_24px] items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/45',
        active && 'bg-primary/[0.07]',
      )}
    >
      <span className="font-mono text-[9px] text-muted-foreground">
        {new Date(at).toLocaleTimeString()}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            event.outcome === 'failure'
              ? 'bg-destructive'
              : event.outcome === 'success'
                ? 'bg-success'
                : 'bg-primary',
          )}
        />
        <span className="truncate font-mono text-[11px] font-medium">{event.eventType}</span>
      </span>
      <span className={cn('w-fit rounded px-1.5 py-0.5 text-[9px]', outcomeClass(event.outcome))}>
        {event.outcome ?? 'unknown'}
      </span>
      <span className="truncate font-mono text-[9px] text-muted-foreground">{actor}</span>
      <span className="truncate font-mono text-[9px] text-muted-foreground">{resource}</span>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
    </button>
  );
}
function Detail({
  event,
  graph,
}: {
  event: ChronicleEventView;
  graph: ChronicleGraphResult | null;
}) {
  const { t } = useAppTranslation();
  const sections = useMemo(
    () =>
      [
        ['Scope', event.scope],
        ['Correlation', event.correlation],
        ['Runtime', event.runtime],
        ['Resource', event.resource],
        ['Attributes', event.attributes],
        ['Tags', event.tags],
      ] as const,
    [event],
  );
  return (
    <div className="p-4">
      <div className="mb-4 rounded-lg border border-border bg-background/60 p-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              event.outcome === 'failure'
                ? 'bg-destructive'
                : event.outcome === 'success'
                  ? 'bg-success'
                  : 'bg-primary',
            )}
          />
          <span className="font-mono text-xs font-semibold">{event.eventType}</span>
        </div>
        <div className="mt-2 flex gap-4 text-[9px] text-muted-foreground">
          <span>{new Date(event.occurredAt ?? event.observedAt).toLocaleString()}</span>
          <span>{formatDuration(Number(event.durationNs ?? 0))}</span>
        </div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Badge
          icon={<ShieldCheck />}
          label={t('activity:chronicle.evidenceHash')}
          value={event.hash.slice(0, 16)}
        />
        <Badge
          icon={<Database />}
          label={t('activity:chronicle.sequence')}
          value={String(event.sequence)}
        />
      </div>
      {graph && (
        <section className="mb-4">
          <h3 className="mb-1.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            Lineage · {graph.nodes.length} nodes · {graph.edges.length} edges
          </h3>
          <div className="space-y-1 rounded-md border border-border bg-background/70 p-2">
            {graph.edges.slice(0, 40).map((edge, index) => (
              <div
                key={`${edge.from}-${edge.to}-${edge.kind}-${index}`}
                className="flex items-center gap-2 font-mono text-[9px]"
              >
                <span
                  className={cn(
                    'rounded px-1',
                    edge.confidence === 'explicit'
                      ? 'bg-success/10 text-success'
                      : edge.confidence === 'inferred'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-primary/10 text-primary',
                  )}
                >
                  {edge.confidence}
                </span>
                <span className="text-muted-foreground">{edge.kind}</span>
                <span className="truncate">
                  {graph.nodes.find((node) => node.eventId === edge.from)?.eventType} →{' '}
                  {graph.nodes.find((node) => node.eventId === edge.to)?.eventType}
                </span>
              </div>
            ))}
          </div>
          {graph.truncated && (
            <p className="mt-1 text-[9px] text-warning">
              {t('activity:chronicle.lineageTruncatedAtSafetyLimit')}
            </p>
          )}
        </section>
      )}
      {sections.map(
        ([label, value]) =>
          value && (
            <section key={label} className="mb-4">
              <h3 className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </h3>
              <pre className="overflow-auto rounded-md border border-border bg-background/70 p-3 font-mono text-[9px] leading-relaxed">
                {JSON.stringify(value, null, 2)}
              </pre>
            </section>
          ),
      )}
    </div>
  );
}
function Badge({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-1 text-[8px] uppercase text-muted-foreground">
        <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[9px]">{value}</div>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
function outcomeClass(outcome?: string) {
  return outcome === 'failure'
    ? 'bg-destructive/10 text-destructive'
    : outcome === 'success'
      ? 'bg-success/10 text-success'
      : outcome === 'started'
        ? 'bg-primary/10 text-primary'
        : 'bg-muted text-muted-foreground';
}
