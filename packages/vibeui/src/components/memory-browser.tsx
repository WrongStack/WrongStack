'use client';

import { Background, Controls, type Edge, type Node, Position, ReactFlow } from '@xyflow/react';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  Copy,
  Heart,
  Lightbulb,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listReplyEffect } from '../lib/component-guards';
import { memoryKindLabel } from '../lib/explorer-view';
import { directMemoryEdges, memoryDate } from '../lib/memory-view';
import { record, rows, text } from '../lib/session';
import { useCopyText } from '../lib/use-copy-text';
import { usePanelRequests } from '../lib/use-panel-requests';
import type { SessionController } from '../lib/use-session';
import { CodePanel } from './code-panel';
import { MarkdownContent } from './markdown-content';
import { usePresentation } from './presentation-mode';
import { EmptyArtwork } from './vibe-visuals';
import { CollectionViewSwitch, useWorkspacePreferences } from './workspace-preferences';

function KnowledgeSymbol({ kind }: { kind: string }) {
  const Icon =
    kind === 'preference'
      ? Heart
      : kind === 'decision'
        ? Lightbulb
        : kind === 'convention'
          ? BookOpen
          : Brain;
  return <Icon size={15} aria-hidden="true" />;
}

export function MemoryBrowser({
  controller,
  onUse,
}: {
  controller: SessionController;
  onUse: () => void;
}) {
  const { request, busy, error } = usePanelRequests(controller);
  const { mode } = usePresentation();
  const { preferences } = useWorkspacePreferences();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('active');
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [filters, setFilters] = useState<boolean | null>(null);
  const filtersOpen = filters ?? mode === 'extended';
  const [canvas, setCanvas] = useState(false);
  const [visibleRelations, setVisibleRelations] = useState(12);
  const selectionEpoch = useRef(0);
  const [view, setView] = useState<'records' | 'graph'>('records');
  const [graph, setGraph] = useState<Record<string, unknown> | null>(null);
  const clipboard = useCopyText(text(selected?.id));
  const epoch = useRef(0);
  const offline = controller.connection !== 'open';
  const load = useCallback(
    async (cursor?: string) => {
      const owner = ++epoch.current;
      const selectionOwner = ++selectionEpoch.current;
      const result = await request('memory.sage.listPage', {
        query,
        kind,
        statuses:
          status === 'all'
            ? ['active', 'stale', 'superseded', 'contradicted', 'archived', 'deleted']
            : [status],
        limit: 30,
        cursor,
      });
      if (!result || result.error) return;
      const effect = listReplyEffect(owner, epoch.current, selectionOwner, selectionEpoch.current);
      if (effect === 'ignore') return;
      setItems(rows(result.memories));
      setTotal(Number(result.total) || 0);
      setNext(typeof result.nextCursor === 'string' ? result.nextCursor : null);
      // A record opened while this page was loading stays open.
      if (effect === 'list-and-clear-selection') {
        setSelected(null);
        setGraph(null);
      }
    },
    [request, query, kind, status],
  );
  useEffect(() => {
    setCursors([undefined]);
    const timer = setTimeout(() => void load(), 300);
    return () => {
      clearTimeout(timer);
      epoch.current++;
      selectionEpoch.current++;
    };
  }, [load]);
  const pick = async (item: Record<string, unknown>) => {
    const owner = ++selectionEpoch.current;
    setSelected(item);
    setGraph(null);
    setView('records');
    const result = await request('memory.sage.get', { id: item.id });
    if (owner === selectionEpoch.current && result?.memory) setSelected(record(result.memory));
  };
  const showGraph = async () => {
    if (!selected) return;
    const owner = selectionEpoch.current;
    setView('graph');
    setCanvas(false);
    setVisibleRelations(12);
    setGraph(null);
    const result = await request('memory.sage.graph', {
      query: `mem:${text(selected.id)}`,
      maxDepth: 1,
      limit: 120,
    });
    if (owner === selectionEpoch.current && result && !result.error) setGraph(result);
  };
  const direct = useMemo(
    () => directMemoryEdges(text(selected?.id), graph?.edges),
    [selected?.id, graph],
  );
  const relations = direct.filter(
    (edge) => text(edge.from).startsWith('mem:') && text(edge.to).startsWith('mem:'),
  );
  const sources = direct.filter(
    (edge) => !text(edge.from).startsWith('mem:') || !text(edge.to).startsWith('mem:'),
  );
  const flow = useMemo(() => {
    const relations = direct
      .filter((edge) => text(edge.from).startsWith('mem:') && text(edge.to).startsWith('mem:'))
      .slice(0, visibleRelations);
    const root = selected ? `mem:${text(selected.id)}` : '';
    const ids = [
      ...new Set([root, ...relations.flatMap((edge) => [text(edge.from), text(edge.to)])]),
    ].filter(Boolean);
    const memories = [selected, ...rows(graph?.memories)].filter(Boolean) as Record<
      string,
      unknown
    >[];
    const nodes: Node[] = ids.map((id, i) => ({
      id,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: memories.find((item) => `mem:${text(item.id)}` === id)?.text
          ? text(memories.find((item) => `mem:${text(item.id)}` === id)?.text).slice(0, 90)
          : id,
      },
      position: {
        x: i === 0 ? 0 : 320 + Math.floor((i - 1) / 5) * 310,
        y: i === 0 ? Math.min(relations.length - 1, 4) * 55 : ((i - 1) % 5) * 110,
      },
      style: {
        width: 200,
        background: 'var(--raised)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.5,
      },
      selected: id === root,
    }));
    const edges: Edge[] = relations.map((edge, i) => ({
      id: text(edge.id) || `edge-${i}`,
      source: text(edge.from),
      target: text(edge.to),
      label: text(edge.relation) || text(edge.type),
      type: 'smoothstep',
      labelStyle: { fill: 'var(--text)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--raised)' },
      data: edge,
    }));
    return { nodes, edges };
  }, [graph, selected, direct, visibleRelations]);
  return (
    <section
      className="memory-browser"
      data-selected={Boolean(selected)}
      aria-label="Memory browser"
    >
      <div className="memory-overview">
        <span className="knowledge-orbit" aria-hidden="true">
          <Brain size={27} />
          <i />
          <i />
          <i />
        </span>
        <div>
          <strong>
            {busy
              ? 'Finding your knowledge…'
              : `${total.toLocaleString()} ${total === 1 ? 'memory' : 'memories'} found`}
          </strong>
          <p>
            {items.length} on this page ·{' '}
            {status === 'active'
              ? 'Current project knowledge'
              : status === 'all'
                ? 'All saved statuses'
                : `${status} knowledge`}
          </p>
        </div>
        <span className="explorer-badge">Read only</span>
      </div>
      <div className="memory-toolbar">
        <label className="file-search">
          <Search size={15} />
          <input
            aria-label="Search memory"
            placeholder="Search remembered knowledge…"
            value={query}
            disabled={busy || offline}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="secondary-button"
          aria-expanded={filtersOpen}
          aria-controls="memory-filters"
          onClick={() => setFilters(!filtersOpen)}
        >
          <SlidersHorizontal size={14} /> Filters
          {kind !== 'all' || status !== 'active' ? ' · active' : ''}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh memory"
          disabled={busy || offline}
          onClick={() => void load(cursors.at(-1))}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <fieldset
        hidden={preferences.view !== 'studio' && !filtersOpen}
        className="explorer-filters memory-quick-filters"
        aria-label="Memory shortcuts"
      >
        {(
          [
            ['all', 'All knowledge'],
            ['preference', 'Preferences'],
            ['decision', 'Decisions'],
            ['convention', 'Project habits'],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={kind === value}
            disabled={busy || offline}
            onClick={() => setKind(value)}
          >
            <KnowledgeSymbol kind={value} />
            {label}
          </button>
        ))}
        {(query || kind !== 'all' || status !== 'active') && (
          <button
            type="button"
            disabled={busy || offline}
            onClick={() => {
              setQuery('');
              setKind('all');
              setStatus('active');
            }}
          >
            Clear memory search and filters
          </button>
        )}
      </fieldset>
      <div className="memory-filters" id="memory-filters" hidden={!filtersOpen}>
        <select
          aria-label="Memory kind"
          value={kind}
          disabled={busy || offline}
          onChange={(event) => setKind(event.target.value)}
        >
          {[
            'all',
            'fact',
            'preference',
            'decision',
            'convention',
            'workflow',
            'warning',
            'bug_root_cause',
            'file_note',
            'summary',
          ].map((value) => (
            <option key={value} value={value}>
              {value === 'all' ? 'All kinds' : value.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        <select
          aria-label="Memory status"
          value={status}
          disabled={busy || offline}
          onChange={(event) => setStatus(event.target.value)}
        >
          {['active', 'stale', 'superseded', 'contradicted', 'archived', 'deleted', 'all'].map(
            (value) => (
              <option key={value} value={value}>
                {value === 'all' ? 'All statuses' : value}
              </option>
            ),
          )}
        </select>
        {(kind !== 'all' || status !== 'active') && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setKind('all');
              setStatus('active');
            }}
          >
            Reset filters
          </button>
        )}
      </div>
      <p className="sr-only" role="status">
        {busy
          ? 'Loading memory…'
          : `${total.toLocaleString()} matching memories · ${items.length} on this page`}
      </p>
      {!selected && (
        <div className="memory-collection-view">
          <CollectionViewSwitch />
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {offline && <p className="panel-hint">Reconnect to browse memory.</p>}
      <div className="memory-layout" data-selected={Boolean(selected)}>
        <nav className="memory-records" aria-label="Memory records">
          {items.map((item) => (
            <button
              type="button"
              className="hub-row memory-card"
              key={text(item.id)}
              aria-current={selected?.id === item.id ? 'true' : undefined}
              disabled={busy || offline}
              onClick={() => void pick(item)}
            >
              <span className="memory-card-heading">
                <span className="memory-kind">
                  <KnowledgeSymbol kind={text(item.kind)} />
                  {memoryKindLabel(item.kind)}
                </span>
                <span className="memory-state" data-status={text(item.status)}>
                  {text(item.status) || 'Status not reported'}
                </span>
              </span>
              <strong>{text(item.text).slice(0, 160)}</strong>
              <small>
                {text(item.scope) ? `${text(item.scope)} knowledge` : 'Saved knowledge'}
              </small>
              {Array.isArray(item.tags) && (
                <span className="memory-card-tags">
                  {item.tags
                    .filter((tag): tag is string => typeof tag === 'string')
                    .slice(0, 2)
                    .map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                </span>
              )}
            </button>
          ))}
          {!busy && !items.length && !error && (
            <div className="explorer-no-results">
              <Brain size={28} />
              <strong>No memories match these filters.</strong>
              <p>
                Try a broader search or choose All knowledge. Saved preferences and project
                decisions will appear here.
              </p>
            </div>
          )}
        </nav>
        <div className="memory-detail">
          {selected ? (
            <>
              <div className="memory-detail-toolbar">
                <button
                  type="button"
                  className="secondary-button memory-back"
                  onClick={() => {
                    selectionEpoch.current++;
                    setSelected(null);
                    setGraph(null);
                  }}
                >
                  <ArrowLeft size={14} /> All memories
                </button>
                <strong className="memory-kind">
                  <KnowledgeSymbol kind={text(selected.kind)} />
                  {memoryKindLabel(selected.kind)} memory
                </strong>
                <div className="detail-switch">
                  <button
                    type="button"
                    aria-pressed={view === 'records'}
                    onClick={() => setView('records')}
                  >
                    Record
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === 'graph'}
                    disabled={busy || offline}
                    onClick={() => void showGraph()}
                  >
                    Relationships
                  </button>
                </div>
              </div>
              {view === 'records' ? (
                <>
                  <div className="memory-record-meta">
                    <span>{text(selected.status)}</span>
                    <span>{text(selected.scope)}</span>
                  </div>
                  <MarkdownContent text={text(selected.text)} />
                  {selected.status === 'stale' && (
                    <p className="panel-hint">
                      This memory may be out of date. {text(selected.staleReason)}
                    </p>
                  )}
                  <details className="memory-record-details" key={mode} open={mode === 'extended'}>
                    <summary>Sources & details</summary>
                    <dl className="memory-facts">
                      <dt>Updated</dt>
                      <dd>{memoryDate(selected.updatedAt)}</dd>
                      <dt>Created</dt>
                      <dd>{memoryDate(selected.createdAt)}</dd>
                      <dt>Confidence</dt>
                      <dd>
                        {typeof selected.confidence === 'number'
                          ? `${Math.round(selected.confidence * 100)}%`
                          : 'Not reported'}
                      </dd>
                    </dl>
                    {rows(selected.anchors).map((anchor, i) => (
                      <p className="memory-source" key={i}>
                        <small>{text(anchor.type)}</small>{' '}
                        {text(anchor.path) ||
                          text(anchor.command) ||
                          text(anchor.symbol) ||
                          text(anchor.role)}
                      </p>
                    ))}
                    {!rows(selected.anchors).length && (
                      <p className="fine-print">No source anchors recorded.</p>
                    )}
                  </details>
                  <div className="memory-tags">
                    {Array.isArray(selected.tags) &&
                      selected.tags.map((tag) => <span key={String(tag)}>{String(tag)}</span>)}
                  </div>
                  <div className="memory-reuse">
                    <div>
                      <strong>Bring this into the conversation</strong>
                      <p>Add this knowledge to your draft. You decide when to send it.</p>
                    </div>
                    <div>
                      <button
                        type="button"
                        className="secondary-button"
                        aria-label="Copy memory"
                        onClick={() => void clipboard.copy(text(selected.text))}
                        disabled={!text(selected.text)}
                      >
                        {clipboard.status === 'copied' ? <Check size={14} /> : <Copy size={14} />}{' '}
                        Copy
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy || offline || !text(selected.text)}
                        onClick={() => {
                          controller.prepareDraft(
                            `Please take this project knowledge into account:\n\n${text(selected.text)}`,
                          );
                          onUse();
                        }}
                      >
                        Use in message <ArrowUpRight size={14} />
                      </button>
                    </div>
                    {clipboard.status !== 'idle' && (
                      <p role="status">
                        {clipboard.status === 'copied'
                          ? 'Memory copied.'
                          : 'Could not copy. Select the memory text to copy it manually.'}
                      </p>
                    )}
                  </div>
                  {mode === 'extended' && (
                    <>
                      <h3>Stored metadata</h3>
                      <CodePanel
                        label="Memory record"
                        value={JSON.stringify(selected, null, 2)}
                        defaultView="tree"
                      />
                    </>
                  )}
                </>
              ) : (
                <>
                  {!graph && !error && (
                    <p className="fine-print" role="status">
                      Loading relationships…
                    </p>
                  )}
                  {graph && (
                    <>
                      <div className="memory-relations-heading">
                        <span>
                          {relations.length} direct{' '}
                          {relations.length === 1 ? 'relationship' : 'relationships'}
                        </span>
                        {relations.length > 0 && (
                          <button
                            type="button"
                            className="secondary-button"
                            aria-expanded={canvas}
                            onClick={() => setCanvas(!canvas)}
                          >
                            {canvas ? 'Hide graph' : 'Show graph'}
                          </button>
                        )}
                      </div>
                      <p className="fine-print">
                        Only connections to this memory. Shared files and indirect neighbors are
                        excluded.
                      </p>
                      <div className="memory-relations">
                        {relations.slice(0, visibleRelations).map((edge, i) => {
                          const root = `mem:${text(selected.id)}`;
                          const incoming = text(edge.to) === root;
                          const otherId = text(incoming ? edge.from : edge.to).slice(4);
                          const other = rows(graph.memories).find(
                            (item) => text(item.id) === otherId,
                          );
                          return (
                            <button
                              type="button"
                              className="hub-row"
                              key={text(edge.id) || i}
                              disabled={busy || offline}
                              onClick={() =>
                                void pick(other || { id: otherId, text: 'Loading memory…' })
                              }
                            >
                              <small>
                                {text(edge.relation).replaceAll('_', ' ') ||
                                  text(edge.type) ||
                                  'Related'}{' '}
                                · {incoming ? 'Incoming' : 'Outgoing'}
                              </small>
                              <strong>{other ? text(other.text) : 'Open related memory'}</strong>
                            </button>
                          );
                        })}
                      </div>
                      {!relations.length && (
                        <p className="panel-hint">No direct memory relationships recorded.</p>
                      )}
                      {relations.length > visibleRelations && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setVisibleRelations((value) => value + 12)}
                        >
                          Show more relationships · {relations.length - visibleRelations} remaining
                        </button>
                      )}
                      {canvas && (
                        <section
                          className="memory-graph"
                          aria-label="Memory relationship graph"
                          style={{ height: flow.nodes.length <= 4 ? 230 : 350 }}
                        >
                          <ReactFlow
                            key={text(selected.id) + visibleRelations}
                            nodes={flow.nodes}
                            edges={flow.edges}
                            fitView
                            // React Flow 13 reads a bare number as pixels; 10% per side is v12's 0.25.
                            fitViewOptions={{ padding: '10%', minZoom: 0.35, maxZoom: 1 }}
                            nodesDraggable={false}
                            nodesConnectable={false}
                            deleteKeyCode={null}
                            zoomOnScroll={false}
                            onNodeClick={(_event, node) => {
                              if (node.id !== `mem:${text(selected.id)}`)
                                void pick(
                                  rows(graph.memories).find(
                                    (item) => `mem:${text(item.id)}` === node.id,
                                  ) || { id: node.id.slice(4), text: 'Loading memory…' },
                                );
                            }}
                          >
                            <Background gap={24} />
                            <Controls showInteractive={false} />
                          </ReactFlow>
                        </section>
                      )}
                      {sources.length > 0 && (
                        <details className="memory-record-details">
                          <summary>Source connections · {sources.length}</summary>
                          {sources.map((edge, i) => (
                            <p className="memory-source" key={i}>
                              {text(edge.from) === `mem:${text(selected.id)}`
                                ? text(edge.to)
                                : text(edge.from)}
                            </p>
                          ))}
                        </details>
                      )}
                      {rows(graph.edges).length >= 120 && (
                        <p className="fine-print">
                          The server response reached its limit; additional connections may not be
                          included.
                        </p>
                      )}
                    </>
                  )}
                  {mode === 'extended' && graph && (
                    <details>
                      <summary>Relationship metadata · {direct.length} direct edges</summary>
                      <CodePanel
                        label="Memory relationships"
                        value={JSON.stringify(direct, null, 2)}
                        defaultView="tree"
                      />
                    </details>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="file-empty">
              <EmptyArtwork kind="memory" />
              <h3>Explore what is remembered</h3>
              <p>Choose a memory to read its content and inspect its relationships.</p>
            </div>
          )}
        </div>
      </div>
      <footer className="hub-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || cursors.length === 1 || offline}
          onClick={() => {
            const previous = cursors.slice(0, -1);
            setCursors(previous);
            void load(previous.at(-1));
          }}
        >
          Previous memories
        </button>
        <span className="fine-print">Page {cursors.length}</span>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !next || offline}
          onClick={() => {
            if (next) {
              setCursors([...cursors, next]);
              void load(next);
            }
          }}
        >
          Next memories
        </button>
      </footer>
      {mode === 'extended' && (
        <p className="fine-print">
          Read-only SAGE records. Direct connections only; up to 120 returned edges per request.
          Graphs show the same relationships as the list.
        </p>
      )}
    </section>
  );
}
