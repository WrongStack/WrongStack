import { DefaultTaskStore, TaskTracker } from '@wrongstack/core/tasking';
import type { Specification } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  assertSpecTaskGraphCoverage,
  assertTaskGraphExecutionIntegrity,
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
});
