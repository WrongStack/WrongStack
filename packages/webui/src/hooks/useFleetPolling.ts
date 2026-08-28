/**
 * useFleetPolling — live fleet data hook for the AgentsPanel and other
 * agent-roster surfaces.
 *
 * Subscribes to the fleet store with individual selectors so re-renders
 * only fire when the relevant slice changes. Derives the fleet summary
 * and sorted agent list via useMemo.
 *
 * Also exposes a self-ticking `now` timestamp (updates every second) so
 * elapsed-time displays (e.g. "2m 30s") tick live without each consumer
 * mounting its own setInterval.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFleetStore } from '@/stores';
import type { SubagentView, FleetSummary } from '@/stores';
import { tallyAgents } from '@/lib/agent-status';

export interface FleetPollingResult {
  /** Derived fleet-wide summary (running/completed/failed/total/cost/tokens). */
  summary: FleetSummary;
  /** Agent list sorted leader-first, running-first, then by startedAt. */
  agentList: SubagentView[];
  /**
   * Live timestamp updated every second. Pass to `computeAgentStats`
   * for live-elapsed displays without each consumer mounting a timer.
   */
  now: number;
  /** Force a re-computation of derived values on next render. */
  refreshNow: () => void;
}

/**
 * Subscribe to live fleet data via derived selectors.
 *
 * @param enabled  When false, stops the ticking clock and returns
 *                 an empty result. Useful for panels that render
 *                 only when visible.
 */
export function useFleetPolling(enabled = true): FleetPollingResult {
  // Individual store subscriptions — zustand uses reference equality so
  // each selector only re-renders when its specific field changes.
  const agents = useFleetStore((s) => s.agents);
  const fleetTokensIn = useFleetStore((s) => s.fleetTokensIn);
  const fleetTokensOut = useFleetStore((s) => s.fleetTokensOut);
  const fleetConcurrency = useFleetStore((s) => s.fleetConcurrency);
  const fleetConcurrencyMax = useFleetStore((s) => s.fleetConcurrencyMax);

  // Derive the sorted agent list — only re-computes when the agents Map
  // reference changes (triggered by any applyEvent).
  const agentList = useMemo<SubagentView[]>(() => {
    const arr = Array.from(agents.values());
    arr.sort((x, y) => {
      // Every session's leader sorts first — the process-wide leaderId
      // pointer is last-writer-wins and would crown only one tab's leader.
      if (x.isLeader !== y.isLeader) return x.isLeader ? -1 : 1;
      const xa = x.status === 'running' ? 0 : 1;
      const ya = y.status === 'running' ? 0 : 1;
      if (xa !== ya) return xa - ya;
      return x.startedAt - y.startedAt;
    });
    return arr;
  }, [agents]);

  // Derive the fleet summary — one-pass iteration over the agent list.
  const summary = useMemo<FleetSummary>(() => {
    const tally = tallyAgents(agentList);
    const totalCost = agentList.reduce((sum, a) => sum + a.costUsd, 0);
    return {
      running: tally.running,
      completed: tally.completed,
      failed: tally.failed,
      total: tally.total,
      totalCost,
      tokensIn: fleetTokensIn,
      tokensOut: fleetTokensOut,
      concurrency: fleetConcurrency,
      concurrencyMax: fleetConcurrencyMax,
    };
  }, [agentList, fleetTokensIn, fleetTokensOut, fleetConcurrency, fleetConcurrencyMax]);

  // Self-ticking clock for live elapsed-time displays.
  const [now, setNow] = useState(Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (tickRef.current) clearInterval(tickRef.current);
      tickRef.current = null;
      return;
    }
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [enabled]);

  const refreshNow = () => setNow(Date.now());

  return useMemo(
    () => ({ summary, agentList, now, refreshNow }),
    [summary, agentList, now],
  );
}
