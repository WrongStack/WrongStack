import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Clock3,
  Download,
  FileCode2,
  GitBranch,
  History,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChronicleInsights } from './ChronicleInsights';
import { ChronicleManifest } from './ChronicleManifest';
import {
  chronicleFileName,
  chronicleJsonl,
  chronicleLineageMarkdown,
  chronicleMarkdown,
} from './chronicle-export';
import { chronicleManifest, withoutManifest } from './chronicle-manifest';
import {
  chronicleGraph,
  chronicleQuery,
  eventTitle,
  evidenceText,
  initialChronicleFilters,
} from './chronicle-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { GraphCanvas } from './GraphCanvas';

const facetFields = ['eventType', 'outcome', 'providerId', 'modelId', 'agentId'] as const;
export function ProjectChronicle({
  command,
  onOpenFile,
  onOpenSession,
}: {
  command: EngineCommand;
  onOpenFile: (path: string) => void;
  /** Opens this project's conversation history at a core session id. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const { t } = useDesktopText();
  const outcome = (value: unknown) =>
    t(`chronicleView.outcome.${String(value ?? 'unknown')}`, {
      defaultValue: String(value ?? 'unknown'),
    });
  const [draft, setDraft] = useState(initialChronicleFilters),
    [filters, setFilters] = useState(initialChronicleFilters);
  const [data, setData] = useState<Record<string, unknown>>({}),
    [facets, setFacets] = useState<Record<string, unknown>>({});
  const [health, setHealth] = useState<Record<string, unknown>>({}),
    [graphData, setGraphData] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null),
    [view, setView] = useState<'timeline' | 'graph'>('timeline');
  const [error, setError] = useState(''),
    [healthError, setHealthError] = useState(''),
    [busy, setBusy] = useState(false),
    [graphBusy, setGraphBusy] = useState(false);
  const generation = useRef(0),
    graphGeneration = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      const id = ++generation.current;
      setBusy(true);
      setError('');
      try {
        const query = chronicleQuery(filters);
        const result = await command(
          'chronicle.query',
          { query: { ...query, ...(cursor ? { cursor } : {}) } },
          ['chronicle.query_result', 'chronicle.error'],
          { timeoutMs: 45000 },
        );
        if (id !== generation.current) return;
        if (result['message'] && !result['events']) throw new Error(String(result['message']));
        setData((current) =>
          cursor
            ? { ...result, events: [...entries(current['events']), ...entries(result['events'])] }
            : result,
        );
      } catch (e) {
        if (id === generation.current) setError(String(e instanceof Error ? e.message : e));
      } finally {
        if (id === generation.current) setBusy(false);
      }
    },
    [command, filters],
  );
  const refreshHealth = useCallback(async () => {
    try {
      const result = await command(
        'chronicle.status',
        {},
        ['chronicle.status_result', 'chronicle.error'],
        { timeoutMs: 45000 },
      );
      if (result['message'] && !result['pipeline']) throw new Error(String(result['message']));
      setHealth(result);
      setHealthError('');
    } catch (e) {
      setHealthError(String(e instanceof Error ? e.message : e));
    }
  }, [command]);
  useEffect(() => {
    let current = true;
    setFacets({});
    setSelected(null);
    setView('timeline');
    setGraphData(null);
    graphGeneration.current++;
    void load();
    void command(
      'chronicle.facets',
      { fields: [...facetFields], query: chronicleQuery(filters), limit: 100 },
      ['chronicle.facets_result', 'chronicle.error'],
      { timeoutMs: 45000 },
    )
      .then((result) => {
        if (current && result['values']) setFacets(record(result['values']));
      })
      .catch(() => {});
    return () => {
      current = false;
      generation.current++;
      graphGeneration.current++;
    };
  }, [load, command, filters]);
  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);
  const trace = async (event: Record<string, unknown>) => {
    const id = ++graphGeneration.current;
    setSelected(event);
    setGraphBusy(true);
    setError('');
    setView('graph');
    setGraphData(null);
    try {
      const result = await command(
        'chronicle.graph',
        { seed: { eventId: event['eventId'] }, hops: 2, maxNodes: 160 },
        ['chronicle.graph_result', 'chronicle.error'],
        { timeoutMs: 45000 },
      );
      if (id !== graphGeneration.current) return;
      if (result['message'] && !result['nodes']) throw new Error(String(result['message']));
      setGraphData(result);
    } catch (e) {
      if (id === graphGeneration.current) setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (id === graphGeneration.current) setGraphBusy(false);
    }
  };
  const rows = entries(data['events']),
    summary = record(data['summary']);
  const [notice, setNotice] = useState('');
  /** Exports the loaded events only; older pages that were not loaded are not fetched. */
  /** Downloads text as a file; the notice says what was requested. */
  const download = (content: string, type: string, name: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  /** Exports the traced lineage exactly as the engine returned it, or as readable tables. */
  const exportLineage = (format: 'md' | 'json') => {
    if (!graphData) return;
    const exportedAt = new Date().toISOString();
    const seed = String(selected?.['eventId'] ?? '');
    download(
      format === 'md'
        ? chronicleLineageMarkdown(graphData, { seed, exportedAt })
        : `${JSON.stringify(graphData, null, 2)}\n`,
      format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json',
      chronicleFileName(exportedAt, format, 'lineage'),
    );
    setNotice(
      t('chronicleView.exportLineage', {
        events: graph.nodes.length,
        relations: graph.edges.length,
      }),
    );
  };
  const exportEvents = (format: 'md' | 'jsonl') => {
    const exportedAt = new Date().toISOString();
    const applied = Object.entries(filters)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => `${key} ${String(value)}`);
    const more = typeof data['nextCursor'] === 'string';
    const filterText = [
      applied.length ? `filters: ${applied.join(', ')}` : 'no filters',
      more && 'older events not loaded',
    ]
      .filter(Boolean)
      .join(' · ');
    const content =
      format === 'md'
        ? chronicleMarkdown(rows, { filters: filterText, exportedAt, total: data['total'] })
        : chronicleJsonl(rows);
    const url = URL.createObjectURL(
      new Blob([content], {
        type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/x-ndjson',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = chronicleFileName(exportedAt, format);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const one = rows.length === 1;
    setNotice(
      t(
        more
          ? one
            ? 'chronicleView.exportOneMore'
            : 'chronicleView.exportManyMore'
          : one
            ? 'chronicleView.exportOne'
            : 'chronicleView.exportMany',
        { n: rows.length },
      ),
    );
  };
  const graph = useMemo(() => chronicleGraph(graphData), [graphData]);
  const pipeline = record(health['pipeline']),
    journal = record(health['journal']),
    watcher = record(health['watcher']);
  return (
    <section className="project-chronicle" aria-label={t('chronicleView.label')}>
      <header className="studio-heading">
        <div>
          <h1>{t('chronicleView.title')}</h1>
          <p>{t('chronicleView.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            void load();
            void refreshHealth();
          }}
        >
          <RefreshCw size={14} />
          {t('chronicleView.refresh')}
        </button>
      </header>
      <ChronicleInsights command={command} onOpenFile={onOpenFile} />
      <div className="chronicle-metrics">
        {[
          ['total', data['total']],
          ['modelAttempts', summary['modelAttempts']],
          ['toolCalls', summary['toolCalls']],
          ['uniqueFiles', summary['uniqueFiles']],
          ['failures', summary['failures']],
          [
            'cost',
            typeof summary['estimatedCostUsd'] === 'number'
              ? `$${summary['estimatedCostUsd'].toFixed(4)}`
              : undefined,
          ],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <span>{t(`chronicleView.metric.${String(label)}`)}</span>
            <strong>{value === undefined ? '—' : String(value)}</strong>
          </div>
        ))}
      </div>
      <form
        className="chronicle-filters"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            chronicleQuery(draft, {
              invalidDate: t('chronicleView.invalidDate'),
              endBeforeStart: t('chronicleView.endBeforeStart'),
            });
            setFilters({ ...draft });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        <label className="chronicle-text-filter">
          <Search size={14} />
          <input
            aria-label={t('chronicleView.search')}
            placeholder={t('chronicleView.searchPlaceholder')}
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
        </label>
        <label>
          {t('chronicleView.path')}
          <input
            aria-label={t('chronicleView.pathLabel')}
            placeholder="src/app.ts"
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          />
        </label>
        {facetFields.map((field) => (
          <label key={field}>
            {t(`chronicleView.facet.${field}`)}
            <select
              aria-label={t(`chronicleView.facetAria.${field}`)}
              value={draft[field]}
              onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
            >
              <option value="">{t('chronicleView.any')}</option>
              {entries(facets[field]).map((item) => (
                <option key={String(item['value'])} value={String(item['value'])}>
                  {String(item['value'])} ({String(item['count'])})
                </option>
              ))}
            </select>
          </label>
        ))}
        <details className="chronicle-extra-filters">
          <summary>{t('chronicleView.timeRange')}</summary>
          <div>
            <label>
              {t('chronicleView.from')}
              <input
                type="datetime-local"
                aria-label={t('chronicleView.fromLabel')}
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </label>
            <label>
              {t('chronicleView.to')}
              <input
                type="datetime-local"
                aria-label={t('chronicleView.toLabel')}
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
            <label>
              {t('chronicleView.session')}
              <input
                aria-label={t('chronicleView.sessionLabel')}
                value={draft.sessionId}
                onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })}
              />
            </label>
          </div>
        </details>
        <button className="button primary small" type="submit" disabled={busy}>
          {t('chronicleView.apply')}
        </button>
        <button
          className="button secondary small"
          type="button"
          disabled={busy}
          onClick={() => {
            const defaults = initialChronicleFilters();
            setDraft(defaults);
            setFilters(defaults);
          }}
        >
          {t('chronicleView.reset')}
        </button>
      </form>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="field-help">
          {notice}
        </p>
      )}
      <div className="chronicle-body">
        <div className="chronicle-main">
          <header className="chronicle-list-heading">
            <Activity size={15} />
            <strong>
              {view === 'timeline' ? t('chronicleView.timeline') : t('chronicleView.lineage')}
            </strong>
            <span>
              {view === 'timeline'
                ? t('chronicleView.loaded', {
                    loaded: rows.length,
                    total: String(data['total'] ?? '…'),
                  })
                : t('chronicleView.graphCount', {
                    events: t('counts.events', { count: graph.nodes.length }),
                    relations: t('counts.relationships', { count: graph.edges.length }),
                  })}
            </span>
            {view === 'timeline' && rows.length > 0 && (
              <>
                <button type="button" disabled={busy} onClick={() => exportEvents('md')}>
                  <Download size={13} />
                  {t('chronicleView.exportMarkdown')}
                </button>
                <button type="button" disabled={busy} onClick={() => exportEvents('jsonl')}>
                  <Download size={13} />
                  {t('chronicleView.exportJsonl')}
                </button>
              </>
            )}
            {view === 'graph' && graphData && !graphBusy && (
              <>
                <button type="button" onClick={() => exportLineage('md')}>
                  <Download size={13} />
                  {t('chronicleView.exportLineageMarkdown')}
                </button>
                <button type="button" onClick={() => exportLineage('json')}>
                  <Download size={13} />
                  {t('chronicleView.exportLineageJson')}
                </button>
              </>
            )}
            {view === 'graph' && (
              <button
                type="button"
                onClick={() => {
                  graphGeneration.current++;
                  setGraphBusy(false);
                  setView('timeline');
                }}
              >
                <ArrowLeft size={13} />
                {t('chronicleView.back')}
              </button>
            )}
          </header>
          {view === 'graph' ? (
            <>
              <GraphCanvas
                graph={graph}
                selected={String(selected?.['eventId'] ?? '')}
                onSelect={(id) =>
                  setSelected(graph.nodes.find((node) => node.id === id)?.data ?? null)
                }
                label={t('chronicleView.graphLabel')}
                layout="layers"
                minimap
                empty={
                  <p>{graphBusy ? t('chronicleView.following') : t('chronicleView.noGraph')}</p>
                }
              />
              {graphData?.['truncated'] === true && (
                <p className="chronicle-footnote">{t('chronicleView.truncated')}</p>
              )}
              <p className="chronicle-footnote">{t('chronicleView.evidenceClass')}</p>
            </>
          ) : (
            <>
              {busy && !rows.length && (
                <div className="chronicle-empty">
                  <LoaderCircle className="spin" size={24} />
                  <p>{t('chronicleView.reading')}</p>
                </div>
              )}
              {!busy && !rows.length && (
                <div className="chronicle-empty">
                  <Clock3 size={32} />
                  <h2>{t('chronicleView.noEvents')}</h2>
                  <p>{t('chronicleView.noEventsHint')}</p>
                </div>
              )}
              <div className="chronicle-events">
                {rows.map((event) => {
                  const resource = record(event['resource']),
                    scope = record(event['scope']),
                    runtime = record(event['runtime']);
                  return (
                    <button
                      key={String(event['eventId'])}
                      type="button"
                      aria-label={t('chronicleView.inspect', { title: eventTitle(event) })}
                      className={
                        event['eventId'] === selected?.['eventId'] ? 'chronicle-event-selected' : ''
                      }
                      onClick={() => setSelected(event)}
                    >
                      <span
                        className={`chronicle-outcome outcome-${String(event['outcome'] ?? 'unknown')}`}
                      />
                      <time dateTime={String(event['occurredAt'])}>
                        {new Date(String(event['occurredAt'])).toLocaleTimeString()}
                        <small>{new Date(String(event['occurredAt'])).toLocaleDateString()}</small>
                      </time>
                      <div>
                        <span>{String(event['eventType'])}</span>
                        <strong>{eventTitle(event)}</strong>
                        <small>
                          {String(
                            resource['path'] ??
                              resource['id'] ??
                              runtime['modelId'] ??
                              scope['agentId'] ??
                              t('chronicleView.projectEvent'),
                          )}
                        </small>
                      </div>
                      <span className="chronicle-event-result">{outcome(event['outcome'])}</span>
                      <ArrowRight size={13} />
                    </button>
                  );
                })}
              </div>
              {typeof data['nextCursor'] === 'string' && (
                <button
                  type="button"
                  className="button secondary chronicle-load-more"
                  disabled={busy}
                  onClick={() => void load(String(data['nextCursor']))}
                >
                  {busy ? t('chronicleView.loading') : t('chronicleView.loadOlder')}
                </button>
              )}
              <p className="chronicle-footnote">
                {t('chronicleView.scanFacts', {
                  partitions: String(data['sourceFiles'] ?? 0),
                  scanned: String(data['scannedEvents'] ?? 0),
                  invalid: String(data['invalidLines'] ?? 0),
                })}
              </p>
            </>
          )}
        </div>
        {selected ? (
          <ChronicleDetail
            event={selected}
            onTrace={() => void trace(selected)}
            onClose={() => setSelected(null)}
            onOpenFile={onOpenFile}
            onOpenSession={onOpenSession}
          />
        ) : (
          <aside className="chronicle-inspector chronicle-inspector-empty">
            <GitBranch size={30} />
            <h2>{t('chronicleView.followTitle')}</h2>
            <p>{t('chronicleView.followHint')}</p>
          </aside>
        )}
      </div>
      <details className="chronicle-collector">
        <summary>
          <Activity size={14} />
          {t('chronicleView.health')}
          <span>
            {healthError
              ? t('chronicleView.unavailable')
              : health['mode']
                ? t(
                    watcher['active'] === true
                      ? 'chronicleView.watching'
                      : 'chronicleView.notWatching',
                    { mode: String(health['mode']) },
                  )
                : t('chronicleView.checking')}
          </span>
        </summary>
        {healthError ? (
          <p role="alert">{healthError}</p>
        ) : (
          <dl>
            {[
              ['collector', pipeline['collection']],
              ['processor', pipeline['processing']],
              ['storage', pipeline['storage']],
              ['pending', journal['pendingEvents']],
              ['rejected', journal['rejectedEvents']],
              ['watched', watcher['watchedFiles']],
              [
                'uptime',
                typeof health['uptimeMs'] === 'number'
                  ? t('chronicleView.seconds', { count: Math.round(health['uptimeMs'] / 1000) })
                  : undefined,
              ],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{t(`chronicleView.healthRow.${String(label)}`)}</dt>
                <dd>{value === undefined ? t('chronicleView.notReported') : String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </details>
    </section>
  );
}
function ChronicleDetail({
  event,
  onTrace,
  onClose,
  onOpenFile,
  onOpenSession,
}: {
  event: Record<string, unknown>;
  onTrace: () => void;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const resource = record(event['resource']),
    scope = record(event['scope']),
    runtime = record(event['runtime']),
    correlation = record(event['correlation']);
  const manifest = chronicleManifest(event['attributes']);
  const { t } = useDesktopText();
  return (
    <aside className="chronicle-inspector" aria-label={t('chronicleView.detail.label')}>
      <header>
        <span>{t('chronicleView.detail.eyebrow')}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t('chronicleView.detail.close')}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <span className={`chronicle-result-badge outcome-${String(event['outcome'])}`}>
        {t(`chronicleView.outcome.${String(event['outcome'] ?? 'unknown')}`, {
          defaultValue: String(event['outcome'] ?? 'unknown'),
        })}
      </span>
      <h2>{eventTitle(event)}</h2>
      <p className="chronicle-event-type">{String(event['eventType'])}</p>
      <button type="button" className="button primary small" onClick={onTrace}>
        <GitBranch size={14} />
        {t('chronicleView.detail.trace')}
      </button>
      {typeof resource['path'] === 'string' && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onOpenFile(resource['path'] as string)}
        >
          <FileCode2 size={14} />
          {t('chronicleView.openFile')}
        </button>
      )}
      {onOpenSession && typeof scope['sessionId'] === 'string' && scope['sessionId'] && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onOpenSession(scope['sessionId'] as string)}
        >
          <History size={14} />
          {t('chronicleView.detail.history')}
        </button>
      )}
      <dl className="chronicle-event-facts">
        {[
          ['occurred', event['occurredAt']],
          ['persisted', event['persistedAt']],
          [
            'duration',
            typeof event['durationNs'] === 'string'
              ? `${(Number(event['durationNs']) / 1000000).toFixed(2)} ms`
              : undefined,
          ],
          ['agent', scope['agentId']],
          ['session', scope['sessionId']],
          ['task', scope['taskId']],
          ['provider', runtime['providerId']],
          ['model', runtime['modelId']],
          ['resource', resource['path'] ?? resource['id']],
          [
            'lines',
            resource['lineStart']
              ? `${resource['lineStart']}–${resource['lineEnd'] ?? resource['lineStart']}`
              : undefined,
          ],
        ]
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => (
            <div key={String(label)}>
              <dt>{t(`chronicleView.fact.${String(label)}`)}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
      </dl>
      {manifest && <ChronicleManifest manifest={manifest} />}
      <section className="chronicle-attributes">
        <h3>{t('chronicleView.detail.evidence')}</h3>
        {Object.entries(withoutManifest(event['attributes'])).map(([key, value]) => (
          <div key={key}>
            <h4>{key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')}</h4>
            <p>{evidenceText(value)}</p>
          </div>
        ))}
        {!Object.keys(withoutManifest(event['attributes'])).length && (
          <p>{t('chronicleView.detail.noEvidence')}</p>
        )}
      </section>
      <details className="chronicle-identities">
        <summary>{t('chronicleView.detail.integrity')}</summary>
        <dl>
          {[
            ['eventId', event['eventId']],
            ['trace', correlation['traceId']],
            ['span', correlation['spanId']],
            ['parentSpan', correlation['parentSpanId']],
            ['logicalRequest', correlation['logicalRequestId']],
            ['attempt', correlation['attemptId']],
            ['toolCall', correlation['toolCallId']],
            ['promptManifest', correlation['promptManifestId']],
            ['sequence', event['sequence']],
            ['hash', event['hash']],
            ['previousHash', event['previousHash']],
          ]
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => (
              <div key={String(label)}>
                <dt>{t(`chronicleView.id.${String(label)}`)}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
        </dl>
      </details>
    </aside>
  );
}
