import {
  ArrowDownLeft,
  ArrowUpRight,
  Box,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  FileCode2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { AtlasBoundaryMap } from './AtlasBoundaryMap';
import { hasStoredGroups, inferCommunities } from './atlas-communities';
import { atlasImpact, atlasSubsystems } from './atlas-views-model';
import type { VisualGraph } from './graph-model';

type Props = {
  graph: VisualGraph;
  selected: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  nodeLimit?: number | null;
};
export function AtlasSubsystemView({
  graph: stored,
  selected,
  onSelect,
  onOpen,
  nodeLimit = 160,
}: Props) {
  // Without stored subsystems or packages, communities found from the references are the default.
  const explicit = useMemo(() => hasStoredGroups(stored), [stored]);
  const [choice, setChoice] = useState<'stored' | 'inferred' | null>(null);
  const grouping = choice ?? (explicit ? 'stored' : 'inferred');
  const graph = useMemo(
    () => (grouping === 'inferred' ? inferCommunities(stored) : stored),
    [grouping, stored],
  );
  const groups = useMemo(() => atlasSubsystems(graph), [graph]);
  return (
    <section className="atlas-subsystem-view" aria-label="Atlas subsystems">
      <header className="atlas-view-heading">
        <Box size={20} />
        <div>
          <h2>Subsystem boundaries</h2>
          <p>Compare code ownership, internal cohesion, and references crossing each boundary.</p>
        </div>
        <fieldset className="atlas-grouping" aria-label="Group nodes by">
          <button
            type="button"
            aria-pressed={grouping === 'stored'}
            onClick={() => setChoice('stored')}
          >
            {explicit ? 'Stored subsystems' : 'Node kind'}
          </button>
          <button
            type="button"
            aria-pressed={grouping === 'inferred'}
            onClick={() => setChoice('inferred')}
          >
            Inferred communities
          </button>
        </fieldset>
      </header>
      {grouping === 'inferred' && (
        <p className="field-help">
          Inferred communities are computed here from the stored references; they are not subsystems
          recorded by the index.
          {!explicit && ' The index stored no subsystem or package for these nodes.'}
        </p>
      )}
      <AtlasBoundaryMap graph={graph} onSelect={onSelect} onOpen={onOpen} nodeLimit={nodeLimit} />
      <div className="atlas-subsystem-grid">
        {groups.map((g, index) => (
          <article className={`atlas-subsystem-card atlas-group-${index % 4}`} key={g.name}>
            <header>
              <h3>{g.name}</h3>
              <strong>
                {g.nodes.length}
                <small>nodes</small>
              </strong>
            </header>
            <div className="atlas-subsystem-size">
              <span
                style={{ width: `${(100 * g.nodes.length) / Math.max(1, graph.nodes.length)}%` }}
              />
            </div>
            <dl>
              <div>
                <dt>Internal</dt>
                <dd>{g.internal}</dd>
              </div>
              <div>
                <dt>
                  <ArrowDownLeft size={11} />
                  Inbound
                </dt>
                <dd>{g.incoming}</dd>
              </div>
              <div>
                <dt>
                  <ArrowUpRight size={11} />
                  Outbound
                </dt>
                <dd>{g.outgoing}</dd>
              </div>
            </dl>
            <div className="atlas-subsystem-nodes">
              {g.nodes.map((n) => (
                <button
                  type="button"
                  key={n.id}
                  aria-pressed={n.id === selected}
                  aria-label={`Inspect ${n.label}`}
                  onClick={() => onSelect(n.id)}
                  onDoubleClick={() => onOpen(n.id)}
                >
                  <FileCode2 size={13} />
                  <span>
                    <strong>{n.label}</strong>
                    <small>{n.detail}</small>
                  </span>
                  <b>{Math.round(Number(n.data['rank'] ?? 0) * 100)}%</b>
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
      {!groups.length && <p className="quiet-state">No indexed nodes match the current filters.</p>}
    </section>
  );
}

export function AtlasMatrixView({ graph, selected, onSelect }: Props) {
  const [rowPage, setRowPage] = useState(0),
    [colPage, setColPage] = useState(0);
  const nodes = useMemo(
    () =>
      [...graph.nodes].sort(
        (a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
      ),
    [graph],
  );
  const size = 18,
    pages = Math.max(1, Math.ceil(nodes.length / size));
  const safeRow = Math.min(rowPage, pages - 1),
    safeCol = Math.min(colPage, pages - 1);
  const rows = nodes.slice(safeRow * size, (safeRow + 1) * size),
    cols = nodes.slice(safeCol * size, (safeCol + 1) * size);
  const references = useMemo(() => {
    const map = new Map<string, Map<string, typeof graph.edges>>();
    for (const edge of graph.edges) {
      const targets = map.get(edge.source) ?? new Map();
      targets.set(edge.target, [...(targets.get(edge.target) ?? []), edge]);
      map.set(edge.source, targets);
    }
    return map;
  }, [graph]);
  return (
    <section className="atlas-matrix-view" aria-label="Atlas dependency matrix">
      <header className="atlas-view-heading">
        <div>
          <h2>Dependency matrix</h2>
          <p>Rows depend on columns. Each filled cell represents stored, directed references.</p>
        </div>
      </header>
      <div className="atlas-matrix-pages">
        <span>
          Sources {nodes.length ? safeRow * size + 1 : 0}–
          {Math.min((safeRow + 1) * size, nodes.length)}
        </span>
        <button
          type="button"
          aria-label="Previous matrix sources"
          disabled={safeRow === 0}
          onClick={() => setRowPage(safeRow - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          aria-label="Next matrix sources"
          disabled={safeRow >= pages - 1}
          onClick={() => setRowPage(safeRow + 1)}
        >
          <ChevronRight size={14} />
        </button>
        <span>
          Targets {nodes.length ? safeCol * size + 1 : 0}–
          {Math.min((safeCol + 1) * size, nodes.length)} / {nodes.length}
        </span>
        <button
          type="button"
          aria-label="Previous matrix targets"
          disabled={safeCol === 0}
          onClick={() => setColPage(safeCol - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          aria-label="Next matrix targets"
          disabled={safeCol >= pages - 1}
          onClick={() => setColPage(safeCol + 1)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="atlas-matrix-scroll">
        <table>
          <caption>Directed code references in the current scope</caption>
          <thead>
            <tr>
              <th scope="col">Source ↓ / target →</th>
              {cols.map((n, i) => (
                <th scope="col" key={n.id}>
                  <button
                    type="button"
                    title={`${n.label} · ${n.group}`}
                    onClick={() => onSelect(n.id)}
                  >
                    {safeCol * size + i + 1}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id} className={n.id === selected ? 'atlas-matrix-selected' : ''}>
                <th scope="row">
                  <button type="button" onClick={() => onSelect(n.id)} title={n.detail}>
                    {n.label}
                  </button>
                </th>
                {cols.map((c) => {
                  const refs = references.get(n.id)?.get(c.id) ?? [];
                  return (
                    <td key={c.id} className={n.id === c.id ? 'matrix-diagonal' : ''}>
                      {refs.length ? (
                        <button
                          type="button"
                          className="matrix-reference"
                          aria-label={`${n.label} to ${c.label}: ${refs.map((e) => e.label).join(', ')}`}
                          title={`${refs.map((e) => e.label.replaceAll('_', ' ')).join(', ')} · weight ${refs.reduce((s, e) => s + e.weight, 0)}`}
                          onClick={() => onSelect(c.id)}
                        >
                          {refs.length}
                        </button>
                      ) : (
                        <span title="No reference">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ol className="atlas-matrix-key" start={safeCol * size + 1}>
        {cols.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onSelect(n.id)}>
              {n.label}
              <small>{n.group}</small>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function AtlasImpactView({ graph, selected, onSelect, onOpen }: Props) {
  const [root, setRoot] = useState(selected || graph.nodes[0]?.id || '');
  const [depth, setDepth] = useState(2);
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const validRoot = graph.nodes.some((n) => n.id === root) ? root : (graph.nodes[0]?.id ?? '');
  const distances = useMemo(
    () => atlasImpact(graph, validRoot, depth, direction),
    [graph, validRoot, depth, direction],
  );
  const affected = graph.nodes.filter((n) => n.id !== validRoot && distances.has(n.id));
  return (
    <section className="atlas-impact-view" aria-label="Atlas impact analysis">
      <header className="atlas-view-heading">
        <Crosshair size={20} />
        <div>
          <h2>Change impact</h2>
          <p>Trace real references to understand what may need review when this code changes.</p>
        </div>
      </header>
      <div className="atlas-impact-controls">
        <label>
          Starting node
          <select
            aria-label="Impact starting node"
            value={validRoot}
            onChange={(e) => {
              setRoot(e.target.value);
              onSelect(e.target.value);
            }}
          >
            {graph.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select
            aria-label="Impact direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
          >
            <option value="incoming">Dependents · what uses this</option>
            <option value="outgoing">Dependencies · what this uses</option>
          </select>
        </label>
        <label>
          Depth
          <select
            aria-label="Impact depth"
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          >
            {[1, 2, 3, 5].map((d) => (
              <option key={d} value={d}>
                {d} hops
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="atlas-impact-summary">
        <strong>{affected.length}</strong>
        <span>
          {direction === 'incoming' ? 'reachable dependents' : 'reachable dependencies'}
          <small>Static reference reachability; runtime behavior may differ.</small>
        </span>
      </div>
      {[...new Set(affected.map((n) => distances.get(n.id)!))]
        .sort((a, b) => a - b)
        .map((hop) => (
          <section className="atlas-impact-ring" key={hop}>
            <header>
              <span>{hop === 1 ? 'Direct' : `${hop} hops away`}</span>
              <b>{affected.filter((n) => distances.get(n.id) === hop).length}</b>
            </header>
            {affected
              .filter((n) => distances.get(n.id) === hop)
              .map((n) => (
                <button
                  type="button"
                  key={n.id}
                  aria-pressed={n.id === selected}
                  onClick={() => onSelect(n.id)}
                  onDoubleClick={() => onOpen(n.id)}
                >
                  <FileCode2 size={15} />
                  <span>
                    <strong>{n.label}</strong>
                    <small>{n.detail}</small>
                  </span>
                  <em>{n.group}</em>
                </button>
              ))}
          </section>
        ))}
      {!affected.length && (
        <p className="quiet-state">
          No references are reachable within this direction, depth, and filtered scope.
        </p>
      )}
    </section>
  );
}
