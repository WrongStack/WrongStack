import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { useMemo } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { RosterRecord } from './roster-model';
import '@xyflow/react/dist/style.css';

export function RosterInheritance({
  catalog,
  selected,
  onSelect,
}: {
  catalog: RosterRecord[];
  selected: string;
  onSelect: (role: string) => void;
}) {
  const { t } = useDesktopText();
  const graph = useMemo(() => {
    const byRole = new Map(catalog.map((entry) => [String(entry['role']), entry]));
    const shown = new Set<string>([selected]);
    let cursor = selected;
    for (let depth = 0; depth < 32; depth++) {
      const parent = byRole.get(cursor)?.['baseRole'];
      if (typeof parent !== 'string' || !byRole.has(parent) || shown.has(parent)) break;
      shown.add(parent);
      cursor = parent;
    }
    const children = catalog.filter((entry) => entry['baseRole'] === selected);
    for (const child of children.slice(0, 60)) shown.add(String(child['role']));
    const depthOf = (role: string, path = new Set<string>()): number => {
      if (path.has(role)) return 0;
      path.add(role);
      const parent = byRole.get(role)?.['baseRole'];
      return typeof parent === 'string' && shown.has(parent)
        ? Math.min(32, depthOf(parent, path) + 1)
        : 0;
    };
    const rows = new Map<number, number>();
    const nodes: Node[] = [...shown]
      .filter((role) => byRole.has(role))
      .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))
      .map((role) => {
        const depth = depthOf(role),
          row = rows.get(depth) ?? 0;
        rows.set(depth, row + 1);
        const entry = byRole.get(role)!;
        return {
          id: role,
          position: { x: depth * 270, y: row * 108 },
          // Parents sit left of their children: edges leave right and enter left, instead of
          // looping from the bottom of one card over the top of the next.
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          selected: role === selected,
          data: {
            label: (
              <div>
                <strong>{String(entry['name'] ?? role)}</strong>
                <small>{role}</small>
              </div>
            ),
          },
          style: {
            width: 220,
            borderColor: role === selected ? 'var(--accent)' : 'var(--border)',
            background: role === selected ? 'var(--accent-soft)' : 'var(--raised)',
            color: 'var(--text)',
            borderRadius: 8,
          },
        };
      });
    const edges: Edge[] = nodes.flatMap((node) => {
      const parent = byRole.get(node.id)?.['baseRole'];
      return typeof parent === 'string' && shown.has(parent)
        ? [
            {
              id: `${parent}:${node.id}`,
              source: parent,
              target: node.id,
              type: 'smoothstep',
              label: 'base role',
              style: { stroke: 'var(--accent)' },
              labelStyle: { fill: 'var(--text)' },
              labelBgStyle: { fill: 'var(--raised)' },
            },
          ]
        : [];
    });
    return { nodes, edges, omitted: Math.max(0, children.length - 60) };
  }, [catalog, selected]);
  return (
    <section className="roster-inheritance" aria-label={t('inheritance.label')}>
      <p>
        {t('inheritance.help')}
        {graph.omitted > 0 ? ` ${t('inheritance.omitted', { count: graph.omitted })}` : ''}
      </p>
      <div>
        <ReactFlow
          key={selected}
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          minZoom={0.15}
          maxZoom={1.5}
          fitViewOptions={{ maxZoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) => onSelect(node.id)}
        >
          <Background color="var(--border)" />
          <Controls showInteractive={false} />
          {graph.nodes.length > 10 && <MiniMap nodeColor="var(--accent)" maskColor="transparent" />}
        </ReactFlow>
      </div>
    </section>
  );
}
