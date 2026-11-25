import type { Specification, TaskGraph } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { SpecVersioning } from '../src/spec-versioning.js';

describe('SpecVersioning blockedBy whitespace trimming (F1999)', () => {
  it('trims blockedBy requirement IDs when wiring depends_on edges', () => {
    const sv = new SpecVersioning();
    const baseSpec = {
      id: 's1',
      title: 'Spec',
      version: '1.0.0',
      status: 'draft',
      overview: '',
      sections: [],
      requirements: [
        {
          id: 'REQ-1',
          type: 'functional',
          priority: 'medium',
          description: 'First',
          acceptanceCriteria: [],
        },
      ],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Specification;
    const nextSpec = {
      ...baseSpec,
      version: '1.1.0',
      requirements: [
        ...baseSpec.requirements,
        {
          id: 'REQ-2',
          type: 'functional',
          priority: 'medium',
          description: 'Second',
          acceptanceCriteria: [],
          blockedBy: [' REQ-1 '],
        },
      ],
    } as unknown as Specification;
    const graph = {
      id: 'g1',
      specId: 's1',
      title: 'Graph',
      nodes: new Map([
        [
          't1',
          {
            id: 't1',
            title: 'First',
            description: 'First',
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            specRequirementId: 'REQ-1',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      ]),
      edges: [],
      rootNodes: ['t1'],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TaskGraph;
    const { graph: updated } = sv.updateTaskGraph(graph, baseSpec, nextSpec);
    expect(updated.edges).toHaveLength(1);
  });
});
