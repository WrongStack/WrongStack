import {
  ArrowLeft,
  ArrowRight,
  Box,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Compass,
  Crosshair,
  FileCode2,
  GitBranch,
  Grid2X2,
  Layers3,
  LoaderCircle,
  Network,
  PanelLeft,
  Radio,
  RefreshCw,
  Route,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AtlasExplorer, AtlasNodeEvidence } from './AtlasDetails';
import { AtlasImpactView, AtlasMatrixView, AtlasSubsystemView } from './AtlasViews';
import { atlasTour, dependencyPath } from './atlas-analysis';
import { DesktopCodeAssist } from './DesktopCodeAssist';
import type { EngineHttp } from './engine-http';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { contentText, entries, record } from './engine-values';
import { GraphCanvas } from './GraphCanvas';
import { atlasGraph } from './graph-model';
import './atlas-views.css';

export function CodeAtlas({
  http,
  send,
  state,
  projectRoot,
  command,
  onOpenMemory,
  onOpenFile,
}: {
  http: EngineHttp;
  send: EngineSend;
  state: EngineState;
  projectRoot: string;
  command: EngineCommand;
  onOpenMemory?: (id: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const displayPath = (file: string) => {
    const normalized = file.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
    const root = projectRoot
      .replace(/^\\\\\?\\/, '')
      .replaceAll('\\', '/')
      .replace(/\/$/, '');
    return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      ? normalized.slice(root.length + 1)
      : normalized;
  };
  const [data, setData] = useState<unknown>({ nodes: [], edges: [] });
  const [path, setPath] = useState<{ package?: string | undefined; file?: string | undefined }>({});
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [canvasMode, setCanvasMode] = useState<'smart' | 'all'>('smart');
  const [view, setView] = useState<'graph' | 'subsystems' | 'matrix' | 'impact'>('graph');
  const [layout, setLayout] = useState<'clusters' | 'layers' | 'orbit'>('layers'),
    [explorer, setExplorer] = useState(true),
    [nodeKind, setNodeKind] = useState('all'),
    [subsystem, setSubsystem] = useState('all'),
    [hideExternal, setHideExternal] = useState(false),
    [minRank, setMinRank] = useState(0),
    [relationTypes, setRelationTypes] = useState<string[] | null>(null),
    [routeTarget, setRouteTarget] = useState(''),
    [route, setRoute] = useState<string[] | null>([]),
    [tourIndex, setTourIndex] = useState(-1),
    [relationLimit, setRelationLimit] = useState(20),
    [activityOpen, setActivityOpen] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [source, setSource] = useState('');
  const graphRequest = useRef(0);
  const building = useRef(false);
  const posting = useRef(false);
  const expectedJob = useRef<number | null>(null);
  const load = useCallback(async () => {
    const generation = ++graphRequest.current;
    setLoading(true);
    setError('');
    try {
      const resource = path.file
        ? `/api/codemap/symbols?file=${encodeURIComponent(path.file)}`
        : path.package
          ? `/api/codemap/files?package=${encodeURIComponent(path.package)}`
          : '/api/codemap/packages';
      const result = await http(resource);
      if (generation !== graphRequest.current) return;
      setData(result);
      setSelected((selected) =>
        entries(record(result)['nodes']).some((node) => node['id'] === selected) ? selected : '',
      );
    } catch (error) {
      if (generation !== graphRequest.current) return;
      setError(error instanceof Error ? error.message : String(error));
      setData({ nodes: [], edges: [] });
    } finally {
      if (generation === graphRequest.current) setLoading(false);
    }
  }, [http, path]);
  useEffect(() => {
    void load();
    return () => {
      graphRequest.current++;
    };
  }, [load]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = record(await http('/api/codemap/status'));
        if (stopped) return;
        if (
          posting.current ||
          (expectedJob.current !== null && result['startedAt'] !== expectedJob.current)
        ) {
          timer = setTimeout(poll, 1200);
          return;
        }
        if (result['status'] === 'indexing') {
          building.current = true;
          setIndexing(true);
        } else if (result['status'] === 'error') {
          building.current = false;
          setIndexing(false);
          setError(String(result['error'] ?? 'The project index could not be built.'));
        } else if (result['status'] === 'ready') {
          setIndexing(false);
          if (building.current) {
            building.current = false;
            void load();
          }
        }
      } catch (error) {
        if (!stopped) setError(String(error instanceof Error ? error.message : error));
      }
      if (!stopped) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [http, load]);
  const index = async () => {
    setError('');
    setIndexing(true);
    posting.current = true;
    try {
      const result = record(await http('/api/codemap/index', 'POST', {}));
      expectedJob.current = typeof result['startedAt'] === 'number' ? result['startedAt'] : null;
      building.current = true;
    } catch (error) {
      setIndexing(false);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      posting.current = false;
    }
  };
  const graph = useMemo(() => atlasGraph(data), [data]);
  const filtered = useMemo(() => {
    const query = search.toLowerCase();
    const nodes = graph.nodes.filter(
      (node) =>
        `${node.label} ${node.detail} ${node.group} ${String(node.data['file'] ?? '')}`
          .toLowerCase()
          .includes(query) &&
        (nodeKind === 'all' || node.data['kind'] === nodeKind) &&
        (subsystem === 'all' || node.group === subsystem) &&
        (!hideExternal || node.data['external'] !== true) &&
        (minRank === 0 || Number(node.data['rank'] ?? -1) >= minRank),
    );
    const ids = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: graph.edges.filter(
        (edge) =>
          ids.has(edge.source) &&
          ids.has(edge.target) &&
          (relationTypes === null || relationTypes.includes(edge.label)),
      ),
    };
  }, [graph, search, nodeKind, subsystem, hideExternal, minRank, relationTypes]);
  const tour = useMemo(() => atlasTour(filtered), [filtered]);
  const selectNode = (id: string) => {
    setSelected(id);
    setTourIndex(-1);
    setSource('');
    setRelationLimit(20);
  };
  useEffect(() => {
    setNodeKind('all');
    setSubsystem('all');
    setRelationTypes(null);
    setRoute([]);
    setTourIndex(-1);
  }, [path]);
  const node = graph.nodes.find((node) => node.id === selected);
  const incoming = graph.edges.filter((edge) => edge.target === selected);
  const outgoing = graph.edges.filter((edge) => edge.source === selected);
  const detail = state.results['files.read'];
  const sourceText = detail?.['filePath'] === source ? contentText(detail['content']) : '';
  const exploreNode = (id: string) => {
    const target = graph.nodes.find((node) => node.id === id);
    if (!target) return;
    const kind = target.data['kind'];
    if (kind === 'package') setPath({ package: String(target.data['package'] ?? target.label) });
    if (kind === 'file' && typeof target.data['file'] === 'string')
      setPath({ ...path, file: target.data['file'] });
    setSource('');
  };
  const explore = () => {
    if (node) exploreNode(node.id);
  };
  const openSource = () => {
    const file = node?.data['file'];
    if (typeof file !== 'string') return;
    setSource(file);
    void send('files.read', { filePath: file }).catch((error: unknown) =>
      setError(String(error instanceof Error ? error.message : error)),
    );
  };
  return (
    <section className="atlas-studio" aria-label="Project code atlas">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">SEE HOW YOUR PROJECT FITS TOGETHER</span>
          <h1>
            Code Atlas<span className="heading-dot">.</span>
          </h1>
          <p className="atlas-intro">
            Follow a dependency. Find a boundary. Understand the code before changing it.
          </p>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={indexing}
          onClick={() => void index()}
        >
          {indexing ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{' '}
          {indexing ? 'Mapping project…' : 'Index project'}
        </button>
      </header>
      <div className="studio-metrics">
        <div>
          <Box size={18} />
          <strong>{graph.nodes.length}</strong>
          <span>{path.file ? 'symbols' : path.package ? 'files' : 'packages'}</span>
        </div>
        <div>
          <GitBranch size={18} />
          <strong>{graph.edges.length}</strong>
          <span>dependencies</span>
        </div>
        <div>
          <Layers3 size={18} />
          <strong>{new Set(graph.nodes.map((node) => node.group)).size}</strong>
          <span>groups</span>
        </div>
        <div>
          <Code2 size={18} />
          <strong>
            {path.file
              ? graph.nodes.length
              : graph.nodes.reduce((sum, node) => sum + Number(node.data['symbolCount'] ?? 0), 0)}
          </strong>
          <span>indexed symbols</span>
        </div>
      </div>
      <nav className="atlas-view-switcher" aria-label="Atlas views">
        {(
          [
            {
              id: 'graph',
              label: 'Architecture',
              hint: 'Explore code and references',
              Icon: Network,
            },
            {
              id: 'subsystems',
              label: 'Subsystems',
              hint: 'Inspect boundaries and coupling',
              Icon: Boxes,
            },
            {
              id: 'matrix',
              label: 'Dependency matrix',
              hint: 'Compare directed references',
              Icon: Grid2X2,
            },
            {
              id: 'impact',
              label: 'Change impact',
              hint: 'Trace dependents and dependencies',
              Icon: Crosshair,
            },
          ] as const
        ).map(({ id, label, hint, Icon }) => (
          <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>
            <Icon size={17} />
            <span>
              <strong>{label}</strong>
              <small>{hint}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="atlas-analysis-controls">
        <fieldset className="view-segment atlas-scope-switch" aria-label="Atlas rendering scope">
          <button
            type="button"
            aria-pressed={canvasMode === 'smart'}
            onClick={() => setCanvasMode('smart')}
          >
            Smart scope
          </button>
          <button
            type="button"
            aria-pressed={canvasMode === 'all'}
            onClick={() => setCanvasMode('all')}
          >
            All nodes
          </button>
        </fieldset>
        <button
          type="button"
          className="atlas-explorer-toggle"
          aria-pressed={explorer}
          onClick={() => setExplorer(!explorer)}
        >
          <PanelLeft size={14} />
          Explorer
        </button>
        <label>
          Layout
          <select
            aria-label="Atlas layout"
            disabled={view !== 'graph'}
            value={layout}
            onChange={(event) => setLayout(event.target.value as typeof layout)}
          >
            <option value="layers">Dependency layers</option>
            <option value="orbit">Circular architecture</option>
            <option value="clusters">Subsystem clusters</option>
          </select>
        </label>
        <label>
          Nodes
          <select
            aria-label="Atlas node kind"
            value={nodeKind}
            onChange={(event) => setNodeKind(event.target.value)}
          >
            <option value="all">All kinds</option>
            {['package', 'file', 'symbol'].map((kind) => (
              <option value={kind} key={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          Subsystem
          <select
            aria-label="Atlas subsystem"
            value={subsystem}
            onChange={(event) => setSubsystem(event.target.value)}
          >
            <option value="all">All groups</option>
            {[...new Set(graph.nodes.map((node) => node.group))].map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
        </label>
        <label className="atlas-centrality-filter">
          Min. centrality
          <input
            type="number"
            aria-label="Minimum atlas centrality"
            min={0}
            max={100}
            value={minRank * 100}
            onChange={(event) => setMinRank(Number(event.target.value) / 100)}
          />
          %
        </label>
        <label className="atlas-external-filter">
          <input
            type="checkbox"
            checked={hideExternal}
            onChange={(event) => setHideExternal(event.target.checked)}
          />
          Hide external
        </label>
        <button
          type="button"
          className="atlas-tour-button"
          disabled={!tour.length}
          onClick={() => {
            setTourIndex(0);
            setSelected(tour[0]!.id);
          }}
        >
          <Compass size={14} />
          Guided tour
        </button>
      </div>
      {graph.edges.length > 0 && (
        <div className="atlas-relation-filters">
          <span>Relationships</span>
          {[...new Set(graph.edges.map((edge) => edge.label))].map((type) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={relationTypes === null || relationTypes.includes(type)}
                onChange={(event) =>
                  setRelationTypes((current) => {
                    const all = current ?? [...new Set(graph.edges.map((edge) => edge.label))];
                    return event.target.checked
                      ? [...all, type]
                      : all.filter((item) => item !== type);
                  })
                }
              />
              {type.replaceAll('_', ' ')}
              <small>{graph.edges.filter((edge) => edge.label === type).length}</small>
            </label>
          ))}
          <span>
            {filtered.nodes.length} / {graph.nodes.length} nodes in view
          </span>
        </div>
      )}
      {tourIndex >= 0 && tour[tourIndex] && (
        <section className="atlas-tour-card" aria-label="Guided architecture tour">
          <Compass size={22} />
          <div>
            <small>
              STOP {tourIndex + 1} OF {tour.length}
            </small>
            <strong>{tour[tourIndex]!.label}</strong>
            <p>
              {String(
                tour[tourIndex]!.data['concept'] ??
                  `${filtered.edges.filter((edge) => edge.target === tour[tourIndex]!.id).length} incoming and ${filtered.edges.filter((edge) => edge.source === tour[tourIndex]!.id).length} outgoing dependencies in this scope.`,
              )}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Previous architecture tour stop"
            disabled={tourIndex === 0}
            onClick={() => {
              setTourIndex(tourIndex - 1);
              setSelected(tour[tourIndex - 1]!.id);
            }}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next architecture tour stop"
            disabled={tourIndex === tour.length - 1}
            onClick={() => {
              setTourIndex(tourIndex + 1);
              setSelected(tour[tourIndex + 1]!.id);
            }}
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close architecture tour"
            onClick={() => setTourIndex(-1)}
          >
            <X size={14} />
          </button>
        </section>
      )}
      <div className="atlas-breadcrumbs">
        <button
          type="button"
          onClick={() => {
            setPath({});
            setSource('');
          }}
        >
          <Network size={14} />
          Packages
        </button>
        {path.package && (
          <>
            <ChevronRight size={13} />
            <button
              type="button"
              onClick={() => {
                setPath({ package: path.package });
                setSource('');
              }}
            >
              {path.package}
            </button>
          </>
        )}
        {path.file && (
          <>
            <ChevronRight size={13} />
            <span title={path.file}>{displayPath(path.file)}</span>
          </>
        )}
        <button
          type="button"
          className="atlas-refresh icon-button"
          aria-label="Refresh code atlas"
          disabled={loading || indexing}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="studio-toolbar">
        <Search size={15} />
        <input
          aria-label="Search code atlas"
          placeholder="Find a package, file, or symbol…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {record(data)['stale'] === true && (
          <span className="atlas-stale">Refreshing index · showing the last map</span>
        )}
      </div>
      {error && (
        <div className="atlas-index-notice" role="alert">
          <span>
            {error === 'CodeMap index unavailable'
              ? 'Build the project index to explore its code.'
              : error}
          </span>
          {!indexing && (
            <button type="button" onClick={() => void index()}>
              Build code atlas
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
      <div className={`atlas-layout ${explorer ? 'atlas-with-explorer' : ''}`}>
        {explorer && (
          <AtlasExplorer
            displayPath={displayPath}
            graph={filtered}
            selected={selected}
            onSelect={selectNode}
            onOpen={exploreNode}
          />
        )}
        {view === 'subsystems' ? (
          <AtlasSubsystemView
            graph={filtered}
            nodeLimit={canvasMode === 'all' ? null : 160}
            selected={selected}
            onSelect={selectNode}
            onOpen={exploreNode}
          />
        ) : view === 'matrix' ? (
          <AtlasMatrixView
            graph={filtered}
            selected={selected}
            onSelect={selectNode}
            onOpen={exploreNode}
          />
        ) : view === 'impact' ? (
          <AtlasImpactView
            graph={filtered}
            selected={selected}
            onSelect={selectNode}
            onOpen={exploreNode}
          />
        ) : (
          <GraphCanvas
            graph={filtered}
            selected={selected}
            onSelect={selectNode}
            onActivate={exploreNode}
            layout={layout}
            nodeLimit={canvasMode === 'all' ? null : 160}
            highlightPath={route ?? []}
            minimap
            label="Code dependency map"
            empty={
              <>
                <Network size={40} />
                <h2>
                  {loading
                    ? 'Reading your project map…'
                    : indexing
                      ? 'Your project is taking shape.'
                      : search
                        ? 'No matching code.'
                        : 'A whole project. One map.'}
                </h2>
                <p>
                  {search
                    ? 'Try a package, file name, or symbol.'
                    : 'Index the project to discover its packages, files, symbols, and their real dependencies.'}
                </p>
                {!loading && !indexing && !search && (
                  <button type="button" className="button secondary" onClick={() => void index()}>
                    Build code atlas
                  </button>
                )}
              </>
            }
          />
        )}
        <aside className="atlas-inspector">
          {node ? (
            <>
              <header>
                <span className="eyebrow">{String(node.data['kind']).toUpperCase()} DETAILS</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear code selection"
                  onClick={() => {
                    setSelected('');
                    setSource('');
                  }}
                >
                  <X size={14} />
                </button>
              </header>
              <span className="atlas-node-icon">
                {node.data['kind'] === 'package' ? <Box size={25} /> : <FileCode2 size={25} />}
              </span>
              <h2>{node.label}</h2>
              {typeof node.data['concept'] === 'string' && (
                <p className="atlas-concept">{node.data['concept']}</p>
              )}
              <p className="atlas-node-path">
                {typeof node.data['file'] === 'string'
                  ? displayPath(node.data['file'])
                  : String(node.data['package'] ?? '')}
              </p>
              <div className="atlas-node-counts">
                <div>
                  <strong>{incoming.length}</strong>
                  <span>used by</span>
                </div>
                <div>
                  <strong>{outgoing.length}</strong>
                  <span>depends on</span>
                </div>
              </div>
              {node.data['kind'] !== 'symbol' && (
                <button type="button" className="button primary full" onClick={explore}>
                  {node.data['kind'] === 'package' ? 'Explore files' : 'Explore symbols'}
                  <ArrowRight size={14} />
                </button>
              )}
              {typeof node.data['file'] === 'string' && (
                <button type="button" className="button secondary full" onClick={openSource}>
                  <Code2 size={14} />
                  Read source
                </button>
              )}
              {typeof node.data['healthScore'] === 'number' && (
                <div className="atlas-health">
                  <span>File health</span>
                  <strong>{node.data['healthScore']}/100</strong>
                  <div>
                    <span
                      className="atlas-health-fill"
                      style={{ width: `${Math.max(0, Math.min(100, node.data['healthScore']))}%` }}
                    />
                  </div>
                </div>
              )}
              {node.data['isFragile'] === true && (
                <p className="atlas-fragile">
                  Frequently changed code · review related dependencies before editing.
                </p>
              )}
              <AtlasNodeEvidence
                node={node}
                command={command}
                {...(onOpenMemory ? { onOpenMemory } : {})}
                {...(onOpenFile
                  ? { onOpenFile: (file: string) => onOpenFile(displayPath(file)) }
                  : {})}
              />
              <section className="atlas-path-finder">
                <h3>
                  <Route size={14} />
                  Trace a dependency path
                </h3>
                <label>
                  From {node.label}
                  <select
                    aria-label="Dependency path target"
                    value={routeTarget}
                    onChange={(event) => setRouteTarget(event.target.value)}
                  >
                    <option value="">Choose target…</option>
                    {filtered.nodes
                      .filter((target) => target.id !== node.id)
                      .map((target) => (
                        <option value={target.id} key={target.id}>
                          {target.label}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="button secondary full"
                  disabled={!routeTarget}
                  onClick={() => setRoute(dependencyPath(filtered, node.id, routeTarget))}
                >
                  Find shortest path
                  <ArrowRight size={13} />
                </button>
                {route === null ? (
                  <p>No directed dependency path in the current scope.</p>
                ) : route.length > 0 ? (
                  <div className="atlas-path-steps">
                    {route.map((id, index) => (
                      <button type="button" key={id} onClick={() => selectNode(id)}>
                        <span>{index + 1}</span>
                        {graph.nodes.find((node) => node.id === id)?.label ?? id}
                      </button>
                    ))}
                    <button type="button" onClick={() => setRoute([])}>
                      Clear highlighted path
                    </button>
                  </div>
                ) : null}
              </section>
              <div className="atlas-dependency-list">
                <h3>Connections</h3>
                {[
                  ...outgoing.map((edge) => ({
                    ...edge,
                    targetId: edge.target,
                    direction: 'Depends on',
                  })),
                  ...incoming.map((edge) => ({
                    ...edge,
                    targetId: edge.source,
                    direction: 'Used by',
                  })),
                ]
                  .slice(0, relationLimit)
                  .map((edge, index) => (
                    <button
                      type="button"
                      key={`${edge.targetId}-${index}`}
                      onClick={() => selectNode(edge.targetId)}
                    >
                      <small>
                        {edge.direction} · {edge.label.replaceAll('_', ' ')} · weight {edge.weight}
                      </small>
                      <span>
                        {graph.nodes.find((node) => node.id === edge.targetId)?.label ??
                          edge.targetId}
                      </span>
                      <ChevronRight size={13} />
                    </button>
                  ))}
                {!incoming.length && !outgoing.length && <p>No dependencies in this view.</p>}
                {incoming.length + outgoing.length > relationLimit && (
                  <button type="button" onClick={() => setRelationLimit((limit) => limit + 30)}>
                    Show more relationships ({incoming.length + outgoing.length - relationLimit})
                  </button>
                )}
              </div>
              {typeof node.data['file'] === 'string' && (
                <DesktopCodeAssist
                  key={node.id}
                  filePath={displayPath(node.data['file'])}
                  {...(node.data['kind'] === 'symbol' ? { symbol: node.label } : {})}
                  {...(typeof node.data['line'] === 'number' ? { line: node.data['line'] } : {})}
                  send={send}
                  command={command}
                  state={state}
                  onEdited={() => void load()}
                />
              )}
            </>
          ) : (
            <div className="atlas-inspector-empty">
              <Box size={32} />
              <h2>Find your bearings.</h2>
              <p>
                Select a node to see its role, connections, and source. Explore packages, then
                files, then individual symbols.
              </p>
              <div>
                <span>
                  <Box size={16} />
                  Package
                </span>
                <ChevronRight size={13} />
                <span>
                  <FileCode2 size={16} />
                  File
                </span>
                <ChevronRight size={13} />
                <span>
                  <Code2 size={16} />
                  Symbol
                </span>
              </div>
            </div>
          )}
        </aside>
      </div>
      <section className="atlas-live-activity">
        <button
          type="button"
          aria-expanded={activityOpen}
          onClick={() => setActivityOpen(!activityOpen)}
        >
          <Radio size={14} />
          Live project activity
          <span>
            {state.activity.filter((event) => event.type.startsWith('codemap.')).length} recorded
            events
          </span>
          {activityOpen ? <ChevronLeft size={13} /> : <ChevronDown size={13} />}
        </button>
        {activityOpen && (
          <div>
            {state.activity
              .filter((event) => event.type.startsWith('codemap.'))
              .slice(-40)
              .reverse()
              .map((event, index) => (
                <article key={index}>
                  <span>{event.type.replace('codemap.', '').replaceAll('_', ' ')}</span>
                  <strong>
                    {String(
                      event.payload['filePath'] ??
                        event.payload['path'] ??
                        event.payload['name'] ??
                        'Index update',
                    )}
                  </strong>
                  <small>
                    {String(
                      event.payload['agentName'] ??
                        event.payload['agentId'] ??
                        event.payload['operation'] ??
                        'Project runtime',
                    )}
                  </small>
                </article>
              ))}
            {!state.activity.some((event) => event.type.startsWith('codemap.')) && (
              <p>
                File operations and index changes appear here when the project runtime reports them.
              </p>
            )}
          </div>
        )}
      </section>
      {source && (
        <section className="atlas-source">
          <header>
            <button
              type="button"
              className="icon-button"
              aria-label="Close source preview"
              onClick={() => setSource('')}
            >
              <ArrowLeft size={15} />
            </button>
            <strong title={source}>{displayPath(source)}</strong>
            {Boolean(node?.data['line']) && (
              <span>Declaration at line {String(node?.data['line'])}</span>
            )}
          </header>
          <pre>
            <code>
              {detail?.['filePath'] === source
                ? sourceText || String(detail['error'] ?? 'This file has no text content.')
                : 'Reading source…'}
            </code>
          </pre>
        </section>
      )}
    </section>
  );
}
