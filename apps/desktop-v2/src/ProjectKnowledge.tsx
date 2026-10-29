import {
  ArrowRight,
  Brain,
  HeartPulse,
  Inbox,
  Network,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineHttp } from './engine-http';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { byteSize } from './file-model';
import { ProjectMemory } from './ProjectMemory';
import { SageAudience } from './SageAudience';
import { SageRecordDetails } from './SageRecordDetails';
import { sageRepairs } from './sage-model';
import { VectorMemoryAdd, VectorMemoryForget } from './VectorMemoryEntries';

export function ProjectKnowledge({
  command,
  http,
  initialMemoryId,
}: {
  command: EngineCommand;
  http: EngineHttp;
  initialMemoryId?: string;
}) {
  const [system, setSystem] = useState<'sage' | 'vector'>('sage'),
    [page, setPage] = useState('library'),
    [linked, setLinked] = useState<string | undefined>(initialMemoryId);
  const open = (id: string) => {
    setSystem('sage');
    setPage('library');
    setLinked(id);
  };
  return (
    <div className="project-knowledge">
      <nav className="memory-systems" aria-label="Project memory systems">
        <button
          type="button"
          aria-current={system === 'sage' ? 'page' : undefined}
          onClick={() => setSystem('sage')}
        >
          <Brain size={17} />
          <div>
            <strong>SAGE Memory</strong>
            <span>Durable knowledge, evidence & lifecycle</span>
          </div>
        </button>
        <button
          type="button"
          aria-current={system === 'vector' ? 'page' : undefined}
          onClick={() => setSystem('vector')}
        >
          <Network size={17} />
          <div>
            <strong>Vector Memory</strong>
            <span>Embedding store & semantic retrieval</span>
          </div>
        </button>
      </nav>
      {system === 'vector' ? (
        <VectorMemory http={http} onOpenSage={open} />
      ) : (
        <>
          <nav className="sage-workspace-nav" aria-label="SAGE workspace">
            {[
              { id: 'library', label: 'Knowledge & graph', Icon: Brain },
              { id: 'review', label: 'Review queue', Icon: Inbox },
              { id: 'health', label: 'Health & maintenance', Icon: HeartPulse },
              { id: 'search', label: 'Retrieval analysis', Icon: Search },
              { id: 'audience', label: 'Audience', Icon: Users },
            ].map(({ id, label, Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => setPage(id)}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </nav>
          {page === 'library' ? (
            <ProjectMemory command={command} {...(linked ? { initialMemoryId: linked } : {})} />
          ) : page === 'review' ? (
            <SageReview command={command} onOpen={open} />
          ) : page === 'health' ? (
            <SageHealth command={command} onOpen={open} />
          ) : page === 'audience' ? (
            <SageAudience command={command} onOpen={open} />
          ) : (
            <SageRetrieval command={command} onOpen={open} />
          )}
        </>
      )}
    </div>
  );
}
function SageReview({ command, onOpen }: { command: EngineCommand; onOpen: (id: string) => void }) {
  const [candidates, setCandidates] = useState<Record<string, unknown>[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [includeResolved, setIncludeResolved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [decision, setDecision] = useState<{ ids: string[]; action: 'accept' | 'reject' } | null>(null),
    [reason, setReason] = useState(''),
    [target, setTarget] = useState<Record<string, unknown> | null>(null);
  const load = useCallback(async () => {
    const reply = await command('memory.sage.listCandidates', { includeResolved }, [
      'memory.sage.listCandidates',
    ]);
    setCandidates(entries(reply['candidates']));
  }, [command, includeResolved]);
  useEffect(() => {
    void load().catch((e: unknown) => setError(String(e)));
  }, [load]);
  const resolve = async () => {
    if (!decision) return;
    setBusy(true);
    setError('');
    let completed = 0;
    try {
      for (const id of decision.ids) {
        await command(
          'memory.sage.candidateResolve',
          {
            candidateId: id,
            action: decision.action,
            reason: reason.trim() || 'Reviewed in project SAGE workspace',
          },
          ['memory.sage.candidateResolve'],
        );
        completed++;
      }
      setNotice(
        `${completed} proposal${completed === 1 ? '' : 's'} ${decision.action === 'accept' ? 'accepted' : 'kept or rejected'}.`,
      );
      setSelected([]);
      setDecision(null);
    } catch (error) {
      setError(`${completed} completed. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await load().catch(() => {});
      setBusy(false);
    }
  };
  const inspect = async (id: string) => {
    setError('');
    try {
      const reply = await command('memory.sage.get', { id }, ['memory.sage.get']);
      setTarget(record(reply['memory']));
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section className="sage-management">
      <header className="sage-page-heading">
        <div>
          <span className="eyebrow">HUMAN REVIEW · PROJECT KNOWLEDGE</span>
          <h1>
            Review queue<span className="heading-dot">.</span>
          </h1>
          <p>Inspect the evidence before accepting a proposal or keeping existing knowledge.</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load().catch((e) => setError(String(e)))}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </header>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      <div className="sage-review-toolbar">
        <label>
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(event) => setIncludeResolved(event.target.checked)}
          />
          Include resolved proposals
        </label>
        <span>{candidates.length} proposals</span>
        <button
          type="button"
          className="button secondary small"
          disabled={!selected.length || busy}
          onClick={() => {
            setReason('');
            setDecision({ ids: selected, action: 'reject' });
          }}
        >
          Keep / reject selected ({selected.length})
        </button>
        <button
          type="button"
          className="button primary small"
          disabled={!selected.length || busy}
          onClick={() => {
            setReason('');
            setDecision({ ids: selected, action: 'accept' });
          }}
        >
          Review selected
        </button>
      </div>
      <div className="sage-review-layout">
        <div className="sage-review-cards">
          {candidates.map((candidate) => {
            const id = String(candidate['id']),
              isPending = candidate['status'] === 'pending',
              targetId = String(candidate['targetMemoryId'] ?? candidate['memoryId'] ?? ''),
              advice = String(
                candidate['suggestedAction'] ??
                  (candidate['kind'] === 'memory_review' ? 'investigate' : 'store knowledge'),
              );
            return (
              <article className="sage-candidate-card" key={id}>
                <header>
                  <label>
                    <input
                      aria-label={`Select proposal ${id}`}
                      type="checkbox"
                      disabled={!isPending || busy}
                      checked={selected.includes(id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked ? [...current, id] : current.filter((i) => i !== id),
                        )
                      }
                    />
                    <span>{String(candidate['kind']).replaceAll('_', ' ')}</span>
                  </label>
                  <span className={`sage-candidate-status status-${String(candidate['status'])}`}>
                    {String(candidate['status'])}
                  </span>
                </header>
                <h2>{String(candidate['text'])}</h2>
                <p className="sage-review-reason">
                  {String(
                    candidate['reviewReason'] ??
                      candidate['reason'] ??
                      'A proposal to add project knowledge.',
                  )}
                </p>
                <dl>
                  <div>
                    <dt>Suggested action</dt>
                    <dd>{advice}</dd>
                  </div>
                  <div>
                    <dt>Confidence</dt>
                    <dd>
                      {typeof candidate['confidence'] === 'number'
                        ? `${Math.round(candidate['confidence'] * 100)}%`
                        : 'Not reported'}
                    </dd>
                  </div>
                  {candidate['targetRevision'] !== undefined && (
                    <div>
                      <dt>Target revision</dt>
                      <dd>{String(candidate['targetRevision'])}</dd>
                    </div>
                  )}
                </dl>
                {entries(candidate['anchors']).map((anchor, index) => (
                  <code key={index}>
                    {String(anchor['path'] ?? anchor['symbol'] ?? anchor['command'] ?? '')}
                  </code>
                ))}
                <footer>
                  {targetId && (
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => void inspect(targetId)}
                    >
                      Inspect target memory
                      <ArrowRight size={12} />
                    </button>
                  )}
                  {isPending && (
                    <>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={busy}
                        onClick={() => {
                          setReason('');
                          setDecision({ ids: [id], action: 'reject' });
                        }}
                      >
                        {candidate['kind'] === 'memory_review' ? 'Keep memory' : 'Reject proposal'}
                      </button>
                      <button
                        type="button"
                        className="button primary small"
                        disabled={busy}
                        onClick={() => {
                          setReason('');
                          setDecision({ ids: [id], action: 'accept' });
                        }}
                      >
                        Review & accept
                      </button>
                    </>
                  )}
                </footer>
              </article>
            );
          })}
          {!candidates.length && (
            <div className="sage-large-empty">
              <ShieldCheck size={40} />
              <h2>No pending review proposals.</h2>
              <p>
                Hygiene and agent workflows can propose additions, corrections, and retirement.
                Existing knowledge remains under your control.
              </p>
            </div>
          )}
        </div>
        {target && (
          <aside className="sage-target-inspector">
            <header>
              <h2>Target memory</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close target memory"
                onClick={() => setTarget(null)}
              >
                <X size={15} />
              </button>
            </header>
            <p>{String(target['text'])}</p>
            <SageRecordDetails memory={target} onOpen={onOpen} command={command} />
            <button
              type="button"
              className="button secondary"
              onClick={() => onOpen(String(target['id']))}
            >
              Open in SAGE library
              <ArrowRight size={13} />
            </button>
          </aside>
        )}
      </div>
      {decision && (
        <SageDecisionDialog
          title={
            decision.action === 'accept' ? 'Accept SAGE proposal' : 'Keep or reject SAGE proposal'
          }
          onClose={() => setDecision(null)}
          onConfirm={() => void resolve()}
          busy={busy}
        >
          <p>
            {decision.ids.length} proposal(s) selected. Accepting a retirement proposal can archive
            or delete its target. Investigation proposals must be inspected and corrected first.
          </p>
          {error && (
            <p className="session-error" role="alert">
              {error}
            </p>
          )}
          <label>
            Decision reason
            <textarea
              aria-label="SAGE decision reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </SageDecisionDialog>
      )}
    </section>
  );
}
function SageHealth({ command, onOpen }: { command: EngineCommand; onOpen: (id: string) => void }) {
  const [report, setReport] = useState<Record<string, unknown> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [repair, setRepair] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const load = useCallback(
    async (fix?: string) => {
      setBusy(true);
      setError('');
      try {
        const reply = await command(
          'memory.sage.doctor',
          fix ? { fix: [fix] } : {},
          ['memory.sage.doctor'],
          { timeoutMs: fix === 'hygiene' ? 360000 : 45000 },
        );
        setReport(record(reply['report']));
        if (fix)
          setNotice(
            entries(record(reply['report'])['fixesApplied'])
              .map((item) => String(item['detail'] ?? `${item['changed']} changed`))
              .join(' · '),
          );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setRepair(null);
      }
    },
    [command],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const metrics = record(report?.['metrics']),
    maintenance = record(report?.['maintenance']);
  const metric = (key: string, suffix = '') =>
    typeof metrics[key] === 'number' ? `${metrics[key]}${suffix}` : 'Not reported';
  return (
    <section className="sage-management">
      <header className="sage-page-heading">
        <div>
          <span className="eyebrow">SAGE DOCTOR · LIVE STORE REPORT</span>
          <h1>
            Health & maintenance<span className="heading-dot">.</span>
          </h1>
          <p>Inspect the store, retrieval usefulness, evidence gaps, and maintenance ownership.</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          Run diagnosis
        </button>
      </header>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      )}
      {busy && !report ? (
        <p className="file-quiet-state">Reading the SAGE store health report…</p>
      ) : (
        report && (
          <>
            <div className="sage-health-metrics">
              {[
                ['Active knowledge', metric('active')],
                ['All records', metric('total')],
                ['Relationships', metric('edges')],
                ['Pending reviews', metric('pendingCandidates')],
                ['Context injections', metric('injections')],
                ['Useful references', metric('uses')],
                [
                  'Injection precision',
                  typeof metrics['precision'] === 'number'
                    ? `${(metrics['precision'] * 100).toFixed(1)}%`
                    : 'Not reported',
                ],
                [
                  'Store size',
                  typeof metrics['dbBytes'] === 'number'
                    ? byteSize(metrics['dbBytes'])
                    : 'Not reported',
                ],
              ].map(([label, value]) => (
                <article key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </article>
              ))}
            </div>
            <div className="sage-health-layout">
              <section className="sage-health-checks">
                <h2>Findings</h2>
                {entries(report['checks']).map((check) => (
                  <article
                    className={`sage-health-check severity-${String(check['severity'])}`}
                    key={String(check['id'])}
                  >
                    <header>
                      <span>{String(check['severity'])}</span>
                      <strong>{String(check['title'])}</strong>
                      {typeof check['count'] === 'number' && <b>{check['count']}</b>}
                    </header>
                    <p>{String(check['summary'])}</p>
                    {Array.isArray(check['samples']) && (
                      <div className="sage-check-samples">
                        {check['samples'].slice(0, 8).map((sample, index) => (
                          <button
                            type="button"
                            key={index}
                            disabled={!/^(?:mem_)?[0-9A-HJKMNP-TV-Z]{26}$/i.test(String(sample))}
                            onClick={() => onOpen(String(sample))}
                          >
                            {String(sample)}
                          </button>
                        ))}
                      </div>
                    )}
                    {typeof check['fix'] === 'string' && (
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={busy}
                        onClick={() => setRepair(String(check['fix']))}
                      >
                        <Wrench size={12} />
                        Review repair
                      </button>
                    )}
                  </article>
                ))}
              </section>
              <aside className="sage-maintenance">
                <h2>Maintenance scheduler</h2>
                <dl>
                  {[
                    ['Owner', maintenance['owner']],
                    [
                      'State',
                      maintenance['running']
                        ? 'Running'
                        : maintenance['scheduled']
                          ? 'Scheduled'
                          : 'Not scheduled',
                    ],
                    ['Last run', maintenance['lastRunAt']],
                    ['Next run', maintenance['nextRunAt']],
                    [
                      'Last duration',
                      typeof maintenance['lastDurationMs'] === 'number'
                        ? `${maintenance['lastDurationMs']} ms`
                        : undefined,
                    ],
                  ].map(([key, value]) => (
                    <div key={String(key)}>
                      <dt>{String(key)}</dt>
                      <dd>{value === undefined ? 'Not reported' : String(value)}</dd>
                    </div>
                  ))}
                </dl>
                {Boolean(maintenance['lastError']) && (
                  <p className="session-error">{String(maintenance['lastError'])}</p>
                )}
                <h2>Named repairs</h2>
                {sageRepairs.map((fix) => (
                  <button
                    type="button"
                    key={fix.id}
                    disabled={busy}
                    onClick={() => setRepair(fix.id)}
                  >
                    <Wrench size={14} />
                    <span>
                      <strong>{fix.title}</strong>
                      <small>{fix.description}</small>
                    </span>
                    <ArrowRight size={13} />
                  </button>
                ))}
              </aside>
            </div>
          </>
        )
      )}
      {repair && (
        <SageDecisionDialog
          title="Apply SAGE repair"
          busy={busy}
          onClose={() => setRepair(null)}
          onConfirm={() => void load(repair)}
        >
          <p>{sageRepairs.find((item) => item.id === repair)?.description}</p>
          <p>
            This runs the engine’s named maintenance action. Its observed changes will be reported
            after completion.
          </p>
        </SageDecisionDialog>
      )}
    </section>
  );
}
function SageRetrieval({
  command,
  onOpen,
}: {
  command: EngineCommand;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [data, setData] = useState<Record<string, unknown>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false);
  const search = async () => {
    setBusy(true);
    setError('');
    try {
      setData(
        await command('memory.sage.searchBreakdown', { query, limit: 50, includeStale: stale }, [
          'memory.sage.searchBreakdown',
        ]),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sage-management">
      <header className="sage-page-heading">
        <div>
          <span className="eyebrow">WHY THIS KNOWLEDGE WAS RETRIEVED</span>
          <h1>
            Retrieval analysis<span className="heading-dot">.</span>
          </h1>
          <p>Inspect SAGE’s lexical, semantic and final ranking signals for a project query.</p>
        </div>
      </header>
      <form
        className="sage-retrieval-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Search size={17} />
        <input
          aria-label="SAGE retrieval query"
          placeholder="Ask about a decision, convention, file, or failure…"
          required
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={stale}
            onChange={(event) => setStale(event.target.checked)}
          />
          Include stale
        </label>
        <button type="submit" className="button primary" disabled={busy}>
          Analyze retrieval
        </button>
      </form>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {Boolean(data['source']) && (
        <p className="sage-retrieval-channel">
          {data['source'] === 'breakdown'
            ? 'Engine channel breakdown'
            : 'Lexical fallback reported by the engine'}
        </p>
      )}
      <div className="sage-search-hits">
        {entries(data['hits']).map((hit, index) => {
          const memory = record(hit['memory']);
          return (
            <button
              type="button"
              key={String(memory['id'] ?? index)}
              onClick={() => onOpen(String(memory['id']))}
            >
              <span className="sage-hit-rank">{index + 1}</span>
              <div>
                <span>
                  {String(memory['kind']).replaceAll('_', ' ')} · {String(hit['source'])}
                </span>
                <h2>{String(memory['text'])}</h2>
                <p>{Array.isArray(memory['tags']) ? memory['tags'].join(' · ') : ''}</p>
              </div>
              <dl>
                {[
                  ['Lexical', 'lexicalScore'],
                  ['Semantic', 'vectorScore'],
                  ['Final rank', 'finalScore'],
                ].map(([label, key]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {typeof hit[key!] === 'number' ? Number(hit[key!]).toFixed(4) : 'Unavailable'}
                    </dd>
                  </div>
                ))}
              </dl>
              <ArrowRight size={16} />
            </button>
          );
        })}
      </div>
      {busy && <p className="file-quiet-state">Searching SAGE…</p>}
      {!busy && Array.isArray(data['hits']) && !entries(data['hits']).length && (
        <p className="file-quiet-state">No memories matched this query.</p>
      )}
    </section>
  );
}
function VectorMemory({
  http,
  onOpenSage,
}: {
  http: EngineHttp;
  onOpenSage: (id: string) => void;
}) {
  const [status, setStatus] = useState<Record<string, unknown>>({}),
    [query, setQuery] = useState(''),
    [hits, setHits] = useState<Record<string, unknown>[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [statusRead, setStatusRead] = useState(0);
  useEffect(() => {
    let current = true;
    void statusRead;
    void http('/api/vector-memory/status')
      .then((data) => {
        if (current) setStatus(record(data));
      })
      .catch((e) => {
        if (current) setError(String(e));
      });
    return () => {
      current = false;
    };
  }, [http, statusRead]);
  const search = async () => {
    setBusy(true);
    setError('');
    try {
      const result = record(
        await http(
          `/api/vector-memory/search?q=${encodeURIComponent(query)}&limit=30&similarity=1`,
        ),
      );
      setHits(entries(result['hits']));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sage-management">
      <header className="sage-page-heading">
        <div>
          <span className="eyebrow">OPTIONAL EMBEDDING STORE</span>
          <h1>
            Vector Memory<span className="heading-dot">.</span>
          </h1>
          <p>Inspect vector-backed retrieval and verified links to durable SAGE records.</p>
        </div>
      </header>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {status['enabled'] === false ? (
        <div className="sage-large-empty">
          <Network size={42} />
          <h2>Vector Memory is not enabled for this project.</h2>
          <p>
            Your SAGE knowledge remains available in the SAGE Memory workspace. Enable a vector
            provider in the engine configuration to use this store.
          </p>
          <button type="button" className="button secondary" onClick={() => onOpenSage('')}>
            Open SAGE Memory
            <ArrowRight size={13} />
          </button>
        </div>
      ) : status['enabled'] === true ? (
        <>
          <div className="sage-health-metrics">
            {[
              ['Provider', status['providerId']],
              ['Model', status['modelId']],
              ['Dimensions', status['dimensions']],
              ['Vectors', status['vectors']],
            ].map(([key, value]) => (
              <article key={String(key)}>
                <span>{String(key)}</span>
                <strong>{String(value ?? 'Not reported')}</strong>
              </article>
            ))}
          </div>
          <VectorMemoryAdd http={http} onStored={() => setStatusRead((value) => value + 1)} />
          <form
            className="sage-retrieval-search"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <Search size={16} />
            <input
              aria-label="Vector memory query"
              value={query}
              required
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search semantic memory…"
            />
            <button type="submit" className="button primary" disabled={busy}>
              Search vectors
            </button>
          </form>
          <div className="sage-vector-hits">
            {hits.map((hit) => (
              <article key={String(hit['id'])}>
                <header>
                  <span>
                    Similarity{' '}
                    {typeof hit['score'] === 'number'
                      ? (hit['score'] * 100).toFixed(1) + '%'
                      : 'Not reported'}
                  </span>
                  <span>{String(hit['kind'] ?? 'Vector entry')}</span>
                </header>
                <p>{String(hit['text'])}</p>
                {!record(hit['sage'])['id'] && (
                  <VectorMemoryForget
                    http={http}
                    id={String(hit['id'])}
                    onRemoved={() => {
                      setHits((current) => current.filter((item) => item['id'] !== hit['id']));
                      setStatusRead((value) => value + 1);
                    }}
                  />
                )}
                {record(hit['sage'])['status'] === 'verified' && (
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => onOpenSage(String(record(hit['sage'])['id']))}
                  >
                    Open verified SAGE record
                    <ArrowRight size={13} />
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="file-quiet-state">Reading vector store status…</p>
      )}
    </section>
  );
}
function SageDecisionDialog({
  title,
  children,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  children: React.ReactNode;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal sage-decision-dialog" aria-label={title} onCancel={onClose}>
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close SAGE decision"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      {children}
      <footer>
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Applying…' : 'Confirm action'}
        </button>
      </footer>
    </dialog>
  );
}
