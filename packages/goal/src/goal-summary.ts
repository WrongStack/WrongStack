import type { PhaseGraph } from './types.js';

export interface GoalSummary {
  id: string;
  title: string;
  sessionId: string | null;
  status: 'planning' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed' | 'pending';
  updatedAt: number;
  percentComplete: number | null;
  completedTasks: number;
  totalTasks: number;
  completedPhases: number;
  totalPhases: number;
  phases: Array<{
    id: string;
    name: string;
    status: string;
    completedTasks: number;
    totalTasks: number;
  }>;
  blockers: string[];
  reachability: 'unknown' | 'blocked' | 'verified';
  verification: 'passed' | 'failed' | 'not_run';
  branch: string | null;
  ownerId: string | null;
}

/** A work percentage is evidence of task progress, never proof of goal success. */
export function summarizeGoal(graph: PhaseGraph, ownerId: string | null = null): GoalSummary {
  const phases = [...graph.phases.values()].map((phase) => ({
    id: phase.id,
    name: phase.name,
    status: phase.status,
    completedTasks: [...phase.taskGraph.nodes.values()].filter(
      (task) => task.status === 'completed',
    ).length,
    totalTasks: phase.taskGraph.nodes.size,
  }));
  const totalTasks = phases.reduce((sum, phase) => sum + phase.totalTasks, 0);
  const completedTasks = phases.reduce((sum, phase) => sum + phase.completedTasks, 0);
  const completedPhases = phases.filter(
    (phase) => phase.status === 'completed' || phase.status === 'skipped',
  ).length;
  const blockers: string[] = [];
  if (graph.runError) blockers.push(graph.runError);
  for (const phase of graph.phases.values()) {
    if (phase.status === 'failed') blockers.push(`${phase.name}: phase failed`);
    for (const task of phase.taskGraph.nodes.values()) {
      if (task.status === 'failed' || task.status === 'blocked')
        blockers.push(`${phase.name}: ${task.title} (${task.status})`);
    }
    if (
      phase.metadata?.['integrationStatus'] === 'needs_review' ||
      phase.metadata?.['integrationStatus'] === 'merge_failed'
    ) {
      blockers.push(`${phase.name}: integration needs review`);
    }
  }
  if (graph.finalVerification?.status === 'failed')
    blockers.push(graph.finalVerification.error ?? 'Final verification failed');
  const complete =
    phases.length > 0 &&
    completedPhases === phases.length &&
    graph.completedAt !== undefined &&
    phases.every(
      (phase) => phase.status === 'skipped' || phase.completedTasks === phase.totalTasks,
    );
  const status: GoalSummary['status'] =
    graph.runState === 'failed' ||
    graph.failedPhaseIds.length > 0 ||
    phases.some((phase) => phase.status === 'failed') ||
    graph.finalVerification?.status === 'failed'
      ? 'failed'
      : complete
        ? 'completed'
        : ownerId
          ? graph.runState === 'paused'
            ? 'paused'
            : graph.runState === 'planning'
              ? 'planning'
              : 'running'
          : graph.runState || graph.startedAt
            ? 'stopped'
            : 'pending';
  const verification = graph.finalVerification?.skipped
    ? 'not_run'
    : (graph.finalVerification?.status ?? 'not_run');
  return {
    id: graph.id,
    title: graph.title,
    sessionId: graph.sessionId ?? null,
    status,
    updatedAt: graph.updatedAt,
    percentComplete: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : null,
    totalTasks,
    completedTasks,
    totalPhases: phases.length,
    completedPhases,
    phases,
    blockers,
    reachability:
      blockers.length > 0
        ? 'blocked'
        : complete && verification === 'passed'
          ? 'verified'
          : 'unknown',
    verification,
    branch: graph.workspace?.branch ?? null,
    ownerId,
  };
}
