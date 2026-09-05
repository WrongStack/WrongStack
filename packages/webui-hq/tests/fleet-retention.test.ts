/**
 * Fleet Map presence retention.
 *
 * HQ holds a client's sessions in a map on the SOCKET, so any publisher
 * reconnect hands the server a client with no sessions and the terminal (with
 * every agent under it) is missing from the very next broadcast. Rebuilding
 * the map straight off each snapshot turned that into a node blinking out and
 * back — fleet churn that never happened.
 */
import { describe, expect, it } from 'vitest';
import {
  FLEET_TOPOLOGY_RETENTION_MS,
  type FleetTopology,
  retainFleetTopology,
} from '../src/domain/fleet-topology.js';

const T0 = Date.parse('2026-09-05T12:00:00.000Z');

function topology(nodeIds: string[]): FleetTopology {
  return {
    nodes: nodeIds.map((id) => ({
      id,
      kind: id.startsWith('m') ? 'machine' : 'terminal',
      label: id,
      chips: ['idle'],
      status: 'active',
    })),
    edges: nodeIds
      .filter((id) => !id.startsWith('m'))
      .map((id) => ({ id: `m1->${id}`, source: 'm1', target: id })),
  };
}

describe('retainFleetTopology', () => {
  it('keeps a node that dropped out of the newest snapshot', () => {
    const previous = topology(['m1', 't1', 't2']);
    const next = topology(['m1', 't1']);

    const result = retainFleetTopology(next, previous, {}, T0);

    expect(result.topology.nodes.map((n) => n.id).sort()).toEqual(['m1', 't1', 't2']);
    expect(result.missingSince).toEqual({ t2: T0 });
    const retained = result.topology.nodes.find((n) => n.id === 't2');
    expect(retained?.retained).toBe(true);
    expect(retained?.status).toBe('offline');
    expect(retained?.chips).toContain('reconnecting…');
    // The edge to a retained node survives with it.
    expect(result.topology.edges.map((e) => e.id)).toContain('m1->t2');
  });

  it('drops the node once it has been missing past the grace window', () => {
    const previous = retainFleetTopology(
      topology(['m1', 't1']),
      topology(['m1', 't1', 't2']),
      {},
      T0,
    );
    const late = T0 + FLEET_TOPOLOGY_RETENTION_MS + 1;

    const result = retainFleetTopology(
      topology(['m1', 't1']),
      previous.topology,
      previous.missingSince,
      late,
    );

    expect(result.topology.nodes.map((n) => n.id)).toEqual(['m1', 't1']);
    expect(result.missingSince).toEqual({});
    expect(result.topology.edges.map((e) => e.id)).not.toContain('m1->t2');
  });

  it('does not restart the clock while a node stays missing', () => {
    // `previous` is the RETAINED topology, so the node is present in it on the
    // second pass — reading `missingSince` from the carried state is the only
    // thing that keeps the original timestamp.
    const first = retainFleetTopology(topology(['m1']), topology(['m1', 't1']), {}, T0);
    const second = retainFleetTopology(
      topology(['m1']),
      first.topology,
      first.missingSince,
      T0 + 30_000,
    );

    expect(second.missingSince).toEqual({ t1: T0 });

    const third = retainFleetTopology(
      topology(['m1']),
      second.topology,
      second.missingSince,
      T0 + FLEET_TOPOLOGY_RETENTION_MS + 1,
    );
    expect(third.topology.nodes.map((n) => n.id)).toEqual(['m1']);
  });

  it('restores the live node when the publisher comes back', () => {
    const gap = retainFleetTopology(topology(['m1']), topology(['m1', 't1']), {}, T0);
    expect(gap.topology.nodes.find((n) => n.id === 't1')?.retained).toBe(true);

    const back = retainFleetTopology(
      topology(['m1', 't1']),
      gap.topology,
      gap.missingSince,
      T0 + 2_000,
    );

    expect(back.missingSince).toEqual({});
    const node = back.topology.nodes.find((n) => n.id === 't1');
    expect(node?.retained).toBeUndefined();
    expect(node?.status).toBe('active');
    expect(node?.chips).not.toContain('reconnecting…');
  });

  it('returns the snapshot untouched when nothing is missing', () => {
    const next = topology(['m1', 't1']);
    const result = retainFleetTopology(next, topology(['m1', 't1']), {}, T0);
    expect(result.topology).toBe(next);
  });

  it('drops an orphaned edge rather than pointing it at a removed node', () => {
    const previous: FleetTopology = {
      nodes: [{ id: 't1', kind: 'terminal', label: 't1', chips: [] }],
      edges: [{ id: 'gone->t1', source: 'gone', target: 't1' }],
    };
    const result = retainFleetTopology({ nodes: [], edges: [] }, previous, {}, T0);
    expect(result.topology.nodes.map((n) => n.id)).toEqual(['t1']);
    expect(result.topology.edges).toEqual([]);
  });
});
