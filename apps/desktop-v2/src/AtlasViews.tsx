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
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
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
    <section className="atlas-subsystem-view" aria-label={t('atlasViews.subsystemsLabel')}>
      <header className="atlas-view-heading">
        <Box size={20} />
        <div>
          <h2>{t('atlasViews.subsystemsTitle')}</h2>
          <p>{t('atlasViews.subsystemsIntro')}</p>
        </div>
        <fieldset className="atlas-grouping" aria-label={t('atlasViews.groupBy')}>
          <button
            type="button"
            aria-pressed={grouping === 'stored'}
            onClick={() => setChoice('stored')}
          >
            {explicit ? t('atlasViews.stored') : t('atlasViews.nodeKind')}
          </button>
          <button
            type="button"
            aria-pressed={grouping === 'inferred'}
            onClick={() => setChoice('inferred')}
          >
            {t('atlasViews.inferred')}
          </button>
        </fieldset>
      </header>
      {grouping === 'inferred' && (
        <p className="field-help">
          {t('atlasViews.inferredHelp')}
          {!explicit && t('atlasViews.noStoredGroups')}
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
                <small>{t('atlasViews.nodes')}</small>
              </strong>
            </header>
            <div className="atlas-subsystem-size">
              <span
                style={{ width: `${(100 * g.nodes.length) / Math.max(1, graph.nodes.length)}%` }}
              />
            </div>
            <dl>
              <div>
                <dt>{t('atlasViews.internal')}</dt>
                <dd>{g.internal}</dd>
              </div>
              <div>
                <dt>
                  <ArrowDownLeft size={11} />
                  {t('atlasViews.inbound')}
                </dt>
                <dd>{g.incoming}</dd>
              </div>
              <div>
                <dt>
                  <ArrowUpRight size={11} />
                  {t('atlasViews.outbound')}
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
                  aria-label={t('atlasViews.inspect', { name: n.label })}
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
      {!groups.length && <p className="quiet-state">{t('atlasViews.noNodes')}</p>}
    </section>
  );
}

export function AtlasMatrixView({ graph, selected, onSelect }: Props) {
  const { t } = useDesktopText();
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
    <section className="atlas-matrix-view" aria-label={t('atlasViews.matrixLabel')}>
      <header className="atlas-view-heading">
        <div>
          <h2>{t('atlasViews.matrixTitle')}</h2>
          <p>{t('atlasViews.matrixIntro')}</p>
        </div>
      </header>
      <div className="atlas-matrix-pages">
        <span>
          {t('atlasViews.sources', {
            from: nodes.length ? safeRow * size + 1 : 0,
            to: Math.min((safeRow + 1) * size, nodes.length),
          })}
        </span>
        <button
          type="button"
          aria-label={t('atlasViews.prevSources')}
          disabled={safeRow === 0}
          onClick={() => setRowPage(safeRow - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          aria-label={t('atlasViews.nextSources')}
          disabled={safeRow >= pages - 1}
          onClick={() => setRowPage(safeRow + 1)}
        >
          <ChevronRight size={14} />
        </button>
        <span>
          {t('atlasViews.targets', {
            from: nodes.length ? safeCol * size + 1 : 0,
            to: Math.min((safeCol + 1) * size, nodes.length),
            total: nodes.length,
          })}
        </span>
        <button
          type="button"
          aria-label={t('atlasViews.prevTargets')}
          disabled={safeCol === 0}
          onClick={() => setColPage(safeCol - 1)}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          aria-label={t('atlasViews.nextTargets')}
          disabled={safeCol >= pages - 1}
          onClick={() => setColPage(safeCol + 1)}
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="atlas-matrix-scroll">
        <table>
          <caption>{t('atlasViews.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('atlasViews.corner')}</th>
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
                          aria-label={t('atlasViews.cell', {
                            source: n.label,
                            target: c.label,
                            relations: refs.map((e) => e.label).join(', '),
                          })}
                          title={t('atlasViews.cellTitle', {
                            relations: refs.map((e) => e.label.replaceAll('_', ' ')).join(', '),
                            weight: refs.reduce((s, e) => s + e.weight, 0),
                          })}
                          onClick={() => onSelect(c.id)}
                        >
                          {refs.length}
                        </button>
                      ) : (
                        <span title={t('atlasViews.noReference')}>·</span>
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
  const { t } = useDesktopText();
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
    <section className="atlas-impact-view" aria-label={t('atlasViews.impactLabel')}>
      <header className="atlas-view-heading">
        <Crosshair size={20} />
        <div>
          <h2>{t('atlasViews.impactTitle')}</h2>
          <p>{t('atlasViews.impactIntro')}</p>
        </div>
      </header>
      <div className="atlas-impact-controls">
        <label>
          {t('atlasViews.start')}
          <select
            aria-label={t('atlasViews.startLabel')}
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
          {t('atlasViews.direction')}
          <select
            aria-label={t('atlasViews.directionLabel')}
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
          >
            <option value="incoming">{t('atlasViews.incoming')}</option>
            <option value="outgoing">{t('atlasViews.outgoing')}</option>
          </select>
        </label>
        <label>
          {t('atlasViews.depth')}
          <select
            aria-label={t('atlasViews.depthLabel')}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
          >
            {[1, 2, 3, 5].map((d) => (
              <option key={d} value={d}>
                {t('atlasViews.hops', { number: d })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="atlas-impact-summary">
        <strong>{affected.length}</strong>
        <span>
          {direction === 'incoming' ? t('atlasViews.dependents') : t('atlasViews.dependencies')}
          <small>{t('atlasViews.static')}</small>
        </span>
      </div>
      {[...new Set(affected.map((n) => distances.get(n.id)!))]
        .sort((a, b) => a - b)
        .map((hop) => (
          <section className="atlas-impact-ring" key={hop}>
            <header>
              <span>
                {hop === 1 ? t('atlasViews.direct') : t('atlasViews.hopsAway', { number: hop })}
              </span>
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
      {!affected.length && <p className="quiet-state">{t('atlasViews.noImpact')}</p>}
    </section>
  );
}
