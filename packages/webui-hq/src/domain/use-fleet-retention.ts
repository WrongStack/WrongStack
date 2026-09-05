/**
 * Presence retention for the Fleet Map.
 *
 * The map is rebuilt from whatever the newest `hq.snapshot` contains, and a
 * client's sessions live on its SOCKET server-side — so a publisher reconnect
 * (network blip, HQ restart, a superseded duplicate connection) empties that
 * client's session map and the terminal, with every agent under it, is absent
 * from the very next broadcast. Rendering that literally makes healthy nodes
 * blink out and back.
 *
 * This hook holds a node for `FLEET_TOPOLOGY_RETENTION_MS` after it stops
 * appearing, dimmed and labelled, then drops it. The decision itself is the
 * pure `retainFleetTopology`; all this adds is the React state and the clock
 * that expires a retained node even while no new snapshot arrives.
 */
import { useEffect, useRef, useState } from 'react';
import {
  FLEET_TOPOLOGY_RETENTION_MS,
  type FleetTopology,
  type FleetTopologyRetention,
  retainFleetTopology,
} from './fleet-topology.js';

/** How often retained nodes are re-checked against the grace window. */
const EXPIRY_TICK_MS = 5_000;

export function useRetainedFleetTopology(
  topology: FleetTopology,
  graceMs: number = FLEET_TOPOLOGY_RETENTION_MS,
): FleetTopology {
  const [state, setState] = useState<FleetTopologyRetention>(() => ({
    topology,
    missingSince: {},
  }));
  // The newest raw topology, readable from the expiry timer without making the
  // timer's effect depend on (and therefore restart with) every snapshot.
  const latestRef = useRef(topology);
  latestRef.current = topology;

  useEffect(() => {
    setState((previous) =>
      retainFleetTopology(topology, previous.topology, previous.missingSince, Date.now(), graceMs),
    );
  }, [topology, graceMs]);

  const hasRetained = Object.keys(state.missingSince).length > 0;
  useEffect(() => {
    if (!hasRetained) return;
    const timer = setInterval(() => {
      setState((previous) =>
        retainFleetTopology(
          latestRef.current,
          previous.topology,
          previous.missingSince,
          Date.now(),
          graceMs,
        ),
      );
    }, EXPIRY_TICK_MS);
    return () => clearInterval(timer);
  }, [graceMs, hasRetained]);

  return state.topology;
}
