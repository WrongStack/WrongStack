import { expect, it } from 'vitest';
import { endpointLabel, readContractGraph } from '../src/KanbanContractMap';

it('reads the contract graph and labels edge endpoints', () => {
  const graph = readContractGraph({
    enforcement: 'strict',
    nodes: [
      {
        id: 'n1',
        taskId: 't1',
        kind: 'objective',
        title: 'Fast',
        enforcement: 'blocking',
        state: 'waived',
        waiver: { actor: 'me', reason: 'later' },
      },
      { id: 'bad' },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'task:t1', type: 'targets' }, { from: 'x' }],
  });
  expect(graph.enforcement).toBe('strict');
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]?.waiver).toBe('me: later');
  expect(graph.edges.map((edge) => edge.id)).toEqual(['e1']);
  const tasks = [{ id: 't1', title: 'Cache' }];
  expect(endpointLabel('n1', graph.nodes, tasks)).toBe('objective: Fast');
  expect(endpointLabel('task:t1', graph.nodes, tasks)).toBe('Card: Cache');
  expect(endpointLabel('gone', graph.nodes, tasks)).toBe('gone');
  // A board without a map reads as off and empty.
  expect(readContractGraph(undefined)).toEqual({ enforcement: 'off', nodes: [], edges: [] });
});
