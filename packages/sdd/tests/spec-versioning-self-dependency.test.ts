/**
 * SpecVersioning.updateTaskGraph — self-dependency invariant on the MODIFIED
 * requirement path.
 *
 * A task never depends on itself: TaskTracker.addDependency rejects self-loops
 * and the added-requirement path of updateTaskGraph guards self-references
 * twice. The modified-requirement rewiring path must honour the same rule — a
 * spec revision whose blockedBy names the requirement itself must not wedge
 * its tasks with a self-edge they can never satisfy (the critical-path
 * analysis would report them blocked forever).
 */
import type { Specification, TaskGraph } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { SpecVersioning } from '../src/spec-versioning.js';

function spec(requirements: Array<Record<string, unknown>>): Specification {
  return {
    id: 's1',
    title: 'Spec',
    version: '1.0.0',
    status: 'draft',
    overview: '',
    sections: [],
    requirements,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Specification;
}

function req(id: string, blockedBy?: string[]): Record<string, unknown> {
  return {
    id,
    type: 'functional',
    priority: 'medium',
    description: `Requirement ${id}`,
    acceptanceCriteria: [],
    ...(blockedBy ? { blockedBy } : {}),
  };
}

function node(id: string, reqId: string): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    specRequirementId: reqId,
    createdAt: 0,
    updatedAt: 0,
  };
}

function graph(nodes: Array<[string, Record<string, unknown>]>): TaskGraph {
  return {
    id: 'g1',
    specId: 's1',
    title: 'Graph',
    nodes: new Map(nodes),
    edges: [],
    rootNodes: nodes.map(([id]) => id),
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TaskGraph;
}

const TWO_TASKS: Array<[string, Record<string, unknown>]> = [
  ['t1', node('t1', 'REQ-1')],
  ['t2', node('t2', 'REQ-2')],
];

describe('SpecVersioning.updateTaskGraph — modified requirement self blockedBy', () => {
  it('does not create a self-dependency edge', () => {
    const sv = new SpecVersioning();
    const oldSpec = spec([req('REQ-1'), req('REQ-2')]);
    const newSpec = spec([req('REQ-1', ['REQ-1']), req('REQ-2')]);
    const { graph: updated } = sv.updateTaskGraph(graph(TWO_TASKS), oldSpec, newSpec);
    expect(updated.edges.filter((e) => e.from === e.to)).toEqual([]);
    expect(updated.edges).toEqual([]);
  });

  it('ignores a whitespace-padded self reference', () => {
    const sv = new SpecVersioning();
    const oldSpec = spec([req('REQ-1'), req('REQ-2')]);
    const newSpec = spec([req('REQ-1', [' REQ-1 ']), req('REQ-2')]);
    const { graph: updated } = sv.updateTaskGraph(graph(TWO_TASKS), oldSpec, newSpec);
    expect(updated.edges).toEqual([]);
  });

  it('does not wedge any task of a 1-to-many decomposed requirement', () => {
    const sv = new SpecVersioning();
    const oldSpec = spec([req('REQ-1'), req('REQ-2')]);
    const newSpec = spec([req('REQ-1', ['REQ-1']), req('REQ-2')]);
    const nodes: Array<[string, Record<string, unknown>]> = [
      ['t1a', node('t1a', 'REQ-1')],
      ['t1b', node('t1b', 'REQ-1')],
      ['t2', node('t2', 'REQ-2')],
    ];
    const { graph: updated } = sv.updateTaskGraph(graph(nodes), oldSpec, newSpec);
    expect(updated.edges.filter((e) => e.from === e.to)).toEqual([]);
    expect(updated.edges).toEqual([]);
  });

  it('removes a pre-existing self edge when the dependency list changes', () => {
    const sv = new SpecVersioning();
    const oldSpec = spec([req('REQ-1', ['REQ-1']), req('REQ-2')]);
    const newSpec = spec([req('REQ-1', ['REQ-2']), req('REQ-2')]);
    const g = graph(TWO_TASKS);
    g.edges.push({ id: 'e-self', from: 't1', to: 't1', type: 'depends_on' });
    const { graph: updated } = sv.updateTaskGraph(g, oldSpec, newSpec);
    expect(updated.edges.filter((e) => e.from === e.to)).toEqual([]);
    expect(updated.edges).toHaveLength(1);
    expect(updated.edges[0]).toMatchObject({ from: 't2', to: 't1', type: 'depends_on' });
  });
});

describe('controls — unaffected paths keep working', () => {
  it('added requirement with a self blockedBy stays guarded', () => {
    const sv = new SpecVersioning();
    const oldSpec = spec([req('REQ-1')]);
    const newSpec = spec([req('REQ-1'), req('REQ-2', ['REQ-2'])]);
    const { graph: updated } = sv.updateTaskGraph(
      graph([['t1', node('t1', 'REQ-1')]]),
      oldSpec,
      newSpec,
    );
    expect(updated.edges.filter((e) => e.from === e.to)).toEqual([]);
  });

  it('a legitimate modified dependency still wires blocker → dependent', () => {
    const sv = new SpecVersioning();
    const oldSpec = spec([req('REQ-1'), req('REQ-2')]);
    const newSpec = spec([req('REQ-1', ['REQ-2']), req('REQ-2')]);
    const { graph: updated } = sv.updateTaskGraph(graph(TWO_TASKS), oldSpec, newSpec);
    expect(updated.edges).toHaveLength(1);
    expect(updated.edges[0]).toMatchObject({ from: 't2', to: 't1', type: 'depends_on' });
  });
});
