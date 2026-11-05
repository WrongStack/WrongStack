import { useMemo, useState } from 'react';
import { atlasBoundaries } from './atlas-boundary-model';
import { useDesktopText } from './desktop-i18n';
import { GraphCanvas } from './GraphCanvas';
import type { VisualGraph } from './graph-model';
import './atlas-boundaries.css';

export function AtlasBoundaryMap({
  graph,
  onSelect,
  onOpen,
  nodeLimit = 160,
}: {
  graph: VisualGraph;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  nodeLimit?: number | null;
}) {
  const { t } = useDesktopText();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  const projection = useMemo(
    () =>
      atlasBoundaries(graph, expanded, {
        group: t('atlasBoundary.subsystem'),
        detail: (members, internal) =>
          `${t('counts.nodes', { count: members })} · ${t('counts.internalReferences', { count: internal })}`,
      }),
    [graph, expanded, t],
  );
  const active = projection.graph.nodes.find((node) => node.id === selected);
  const group = active ? projection.groups.get(active.id) : undefined;
  const original = active?.data['originalId'];
  const toggle = (name: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const choose = (id: string) => {
    setSelected(id);
    const node = projection.graph.nodes.find((node) => node.id === id);
    if (typeof node?.data['originalId'] === 'string') onSelect(node.data['originalId']);
  };
  const activate = (id: string) => {
    const name = projection.groups.get(id);
    if (name !== undefined) toggle(name);
    else {
      const node = projection.graph.nodes.find((node) => node.id === id);
      if (typeof node?.data['originalId'] === 'string') onOpen(node.data['originalId']);
    }
  };
  const links = active
    ? projection.graph.edges.filter(
        (edge) => edge.source === active.id || edge.target === active.id,
      )
    : [];
  return (
    <section className="atlas-boundaries" aria-label={t('atlasBoundary.label')}>
      <header>
        <div>
          <h3>{t('atlasBoundary.title')}</h3>
          <p>{t('atlasBoundary.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary small"
          disabled={!expanded.size}
          onClick={() => {
            setExpanded(new Set());
            setSelected('');
          }}
        >
          {t('atlasBoundary.collapseAll')}
        </button>
      </header>
      <fieldset className="boundary-groups" aria-label={t('atlasBoundary.controls')}>
        {[...projection.groups.values()].map((name) => (
          <button
            type="button"
            key={name}
            aria-expanded={expanded.has(name)}
            onClick={() => toggle(name)}
          >
            {expanded.has(name)
              ? t('atlasBoundary.collapse', { name })
              : t('atlasBoundary.expand', { name })}
          </button>
        ))}
      </fieldset>
      <GraphCanvas
        graph={projection.graph}
        selected={active?.id ?? ''}
        onSelect={choose}
        onActivate={activate}
        label={t('atlasBoundary.graph')}
        empty={t('atlasViews.noNodes')}
        layout="layers"
        minimap
        directed
        nodeLimit={nodeLimit}
      />
      {nodeLimit !== null && projection.graph.nodes.length > nodeLimit && (
        <p>{t('atlasBoundary.limit', { number: nodeLimit })}</p>
      )}
      <p className="boundary-legend">
        {t('atlasBoundary.legend', {
          nodes: t('counts.projectedNodes', { count: projection.graph.nodes.length }),
          edges: t('counts.relationGroups', { count: projection.graph.edges.length }),
        })}
      </p>
      {active && (
        <aside aria-label={t('atlasBoundary.selected')} className="boundary-detail">
          <h4>{active.label}</h4>
          <p>{active.detail}</p>
          {group !== undefined && (
            <button type="button" className="button secondary small" onClick={() => toggle(group)}>
              {t('atlasBoundary.expand', { name: group })}
            </button>
          )}
          {typeof original === 'string' && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => onOpen(original)}
            >
              {t('atlasBoundary.explore', { name: active.label })}
            </button>
          )}
          <h4>{t('atlasBoundary.references')}</h4>
          {links.length ? (
            <ul>
              {links.map((edge, index) => (
                <li key={index}>
                  <button type="button" onClick={() => choose(edge.source)}>
                    {projection.graph.nodes.find((node) => node.id === edge.source)?.label}
                  </button>
                  <span> → </span>
                  <button type="button" onClick={() => choose(edge.target)}>
                    {projection.graph.nodes.find((node) => node.id === edge.target)?.label}
                  </button>
                  <small>
                    {t('atlasBoundary.weight', { label: edge.label, weight: edge.weight })}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('atlasBoundary.none')}</p>
          )}
        </aside>
      )}
    </section>
  );
}
