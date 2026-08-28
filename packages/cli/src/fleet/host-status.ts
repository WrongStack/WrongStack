import type { TaskResult } from '@wrongstack/core/types';

/** Read-only fleet concurrency + lifetime spawn budget snapshot for operators. */
export interface FleetBudgetView {
  maxConcurrent: number;
  activeAgents: number;
  maxSpawns: number;
  usedSpawns: number;
  remainingSpawns: number;
  maxTokens?: number | undefined;
  usedTokens?: number | undefined;
  remainingTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  usedCostUsd?: number | undefined;
  remainingCostUsd?: number | undefined;
  /** Historical ceiling from checkpoint metadata when it differed from live. */
  checkpointMaxSpawns?: number | undefined;
  ceilingMismatch?: boolean | undefined;
  /** Winning source for maxConcurrent: cli-flag | env | profile | default. */
  maxConcurrentSource?: string | undefined;
  /** Winning source for maxSpawns: cli-flag | env | profile | default. */
  maxSpawnsSource?: string | undefined;
  /** Compact effective-source label for status lines. */
  effectiveSource?: string | undefined;
}

export interface FleetHostStatus {
  pending: { taskId: string; description: string; subagentId: string }[];
  completed: TaskResult[];
  live: { subagentId: string; status: string; task?: string | undefined }[];
  summary: string;
  budget?: FleetBudgetView | undefined;
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

interface FleetHostStatusInputs {
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
  budget?: FleetBudgetView | undefined;
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
  const completed = (input.completedResults ?? []).filter(
    (r) => !input.shadowTaskIds.has(r.taskId),
  );
  const completedCount = completed.length;
  const liveCount = live.filter((s) => s.status === 'running' || s.status === 'idle').length;
  const summary =
    !input.coordinatorStatus && !input.completedResults
      ? 'No subagents have been spawned.'
      : liveCount > 0
        ? `${pending.length} pending, ${liveCount} active, ${completedCount} completed.`
        : `${pending.length} pending, ${completedCount} completed.`;
  return {
    pending,
    completed,
    live,
    summary,
    ...(input.budget ? { budget: input.budget } : {}),
  };
}

/** Format a compact multi-line budget block for `/fleet status` and resume logs. */
export function formatFleetBudgetLines(
  budget: FleetBudgetView,
  colorize?: {
    bold: (s: string) => string;
    dim: (s: string) => string;
    amber: (s: string) => string;
  },
): string[] {
  const bold = colorize?.bold ?? ((s: string) => s);
  const dim = colorize?.dim ?? ((s: string) => s);
  const amber = colorize?.amber ?? ((s: string) => s);
  const fmtNum = (n: number): string => (Number.isFinite(n) ? String(n) : '∞');
  const sourceSuffix = budget.effectiveSource
    ? `  ${dim(`(source: ${budget.effectiveSource})`)}`
    : '';
  const lines = [
    bold('Budget'),
    `  maxConcurrent: ${budget.maxConcurrent}  ·  activeAgents: ${budget.activeAgents}`,
    `  maxSpawns: ${fmtNum(budget.maxSpawns)}  ·  usedSpawns: ${budget.usedSpawns}  ·  remainingSpawns: ${fmtNum(budget.remainingSpawns)}${sourceSuffix}`,
  ];
  if (
    budget.maxTokens !== undefined &&
    Number.isFinite(budget.maxTokens) &&
    budget.maxTokens < Number.POSITIVE_INFINITY
  ) {
    lines.push(
      `  tokens: ${budget.usedTokens ?? 0} / ${fmtNum(budget.maxTokens)} remaining ${fmtNum(budget.remainingTokens ?? 0)}`,
    );
  }
  if (
    budget.maxCostUsd !== undefined &&
    Number.isFinite(budget.maxCostUsd) &&
    budget.maxCostUsd < Number.POSITIVE_INFINITY
  ) {
    const used = budget.usedCostUsd ?? 0;
    const rem = budget.remainingCostUsd ?? 0;
    lines.push(
      `  costUsd: ${used.toFixed(4)} / ${budget.maxCostUsd.toFixed(4)} remaining ${rem.toFixed(4)}`,
    );
  }
  if (budget.ceilingMismatch && budget.checkpointMaxSpawns !== undefined) {
    lines.push(
      amber(
        `  ⚠ checkpoint maxSpawns was ${budget.checkpointMaxSpawns}; live ceiling is ${fmtNum(budget.maxSpawns)}`,
      ),
    );
  } else if (budget.checkpointMaxSpawns !== undefined) {
    lines.push(dim(`  checkpointMaxSpawns: ${budget.checkpointMaxSpawns}`));
  }
  return lines;
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
