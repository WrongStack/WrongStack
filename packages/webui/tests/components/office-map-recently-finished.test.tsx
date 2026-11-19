import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRecentlyFinishedFleetAgents } from '../../src/components/OfficeMapCanvas/use-recently-finished.js';
import type { SubagentView } from '../../src/stores/types.js';

describe('useRecentlyFinishedFleetAgents', () => {
  it('keeps its snapshot identity stable across unrelated renders', () => {
    const fleetAgents = new Map<string, SubagentView>();
    const { result, rerender } = renderHook(
      ({ agents }) => useRecentlyFinishedFleetAgents(agents),
      { initialProps: { agents: fleetAgents } },
    );
    const first = result.current;

    rerender({ agents: fleetAgents });

    expect(result.current).toBe(first);
  });

  it('publishes a new snapshot when the fleet snapshot changes', () => {
    const fleetAgents = new Map<string, SubagentView>();
    const { result, rerender } = renderHook(
      ({ agents }) => useRecentlyFinishedFleetAgents(agents),
      { initialProps: { agents: fleetAgents } },
    );
    const first = result.current;

    rerender({ agents: new Map(fleetAgents) });

    expect(result.current).not.toBe(first);
    expect(result.current.map).toBe(first.map);
  });

  it('keeps an agent removed while running as stopped', () => {
    const running = { id: 'A', status: 'running' } as SubagentView;
    const { result, rerender } = renderHook(
      ({ agents }) => useRecentlyFinishedFleetAgents(agents),
      { initialProps: { agents: new Map([['A', running]]) } },
    );
    expect(result.current.map.has('A')).toBe(false);

    rerender({ agents: new Map<string, SubagentView>() });

    expect(result.current.map.get('A')?.agent.status).toBe('stopped');
  });
});
