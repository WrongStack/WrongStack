import type { TaskResult } from '@wrongstack/core/types';

export interface FleetHostStatus {
  pending: { taskId: string; description: string; subagentId: string }[];
  completed: TaskResult[];
  live: { subagentId: string; status: string; task?: string | undefined }[];
  summary: string;
}

export interface FleetHostUsage {
  rows: Array<{
    subagentId: string;
    tasks: number;
    iterations: number;
    toolCalls: number;
    durationMs: number;
    status: string;
  }>;
  totals: { tasks: number; iterations: number; toolCalls: number; durationMs: number };
}

export interface FleetHostStatusInputs {
  coordinatorStatus?:
    | {
        subagents: readonly {
          id: string;
          status: string;
          currentTask?: string | undefined;
        }[];
      }
    | null
    | undefined;
  fleetStatus?:
    | {
        pending: FleetHostStatus['pending'];
      }
    | null
    | undefined;
  completedResults?: readonly TaskResult[] | null | undefined;
  shadowTaskIds: ReadonlySet<string>;
}

export function buildFleetHostStatus(input: FleetHostStatusInputs): FleetHostStatus {
  const activeSubagentIds = new Set<string>();
  const live: FleetHostStatus['live'] = [];
  for (const subagent of input.coordinatorStatus?.subagents ?? []) {
    if (subagent.status === 'running' || subagent.status === 'idle') {
      activeSubagentIds.add(subagent.id);
    }
    live.push({
      subagentId: subagent.id,
      status: subagent.status,
      task: subagent.currentTask,
    });
  }
  const pending = (input.fleetStatus?.pending ?? []).filter((p) =>
    activeSubagentIds.has(p.subagentId),
  );
  const completed = (input.completedResults ?? []).filter((r) => !input.shadowTaskIds.has(r.taskId));
  const completedCount = completed.length;
  const liveCount = live.filter((s) => s.status === 'running' || s.status === 'idle').length;
  const summary =
    !input.coordinatorStatus && !input.completedResults
      ? 'No subagents have been spawned.'
      : liveCount > 0
        ? `${pending.length} pending, ${liveCount} active, ${completedCount} completed.`
        : `${pending.length} pending, ${completedCount} completed.`;
  return { pending, completed, live, summary };
}

export function aggregateFleetUsage(completed: readonly TaskResult[]): FleetHostUsage {
  const bySubagent = new Map<
    string,
    {
      tasks: number;
      iterations: number;
      toolCalls: number;
      durationMs: number;
      lastStatus: string;
    }
  >();
  for (const r of completed) {
    const cur = bySubagent.get(r.subagentId) ?? {
      tasks: 0,
      iterations: 0,
      toolCalls: 0,
      durationMs: 0,
      lastStatus: 'unknown',
    };
    cur.tasks += 1;
    cur.iterations += r.iterations;
    cur.toolCalls += r.toolCalls;
    cur.durationMs += r.durationMs;
    cur.lastStatus = r.status;
    bySubagent.set(r.subagentId, cur);
  }
  const rows = Array.from(bySubagent.entries())
    .map(([subagentId, v]) => ({
      subagentId,
      tasks: v.tasks,
      iterations: v.iterations,
      toolCalls: v.toolCalls,
      durationMs: v.durationMs,
      status: v.lastStatus,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
  const totals = rows.reduce(
    (acc, r) => ({
      tasks: acc.tasks + r.tasks,
      iterations: acc.iterations + r.iterations,
      toolCalls: acc.toolCalls + r.toolCalls,
      durationMs: acc.durationMs + r.durationMs,
    }),
    { tasks: 0, iterations: 0, toolCalls: 0, durationMs: 0 },
  );
  return { rows, totals };
}
