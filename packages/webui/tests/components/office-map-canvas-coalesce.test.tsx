import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeMapCanvas } from '../../src/components/OfficeMapCanvas';
import type { VizEvent } from '../../src/stores/viz-store';
import { useMonitorStore, useVizStore } from '../../src/stores';

/**
 * Regression guard for the viz-overlay coalescing path in OfficeMapCanvas.
 *
 * The store can append several events between two renders (agents spam tools
 * faster than React commits). The old overlay effect processed only
 * `vizEvents[0]`, silently dropping every other event in the burst — desks
 * stayed gray. This suite pushes a three-event burst back-to-back (one React
 * commit) and asserts ALL three targeted desks lit up, plus that events which
 * predate the mount are adopted without being replayed (the arm step).
 */

// jsdom has no ResizeObserver; the canvas measures its surface with one on
// mount. Stub it before the component under test loads.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

// Assertion surface: the stubbed React Flow records the latest nodes/edges
// the canvas handed it, so tests can read flow-node `data` after each commit.
const captured: {
  nodes: Array<{ id: string; data: Record<string, unknown> }>;
  edges: Array<{ id: string; data?: Record<string, unknown> }>;
} = { nodes: [], edges: [] };

// The canvas lists `fitView` in its build-effect deps; a fresh function per
// render (naive stub) would loop the effect forever. Hoist ONE stable fn.
const { fitViewFn } = vi.hoisted(() => ({ fitViewFn: vi.fn() }));

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  ReactFlow: (props: { nodes?: unknown[]; edges?: unknown[] }) => {
    captured.nodes = (props.nodes ?? []) as typeof captured.nodes;
    captured.edges = (props.edges ?? []) as typeof captured.edges;
    return <div data-testid="rf-surface" />;
  },
  useNodesState: <T,>(initial: T[]) => {
    const [value, setValue] = useState<T[]>(initial);
    return [value, setValue, () => {}] as const;
  },
  useEdgesState: <T,>(initial: T[]) => {
    const [value, setValue] = useState<T[]>(initial);
    return [value, setValue, () => {}] as const;
  },
  useReactFlow: () => ({ fitView: fitViewFn }),
  addEdge: () => [],
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Panel: () => null,
  Handle: () => null,
  EdgeLabelRenderer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  getBezierPath: () => ['M0,0 L1,1'],
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  BackgroundVariant: { Lines: 'lines', Cross: 'cross', Dots: 'dots' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
}));

type PushEventArg = Parameters<ReturnType<typeof useVizStore.getState>['pushEvent']>[0];

/** Push a viz event through the store's own normalization (id + timestamp). */
function pushVizEvent(event: { kind: VizEvent['kind']; source: string; label: string }): void {
  useVizStore.getState().pushEvent(event as PushEventArg);
}

// One live WebUI session hosting three desks. resolveClients maps this to
// office nodes `client-4242__agent-<id>` with edges `client-4242->…`.
const LIVE_SESSION = {
  sessionId: '2026-08-29/sess_coalesce',
  pid: 4242,
  clientType: 'webui',
  status: 'active',
  agents: [
    { id: 'a1', name: 'Alpha', status: 'idle' },
    { id: 'a2', name: 'Beta', status: 'idle' },
    { id: 'a3', name: 'Gamma', status: 'idle' },
  ],
};

const A1 = 'client-4242__agent-a1';
const A2 = 'client-4242__agent-a2';
const A3 = 'client-4242__agent-a3';

function statusOf(nodeId: string): unknown {
  return captured.nodes.find((n) => n.id === nodeId)?.data.status;
}

function activityOf(nodeId: string): unknown {
  return captured.nodes.find((n) => n.id === nodeId)?.data.vizActivity;
}

describe('OfficeMapCanvas viz-overlay coalescing', () => {
  beforeEach(() => {
    captured.nodes = [];
    captured.edges = [];
    useVizStore.setState({ events: [] });
    useMonitorStore.setState({ liveSessions: [LIVE_SESSION] });
  });

  afterEach(() => {
    cleanup();
    useVizStore.setState({ events: [] });
    useMonitorStore.setState({ liveSessions: [] });
  });

  it('applies a burst of viz events that lands between two renders', async () => {
    // Pre-mount event: adopted by the arm step, never replayed into the view.
    pushVizEvent({ kind: 'agent:tool', source: 'a1', label: 'pre-mount' });

    render(<OfficeMapCanvas />);
    await act(async () => {}); // settle mount: build effect + arm step

    // All three desks rendered from the live-session snapshot.
    const ids = captured.nodes.map((n) => n.id);
    expect(ids).toContain(A1);
    expect(ids).toContain(A2);
    expect(ids).toContain(A3);

    // Arm-skip: the pre-mount event predates the live view — its desk stays idle.
    expect(statusOf(A1)).toBe('idle');

    // Burst: three events for three different desks pushed back-to-back —
    // they land between two renders and must ALL be applied.
    act(() => {
      pushVizEvent({ kind: 'agent:tool', source: 'a1', label: 'tool-1' });
      pushVizEvent({ kind: 'agent:tool', source: 'a2', label: 'tool-2' });
      pushVizEvent({ kind: 'agent:tool', source: 'a3', label: 'tool-3' });
    });
    await act(async () => {}); // flush the coalesced overlay commit

    expect(statusOf(A1)).toBe('active');
    expect(statusOf(A2)).toBe('active');
    expect(statusOf(A3)).toBe('active');
    expect(activityOf(A1)).toBeGreaterThan(0);
    expect(activityOf(A2)).toBeGreaterThan(0);
    expect(activityOf(A3)).toBeGreaterThan(0);

    // The client→agent wire for a mid-burst desk is boosted too (the old
    // path dropped its edge intensity because the event never ran).
    const edge = captured.edges.find((e) => e.id === `client-4242->${A2}`);
    expect(edge?.data?.animated).toBe(true);
  });

  it('does not re-apply anything when the effect re-runs without new events', async () => {
    // Arm on a pre-mount event so the event below counts as a live-view event.
    act(() => {
      pushVizEvent({ kind: 'agent:tool', source: 'a1', label: 'pre-mount' });
    });
    render(<OfficeMapCanvas />);
    await act(async () => {});

    // Store mutations that reach mounted components must run inside act —
    // a bare push here is what raised the act(...) warning before.
    act(() => {
      pushVizEvent({ kind: 'agent:tool', source: 'a2', label: 'only-once' });
    });
    await act(async () => {});
    expect(statusOf(A2)).toBe('active');
    const firstActivity = activityOf(A2);

    // Re-publish the same buffer (new array identity, identical events) —
    // the freshCount === 0 short-circuit must skip all work: no double boost.
    act(() => {
      useVizStore.setState((state) => ({ events: [...state.events] }));
    });
    await act(async () => {});

    expect(statusOf(A2)).toBe('active');
    expect(activityOf(A2)).toBe(firstActivity);
  });
});
