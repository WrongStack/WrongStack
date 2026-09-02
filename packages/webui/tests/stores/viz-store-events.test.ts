import { beforeEach, describe, expect, it } from 'vitest';
import { useVizStore, wsToVizEvent } from '../../src/stores/viz-store';

/**
 * The `wsToVizEvent` cases the existing viz suite doesn't reach (tool
 * progress, the codemap tool pair, budget events, ctx.pct, error) plus the
 * decay/prune reducers.
 */

function ev(type: string, payload: Record<string, unknown> = {}) {
  return wsToVizEvent(type, payload);
}

beforeEach(() => {
  useVizStore.setState({ events: [], nodes: new Map(), edges: new Map(), isActive: false });
});

describe('tool.progress', () => {
  it('labels the event with the progress text', () => {
    const out = ev('tool.progress', { name: 'Build', event: { type: 'log', text: 'compiling' } });
    expect(out).toMatchObject({
      kind: 'tool:progress',
      source: 'Build',
      target: 'leader',
      label: 'compiling',
      magnitude: 'compiling'.length,
    });
  });

  it('truncates a long progress line', () => {
    const out = ev('tool.progress', { name: 'Build', event: { text: 'x'.repeat(200) } });
    expect(out?.label).toHaveLength(60);
  });

  it('falls back to the tool name when the event carries no text', () => {
    expect(ev('tool.progress', { name: 'Build', event: {} })?.label).toBe('Build');
  });

  it('falls back to a generic name with no name at all', () => {
    expect(ev('tool.progress', {})?.source).toBe('tool');
  });
});

describe('codemap tool pair', () => {
  it('codemap.tool_started flows from the agent to the tool', () => {
    const out = ev('codemap.tool_started', { name: 'Read', agentId: 'sa1' });
    expect(out).toMatchObject({
      kind: 'tool:started',
      source: 'sa1',
      target: 'Read',
      flowGroup: 'agent:sa1',
    });
  });

  it('codemap.tool_started defaults both identifiers', () => {
    expect(ev('codemap.tool_started', {})).toMatchObject({ source: 'subagent', target: 'tool' });
  });

  it('codemap.tool_executed marks a success with a tick and the duration', () => {
    const out = ev('codemap.tool_executed', {
      name: 'Read',
      agentId: 'sa1',
      ok: true,
      durationMs: 42,
    });
    expect(out?.label).toBe('Read ✓ (42ms)');
    expect(out?.magnitude).toBe(42);
  });

  it('codemap.tool_executed marks a failure with a cross and the error colour', () => {
    const ok = ev('codemap.tool_executed', { name: 'Read', ok: true });
    const bad = ev('codemap.tool_executed', { name: 'Read', ok: false });

    expect(bad?.label).toContain('✗');
    expect(bad?.color).not.toBe(ok?.color);
  });

  it('codemap.tool_executed treats a missing ok flag as success', () => {
    expect(ev('codemap.tool_executed', { name: 'Read' })?.label).toBe('Read ✓ (0ms)');
  });
});

describe('budget events', () => {
  it('maps a budget extension', () => {
    const out = ev('subagent.event', {
      kind: 'budget_extended',
      subagentId: 'sa1',
      name: 'scout',
      totalExtensions: 3,
    });
    expect(out).toMatchObject({ kind: 'budget:extended', magnitude: 3, source: 'sa1' });
    expect(out?.label).toContain('extended budget');
  });

  it('defaults the extension count', () => {
    const out = ev('subagent.event', { kind: 'budget_extended', subagentId: 'sa1' });
    expect(out?.magnitude).toBe(1);
  });

  it('maps a budget warning with its usage figures', () => {
    const out = ev('subagent.event', {
      kind: 'budget_warning',
      subagentId: 'sa1',
      name: 'scout',
      budgetKind: 'tokens',
      used: 900,
      limit: 1_000,
    });
    expect(out).toMatchObject({ kind: 'budget:warning', magnitude: 900 });
    expect(out?.label).toContain('tokens 900/1000');
  });

  it('defaults every figure on a bare warning', () => {
    const out = ev('subagent.event', { kind: 'budget_warning', subagentId: 'sa1' });
    expect(out?.label).toContain('budget 0/0');
    expect(out?.magnitude).toBe(1);
  });

  it('returns null for an unrecognised subagent event kind', () => {
    expect(ev('subagent.event', { kind: 'nonsense', subagentId: 'sa1' })).toBeNull();
  });
});

describe('ctx.pct and error', () => {
  it('maps a context reading onto the leader', () => {
    const out = ev('ctx.pct', { tokens: 1_234, load: 0.42 });
    expect(out).toMatchObject({
      kind: 'agent:ctx',
      source: 'leader',
      target: 'session',
      magnitude: 1_234,
    });
    expect(out?.label).toBe('ctx 42%');
  });

  it('defaults the token count', () => {
    expect(ev('ctx.pct', {})?.magnitude).toBe(0);
  });

  it('maps an error with its message', () => {
    expect(ev('error', { message: 'boom' })).toMatchObject({ kind: 'error' });
  });

  it('falls back to a generic error label', () => {
    expect(ev('error', {})?.label).toContain('Error');
  });
});

describe('unmapped types', () => {
  it('returns null rather than a synthetic event', () => {
    expect(ev('completely.unknown')).toBeNull();
  });

  it('mailbox.received is not a viz source', () => {
    // Only `mailbox.event` maps; the delivery notification does not.
    expect(ev('mailbox.received', { from: 'a', to: 'b' })).toBeNull();
  });
});

describe('decay', () => {
  function seed() {
    useVizStore.setState({
      nodes: new Map([
        ['hot', { id: 'hot', kind: 'agent', label: 'hot', activity: 1 } as never],
        ['cold', { id: 'cold', kind: 'agent', label: 'cold', activity: 0.005 } as never],
      ]),
      edges: new Map([
        ['e1', { id: 'e1', from: 'a', to: 'b', intensity: 1 } as never],
        ['e2', { id: 'e2', from: 'a', to: 'c', intensity: 0.005 } as never],
      ]),
    });
  }

  it('multiplies node activity down toward zero', () => {
    seed();
    useVizStore.getState().decayActivity();
    expect(useVizStore.getState().nodes.get('hot')?.activity).toBeCloseTo(0.92);
  });

  it('leaves an already-negligible node untouched', () => {
    seed();
    useVizStore.getState().decayActivity();
    expect(useVizStore.getState().nodes.get('cold')?.activity).toBe(0.005);
  });

  it('snaps a node to exactly zero once it falls below the floor', () => {
    useVizStore.setState({
      nodes: new Map([['n', { id: 'n', kind: 'agent', label: 'n', activity: 0.0105 } as never]]),
      edges: new Map(),
    });
    useVizStore.getState().decayActivity();
    expect(useVizStore.getState().nodes.get('n')?.activity).toBe(0);
  });

  it('decays edges faster than nodes', () => {
    seed();
    useVizStore.getState().decayActivity();
    expect(useVizStore.getState().edges.get('e1')?.intensity).toBeCloseTo(0.9);
  });

  it('snaps an edge to zero below the floor', () => {
    useVizStore.setState({
      nodes: new Map(),
      edges: new Map([['e', { id: 'e', from: 'a', to: 'b', intensity: 0.011 } as never]]),
    });
    useVizStore.getState().decayActivity();
    expect(useVizStore.getState().edges.get('e')?.intensity).toBe(0);
  });
});

describe('prunesStale', () => {
  const now = Date.now();

  it('drops a settled node last seen before the cutoff', () => {
    useVizStore.setState({
      nodes: new Map([
        [
          'old',
          { id: 'old', kind: 'agent', label: 'old', lastSeenAt: now - 10_000, status: 'idle' },
        ],
        ['new', { id: 'new', kind: 'agent', label: 'new', lastSeenAt: now, status: 'idle' }],
      ] as never),
      edges: new Map(),
      events: [],
    });
    useVizStore.getState().prunesStale(5_000);

    const nodes = useVizStore.getState().nodes;
    expect(nodes.has('old')).toBe(false);
    expect(nodes.has('new')).toBe(true);
  });

  // `status` is the mapping of the LAST event kind, not a liveness signal —
  // and `inferStatus` returns 'active' as its DEFAULT (mailbox:send,
  // agent:spawned, agent:ctx, memory:event, brain:council_vote,
  // fleet:snapshot all land there). Exempting 'active' therefore made the
  // majority of nodes immortal, i.e. it disabled the pruner it was written to
  // refine. `lastSeenAt < cutoff` is the whole staleness criterion.
  it('drops a stale node even if its last status was active', () => {
    useVizStore.setState({
      nodes: new Map([
        [
          'busy',
          { id: 'busy', kind: 'agent', label: 'busy', lastSeenAt: now - 10_000, status: 'active' },
        ],
      ] as never),
      edges: new Map(),
      events: [],
    });
    useVizStore.getState().prunesStale(5_000);
    expect(useVizStore.getState().nodes.has('busy')).toBe(false);
  });

  it('drops a stale node whose status was never set', () => {
    useVizStore.setState({
      nodes: new Map([
        ['bare', { id: 'bare', kind: 'agent', label: 'bare', lastSeenAt: now - 10_000 }],
      ] as never),
      edges: new Map(),
      events: [],
    });
    useVizStore.getState().prunesStale(5_000);
    expect(useVizStore.getState().nodes.has('bare')).toBe(false);
  });

  it('keeps a node seen within the window regardless of status', () => {
    useVizStore.setState({
      nodes: new Map([
        ['fresh', { id: 'fresh', kind: 'agent', label: 'fresh', lastSeenAt: now, status: 'idle' }],
      ] as never),
      edges: new Map(),
      events: [],
    });
    useVizStore.getState().prunesStale(5_000);
    expect(useVizStore.getState().nodes.has('fresh')).toBe(true);
  });

  it('drops edges that have gone quiet', () => {
    useVizStore.setState({
      nodes: new Map(),
      edges: new Map([
        ['keep', { id: 'keep', from: 'a', to: 'b', lastActiveAt: now }],
        ['drop', { id: 'drop', from: 'a', to: 'c', lastActiveAt: now - 10_000 }],
      ] as never),
      events: [],
    });
    useVizStore.getState().prunesStale(5_000);

    const edges = useVizStore.getState().edges;
    expect(edges.has('keep')).toBe(true);
    expect(edges.has('drop')).toBe(false);
  });

  it('drops events older than the cutoff', () => {
    useVizStore.setState({
      nodes: new Map(),
      edges: new Map(),
      events: [
        { id: 'a', kind: 'error', timestamp: now, source: 's', label: 'l', magnitude: 0 },
        { id: 'b', kind: 'error', timestamp: now - 10_000, source: 's', label: 'l', magnitude: 0 },
      ] as never,
    });
    useVizStore.getState().prunesStale(5_000);
    expect(useVizStore.getState().events.map((e) => e.id)).toEqual(['a']);
  });
});

describe('graph is bounded at ingest', () => {
  // `events`/`toolEvents` were capped; `nodes`/`edges` were not. Every distinct
  // source/target string ever seen — per-spawn agent ids, session ids, tool
  // names — became a permanent node, and the two pruning actions that were
  // supposed to handle it had ZERO production callers.
  it('caps nodes no matter how many distinct sources arrive', () => {
    useVizStore.setState({ nodes: new Map(), edges: new Map(), events: [] });
    for (let i = 0; i < 1200; i += 1) {
      useVizStore.getState().pushEvent({
        kind: 'agent:spawned',
        source: `agent-${i}`,
        label: `spawn ${i}`,
      } as never);
    }
    const { nodes } = useVizStore.getState();
    expect(nodes.size).toBeGreaterThan(0);
    expect(nodes.size).toBeLessThanOrEqual(400);
    // Eviction is least-recently-active first, so the newest survives.
    expect(nodes.has('agent-1199')).toBe(true);
  });
});
