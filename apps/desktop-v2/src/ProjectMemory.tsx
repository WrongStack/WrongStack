import {
  Brain,
  Check,
  GitBranch,
  List,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { SageEditorFields, SageRecordDetails } from './SageRecordDetails';
import { SageRelationGraph } from './SageRelationGraph';
import {
  assertSageValiditySaved,
  sageEditor,
  sageEditorPatch,
  sageKinds,
  sageStatuses,
} from './sage-model';
import { sageRelationModel } from './sage-relation-model';

export function ProjectMemory({
  command,
  initialMemoryId,
}: {
  command: EngineCommand;
  initialMemoryId?: string;
}) {
  const [data, setData] = useState<Record<string, unknown>>({});
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [view, setView] = useState<'map' | 'library'>('map');
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [mode, setMode] = useState<'read' | 'edit' | 'create'>('read');
  const [relations, setRelations] = useState<unknown[]>([]);
  const [relatedMemories, setRelatedMemories] = useState<Record<string, unknown>[]>([]);
  const [text, setText] = useState('');
  const [tags, setTags] = useState('');
  const [kind, setKind] = useState('fact');
  const [kindFilter, setKindFilter] = useState('all');
  const [advanced, setAdvanced] = useState(() => sageEditor(null));
  const [importance, setImportance] = useState(0.6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (mode !== 'read') editor.current?.focus();
  }, [mode]);
  const load = useCallback(async () => {
    const generation = ++revision.current;
    setLoading(true);
    try {
      const reply = await command(
        'memory.sage.listPage',
        {
          query,
          ...(status === 'all' ? {} : { statuses: [status] }),
          ...(kindFilter === 'all' ? {} : { kind: kindFilter }),
          limit: view === 'map' ? 40 : 100,
          summaryOnly: view === 'map',
          includeStats: true,
        },
        ['memory.sage.listPage'],
      );
      if (generation === revision.current) setData(reply);
    } finally {
      if (generation === revision.current) setLoading(false);
    }
  }, [command, query, status, kindFilter, view]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void load().catch((error: unknown) =>
        setError(String(error instanceof Error ? error.message : error)),
      );
    }, 180);
    return () => {
      clearTimeout(timer);
      revision.current++;
    };
  }, [load]);
  const choose = useCallback((memory: Record<string, unknown> | null) => {
    setMode('read');
    setSelected(memory);
    setText(String(memory?.['text'] ?? ''));
    setTags(Array.isArray(memory?.['tags']) ? memory['tags'].join(', ') : '');
    setKind(String(memory?.['kind'] ?? 'fact'));
    setAdvanced(sageEditor(memory));
    setImportance(Number(memory?.['importance'] ?? 0.6));
    setNotice('');
  }, []);
  const openMemory = useCallback(
    async (id: string) => {
      const reply = await command('memory.sage.get', { id }, ['memory.sage.get']);
      choose(record(reply['memory']));
    },
    [command, choose],
  );
  useEffect(() => {
    if (initialMemoryId)
      void openMemory(initialMemoryId).catch((error: unknown) =>
        setError(error instanceof Error ? error.message : String(error)),
      );
  }, [initialMemoryId, openMemory]);
  useEffect(() => {
    const roots = entries(data['memories'])
      .slice(0, 40)
      .map((memory) => `mem:${memory['id']}`);
    const root = selected?.['id'] ? `mem:${selected['id']}` : roots[0];
    if (!root) {
      setRelations([]);
      setRelatedMemories([]);
      return;
    }
    let current = true;
    void command(
      'memory.sage.graph',
      { query: root, roots: selected ? [root] : roots, summaryOnly: true, maxDepth: 2, limit: 150 },
      ['memory.sage.graph'],
    )
      .then((reply) => {
        if (current) {
          setRelations(Array.isArray(reply['edges']) ? reply['edges'] : []);
          setRelatedMemories(entries(reply['memories']));
        }
      })
      .catch((error: unknown) => {
        if (current) setError(String(error instanceof Error ? error.message : error));
      });
    return () => {
      current = false;
    };
  }, [selected, command, data]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      const type = selected ? 'memory.sage.update' : 'memory.sage.remember';
      const metadata = sageEditorPatch(advanced, selected);
      const reply = await command(
        type,
        {
          ...(selected ? { id: selected['id'], expectedRevision: selected['revision'] } : { kind }),
          kind,
          ...metadata,
          text: text.trim(),
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          importance,
        },
        [type],
      );
      let saved = record(reply['memory']);
      if (metadata.validity !== undefined) {
        if (typeof saved['id'] !== 'string')
          throw Error('The saved memory identity could not be verified. Your edits are retained.');
        const checked = record(
          (await command('memory.sage.get', { id: saved['id'] }, ['memory.sage.get']))['memory'],
        );
        if (checked['id'] !== saved['id'])
          throw Error('The runtime returned a different saved memory. Your edits are retained.');
        assertSageValiditySaved(metadata.validity, checked['validity']);
        saved = checked;
      }
      choose(saved);
      await load();
      setNotice('Saved to project memory.');
    });
  const remove = () =>
    run(async () => {
      if (!selected || !authorized) return;
      await command(
        'memory.sage.delete',
        {
          id: selected['id'],
          force: true,
          reason: reason.trim() || 'Explicitly deleted from project memory',
        },
        ['memory.sage.delete'],
      );
      const readback = await command('memory.sage.get', { id: selected['id'] }, [
        'memory.sage.get',
      ]);
      if (record(readback['memory'])['status'] !== 'deleted')
        throw new Error('The engine did not confirm deletion.');
      choose(null);
      setDeleting(false);
      await load();
      setNotice('Memory moved to Deleted. You can restore it.');
    });
  const restore = () =>
    run(async () => {
      if (!selected) return;
      const reply = await command(
        'memory.sage.recover',
        { id: selected['id'], reason: 'Restored from project memory' },
        ['memory.sage.recover'],
      );
      choose(record(reply['memory']));
      await load();
      setNotice('Memory restored.');
    });
  const memories = useMemo(() => entries(data['memories']), [data]);
  const graphRecords = useMemo(
    () => [
      ...new Map(
        [...memories, ...relatedMemories].map((memory) => [String(memory['id']), memory]),
      ).values(),
    ],
    [memories, relatedMemories],
  );
  const graph = useMemo(
    () => sageRelationModel(graphRecords, relations),
    [graphRecords, relations],
  );
  const loadMore = () =>
    run(async () => {
      const reply = await command(
        'memory.sage.listPage',
        {
          query,
          ...(status === 'all' ? {} : { statuses: [status] }),
          ...(kindFilter === 'all' ? {} : { kind: kindFilter }),
          limit: view === 'map' ? 40 : 100,
          summaryOnly: view === 'map',
          cursor: data['nextCursor'],
          includeStats: true,
        },
        ['memory.sage.listPage'],
      );
      setData((current) =>
        view === 'map'
          ? reply
          : {
              ...reply,
              memories: [
                ...new Map(
                  [...entries(current['memories']), ...entries(reply['memories'])].map((memory) => [
                    String(memory['id']),
                    memory,
                  ]),
                ).values(),
              ],
            },
      );
    });
  const newMemory = () => {
    choose(null);
    setMode('create');
  };
  return (
    <section className="memory-studio" aria-label="Project memory">
      <header className="studio-heading">
        <div>
          <h1>SAGE Memory</h1>
          <p>Durable project knowledge, evidence, lifecycle, and controlled agent injection.</p>
        </div>
        <button type="button" className="button primary" onClick={newMemory} disabled={busy}>
          <Plus size={15} />
          New memory
        </button>
      </header>
      <div className="studio-metrics">
        <div>
          <Brain size={18} />
          <strong>{String(data['total'] ?? 0)}</strong>
          <span>{status === 'all' ? 'SAGE records' : `${status} memories`}</span>
        </div>
        <div>
          <GitBranch size={18} />
          <strong>{graph.edges.length}</strong>
          <span>stored relations in view</span>
        </div>
        <div>
          <Network size={18} />
          <strong>{String(record(record(data['stats'])['byStatus'])['active'] ?? 0)}</strong>
          <span>active records</span>
        </div>
        <div>
          <Check size={18} />
          <strong>{String(record(record(data['stats'])['byKind'])['decision'] ?? 0)}</strong>
          <span>decisions</span>
        </div>
      </div>
      <div className="sage-store-identity">
        <Brain size={19} />
        <div>
          <strong>SAGE knowledge store</strong>
          <span>Structured records · evidence · lifecycle · agent audience</span>
        </div>
        <small>All records excludes deleted memories. Use the status filter to recover them.</small>
      </div>
      <div className="studio-toolbar">
        <input
          aria-label="Search memories"
          placeholder="Find a decision, convention, or topic…"
          disabled={busy}
          value={query}
          onChange={(event) => {
            setLoading(true);
            setData({});
            setQuery(event.target.value);
            choose(null);
          }}
        />
        <select
          aria-label="Memory status"
          disabled={busy}
          value={status}
          onChange={(event) => {
            setLoading(true);
            setData({});
            setStatus(event.target.value);
            choose(null);
          }}
        >
          <option value="all">All records</option>
          {sageStatuses.map((value) => (
            <option key={value} value={value}>
              {value[0]!.toUpperCase() + value.slice(1)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter memory kind"
          value={kindFilter}
          disabled={busy}
          onChange={(event) => {
            setData({});
            setLoading(true);
            setKindFilter(event.target.value);
          }}
        >
          <option value="all">All kinds</option>
          {sageKinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        <div className="view-segment">
          <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
            <Network size={14} />
            Map
          </button>
          <button
            type="button"
            aria-pressed={view === 'library'}
            onClick={() => setView('library')}
          >
            <List size={14} />
            Library
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh memories"
          onClick={() => void run(load)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {error && (
        <div className="session-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          <Check size={13} />
          {notice}
        </p>
      )}
      <div
        className={`memory-layout ${mode === 'read' ? 'memory-reading' : ''} ${view === 'map' && !selected && mode === 'read' ? 'memory-map-overview' : ''}`}
      >
        <section className="memory-map-panel" aria-label="Memories">
          {view === 'map' ? (
            <SageRelationGraph
              memories={graphRecords}
              relations={relations}
              loading={loading}
              selected={selected ? String(selected['id']) : ''}
              onSelect={(id) => {
                if (!busy) void run(() => openMemory(id));
              }}
              empty={
                <>
                  <Brain size={38} />
                  <h2>
                    {loading ? 'Reading project memory…' : 'A shared understanding starts here.'}
                  </h2>
                  <p>
                    Project knowledge and persisted relationships appear here. Full record details
                    load when you select a card.
                  </p>
                  {!loading && (
                    <button type="button" className="button secondary" onClick={newMemory}>
                      Create your first memory
                    </button>
                  )}
                </>
              }
            />
          ) : (
            <div className="memory-library">
              {memories.map((memory) => (
                <button
                  type="button"
                  key={String(memory['id'])}
                  aria-label={String(memory['text'])}
                  aria-pressed={selected?.['id'] === memory['id']}
                  onClick={() => void run(() => openMemory(String(memory['id'])))}
                >
                  <span className="sage-library-meta">
                    <span className="memory-kind">
                      {String(memory['kind']).replaceAll('_', ' ')}
                    </span>
                    <span className={`sage-status sage-status-${memory['status']}`}>
                      {String(memory['status'] ?? 'active')}
                    </span>
                    <small>Revision {String(memory['revision'] ?? 1)}</small>
                  </span>
                  <strong>{String(memory['text'])}</strong>
                  <span>
                    {Array.isArray(memory['tags']) ? memory['tags'].join(' · ') : 'No topics yet'}
                  </span>
                  <span className="sage-library-evidence">
                    <span>{entries(memory['sources']).length} evidence sources</span>
                    <span>{entries(memory['anchors']).length} code anchors</span>
                    <span>
                      {String(memory['persistence'] ?? 'long_lived').replaceAll('_', ' ')} retention
                    </span>
                  </span>
                </button>
              ))}
              {!memories.length && (
                <div className="sage-library-empty">
                  <Brain size={30} />
                  <h2>{loading ? 'Reading SAGE records…' : 'No SAGE records in this view.'}</h2>
                  <p>
                    Save project decisions, conventions, and evidence here. Change the status filter
                    to inspect archived or deleted knowledge.
                  </p>
                </div>
              )}
            </div>
          )}
          <footer className="map-legend">
            <span>Persisted relationships · select a card for full details</span>
            <small>
              {String(data['total'] ?? memories.length)} matching memories
              {data['nextCursor'] ? ' · refine your search to explore more' : ''}
            </small>
          </footer>
          {typeof data['nextCursor'] === 'string' && (
            <button
              type="button"
              className="button secondary sage-load-more"
              disabled={busy}
              onClick={() => void loadMore()}
            >
              {view === 'map' ? 'Next graph page' : 'Load more memories'} · {memories.length}{' '}
              previews · {String(data['total'])} total
            </button>
          )}
        </section>
        <aside className="memory-inspector">
          <header>
            <span className="eyebrow">{selected ? 'MEMORY DETAILS' : 'ADD TO YOUR PROJECT'}</span>
            {selected && (
              <button
                type="button"
                className="icon-button"
                aria-label="Clear memory selection"
                onClick={() => choose(null)}
              >
                <X size={14} />
              </button>
            )}
          </header>
          {mode === 'read' ? (
            selected ? (
              <section className="sage-record-reader" aria-label="SAGE record detail">
                <div className="sage-reader-heading">
                  <span className="memory-kind">
                    {String(selected['kind']).replaceAll('_', ' ')}
                  </span>
                  <span className={`sage-status sage-status-${selected['status']}`}>
                    {String(selected['status'])}
                  </span>
                  <CopyButton text={String(selected['text'])} label="Copy memory text" />
                </div>
                <h2>Memory record</h2>
                <MarkdownContent text={String(selected['text'])} />
                <div className="sage-reader-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || selected['status'] === 'deleted'}
                    onClick={() => setMode('edit')}
                  >
                    <Pencil size={13} />
                    Edit memory
                  </button>
                  <small>
                    Changes require an explicit save against revision{' '}
                    {String(selected['revision'] ?? '—')}.
                  </small>
                </div>
                {relations.length > 0 && (
                  <section className="sage-stored-relations">
                    <h3>Stored relationships</h3>
                    {entries(relations)
                      .filter(
                        (edge) =>
                          edge['from'] === `mem:${selected['id']}` ||
                          edge['to'] === `mem:${selected['id']}`,
                      )
                      .map((edge, index) => {
                        const other = String(
                          edge['from'] === `mem:${selected['id']}` ? edge['to'] : edge['from'],
                        );
                        const memory = relatedMemories.find(
                          (item) => `mem:${item['id']}` === other,
                        );
                        return (
                          <div key={String(edge['id'] ?? index)}>
                            <small>
                              {String(edge['relation']).replaceAll('_', ' ')} ·{' '}
                              {edge['from'] === `mem:${selected['id']}` ? 'outgoing' : 'incoming'}
                            </small>
                            {memory ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void openMemory(String(memory['id'])).catch((e) =>
                                    setError(String(e)),
                                  )
                                }
                              >
                                {String(memory['summary'] ?? memory['text'])}
                              </button>
                            ) : (
                              <code>{other}</code>
                            )}
                          </div>
                        );
                      })}
                  </section>
                )}
              </section>
            ) : (
              <section className="sage-reader-empty">
                <Brain size={34} />
                <h2>Read your project knowledge</h2>
                <p>
                  Select a SAGE record to read its full content, evidence, applicability, and
                  relationships. Create and edit are explicit actions.
                </p>
                <button type="button" className="button secondary" onClick={newMemory}>
                  <Plus size={14} />
                  Create a SAGE record
                </button>
              </section>
            )
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <h2>{selected ? 'Edit memory' : 'Remember something'}</h2>
              <label>
                What should the project remember?
                <textarea
                  ref={editor}
                  aria-label="Memory text"
                  required
                  rows={5}
                  placeholder="For example: All provider credentials must use the encrypted vault."
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <div className="inspector-two-fields">
                <label>
                  Kind
                  <select
                    aria-label="Memory kind"
                    value={kind}
                    disabled={busy}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    {[...new Set([...sageKinds, kind])].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Importance<span className="range-value">{Math.round(importance * 100)}%</span>
                  <input
                    aria-label="Memory importance"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={importance}
                    onChange={(event) => setImportance(Number(event.target.value))}
                  />
                </label>
              </div>
              <label>
                Topics
                <input
                  aria-label="Memory tags"
                  placeholder="architecture, convention"
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                />
                <small className="field-help">
                  Separate topics with commas to connect related memories.
                </small>
              </label>
              <button type="submit" className="button primary full" disabled={busy || !text.trim()}>
                <Save size={14} />
                {busy ? 'Saving…' : 'Save memory'}
              </button>
              <SageEditorFields
                value={advanced}
                onChange={setAdvanced}
                existing={Boolean(selected)}
              />
              <button
                type="button"
                className="button secondary full"
                disabled={busy}
                onClick={() => choose(selected)}
              >
                Cancel editing
              </button>
            </form>
          )}
          {selected && (
            <div className="memory-provenance">
              <SageRecordDetails
                memory={selected}
                {...(mode === 'read' ? { command } : {})}
                onOpen={(id) =>
                  void openMemory(id).catch((error: unknown) => setError(String(error)))
                }
              />
              <dl>
                <div className="memory-provenance-row">
                  <dt>Status</dt>
                  <dd>{String(selected['status'])}</dd>
                </div>
                {typeof selected['confidence'] === 'number' && (
                  <div className="memory-provenance-row">
                    <dt>Confidence</dt>
                    <dd>{Math.round(selected['confidence'] * 100)}%</dd>
                  </div>
                )}
                {typeof selected['updatedAt'] === 'string' && (
                  <div className="memory-provenance-row">
                    <dt>Updated</dt>
                    <dd>{new Date(selected['updatedAt']).toLocaleDateString()}</dd>
                  </div>
                )}
              </dl>
              {selected['status'] === 'deleted' ? (
                <button
                  type="button"
                  className="button secondary full"
                  disabled={busy}
                  onClick={() => void restore()}
                >
                  <Undo2 size={14} />
                  Restore memory
                </button>
              ) : (
                <button
                  type="button"
                  className="button secondary danger full"
                  disabled={busy}
                  onClick={() => {
                    setDeleting(true);
                    setAuthorized(false);
                    setReason('');
                  }}
                >
                  <Trash2 size={14} />
                  Delete memory
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
      {deleting && (
        <MemoryDeleteDialog
          busy={busy}
          authorized={authorized}
          onAuthorize={setAuthorized}
          reason={reason}
          onReason={setReason}
          onClose={() => setDeleting(false)}
          onDelete={() => void remove()}
        />
      )}
    </section>
  );
}
function MemoryDeleteDialog({
  busy,
  authorized,
  onAuthorize,
  reason,
  onReason,
  onClose,
  onDelete,
}: {
  busy: boolean;
  authorized: boolean;
  onAuthorize: (value: boolean) => void;
  reason: string;
  onReason: (value: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      className="modal memory-delete-dialog"
      aria-label="Delete project memory"
      ref={dialog}
      onCancel={onClose}
    >
      <header>
        <div>
          <span className="eyebrow">PROJECT MEMORY</span>
          <h2>Delete this memory?</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel deletion"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <p>
        This removes the memory from active knowledge for the entire project. It remains available
        in Deleted for recovery.
      </p>
      <label>
        Reason
        <input
          aria-label="Memory operation reason"
          value={reason}
          onChange={(event) => onReason(event.target.value)}
          placeholder="Why is this no longer useful?"
        />
      </label>
      <label className="authorization-checkbox">
        <input
          type="checkbox"
          checked={authorized}
          onChange={(event) => onAuthorize(event.target.checked)}
        />
        I explicitly authorize deleting this memory
      </label>
      <footer>
        <button type="button" className="button secondary" onClick={onClose}>
          Keep memory
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!authorized || busy}
          onClick={onDelete}
        >
          Delete memory
        </button>
      </footer>
    </dialog>
  );
}
