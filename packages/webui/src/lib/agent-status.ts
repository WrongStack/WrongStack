/**
 * agent-status — shared, presentation-agnostic helpers for in-process subagent
 * (`SubagentView`) state.
 *
 * The Fleet surfaces (FleetMonitor, FleetPanel) each hand-rolled the same
 * "running-first" sort, the same status counts, and the same `status ===
 * 'running'` active check. This module is the single source for that pure logic
 * so the surfaces stop drifting.
 *
 * Deliberately NOT here: the per-surface visual status maps. FleetMonitor uses
 * the tailwind palette (`bg-emerald-500`) while FleetPanel uses CSS-var tokens
 * (`text-[hsl(var(--success))]`); unifying those would change rendered colors,
 * so each surface keeps its own color map. Only the canonical short labels
 * (identical across surfaces) live here.
 */

import type { SubagentView } from '@/stores';

export type AgentStatus = SubagentView['status'];

/** Canonical short label per status (shared by the Fleet surfaces). */
export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  timeout: 'timeout',
  stopped: 'stopped',
};

/** A subagent is "active" only while running. */
export function isAgentActive(status: string): boolean {
  return status === 'running';
}

/**
 * Sort comparator: running agents first, then oldest-started first. Generic over
 * anything carrying `status` + `startedAt` so both the store's `SubagentView` and
 * lighter row shapes can use it. Callers that pin a leader to the top should
 * apply that special-case before delegating here.
 */
export function compareAgentsByActivity<T extends { status: string; startedAt: number }>(
  a: T,
  b: T,
): number {
  const aActive = isAgentActive(a.status) ? 0 : 1;
  const bActive = isAgentActive(b.status) ? 0 : 1;
  if (aActive !== bActive) return aActive - bActive;
  return a.startedAt - b.startedAt;
}

export interface AgentTally {
  running: number;
  completed: number;
  /** failed + timeout — the two terminal-error states the Fleet UIs group. */
  failed: number;
  total: number;
}

/** Count agents by activity bucket (running / completed / failed-or-timeout). */
export function tallyAgents<T extends { status: string }>(list: readonly T[]): AgentTally {
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const a of list) {
    if (a.status === 'running') running++;
    else if (a.status === 'completed') completed++;
    else if (a.status === 'failed' || a.status === 'timeout') failed++;
  }
  return { running, completed, failed, total: list.length };
}
