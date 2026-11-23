import { describe, expect, it } from 'vitest';
import {
  type CodeMapGraphResponse,
  inferGraphCommunities,
  layoutGraph,
  listGraphClusters,
} from '../src/atlas/codemap-model.js';

// Two coupled triangles joined by one weak edge: Louvain finds two communities.
// File labels are basenames, so both hubs can be called `index.ts`.
function twoCommunities(hubA: string, hubB: string): CodeMapGraphResponse {
  return {
    nodes: [
      { id: 'file:src/auth/index.ts', label: hubA, kind: 'file', package: 'p', rank: 0.9 },
      {
        id: 'file:src/auth/session.ts',
        label: 'session.ts',
        kind: 'file',
        package: 'p',
        rank: 0.7,
      },
      { id: 'file:src/auth/token.ts', label: 'token.ts', kind: 'file', package: 'p', rank: 0.5 },
      { id: 'file:src/billing/index.ts', label: hubB, kind: 'file', package: 'p', rank: 0.8 },
      {
        id: 'file:src/billing/ledger.ts',
        label: 'ledger.ts',
        kind: 'file',
        package: 'p',
        rank: 0.6,
      },
      {
        id: 'file:src/billing/stripe.ts',
        label: 'stripe.ts',
        kind: 'file',
        package: 'p',
        rank: 0.4,
      },
    ],
    edges: [
      {
        source: 'file:src/auth/index.ts',
        target: 'file:src/auth/session.ts',
        weight: 5,
        refType: 'call',
      },
      {
        source: 'file:src/auth/session.ts',
        target: 'file:src/auth/token.ts',
        weight: 5,
        refType: 'call',
      },
      {
        source: 'file:src/auth/index.ts',
        target: 'file:src/auth/token.ts',
        weight: 4,
        refType: 'import',
      },
      {
        source: 'file:src/billing/index.ts',
        target: 'file:src/billing/ledger.ts',
        weight: 5,
        refType: 'call',
      },
      {
        source: 'file:src/billing/ledger.ts',
        target: 'file:src/billing/stripe.ts',
        weight: 5,
        refType: 'call',
      },
      {
        source: 'file:src/billing/index.ts',
        target: 'file:src/billing/stripe.ts',
        weight: 4,
        refType: 'import',
      },
      {
        source: 'file:src/auth/session.ts',
        target: 'file:src/billing/index.ts',
        weight: 1,
        refType: 'call',
      },
    ],
  };
}

describe('inferGraphCommunities hub-label collision (F1300)', () => {
  it('keeps two communities whose hubs share a basename as separate clusters and bands', () => {
    const graph = twoCommunities('index.ts', 'index.ts');
    const communities = inferGraphCommunities(graph);
    expect(communities.get('file:src/auth/index.ts')).not.toBe(
      communities.get('file:src/billing/index.ts'),
    );
    expect(listGraphClusters(graph).map((cluster) => cluster.count)).toEqual([3, 3]);
    const y = new Map(layoutGraph(graph, 'subsystems').map((p) => [p.node.id, p.position.y]));
    expect(y.get('file:src/auth/index.ts')).not.toBe(y.get('file:src/billing/index.ts'));
  });

  it('leaves non-colliding community names in the plain `cluster:<hub>` form', () => {
    const communities = inferGraphCommunities(twoCommunities('login.ts', 'invoice.ts'));
    expect(communities.get('file:src/auth/index.ts')).toBe('cluster:login.ts');
    expect(communities.get('file:src/billing/index.ts')).toBe('cluster:invoice.ts');
  });
});
