import { Box, FileCode2, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import type { EngineHttp } from './engine-http';
import { entries, record } from './engine-values';
import { KitCreateRequest } from './KitCreateRequest';
import { KitParameterDraftNotice, useKitParameterBinding } from './KitParameterDraftNotice';
import { KitParameterForm, KitSchemaDetails, KitValue } from './KitParameterForm';
import { MarkdownContent } from './MarkdownContent';
import type { Session } from './model';
import { type KitSchema, kitInitialValue, kitInputErrors, kitRequest } from './project-kit-model';
import './project-kit.css';

export function ProjectKit({
  projectId,
  http,
  sessions,
  onPrepare,
  onNewSession,
  onOpenFile,
}: {
  projectId: string;
  http: EngineHttp;
  sessions: Session[];
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [invalid, setInvalid] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState('');
  const [kit, setKit] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState<unknown>({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [request, setRequest] = useState('');
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [projectRoot, setProjectRoot] = useState('');
  const sequence = useRef(0);
  const schema = useMemo(() => (kit ? (record(kit['inputSchema']) as KitSchema) : null), [kit]);
  const parameters = useKitParameterBinding(projectId, kit ? selected : '', schema, setInput);
  const load = useCallback(async () => {
    const own = ++sequence.current;
    setLoading(true);
    setError('');
    setKit(null);
    setSelected('');
    setRequest('');
    try {
      const data = record(await http('/api/project-kit'));
      if (own === sequence.current) {
        setRows(entries(data['tools']));
        setInvalid(entries(data['invalid']));
        setProjectRoot(typeof data['projectRoot'] === 'string' ? data['projectRoot'] : '');
      }
    } catch (e) {
      if (own === sequence.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === sequence.current) {
        setLoading(false);
        setReading(false);
      }
    }
  }, [http]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const select = async (name: string) => {
    const own = ++sequence.current;
    setSelected(name);
    setKit(null);
    setRequest('');
    setReading(true);
    setError('');
    try {
      const data = record(await http(`/api/project-kit?name=${encodeURIComponent(name)}`));
      if (own !== sequence.current) return;
      const detail = record(data['kit']);
      setKit(detail);
      setInput(kitInitialValue(record(detail['inputSchema']) as KitSchema));
    } catch (e) {
      if (own === sequence.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === sequence.current) setReading(false);
    }
  };
  const prepare = async (action: 'verify' | 'run') => {
    if (!kit || busy) return;
    const own = sequence.current;
    setBusy(true);
    setError('');
    setRequest('');
    try {
      const latest = record(
        record(await http(`/api/project-kit?name=${encodeURIComponent(selected)}`))['kit'],
      );
      if (own !== sequence.current) return;
      if (latest['revision'] !== kit['revision'])
        throw Error(
          'The kit changed on disk. Select it again to review its new revision and parameters.',
        );
      if (action === 'run' && latest['verified'] !== true)
        throw Error(
          'This revision needs verification before running. Prepare a verification request first.',
        );
      const errors = kitInputErrors(record(kit['inputSchema']) as KitSchema, input);
      if (action === 'run' && errors.length) throw Error(errors.join(' '));
      setRequest(kitRequest(selected, String(kit['revision']), action, input));
    } catch (e) {
      if (own === sequence.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === sequence.current) setBusy(false);
    }
  };
  const errors = kit ? kitInputErrors(record(kit['inputSchema']) as KitSchema, input) : [];
  const visible = rows.filter((item) =>
    `${item['name']} ${item['description']}`.toLowerCase().includes(query.toLowerCase()),
  );
  const agents = sessions.filter((item) => item.kind === 'agent');
  return (
    <section className="project-kit" aria-label="Project Kit workspace">
      <header className="studio-heading">
        <div>
          <h1>Project Kit</h1>
          <p>
            Understand the contract, review the evidence, and prepare an exact revision for your
            agent.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={loading || busy}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          Refresh kits
        </button>
        <button type="button" className="button primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          Create a kit
        </button>
      </header>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      <div className="kit-layout">
        <aside className="kit-catalog">
          <label className="kit-search">
            <Search size={15} />
            <input
              aria-label="Search project kits"
              placeholder="Find a capability…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <small>
            {rows.length} kits · {invalid.length} invalid
          </small>
          {loading ? (
            <p role="status">Reading project kits…</p>
          ) : visible.length ? (
            visible.map((row) => (
              <button
                type="button"
                key={String(row['name'])}
                aria-pressed={selected === row['name']}
                disabled={busy}
                onClick={() => void select(String(row['name']))}
              >
                <Box size={17} />
                <div>
                  <strong>{String(row['name'])}</strong>
                  <p>{String(row['description'] ?? '')}</p>
                  <small>{effectLabel(row['effects'])}</small>
                </div>
              </button>
            ))
          ) : (
            <div className="kit-empty">
              <Box size={25} />
              <h3>{rows.length ? 'No matching kits' : 'A home for reusable project work'}</h3>
              <p>
                Kits live in .wrongstack/project-kit. Ask a project agent to inspect project_kit
                templates and create a capability with a guide, contracts and tests.
              </p>
            </div>
          )}
          {invalid.length > 0 && (
            <details className="kit-invalid">
              <summary>Invalid kit definitions ({invalid.length})</summary>
              {invalid.map((item, i) => (
                <div key={i}>
                  <strong>{String(item['name'])}</strong>
                  <p>{String(item['error'])}</p>
                </div>
              ))}
            </details>
          )}
        </aside>
        <article className="kit-detail" aria-label="Project Kit details">
          {creating && (
            <KitCreateRequest
              projectRoot={projectRoot}
              sessions={sessions}
              onPrepare={onPrepare}
              onNewSession={onNewSession}
              onClose={() => setCreating(false)}
            />
          )}
          {reading ? (
            <p role="status">Reading guide and contracts…</p>
          ) : kit ? (
            <>
              <header>
                <div>
                  <span className="eyebrow">{effectLabel(kit['effects'])}</span>
                  <h2>{String(kit['name'])}</h2>
                  <p>{String(kit['description'])}</p>
                </div>
                <span className={`kit-verification ${kit['verified'] === true ? 'verified' : ''}`}>
                  <ShieldCheck size={16} />
                  {kit['verified'] === true ? 'Revision verified' : 'Verification required'}
                </span>
              </header>
              <div className="kit-facts">
                <div>
                  <small>Revision</small>
                  <code title={String(kit['revision'])}>
                    {String(kit['revision']).slice(0, 12)}
                  </code>
                </div>
                <div>
                  <small>Entry point</small>
                  <strong>{String(kit['entry'])}</strong>
                </div>
                <div>
                  <small>Execution limit</small>
                  <strong>{Number(kit['timeoutMs']) / 1000}s</strong>
                </div>
                <div>
                  <small>Test cases</small>
                  <strong>{entries(kit['tests']).length}</strong>
                </div>
              </div>
              <section>
                <h3>Guide</h3>
                <MarkdownContent text={String(kit['guide'] ?? '')} />
              </section>
              <section className="kit-run-form">
                <h3>Prepare a run</h3>
                <p>
                  Review the parameters below. Preparing a request does not execute code.
                  Verification also executes kit code and follows the agent’s normal permission
                  flow.
                </p>
                <KitParameterDraftNotice
                  binding={parameters}
                  initial={kitInitialValue(record(kit['inputSchema']) as KitSchema)}
                  onUseSaved={setInput}
                />
                <KitParameterForm
                  schema={record(kit['inputSchema']) as KitSchema}
                  value={input}
                  onChange={(next) => {
                    setInput(next);
                    setRequest('');
                    parameters.edit(next);
                  }}
                />
                {errors.length > 0 && (
                  <ul className="field-help">
                    {errors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}
                <div className="kit-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void prepare('verify')}
                  >
                    Prepare verification request
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || errors.length > 0 || kit['verified'] !== true}
                    onClick={() => void prepare('run')}
                  >
                    Prepare run request
                  </button>
                </div>
              </section>
              {request && (
                <section className="kit-request" aria-label="Prepared kit request">
                  <h3>Ready for review in chat</h3>
                  <p>
                    The request pins this revision and your parameter values. Sending it remains an
                    explicit action in the conversation.
                  </p>
                  <details>
                    <summary>Review prepared instruction</summary>
                    <MarkdownContent text={request} />
                  </details>
                  <CopyButton text={request} label="Copy Project Kit request" />
                  {agents.length ? (
                    <div className="kit-actions">
                      <label className="kit-field">
                        Target conversation
                        <select
                          aria-label="Project Kit target conversation"
                          disabled={busy}
                          value={session}
                          onChange={(e) => setSession(e.target.value)}
                        >
                          <option value="">Choose a project conversation…</option>
                          {agents.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.title} · {item.status}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || !agents.some((item) => item.id === session)}
                        onClick={() => {
                          setBusy(true);
                          const submitted = parameters.draft.controller.snapshot().value;
                          void onPrepare(session, request)
                            .then(async (ok) => {
                              // Parked parameters are removed only after the request is in the conversation draft.
                              if (ok) await parameters.settle(submitted);
                              if (!ok)
                                setError(
                                  'The request was kept in the conversation draft. Resolve its save conflict before sending.',
                                );
                            })
                            .catch((e) => setError(String(e)))
                            .finally(() => setBusy(false));
                        }}
                      >
                        Add to conversation draft
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="button secondary" onClick={onNewSession}>
                      Create a project conversation
                    </button>
                  )}
                </section>
              )}
              <details>
                <summary>Output contract</summary>
                <KitSchemaDetails schema={record(kit['outputSchema']) as KitSchema} />
              </details>
              <details>
                <summary>Test cases ({entries(kit['tests']).length})</summary>
                {entries(kit['tests']).map((test, i) => (
                  <section className="kit-test" key={i}>
                    <h4>{String(test['name'])}</h4>
                    <h5>Input</h5>
                    <KitValue value={test['input']} />
                    <h5>Expected result</h5>
                    <KitValue value={test['expected']} />
                  </section>
                ))}
              </details>
              <details>
                <summary>Run and verification history ({entries(kit['history']).length})</summary>
                {entries(kit['history']).length ? (
                  entries(kit['history']).map((run, i) => (
                    <div className="kit-history-row" key={String(run['runId'] ?? i)}>
                      <strong>
                        {String(run['action'])} · {String(run['status'])}
                      </strong>
                      <time>{String(run['startedAt'])}</time>
                      <small>
                        Revision {String(run['revision']).slice(0, 12)}
                        {typeof run['durationMs'] === 'number' ? ` · ${run['durationMs']} ms` : ''}
                      </small>
                      {typeof run['error'] === 'string' && <p>{run['error']}</p>}
                    </div>
                  ))
                ) : (
                  <p>No runs recorded yet.</p>
                )}
              </details>
              <details>
                <summary>
                  Kit source files ({Array.isArray(kit['files']) ? kit['files'].length : 0})
                </summary>
                <div className="kit-source-files">
                  {(Array.isArray(kit['files']) ? kit['files'] : [])
                    .filter((file): file is string => typeof file === 'string')
                    .map((file) => (
                      <button
                        type="button"
                        className="button secondary small"
                        key={file}
                        onClick={() => onOpenFile(`.wrongstack/project-kit/${selected}/${file}`)}
                      >
                        <FileCode2 size={14} />
                        {file}
                      </button>
                    ))}
                </div>
              </details>
            </>
          ) : (
            <div className="kit-empty">
              <Box size={34} />
              <h2>Know exactly what your agent can run.</h2>
              <p>
                Select a kit to review its guide, typed inputs, output contract, tests and revision
                history.
              </p>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}
function effectLabel(value: unknown) {
  return value === 'read'
    ? 'Reads project data'
    : value === 'write'
      ? 'Changes project files'
      : value === 'external'
        ? 'Uses external services'
        : 'Effects not reported';
}
