import type { Specification } from '@wrongstack/core/types/spec.js';
import type { TaskGraph, TaskNode } from '@wrongstack/core/types/task-graph.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { SpecVersioning } from '../src/spec-versioning.js';

function makeSpec(overrides: Partial<Specification> = {}): Specification {
  return {
    id: 'spec-1',
    title: 'Test Spec',
    version: '1.0.0',
    status: 'draft',
    overview: 'Overview',
    sections: [],
    requirements: [
      {
        id: 'REQ-1',
        type: 'functional',
        priority: 'high',
        description: 'Feature A',
        acceptanceCriteria: ['AC 1'],
      },
      {
        id: 'REQ-2',
        type: 'functional',
        priority: 'medium',
        description: 'Feature B',
        acceptanceCriteria: [],
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeGraph(nodes: TaskNode[] = []): TaskGraph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    id: 'graph-1',
    specId: 'spec-1',
    title: 'Test Graph',
    nodes: nodeMap,
    edges: [],
    rootNodes: nodes.map((n) => n.id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeNode(id: string, specReqId?: string): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: 'Description',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    specRequirementId: specReqId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('SpecVersioning', () => {
  let versioning: SpecVersioning;

  beforeEach(() => {
    versioning = new SpecVersioning();
  });

  it('records versions', () => {
    const spec = makeSpec();
    versioning.recordVersion(spec, 'Initial');
    const history = versioning.getHistory('spec-1');
    expect(history).toHaveLength(1);
    expect(history[0]!.version).toBe('1.0.0');
  });

  it('recorded versions are deep snapshots — later caller mutations do not corrupt history', () => {
    const spec = makeSpec();
    versioning.recordVersion(spec, 'Initial');

    // Caller keeps editing the same spec object after recording.
    spec.version = '2.0.0';
    spec.requirements.push({
      id: 'REQ-3',
      type: 'functional',
      priority: 'low',
      description: 'Added later',
      acceptanceCriteria: [],
    });
    spec.requirements[0]!.description = 'MUTATED';

    // The recorded snapshot must reflect the spec as it was at record time.
    const recorded = versioning.getLatest('spec-1')!;
    expect(recorded.version).toBe('1.0.0');
    expect(recorded.spec.version).toBe('1.0.0');
    expect(recorded.spec.requirements).toHaveLength(2);
    expect(recorded.spec.requirements[0]!.description).toBe('Feature A');
  });

  it('returns empty history for unknown spec', () => {
    expect(versioning.getHistory('unknown')).toEqual([]);
  });

  it('gets latest version', () => {
    const spec1 = makeSpec({ version: '1.0.0' });
    const spec2 = makeSpec({ version: '1.1.0' });
    versioning.recordVersion(spec1);
    versioning.recordVersion(spec2);
    const latest = versioning.getLatest('spec-1');
    expect(latest!.version).toBe('1.1.0');
  });

  it('gets specific version', () => {
    const spec1 = makeSpec({ version: '1.0.0' });
    const spec2 = makeSpec({ version: '1.1.0' });
    versioning.recordVersion(spec1);
    versioning.recordVersion(spec2);
    const v = versioning.getVersion('spec-1', '1.0.0');
    expect(v).toBeDefined();
    expect(v!.version).toBe('1.0.0');
  });

  it('returns undefined when an unknown spec or version is requested', () => {
    expect(versioning.getVersion('unknown', '1.0.0')).toBeUndefined();
    expect(versioning.getLatest('unknown')).toBeUndefined();

    versioning.recordVersion(makeSpec());
    expect(versioning.getVersion('spec-1', '9.9.9')).toBeUndefined();
  });

  it('computes diff with added requirements', () => {
    const old = makeSpec({ requirements: [] });
    const updated = makeSpec({
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'high',
          description: 'New',
          acceptanceCriteria: [],
        },
      ],
    });
    const diff = versioning.diff(old, updated);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.summary).toContain('1 added');
  });

  it('computes diff with removed requirements', () => {
    const old = makeSpec();
    const updated = makeSpec({ requirements: [] });
    const diff = versioning.diff(old, updated);
    expect(diff.removed).toHaveLength(2);
    expect(diff.summary).toContain('2 removed');
  });

  it('computes diff with modified requirements', () => {
    const old = makeSpec();
    const updated = makeSpec({
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'critical',
          description: 'Changed',
          acceptanceCriteria: [],
        },
        {
          id: 'REQ-2',
          type: 'functional',
          priority: 'medium',
          description: 'Feature B',
          acceptanceCriteria: [],
        },
      ],
    });
    const diff = versioning.diff(old, updated);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.changes).toContain('description');
    expect(diff.modified[0]!.changes).toContain('priority');
  });

  it('reports every supported requirement change', () => {
    const old = makeSpec({
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'high',
          description: 'Before',
          acceptanceCriteria: ['old'],
          blockedBy: ['REQ-0'],
        },
      ],
    });
    const updated = makeSpec({
      requirements: [
        {
          id: 'REQ-1',
          type: 'security',
          priority: 'low',
          description: 'After',
          acceptanceCriteria: ['new'],
          blockedBy: ['REQ-X'],
        },
      ],
    });

    expect(versioning.diff(old, updated).modified[0]!.changes).toEqual([
      'description',
      'priority',
      'type',
      'acceptance criteria',
      'dependencies',
    ]);
  });

  it('returns no changes for identical specs', () => {
    const spec = makeSpec();
    const diff = versioning.diff(spec, spec);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
    expect(diff.summary).toBe('No changes');
  });

  it('updates task graph with added requirements', () => {
    const old = makeSpec({ requirements: [] });
    const updated = makeSpec({
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'high',
          description: 'New Feature',
          acceptanceCriteria: [],
        },
      ],
    });
    const graph = makeGraph([]);
    const result = versioning.updateTaskGraph(graph, old, updated);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.graph.nodes.size).toBe(1);
  });

  it('updates task graph with removed requirements', () => {
    const old = makeSpec();
    const updated = makeSpec({ requirements: [] });
    const node = makeNode('task-1', 'REQ-1');
    const graph = makeGraph([node]);
    const result = versioning.updateTaskGraph(graph, old, updated);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.graph.nodes.size).toBe(0);
  });

  it('removes connected edges and ignores requirements without tasks', () => {
    const old = makeSpec();
    const updated = makeSpec({ requirements: [] });
    const node = makeNode('task-1', 'REQ-1');
    const unrelated = makeNode('task-2');
    const graph = makeGraph([node, unrelated]);
    graph.edges = [
      { id: 'edge-in', from: 'task-2', to: 'task-1', type: 'depends_on' },
      { id: 'edge-out', from: 'task-1', to: 'task-2', type: 'depends_on' },
      { id: 'edge-keep', from: 'task-2', to: 'other', type: 'depends_on' },
    ];

    const result = versioning.updateTaskGraph(graph, old, updated);

    expect(result.graph.edges).toEqual([
      { id: 'edge-keep', from: 'task-2', to: 'other', type: 'depends_on' },
    ]);
    expect(result.changes).toEqual(['Removed task: Task task-1']);
  });

  it('updates task graph with modified requirements', () => {
    const old = makeSpec();
    const updated = makeSpec({
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'critical',
          description: 'Updated Feature',
          acceptanceCriteria: [],
        },
        {
          id: 'REQ-2',
          type: 'functional',
          priority: 'medium',
          description: 'Feature B',
          acceptanceCriteria: [],
        },
      ],
    });
    const node = makeNode('task-1', 'REQ-1');
    const graph = makeGraph([node]);
    const result = versioning.updateTaskGraph(graph, old, updated);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.graph.nodes.get('task-1')!.title).toBe('Updated Feature');
    expect(result.graph.nodes.get('task-1')!.priority).toBe('critical');
  });

  it('ignores a modified requirement that has no matching task', () => {
    const old = makeSpec();
    const updated = makeSpec({
      requirements: [
        {
          ...old.requirements[0]!,
          description: 'Changed without a task',
        },
        old.requirements[1]!,
      ],
    });

    const result = versioning.updateTaskGraph(makeGraph(), old, updated);

    expect(result.changes).toEqual([]);
    expect(result.graph.nodes.size).toBe(0);
  });

  it.each(['functional', 'non-functional', 'security', 'performance', 'ux'] as const)(
    'maps an added %s requirement to a feature task',
    (type) => {
      const old = makeSpec({ requirements: [] });
      const updated = makeSpec({
        requirements: [
          {
            id: `REQ-${type}`,
            type,
            priority: 'high',
            description: `${type} requirement`,
            acceptanceCriteria: ['first', 'second'],
          },
        ],
      });

      const result = versioning.updateTaskGraph(makeGraph(), old, updated);
      const task = [...result.graph.nodes.values()][0]!;

      expect(task.type).toBe('feature');
      expect(task.description).toContain('**Acceptance Criteria:**\n- first\n- second');
    },
  );

  it('rejects an unsupported requirement type', () => {
    const old = makeSpec({ requirements: [] });
    const updated = makeSpec({
      requirements: [
        {
          id: 'REQ-invalid',
          type: 'invalid' as never,
          priority: 'high',
          description: 'Invalid requirement',
          acceptanceCriteria: [],
        },
      ],
    });

    expect(() => versioning.updateTaskGraph(makeGraph(), old, updated)).toThrow();
  });
});
