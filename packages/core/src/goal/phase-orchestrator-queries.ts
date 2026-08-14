/**
 * Read-only queries over a phase graph, plus the two leaf helpers that only
 * touch a phase's own record.
 *
 * Split out of `phase-orchestrator.ts`. Nothing here schedules, emits, or
 * mutates orchestrator state — each function derives its answer from the graph
 * (and, where task counts are involved, the orchestrator's tracker lookup).
 *
 * @module goal/phase-orchestrator-queries
 */
import type { TaskTracker } from '../tasking/index.js';
import type { TaskNode } from '../types/task-graph.js';
import type { PhaseGraph, PhaseNode, PhaseProgress } from './types.js';

/** Resolves (and memoizes) the TaskTracker backing a phase's task graph. */
export type TrackerLookup = (phase: PhaseNode) => TaskTracker;

export function getReadyPhases(graph: PhaseGraph): PhaseNode[] {
  const ready: PhaseNode[] = [];

  for (const phase of graph.phases.values()) {
    if (phase.status !== 'pending') continue;

    const depsDone = phase.dependsOn.every((depId) => {
      const dep = graph.phases.get(depId);
      // A failed predecessor does not satisfy a dependency. Treating it as
      // resolved started downstream phases with missing source evidence.
      return dep?.status === 'completed' || dep?.status === 'skipped';
    });

    // A phase is ready ONLY when its dependencies are resolved. `parallelizable`
    // governs whether ready phases may run CONCURRENTLY (the `maxConcurrentPhases`
    // batch in start()/tick() already enforces that) — it must NOT let a phase
    // start before its dependencies finish. (Previously this read
    // `depsDone || phase.parallelizable`, which let a dependent-but-parallelizable
    // phase, e.g. a Testing phase depending on Implementation, jump the gun.)
    if (depsDone) {
      ready.push(phase);
    }
  }

  const prioOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  ready.sort((a, b) => (prioOrder[a.priority] ?? 4) - (prioOrder[b.priority] ?? 4));

  return ready;
}

export function getActivePhases(graph: PhaseGraph): PhaseNode[] {
  return Array.from(graph.phases.values()).filter((p) => p.status === 'running');
}

export function getExecutableTasks(trackerFor: TrackerLookup, phase: PhaseNode): TaskNode[] {
  const tracker = trackerFor(phase);
  return tracker
    .getAllNodes({ status: ['pending', 'blocked'] })
    .filter(
      (n: { id: string; status: string; priority: string }) =>
        n.status === 'pending' && tracker.canStart(n.id),
    )
    .sort((a: { priority: TaskNode['priority'] }, b: { priority: TaskNode['priority'] }) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4);
    });
}

export function getFailedTaskCount(trackerFor: TrackerLookup, phase: PhaseNode): number {
  return trackerFor(phase).getAllNodes({ status: ['failed'] }).length;
}

export function getCompletedTaskCount(trackerFor: TrackerLookup, phase: PhaseNode): number {
  return trackerFor(phase).getAllNodes({ status: ['completed'] }).length;
}

export function isGraphComplete(graph: PhaseGraph): boolean {
  const allPhases = Array.from(graph.phases.values());
  return allPhases.every((p) => p.status === 'completed' || p.status === 'skipped');
}

export function getProgress(graph: PhaseGraph, trackerFor: TrackerLookup): PhaseProgress {
  const phases = Array.from(graph.phases.values());
  let pending = 0;
  let ready = 0;
  let running = 0;
  let paused = 0;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let totalTasks = 0;
  let completedTasks = 0;
  let failedTasks = 0;
  let estimatedHours = 0;
  let actualHours = 0;

  for (const p of phases) {
    switch (p.status) {
      case 'pending':
        pending++;
        break;
      case 'ready':
        ready++;
        break;
      case 'running':
        running++;
        break;
      case 'paused':
        paused++;
        break;
      case 'completed':
        completed++;
        break;
      case 'failed':
        failed++;
        break;
      case 'skipped':
        skipped++;
        break;
      default:
        // Unknown phase status — log and skip in counter
        break;
    }
    estimatedHours += p.estimateHours;
    if (p.actualDurationMs) actualHours += p.actualDurationMs / 3600000;

    const tracker = trackerFor(p);
    const progress = tracker.getProgress();
    totalTasks += progress.total;
    completedTasks += progress.completed;
    failedTasks += progress.failed;
  }

  const totalPhases = phases.length;
  const done = completed + skipped;

  return {
    totalPhases,
    pending,
    ready,
    running,
    paused,
    completed,
    failed,
    skipped,
    percentComplete: totalPhases > 0 ? Math.min(100, Math.round((done / totalPhases) * 100)) : 0,
    totalTasks,
    completedTasks,
    failedTasks,
    estimatedHours,
    actualHours,
  };
}

export function setIntegrationMetadata(
  graph: PhaseGraph,
  phase: PhaseNode,
  status: 'merged' | 'needs_review' | 'merge_failed' | 'not_merged_failed_phase',
  details: {
    branch?: string | undefined;
    worktreeDir?: string | undefined;
    conflictFiles?: string[] | undefined;
    error?: string | undefined;
  } = {},
): void {
  phase.metadata = {
    ...phase.metadata,
    integrationStatus: status,
    integrationBranch: details.branch,
    integrationWorktreeDir: details.worktreeDir,
    integrationConflictFiles: details.conflictFiles,
    integrationError: details.error,
    integrationUpdatedAt: Date.now(),
  };
  phase.updatedAt = Date.now();
  graph.updatedAt = Date.now();
}

export function truncate(text: string, max = 500): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}… (+${t.length - max} chars)`;
}
