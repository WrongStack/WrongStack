import { Background, Controls, type Edge, type Node, Position, ReactFlow } from '@xyflow/react';
import { useDesktopText } from './desktop-i18n';
import { entries } from './engine-state';
import '@xyflow/react/dist/style.css';

/** The engine reports dependencies as short task IDs in topological columns. */
export function sddGraphElements(columns: Record<string, unknown>[]): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = [];
  const tasks: Record<string, unknown>[] = [];
  const byShortId = new Map<string, string>();
  for (const [columnIndex, column] of columns.entries()) {
    for (const [rowIndex, task] of entries(column['tasks']).entries()) {
      if (typeof task['id'] !== 'string' || !task['id']) continue;
      const id = task['id'];
      if (typeof task['shortId'] === 'string') byShortId.set(task['shortId'], id);
      tasks.push(task);
      nodes.push({
        id,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        position: { x: columnIndex * 270, y: rowIndex * 110 },
        data: {
          label: `${typeof task['shortId'] === 'string' ? `${task['shortId']} · ` : ''}${typeof task['title'] === 'string' ? task['title'] : 'Task'}`,
        },
        draggable: false,
      });
    }
  }
  const edges: Edge[] = [];
  for (const task of tasks) {
    if (!Array.isArray(task['deps']) || typeof task['id'] !== 'string') continue;
    for (const dependency of task['deps']) {
      const source = typeof dependency === 'string' ? byShortId.get(dependency) : undefined;
      if (source) edges.push({ id: `${source}->${task['id']}`, source, target: task['id'] });
    }
  }
  return { nodes, edges };
}

export function SddDependencyGraph({ columns }: { columns: Record<string, unknown>[] }) {
  const { t } = useDesktopText();
  const { nodes, edges } = sddGraphElements(columns);
  return (
    <section className="sdd-flow" aria-label={t('sddView.graphLabel')}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' && value ? value : fallback;

/** A specification's task graph as a list: one column per phase, in dependency order. */
export function SddTaskColumns({ columns }: { columns: Record<string, unknown>[] }) {
  const { t } = useDesktopText();
  const named = (value: unknown) =>
    typeof value === 'string' && value
      ? t(`sddView.value.${value}`, { defaultValue: value.replaceAll('_', ' ') })
      : t('sddView.notReported');
  return (
    <div className="sdd-task-columns">
      {columns.map((column, i) => (
        <section key={i}>
          <h3>{text(column['label'], t('sddView.phase'))}</h3>
          {entries(column['tasks']).map((item) => (
            <article key={String(item['id'])}>
              <strong>{text(item['title'], t('sddView.task'))}</strong>
              <p>{text(item['description'], '')}</p>
              <small>
                {named(item['displayStatus'] ?? item['status'])} · {named(item['priority'])}
              </small>
              {Array.isArray(item['deps']) && item['deps'].length > 0 && (
                <small>
                  {t('sddView.dependsOn', {
                    list: item['deps'].filter((x) => typeof x === 'string').join(', '),
                  })}
                </small>
              )}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
