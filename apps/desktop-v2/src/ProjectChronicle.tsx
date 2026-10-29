import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Clock3,
  Download,
  FileCode2,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChronicleInsights } from './ChronicleInsights';
import {
  chronicleFileName,
  chronicleJsonl,
  chronicleLineageMarkdown,
  chronicleMarkdown,
} from './chronicle-export';
import {
  chronicleGraph,
  chronicleQuery,
  eventTitle,
  evidenceText,
  initialChronicleFilters,
} from './chronicle-model';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { GraphCanvas } from './GraphCanvas';

const facetFields = ['eventType', 'outcome', 'providerId', 'modelId', 'agentId'] as const;
export function ProjectChronicle({
  command,
  onOpenFile,
}: {
  command: EngineCommand;
  onOpenFile: (path: string) => void;
}) {
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
      `Export requested for the lineage of ${graph.nodes.length} events and ${graph.edges.length} relationships.`,
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
    setNotice(
      `Export requested for the ${rows.length} loaded ${rows.length === 1 ? 'event' : 'events'}${more ? '; load older events first to include them' : ''}.`,
    );
  };
  const graph = useMemo(() => chronicleGraph(graphData), [graphData]);
  const pipeline = record(health['pipeline']),
    journal = record(health['journal']),
    watcher = record(health['watcher']);
  return (
    <section className="project-chronicle" aria-label="Project Chronicle">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">THE EVIDENCE BEHIND YOUR PROJECT</span>
          <h1>
            Chronicle<span className="heading-dot">.</span>
          </h1>
          <p>
            Follow work across agents, files, tools, and conversations. Keep every outcome in
            context.
          </p>
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
          Refresh journal
        </button>
      </header>
      <ChronicleInsights command={command} onOpenFile={onOpenFile} />
      <div className="chronicle-metrics">
        {[
          ['Matching events', data['total']],
          ['Model attempts', summary['modelAttempts']],
          ['Tool calls', summary['toolCalls']],
          ['Files touched', summary['uniqueFiles']],
          ['Failed outcomes', summary['failures']],
          [
            'Estimated cost',
            typeof summary['estimatedCostUsd'] === 'number'
              ? `$${summary['estimatedCostUsd'].toFixed(4)}`
              : undefined,
          ],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <span>{String(label)}</span>
            <strong>{value === undefined ? '—' : String(value)}</strong>
          </div>
        ))}
      </div>
      <form
        className="chronicle-filters"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            chronicleQuery(draft);
            setFilters({ ...draft });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        <label className="chronicle-text-filter">
          <Search size={14} />
          <input
            aria-label="Search Chronicle"
            placeholder="Find a decision, tool call, or outcome…"
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
        </label>
        <label>
          File path
          <input
            aria-label="Chronicle file path"
            placeholder="src/app.ts"
            value={draft.path}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
          />
        </label>
        {facetFields.map((field) => (
          <label key={field}>
            {field.replace(/([A-Z])/g, ' $1').replace('Id', '')}
            <select
              aria-label={`Chronicle ${field}`}
              value={draft[field]}
              onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
            >
              <option value="">Any</option>
              {entries(facets[field]).map((item) => (
                <option key={String(item['value'])} value={String(item['value'])}>
                  {String(item['value'])} ({String(item['count'])})
                </option>
              ))}
            </select>
          </label>
        ))}
        <details className="chronicle-extra-filters">
          <summary>Time range & session</summary>
          <div>
            <label>
              From (UTC)
              <input
                type="datetime-local"
                aria-label="Chronicle from UTC"
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </label>
            <label>
              To (UTC)
              <input
                type="datetime-local"
                aria-label="Chronicle to UTC"
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
            <label>
              Conversation ID
              <input
                aria-label="Chronicle session ID"
                value={draft.sessionId}
                onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })}
              />
            </label>
          </div>
        </details>
        <button className="button primary small" type="submit" disabled={busy}>
          Apply filters
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
          Reset filters
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
            <strong>{view === 'timeline' ? 'Project timeline' : 'Evidence lineage'}</strong>
            <span>
              {view === 'timeline'
                ? `${rows.length} of ${String(data['total'] ?? '…')} loaded`
                : `${graph.nodes.length} events · ${graph.edges.length} relationships`}
            </span>
            {view === 'timeline' && rows.length > 0 && (
              <>
                <button type="button" disabled={busy} onClick={() => exportEvents('md')}>
                  <Download size={13} />
                  Export Markdown
                </button>
                <button type="button" disabled={busy} onClick={() => exportEvents('jsonl')}>
                  <Download size={13} />
                  Export JSONL
                </button>
              </>
            )}
            {view === 'graph' && graphData && !graphBusy && (
              <>
                <button type="button" onClick={() => exportLineage('md')}>
                  <Download size={13} />
                  Export lineage Markdown
                </button>
                <button type="button" onClick={() => exportLineage('json')}>
                  <Download size={13} />
                  Export lineage JSON
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
                Back to timeline
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
                label="Chronicle evidence lineage"
                layout="layers"
                minimap
                empty={
                  <p>
                    {graphBusy
                      ? 'Following the event evidence…'
                      : 'No connected journal events were returned.'}
                  </p>
                }
              />
              {graphData?.['truncated'] === true && (
                <p className="chronicle-footnote">
                  The graph reached its 160-event limit. Select a closer event to explore its
                  neighborhood.
                </p>
              )}
              <p className="chronicle-footnote">
                Relationships retain the engine’s explicit, correlated, or inferred evidence
                classification.
              </p>
            </>
          ) : (
            <>
              {busy && !rows.length && (
                <div className="chronicle-empty">
                  <LoaderCircle className="spin" size={24} />
                  <p>Reading the project journal…</p>
                </div>
              )}
              {!busy && !rows.length && (
                <div className="chronicle-empty">
                  <Clock3 size={32} />
                  <h2>No events in this range.</h2>
                  <p>
                    Widen the time range or clear filters. Project work will appear here when the
                    engine records it.
                  </p>
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
                      aria-label={`Inspect ${eventTitle(event)}`}
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
                              'Project event',
                          )}
                        </small>
                      </div>
                      <span className="chronicle-event-result">
                        {String(event['outcome'] ?? 'unknown')}
                      </span>
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
                  {busy ? 'Loading…' : 'Load older events'}
                </button>
              )}
              <p className="chronicle-footnote">
                {String(data['sourceFiles'] ?? 0)} journal partitions ·{' '}
                {String(data['scannedEvents'] ?? 0)} events scanned ·{' '}
                {String(data['invalidLines'] ?? 0)} invalid entries. Summary totals cover all
                matching events.
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
          />
        ) : (
          <aside className="chronicle-inspector chronicle-inspector-empty">
            <GitBranch size={30} />
            <h2>Follow the evidence.</h2>
            <p>
              Select an event to see its actors, resource, timing, and original evidence. Trace its
              relationships across the project.
            </p>
          </aside>
        )}
      </div>
      <details className="chronicle-collector">
        <summary>
          <Activity size={14} />
          Journal health
          <span>
            {healthError
              ? 'Unavailable'
              : health['mode']
                ? `${String(health['mode'])} · ${watcher['active'] === true ? 'watching files' : 'watcher inactive'}`
                : 'Checking…'}
          </span>
        </summary>
        {healthError ? (
          <p role="alert">{healthError}</p>
        ) : (
          <dl>
            {[
              ['Collector', pipeline['collection']],
              ['Processor', pipeline['processing']],
              ['Storage', pipeline['storage']],
              ['Pending events', journal['pendingEvents']],
              ['Rejected events', journal['rejectedEvents']],
              ['Watched files', watcher['watchedFiles']],
              [
                'Uptime',
                typeof health['uptimeMs'] === 'number'
                  ? `${Math.round(health['uptimeMs'] / 1000)} seconds`
                  : undefined,
              ],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt>{String(label)}</dt>
                <dd>{value === undefined ? 'Not reported' : String(value)}</dd>
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
}: {
  event: Record<string, unknown>;
  onTrace: () => void;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const resource = record(event['resource']),
    scope = record(event['scope']),
    runtime = record(event['runtime']),
    correlation = record(event['correlation']);
  return (
    <aside className="chronicle-inspector" aria-label="Chronicle event details">
      <header>
        <span>EVENT EVIDENCE</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Close Chronicle event"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <span className={`chronicle-result-badge outcome-${String(event['outcome'])}`}>
        {String(event['outcome'] ?? 'unknown')}
      </span>
      <h2>{eventTitle(event)}</h2>
      <p className="chronicle-event-type">{String(event['eventType'])}</p>
      <button type="button" className="button primary small" onClick={onTrace}>
        <GitBranch size={14} />
        Trace related events
      </button>
      {typeof resource['path'] === 'string' && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onOpenFile(resource['path'] as string)}
        >
          <FileCode2 size={14} />
          Open project file
        </button>
      )}
      <dl className="chronicle-event-facts">
        {[
          ['Occurred', event['occurredAt']],
          ['Persisted', event['persistedAt']],
          [
            'Duration',
            typeof event['durationNs'] === 'string'
              ? `${(Number(event['durationNs']) / 1000000).toFixed(2)} ms`
              : undefined,
          ],
          ['Agent', scope['agentId']],
          ['Session', scope['sessionId']],
          ['Task', scope['taskId']],
          ['Provider', runtime['providerId']],
          ['Model', runtime['modelId']],
          ['Resource', resource['path'] ?? resource['id']],
          [
            'Lines',
            resource['lineStart']
              ? `${resource['lineStart']}–${resource['lineEnd'] ?? resource['lineStart']}`
              : undefined,
          ],
        ]
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => (
            <div key={String(label)}>
              <dt>{String(label)}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
      </dl>
      <section className="chronicle-attributes">
        <h3>Recorded evidence</h3>
        {Object.entries(record(event['attributes'])).map(([key, value]) => (
          <div key={key}>
            <h4>{key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')}</h4>
            <p>{evidenceText(value)}</p>
          </div>
        ))}
        {!Object.keys(record(event['attributes'])).length && (
          <p>No additional evidence was recorded for this event.</p>
        )}
      </section>
      <details className="chronicle-identities">
        <summary>Trace & integrity</summary>
        <dl>
          {[
            ['Event ID', event['eventId']],
            ['Trace', correlation['traceId']],
            ['Span', correlation['spanId']],
            ['Parent span', correlation['parentSpanId']],
            ['Logical request', correlation['logicalRequestId']],
            ['Attempt', correlation['attemptId']],
            ['Tool call', correlation['toolCallId']],
            ['Prompt manifest', correlation['promptManifestId']],
            ['Sequence', event['sequence']],
            ['Event hash', event['hash']],
            ['Previous hash', event['previousHash']],
          ]
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => (
              <div key={String(label)}>
                <dt>{String(label)}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
        </dl>
      </details>
    </aside>
  );
}
