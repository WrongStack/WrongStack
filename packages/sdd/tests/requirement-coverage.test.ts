import { DefaultTaskStore, TaskTracker } from '@wrongstack/core/tasking';
import type { Specification } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  assertSpecTaskGraphCoverage,
  assertTaskGraphExecutionIntegrity,
  assertTaskGraphRequirementCoverage,
  evaluateTaskGraphRequirementCoverage,
} from '../src/requirement-coverage.js';
import { TaskGenerator } from '../src/task-generator.js';

function specification(): Specification {
  return {
    id: 'spec-1',
    title: 'Deterministic scope',
    version: '1',
    status: 'approved',
    overview: 'Implement both requirements.',
    sections: [],
    requirements: [
      {
        id: 'REQ-1',
        type: 'functional',
        priority: 'high',
        description: 'First requirement',
        acceptanceCriteria: ['First behavior works'],
      },
      {
        id: 'REQ-2',
        type: 'security',
        priority: 'critical',
        description: 'Second requirement',
        acceptanceCriteria: ['Second behavior is verified'],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('task graph requirement coverage', () => {
  it('declares the approved scope and refuses removal of its last implementing task', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await new TaskGenerator({ taskTracker: tracker }).generateFromSpec(
      specification(),
    );

    expect(graph.requiredRequirementIds).toEqual(['REQ-1', 'REQ-2']);
    expect(evaluateTaskGraphRequirementCoverage(graph).valid).toBe(true);
    const req1 = Array.from(graph.nodes.values()).find(
      (node) => node.specRequirementId === 'REQ-1',
    )!;
    expect(tracker.removeNode(req1.id)).toBe(false);
    expect(graph.nodes.has(req1.id)).toBe(true);
  });

  it('repairs an LLM-authored graph by adding every omitted approved requirement', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Model proposal');
    tracker.addNode({
      title: 'A vague model task',
      description: 'Does not carry requirement traceability.',
      type: 'feature',
      priority: 'medium',
      status: 'pending',
    });

    const added = new TaskGenerator({ taskTracker: tracker }).ensureRequirementCoverage(
      specification(),
      graph,
    );

    expect(added.map((node) => node.specRequirementId).sort()).toEqual(['REQ-1', 'REQ-2']);
    expect(() => assertSpecTaskGraphCoverage(graph, specification())).not.toThrow();
  });

  it('blocks execution when declared coverage is missing or points outside the spec', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Invalid proposal');
    graph.requiredRequirementIds = ['REQ-1', 'REQ-2'];
    tracker.addNode({
      title: 'Wrong mapping',
      description: 'Maps to no approved requirement.',
      type: 'feature',
      priority: 'medium',
      status: 'pending',
      specRequirementId: 'REQ-X',
    });

    expect(() => assertSpecTaskGraphCoverage(graph, specification())).toThrow(
      'missing task coverage for REQ-1, REQ-2',
    );
    expect(() => assertSpecTaskGraphCoverage(graph, specification())).toThrow(
      'unknown requirements REQ-X',
    );
  });

  it('fails before dispatch for dangling dependency edges and dependency cycles', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Broken DAG');
    const first = tracker.addNode({
      title: 'First',
      description: 'First',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    graph.edges.push({
      id: 'dangling',
      from: first.id,
      to: 'missing',
      type: 'depends_on',
    });
    expect(() => assertTaskGraphExecutionIntegrity(graph)).toThrow('references a missing task');

    graph.edges = [];
    const second = tracker.addNode({
      title: 'Second',
      description: 'Second',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    graph.edges.push(
      { id: 'one', from: first.id, to: second.id, type: 'depends_on' },
      { id: 'two', from: second.id, to: first.id, type: 'depends_on' },
    );
    expect(() => assertTaskGraphExecutionIntegrity(graph)).toThrow('dependency cycle');
  });

  it('falls back to an empty scope when the graph declares no requirements (:17, :39)', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Scope-less graph');
    expect(graph.requiredRequirementIds).toBeUndefined();

    const result = evaluateTaskGraphRequirementCoverage(graph);
    expect(result).toEqual({
      valid: true,
      requiredRequirementIds: [],
      missingRequirementIds: [],
      unknownRequirementIds: [],
    });
    expect(() => assertTaskGraphRequirementCoverage(graph)).not.toThrow();
  });

  it('reports unknown-only problems without a missing section (:44)', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Unknown mapping');
    tracker.addNode({
      title: 'Wrong mapping',
      description: 'Maps outside the declared scope.',
      type: 'feature',
      priority: 'medium',
      status: 'pending',
      specRequirementId: 'REQ-X',
    });

    let message = '';
    try {
      assertTaskGraphRequirementCoverage(graph, []);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('unknown requirements REQ-X');
    expect(message).not.toContain('missing task coverage');
  });

  it('reports missing-only problems without an unknown section (:47)', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Missing mapping');

    let message = '';
    try {
      assertTaskGraphRequirementCoverage(graph, ['REQ-9']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('missing task coverage for REQ-9');
    expect(message).not.toContain('unknown requirements');
  });

  it('throws when the graph targets a different spec (:55)', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Mismatched graph');

    expect(() => assertSpecTaskGraphCoverage(graph, { ...specification(), id: 'spec-2' })).toThrow(
      'Task graph spec mismatch',
    );
  });

  it('treats a spec without requirements as an empty scope (:62)', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Empty scope');
    const spec = { ...specification(), requirements: undefined } as unknown as Specification;

    expect(() => assertSpecTaskGraphCoverage(graph, spec)).not.toThrow();
  });

  it('rejects a self-referencing dependency (:75)', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Self cycle');
    const node = tracker.addNode({
      title: 'Self',
      description: 'Self',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    graph.edges.push({ id: 'self', from: node.id, to: node.id, type: 'depends_on' });

    expect(() => assertTaskGraphExecutionIntegrity(graph)).toThrow('is a self-cycle');
  });

  it('decrements multi-edge indegree before a dependent becomes ready (:96)', async () => {
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    const graph = await tracker.createGraph('spec-1', 'Diamond DAG');
    const a = tracker.addNode({
      title: 'A',
      description: 'A',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    const b = tracker.addNode({
      title: 'B',
      description: 'B',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    const c = tracker.addNode({
      title: 'C',
      description: 'C',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    // C waits on both A and B: after the first decrement its indegree is 1,
    // so it must NOT be queued early.
    graph.edges.push(
      { id: 'ac', from: a.id, to: c.id, type: 'depends_on' },
      { id: 'bc', from: b.id, to: c.id, type: 'depends_on' },
    );

    expect(() => assertTaskGraphExecutionIntegrity(graph)).not.toThrow();
  });
});
