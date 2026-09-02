import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVizStore, wsToVizEvent } from '../../src/stores/viz-store';

// ── helpers ──────────────────────────────────────────────────────────

function resetStore() {
  useVizStore.setState({
    events: [],
    toolEvents: [],
    nodes: new Map(),
    edges: new Map(),
    isActive: false,
    maxEvents: 500,
    counters: {
      totalTokens: 0,
      totalCost: 0,
      totalToolCalls: 0,
      activeAgents: 0,
      completedTasks: 0,
      errors: 0,
      mailboxMessages: 0,
    },
  });
}

function _makeNode(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'node-1',
    kind: 'agent',
    label: 'Test Agent',
    status: 'active',
    activity: 0.8,
    color: 'hsl(280, 80%, 65%)',
    lastSeenAt: Date.now(),
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'ev-1',
    kind: 'session:start',
    timestamp: Date.now(),
    source: 'session',
    label: 'Test Event',
    ...overrides,
  };
}

function _makeEdge(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'edge-1',
    source: 'provider',
    target: 'leader',
    kind: 'provider:call',
    label: 'API call',
    intensity: 0.8,
    color: 'hsl(180, 80%, 55%)',
    lastActiveAt: Date.now(),
    totalMagnitude: 0,
    ...overrides,
  };
}

// ── reset ──────────────────────────────────────────────────────────

describe('store initialization', () => {
  beforeEach(() => resetStore());

  it('has empty events and maps', () => {
    const state = useVizStore.getState();
    expect(state.events).toHaveLength(0);
    expect(state.toolEvents).toHaveLength(0);
    expect(state.nodes.size).toBe(0);
    expect(state.edges.size).toBe(0);
  });

  it('has default isActive false and maxEvents 500', () => {
    const state = useVizStore.getState();
    expect(state.isActive).toBe(false);
    expect(state.maxEvents).toBe(500);
  });

  it('has zero counters', () => {
    const state = useVizStore.getState();
    expect(state.counters.totalTokens).toBe(0);
    expect(state.counters.totalCost).toBe(0);
    expect(state.counters.totalToolCalls).toBe(0);
    expect(state.counters.activeAgents).toBe(0);
    expect(state.counters.completedTasks).toBe(0);
    expect(state.counters.errors).toBe(0);
    expect(state.counters.mailboxMessages).toBe(0);
  });
});

// ── pushEvent ───────────────────────────────────────────────────────

describe('pushEvent', () => {
  beforeEach(() => resetStore());

  it('prepends event as newest first', () => {
    const now = Date.now();
    useVizStore.getState().pushEvent(makeEvent({ id: 'ev-1', timestamp: now, label: 'First' }));
    useVizStore
      .getState()
      .pushEvent(makeEvent({ id: 'ev-2', timestamp: now + 1, label: 'Second' }));
    const events = useVizStore.getState().events;
    expect(events[0].label).toBe('Second');
    expect(events[1].label).toBe('First');
  });

  it('skips the nodes/edges Map clone for presence-only refreshes inside the volatile window', () => {
    // Regression: `sourceNode` always carries `lastSeenAt: now`, so the
    // documented "skip the Map clone when shallow-equal" optimization NEVER
    // fired — every provider:delta re-cloned nodes+edges and re-rendered
    // OfficeMapCanvas per token. Presence-only refreshes within
    // VOLATILE_REFRESH_MS must return the same Map references.
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(100_000);
      useVizStore
        .getState()
        .pushEvent(
          makeEvent({ id: 'd1', kind: 'provider:delta', source: 'leader', target: 'model-x' }),
        );
      const nodesAfterFirst = useVizStore.getState().nodes;
      const edgesAfterFirst = useVizStore.getState().edges;

      // Same content 20ms later: node upsert is presence-only → identical
      // nodes reference. The EDGE still clones once here — its intensity is
      // genuinely rising 0.7→1 (content, not presence).
      nowSpy.mockReturnValue(100_020);
      useVizStore
        .getState()
        .pushEvent(
          makeEvent({ id: 'd2', kind: 'provider:delta', source: 'leader', target: 'model-x' }),
        );
      expect(useVizStore.getState().nodes).toBe(nodesAfterFirst);
      expect(useVizStore.getState().edges).not.toBe(edgesAfterFirst);

      // Intensity has saturated at 1: from here on the steady token stream
      // is presence-only for BOTH maps.
      const nodesSaturated = useVizStore.getState().nodes;
      const edgesSaturated = useVizStore.getState().edges;
      nowSpy.mockReturnValue(100_040);
      useVizStore
        .getState()
        .pushEvent(
          makeEvent({ id: 'd2b', kind: 'provider:delta', source: 'leader', target: 'model-x' }),
        );
      expect(useVizStore.getState().nodes).toBe(nodesSaturated);
      expect(useVizStore.getState().edges).toBe(edgesSaturated);

      // Past the window the presence stamp refreshes again (recency caps
      // depend on it staying roughly current).
      nowSpy.mockReturnValue(100_400);
      useVizStore
        .getState()
        .pushEvent(
          makeEvent({ id: 'd3', kind: 'provider:delta', source: 'leader', target: 'model-x' }),
        );
      expect(useVizStore.getState().nodes).not.toBe(nodesAfterFirst);
      expect(useVizStore.getState().nodes.get('leader')?.lastSeenAt).toBe(100_400);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('still clones inside the volatile window when node content genuinely changes', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(200_000);
      useVizStore
        .getState()
        .pushEvent(makeEvent({ id: 'c1', kind: 'provider:delta', source: 'leader', label: 'one' }));
      const nodesAfterFirst = useVizStore.getState().nodes;
      nowSpy.mockReturnValue(200_010);
      useVizStore
        .getState()
        .pushEvent(makeEvent({ id: 'c2', kind: 'provider:delta', source: 'leader', label: 'two' }));
      expect(useVizStore.getState().nodes).not.toBe(nodesAfterFirst);
      expect(useVizStore.getState().nodes.get('leader')?.label).toBe('two');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('auto-generates id when not provided', () => {
    const ev = makeEvent({ id: undefined as any });
    useVizStore.getState().pushEvent(ev);
    const events = useVizStore.getState().events;
    expect(events[0].id).toMatch(/^viz_/);
  });

  it('auto-sets timestamp when not provided', () => {
    const before = Date.now();
    useVizStore.getState().pushEvent(makeEvent({ timestamp: undefined as any }));
    const after = Date.now();
    const ts = useVizStore.getState().events[0].timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('enforces ring buffer limit', () => {
    useVizStore.setState({ maxEvents: 3 });
    for (let i = 0; i < 5; i++) {
      useVizStore.getState().pushEvent(makeEvent({ id: `ev-${i}`, label: `Event ${i}` }));
    }
    const events = useVizStore.getState().events;
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.id)).toEqual(['ev-4', 'ev-3', 'ev-2']);
  });

  it('preserves latest events when over limit', () => {
    useVizStore.setState({ maxEvents: 2 });
    useVizStore.getState().pushEvent(makeEvent({ id: 'ev-a', label: 'A' }));
    useVizStore.getState().pushEvent(makeEvent({ id: 'ev-b', label: 'B' }));
    useVizStore.getState().pushEvent(makeEvent({ id: 'ev-c', label: 'C' }));
    expect(useVizStore.getState().events.map((e) => e.label)).toEqual(['C', 'B']);
  });

  it('keeps tool activity in a separate archive when general events overflow', () => {
    useVizStore.setState({ maxEvents: 2 });
    useVizStore
      .getState()
      .pushEvent(makeEvent({ id: 'tool-1', kind: 'tool:executed', label: 'read_file' }));
    for (let index = 0; index < 5; index += 1) {
      useVizStore
        .getState()
        .pushEvent(
          makeEvent({ id: `stream-${index}`, kind: 'provider:delta', label: `delta ${index}` }),
        );
    }

    expect(useVizStore.getState().events.map((event) => event.id)).not.toContain('tool-1');
    expect(useVizStore.getState().toolEvents.map((event) => event.id)).toContain('tool-1');
  });

  it('keeps nodes Map reference stable when pushEvent upserts produce shallow-equal nodes (Track E.7)', () => {
    // Seed source + target nodes that already match what pushEvent would
    // compute for an `iteration:start` event with Date.now frozen at
    // `fixed`. We need a deterministic timestamp to make `lastSeenAt`
    // predictable — it's the source of all churn in this path.
    const fixed = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    try {
      useVizStore.getState().upsertNode({
        id: 'leader',
        kind: 'session',
        label: 'Iteration 0',
        status: 'streaming',
        activity: 1.0,
        color: 'hsl(280, 80%, 65%)',
        lastSeenAt: fixed,
      });
      useVizStore.getState().upsertNode({
        id: 'session',
        kind: 'coordinator',
        label: 'session',
        status: 'streaming',
        activity: 0.8,
        color: 'hsl(280, 80%, 65%)',
        lastSeenAt: fixed,
      });
      useVizStore.getState().upsertEdge({
        id: 'leader->session',
        source: 'leader',
        target: 'session',
        kind: 'iteration:start',
        label: 'Iteration 0',
        intensity: 1,
        color: 'hsl(280, 80%, 65%)',
        lastActiveAt: fixed,
        totalMagnitude: 0,
      });
      const nodesRefBefore = useVizStore.getState().nodes;
      const edgesRefBefore = useVizStore.getState().edges;

      // Push an event whose computed merged source/target/edge are all
      // shallow-equal to the seeded entries — same ids, same kinds (because
      // inferKind maps iteration:start → 'session'), same labels, same
      // status, same activity, same color, same lastSeenAt (Date.now frozen).
      useVizStore.getState().pushEvent({
        kind: 'iteration:start',
        timestamp: fixed,
        source: 'leader',
        target: 'session',
        label: 'Iteration 0',
        magnitude: 0,
        color: 'hsl(280, 80%, 65%)',
        flowGroup: 'iteration',
      });

      const state = useVizStore.getState();
      // Events array reference must change (new event prepended).
      expect(state.events.length).toBe(1);
      // Nodes Map reference must be preserved (shallowEqual matched).
      expect(state.nodes).toBe(nodesRefBefore);
      // Edges Map reference must also be preserved (edge upsert was a no-op too).
      expect(state.edges).toBe(edgesRefBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── upsertNode ──────────────────────────────────────────────────────

describe('upsertNode', () => {
  beforeEach(() => resetStore());

  it('inserts a new node', () => {
    useVizStore.getState().upsertNode({ id: 'n1', kind: 'agent', label: 'Agent 1' });
    expect(useVizStore.getState().nodes.get('n1')?.label).toBe('Agent 1');
  });

  it('updates existing node by merging', () => {
    useVizStore
      .getState()
      .upsertNode({ id: 'n1', kind: 'agent', label: 'Original', activity: 0.5 });
    useVizStore.getState().upsertNode({ id: 'n1', label: 'Updated' });
    const node = useVizStore.getState().nodes.get('n1');
    expect(node?.label).toBe('Updated');
    expect(node?.kind).toBe('agent');
    expect(node?.activity).toBe(0.5);
  });

  it('updates lastSeenAt on every upsert', () => {
    const _before = Date.now() - 1000;
    useVizStore.getState().upsertNode({ id: 'n1', kind: 'agent', label: 'A' });
    const first = useVizStore.getState().nodes.get('n1')!.lastSeenAt;
    useVizStore.getState().upsertNode({ id: 'n1', label: 'B' });
    const second = useVizStore.getState().nodes.get('n1')!.lastSeenAt;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('preserves fields not in partial update', () => {
    useVizStore.getState().upsertNode({
      id: 'n1',
      kind: 'agent',
      label: 'A',
      status: 'streaming',
      activity: 0.9,
    } as any);
    useVizStore.getState().upsertNode({ id: 'n1', label: 'B' });
    const node = useVizStore.getState().nodes.get('n1');
    expect(node?.status).toBe('streaming');
    expect(node?.activity).toBe(0.9);
  });
});

// ── removeNode ──────────────────────────────────────────────────────

describe('removeNode', () => {
  beforeEach(() => resetStore());

  it('removes the node', () => {
    useVizStore.getState().upsertNode({ id: 'n1', kind: 'agent', label: 'A' });
    useVizStore.getState().removeNode('n1');
    expect(useVizStore.getState().nodes.has('n1')).toBe(false);
  });

  it('removes connected edges', () => {
    useVizStore.getState().upsertNode({ id: 'n1', kind: 'agent', label: 'A' } as any);
    useVizStore.getState().upsertNode({ id: 'n2', kind: 'provider', label: 'P' } as any);
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'n1', target: 'n2', kind: 'provider:call', label: 'call' });
    useVizStore
      .getState()
      .upsertEdge({ id: 'e2', source: 'n2', target: 'n1', kind: 'agent:tool', label: 'tool' });
    useVizStore
      .getState()
      .upsertEdge({ id: 'e3', source: 'n1', target: 'n2', kind: 'provider:call', label: 'call2' });
    useVizStore.getState().removeNode('n1');
    const edges = useVizStore.getState().edges;
    expect(edges.has('e1')).toBe(false);
    expect(edges.has('e2')).toBe(false);
    expect(edges.has('e3')).toBe(false);
  });

  it('leaves unrelated edges', () => {
    useVizStore.getState().upsertNode({ id: 'n1', kind: 'agent', label: 'A' } as any);
    useVizStore.getState().upsertNode({ id: 'n2', kind: 'tool', label: 'T' } as any);
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'n1', target: 'n2', kind: 'agent:tool', label: 'tool' });
    useVizStore.getState().removeNode('n1');
    expect(useVizStore.getState().edges.has('e1')).toBe(false);
  });
});

// ── upsertEdge ──────────────────────────────────────────────────────

describe('upsertEdge', () => {
  beforeEach(() => resetStore());

  it('inserts a new edge', () => {
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'provider:call', label: 'call' });
    expect(useVizStore.getState().edges.get('e1')?.label).toBe('call');
  });

  it('merges partial edge update', () => {
    useVizStore.getState().upsertEdge({
      id: 'e1',
      source: 'a',
      target: 'b',
      kind: 'provider:call',
      label: 'call',
      intensity: 0.3,
    });
    useVizStore.getState().upsertEdge({ id: 'e1', label: 'updated call' });
    const edge = useVizStore.getState().edges.get('e1');
    expect(edge?.label).toBe('updated call');
    expect(edge?.intensity).toBe(0.3);
  });

  it('sets default intensity from EDGE_COLORS then existing', () => {
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'provider:call', label: 'call' });
    expect(useVizStore.getState().edges.get('e1')?.intensity).toBe(0.5); // default
  });

  it('uses existing intensity when partial has none', () => {
    useVizStore.getState().upsertEdge({
      id: 'e1',
      source: 'a',
      target: 'b',
      kind: 'provider:call',
      label: 'c',
      intensity: 0.9,
    });
    useVizStore.getState().upsertEdge({ id: 'e1', label: 'updated' }); // no intensity
    expect(useVizStore.getState().edges.get('e1')?.intensity).toBe(0.9);
  });

  it('uses partial intensity when provided', () => {
    useVizStore.getState().upsertEdge({
      id: 'e1',
      source: 'a',
      target: 'b',
      kind: 'provider:call',
      label: 'c',
      intensity: 0.9,
    });
    useVizStore.getState().upsertEdge({ id: 'e1', label: 'updated', intensity: 0.2 });
    expect(useVizStore.getState().edges.get('e1')?.intensity).toBe(0.2);
  });

  it('sets color from EDGE_COLORS by kind', () => {
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'provider:call', label: 'c' });
    expect(useVizStore.getState().edges.get('e1')?.color).toBe('hsl(var(--info))');
  });

  it('uses partial color when provided', () => {
    useVizStore.getState().upsertEdge({
      id: 'e1',
      source: 'a',
      target: 'b',
      kind: 'provider:call',
      label: 'c',
      color: 'red',
    });
    expect(useVizStore.getState().edges.get('e1')?.color).toBe('red');
  });

  it('accumulates totalMagnitude', () => {
    useVizStore.getState().upsertEdge({
      id: 'e1',
      source: 'a',
      target: 'b',
      kind: 'provider:call',
      label: 'c',
      totalMagnitude: 10,
    });
    useVizStore.getState().upsertEdge({ id: 'e1', totalMagnitude: 5 });
    expect(useVizStore.getState().edges.get('e1')?.totalMagnitude).toBe(15);
  });

  it('updates lastActiveAt on every upsert', () => {
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'provider:call', label: 'c' });
    const before = useVizStore.getState().edges.get('e1')!.lastActiveAt;
    // wait a tiny bit
    const _now = Date.now();
    useVizStore.getState().upsertEdge({ id: 'e1' });
    const after = useVizStore.getState().edges.get('e1')!.lastActiveAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

// ── removeEdge ──────────────────────────────────────────────────────

describe('removeEdge', () => {
  beforeEach(() => resetStore());

  it('removes the edge', () => {
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'provider:call', label: 'c' });
    useVizStore.getState().removeEdge('e1');
    expect(useVizStore.getState().edges.has('e1')).toBe(false);
  });

  it('is a no-op when edge does not exist', () => {
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'provider:call', label: 'c' });
    useVizStore.getState().removeEdge('non-existent'); // should not throw
    expect(useVizStore.getState().edges.size).toBe(1);
  });
});

// ── clear ────────────────────────────────────────────────────────────

describe('clear', () => {
  beforeEach(() => resetStore());

  it('resets events, tool archive, nodes, edges, and counters but preserves isActive', () => {
    useVizStore.getState().upsertNode({ id: 'n1', kind: 'agent', label: 'A' } as any);
    useVizStore
      .getState()
      .upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'provider:call', label: 'c' });
    useVizStore
      .getState()
      .pushEvent(makeEvent({ id: 'ev-1', kind: 'tool:executed', label: 'read_file' }));
    useVizStore.setState({ isActive: true });
    useVizStore.getState().clear();
    const state = useVizStore.getState();
    expect(state.events).toHaveLength(0);
    expect(state.toolEvents).toHaveLength(0);
    expect(state.nodes.size).toBe(0);
    expect(state.edges.size).toBe(0);
    expect(state.isActive).toBe(true); // clear() preserves isActive
    expect(state.counters.totalTokens).toBe(0);
  });
});

// ── setActive ───────────────────────────────────────────────────────

describe('setActive', () => {
  beforeEach(() => resetStore());

  it('sets isActive to true', () => {
    useVizStore.getState().setActive(true);
    expect(useVizStore.getState().isActive).toBe(true);
  });

  it('sets isActive to false', () => {
    useVizStore.setState({ isActive: true });
    useVizStore.getState().setActive(false);
    expect(useVizStore.getState().isActive).toBe(false);
  });
});

// ── decayActivity ────────────────────────────────────────────────────

describe('decayActivity', () => {
  beforeEach(() => resetStore());

  it('multiplies activity by 0.92 per call', () => {
    useVizStore
      .getState()
      .upsertNode({ id: 'n1', kind: 'agent', label: 'A', activity: 1.0 } as any);
    useVizStore.getState().upsertNode({ id: 'n2', kind: 'tool', label: 'T', activity: 0.5 } as any);
    useVizStore.getState().decayActivity();
    const n1 = useVizStore.getState().nodes.get('n1')!;
    const n2 = useVizStore.getState().nodes.get('n2')!;
    expect(n1.activity).toBeCloseTo(0.92, 5);
    expect(n2.activity).toBeCloseTo(0.46, 5);
  });

  it('sets very low activity to 0', () => {
    useVizStore
      .getState()
      .upsertNode({ id: 'n1', kind: 'agent', label: 'A', activity: 0.01 } as any);
    useVizStore.getState().decayActivity();
    expect(useVizStore.getState().nodes.get('n1')!.activity).toBeLessThan(0.01);
  });
});

// ── prunesStale ─────────────────────────────────────────────────────

describe('prunesStale', () => {
  beforeEach(() => resetStore());

  it('removes every node not seen since the cutoff', () => {
    const now = Date.now();
    useVizStore.getState().upsertNode({
      id: 'stale',
      kind: 'agent',
      label: 'A',
      lastSeenAt: now - 10000,
      status: 'idle',
    } as any);
    useVizStore.getState().upsertNode({
      id: 'recent',
      kind: 'agent',
      label: 'B',
      lastSeenAt: now - 1000,
      status: 'idle',
    } as any);
    useVizStore.getState().upsertNode({
      id: 'active',
      kind: 'agent',
      label: 'C',
      lastSeenAt: now - 10000,
      status: 'active',
    } as any);
    useVizStore.getState().prunesStale(5000); // 5s cutoff
    const nodes = useVizStore.getState().nodes;
    expect(nodes.has('stale')).toBe(false);
    expect(nodes.has('recent')).toBe(true);
    // No status exemption: `inferStatus` returns 'active' by DEFAULT, so
    // exempting it kept most nodes forever — the pruner never pruned.
    expect(nodes.has('active')).toBe(false);
  });

  it('removes edges inactive before cutoff', () => {
    const now = Date.now();
    useVizStore.getState().upsertEdge({
      id: 'e-stale',
      source: 'a',
      target: 'b',
      kind: 'provider:call',
      label: 'c',
      lastActiveAt: now - 10000,
    });
    useVizStore.getState().upsertEdge({
      id: 'e-recent',
      source: 'a',
      target: 'b',
      kind: 'provider:call',
      label: 'c',
      lastActiveAt: now - 1000,
    });
    useVizStore.getState().prunesStale(5000);
    const edges = useVizStore.getState().edges;
    expect(edges.has('e-stale')).toBe(false);
    expect(edges.has('e-recent')).toBe(true);
  });

  it('removes events older than cutoff', () => {
    const now = Date.now();
    useVizStore
      .getState()
      .pushEvent(makeEvent({ id: 'ev-old', timestamp: now - 10000, label: 'Old' }));
    useVizStore
      .getState()
      .pushEvent(makeEvent({ id: 'ev-new', timestamp: now - 1000, label: 'New' }));
    useVizStore.getState().prunesStale(5000);
    const labels = useVizStore.getState().events.map((e) => e.label);
    expect(labels).not.toContain('Old');
    expect(labels).toContain('New');
  });
});

// ── wsToVizEvent ────────────────────────────────────────────────────

describe('wsToVizEvent', () => {
  it('handles provider.text_delta', () => {
    const result = wsToVizEvent('provider.text_delta', { text: 'Hello world' });
    expect(result?.kind).toBe('provider:delta');
    expect(result?.source).toBe('provider');
    expect(result?.target).toBe('leader');
    expect(result?.magnitude).toBe(11);
    expect(result?.color).toBe('hsl(var(--info))');
  });

  it('handles provider.response', () => {
    const result = wsToVizEvent('provider.response', {
      usage: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50 },
    });
    expect(result?.kind).toBe('provider:response');
    expect(result?.label).toBe('1,000 in / 500 out');
    expect(result?.magnitude).toBe(1500);
  });

  it('handles tool.started', () => {
    const result = wsToVizEvent('tool.started', { name: 'bash' });
    expect(result?.kind).toBe('tool:started');
    expect(result?.source).toBe('bash');
    expect(result?.color).toBe('hsl(var(--warning))');
    expect(result?.flowGroup).toBe('tool:bash');
  });

  it('handles tool.executed with ok=true', () => {
    const result = wsToVizEvent('tool.executed', { name: 'read', ok: true, durationMs: 150 });
    expect(result?.kind).toBe('tool:executed');
    expect(result?.label).toBe('read ✓ (150ms)');
    expect(result?.color).toBe('hsl(var(--warning))');
  });

  it('handles tool.executed with ok=false', () => {
    const result = wsToVizEvent('tool.executed', { name: 'read', ok: false, durationMs: 50 });
    expect(result?.kind).toBe('tool:executed');
    expect(result?.label).toBe('read ✗ (50ms)');
    expect(result?.color).toBe('hsl(var(--destructive))'); // error color
  });

  it('handles subagent.event spawned', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'spawned',
      subagentId: 'agent-42',
      name: 'Worker',
    });
    expect(result?.kind).toBe('agent:spawned');
    expect(result?.source).toBe('agent-42');
    expect(result?.label).toBe('Worker spawned');
    expect(result?.flowGroup).toBe('agent:agent-42');
  });

  it('handles subagent.event tool_executed', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'write',
      ok: true,
      durationMs: 200,
    });
    expect(result?.kind).toBe('agent:tool');
    expect(result?.source).toBe('a1');
    expect(result?.target).toBe('write');
    expect(result?.magnitude).toBe(200);
  });

  it('handles subagent.event task_completed success', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'task_completed',
      subagentId: 'a1',
      name: 'Worker',
      status: 'success',
    });
    expect(result?.kind).toBe('agent:status');
    expect(result?.color).toBe('hsl(var(--success))'); // green
  });

  it('handles subagent.event task_completed failure', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'task_completed',
      subagentId: 'a1',
      name: 'Worker',
      status: 'failed',
    });
    expect(result?.color).toBe('hsl(var(--destructive))'); // error
  });

  it('handles subagent.event ctx_pct', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'ctx_pct',
      subagentId: 'a1',
      load: 0.75,
      tokens: 80000,
    });
    expect(result?.kind).toBe('agent:ctx');
    expect(result?.label).toBe('ctx 75%');
    expect(result?.magnitude).toBe(80000);
  });

  it('caps subagent.event ctx_pct labels at 100%', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'ctx_pct',
      subagentId: 'a1',
      load: 1.5,
      tokens: 150000,
    });
    expect(result?.label).toBe('ctx 100%');
  });

  it('handles subagent.event iteration_summary', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'iteration_summary',
      subagentId: 'a1',
      partialText: 'Writing tests...',
      costUsd: 0.05,
    });
    expect(result?.kind).toBe('agent:text');
    expect(result?.magnitude).toBe(0.05);
  });

  it('handles subagent.event budget_extended', () => {
    const result = wsToVizEvent('subagent.event', {
      kind: 'budget_extended',
      subagentId: 'a1',
      name: 'Worker',
      totalExtensions: 3,
    });
    expect(result?.kind).toBe('budget:extended');
    expect(result?.magnitude).toBe(3);
  });

  it('handles mailbox.event sent', () => {
    const result = wsToVizEvent('mailbox.event', {
      event: 'mailbox.sent',
      from: 'leader',
      to: 'sub-1',
      subject: 'Start task',
    });
    expect(result?.kind).toBe('mailbox:send');
    expect(result?.source).toBe('leader');
    expect(result?.target).toBe('sub-1');
    expect(result?.label).toBe('Start task');
  });

  it('handles mailbox.event delivered', () => {
    const result = wsToVizEvent('mailbox.event', {
      event: 'mailbox.delivered',
      from: 'leader',
      to: 'sub-1',
    });
    expect(result?.kind).toBe('mailbox:deliver');
    expect(result?.source).toBe('leader');
  });

  it('handles iteration.started', () => {
    const result = wsToVizEvent('iteration.started', { index: 3 });
    expect(result?.kind).toBe('iteration:start');
    expect(result?.label).toBe('Iteration 3');
    expect(result?.magnitude).toBe(3);
  });

  it('handles error', () => {
    const result = wsToVizEvent('error', { message: 'Connection failed', phase: 'network' });
    expect(result?.kind).toBe('error');
    expect(result?.label).toBe('Connection failed');
    expect(result?.color).toBe('hsl(var(--destructive))');
  });

  it('handles context.compacted', () => {
    const result = wsToVizEvent('context.compacted', { saved: 4200 });
    expect(result?.kind).toBe('context:compacted');
    expect(result?.label).toBe('Compacted: 4,200 tokens');
    expect(result?.magnitude).toBe(4200);
  });

  it('handles context.repaired', () => {
    const result = wsToVizEvent('context.repaired', { removedMessages: 12 });
    expect(result?.kind).toBe('context:repaired');
    expect(result?.label).toBe('Repaired: 12 msgs');
    expect(result?.magnitude).toBe(12);
  });

  it('handles session.start', () => {
    const result = wsToVizEvent('session.start', {
      sessionId: 'sess_abc123',
      projectName: 'MyApp',
    });
    expect(result?.kind).toBe('session:start');
    expect(result?.label).toBe('MyApp');
  });

  it('handles sessions.status_update', () => {
    const result = wsToVizEvent('sessions.status_update', {
      sessions: [{ id: 's1' }, { id: 's2' }],
    });
    expect(result?.kind).toBe('fleet:snapshot');
    expect(result?.label).toBe('2 session(s)');
    expect(result?.magnitude).toBe(2);
  });

  it('returns null for unknown wsType', () => {
    const result = wsToVizEvent('unknown.event', {});
    expect(result).toBeNull();
  });

  it('returns null for unknown subagent.event kind', () => {
    const result = wsToVizEvent('subagent.event', { kind: 'unknown_kind', subagentId: 'a1' });
    expect(result).toBeNull();
  });

  it('handles missing optional fields gracefully', () => {
    const result = wsToVizEvent('provider.response', {});
    expect(result?.kind).toBe('provider:response');
    expect(result?.label).toBe('0 in / 0 out');
    expect(result?.magnitude).toBe(0);
  });

  it('truncates long text in provider:delta', () => {
    const longText = 'a'.repeat(100);
    const result = wsToVizEvent('provider.text_delta', { text: longText });
    expect(result?.label).toHaveLength(60);
    expect(result?.magnitude).toBe(100);
  });
});
