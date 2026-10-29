import type { PhaseGraph } from '@wrongstack/goal';

export function buildGoalState(
  graph: PhaseGraph | null,
  activePhaseId?: string,
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' = 'idle',
): Record<string, unknown> {
  const normalizedStatus = ['idle', 'running', 'paused', 'completed', 'failed', 'stopped'].includes(
    status,
  )
    ? status
    : 'idle';
  if (!graph) {
    return {
      phases: [],
      tasks: [],
      overallPercent: 0,
      autonomous: true,
      title: '',
      graphId: null,
      multiBoard: false,
      verifyTasks: false,
      chimeraReview: false,
      finalVerification: null,
      status: normalizedStatus,
    };
  }

  const phases = Array.from(graph.phases.values());
  const currentActiveId =
    (activePhaseId && graph.phases.has(activePhaseId) ? activePhaseId : undefined) ||
    phases.find((p) => p.status === 'running')?.id ||
    phases[0]?.id ||
    '';
  const activePhase = graph.phases.get(currentActiveId);

  const totalTasks = phases.reduce((sum, p) => sum + p.taskGraph.nodes.size, 0);
  const completedTasks = phases.reduce(
    (sum, p) =>
      sum + Array.from(p.taskGraph.nodes.values()).filter((t) => t.status === 'completed').length,
    0,
  );

  // Shared task → board-card mapper. Carries assignee/timestamps so the kanban
  // can show who is on each card and how long it has been running.
  const mapTask = (t: import('@wrongstack/contracts/types').TaskNode) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    type: t.type,
    estimateHours: t.estimateHours,
    actualHours: t.actualHours,
    assignee: t.assignee,
    tags: Array.isArray(t.tags) ? t.tags.filter((tag) => typeof tag === 'string') : [],
    startedAt: t.startedAt,
    completedAt: t.completedAt,
  });

  const phaseItems = phases.map((p) => {
    const nodes = Array.from(p.taskGraph.nodes.values());
    const done = nodes.filter((t) => t.status === 'completed').length;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      priority: p.priority,
      estimateHours: p.estimateHours,
      actualDurationMs: p.actualDurationMs,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
      progressPercent:
        nodes.length > 0
          ? Math.round((done / nodes.length) * 100)
          : p.status === 'completed'
            ? 100
            : 0,
      taskCount: nodes.length,
      completedTasks: done,
      assignedAgents: Array.isArray(p.assignedAgents)
        ? p.assignedAgents.filter((agent) => typeof agent === 'string')
        : [],
      isActive: p.id === currentActiveId,
      // Every phase carries its full task list so the board can render each
      // phase as a column (not just the selected one).
      tasks: nodes.map(mapTask),
    };
  });

  // Back-compat: the chat-area TaskBoard still reads the flat active-phase list.
  const taskItems = activePhase
    ? Array.from(activePhase.taskGraph.nodes.values()).map(mapTask)
    : [];

  const completedPhases = phases.filter((p) => p.status === 'completed').length;
  const failedPhases = phases.filter((p) => p.status === 'failed').length;
  const failedTasks = phases.reduce(
    (sum, p) =>
      sum + Array.from(p.taskGraph.nodes.values()).filter((t) => t.status === 'failed').length,
    0,
  );

  // Surface the most recent failure so the board can show it (the store keeps a
  // `lastError` field the UI renders). Prefer the worktree integration error,
  // else a generic phase-failure note.
  const lastFailed = phases
    .filter((p) => p.status === 'failed')
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  const lastError =
    graph.runError ??
    (graph.finalVerification?.status === 'failed'
      ? (graph.finalVerification.error ?? 'final verification failed')
      : lastFailed
        ? `${lastFailed.name}: ${(lastFailed.metadata?.integrationError as string | undefined) ?? 'phase failed'}`
        : null);

  return {
    title: graph.title,
    graphId: graph.id,
    // Full operator prompt, shown verbatim in a dedicated goal block (the
    // title is only a short derived heading). Fall back to the title for
    // legacy boards saved before the title/goal split.
    goal: graph.description || graph.title,
    phases: phaseItems,
    tasks: taskItems,
    activePhaseId: currentActiveId,
    overallPercent: phases.length > 0 ? Math.round((completedPhases / phases.length) * 100) : 0,
    autonomous: graph.autonomous,
    totalTasks,
    completedTasks,
    // Structured progress + lastError consumed by the goal store (were
    // defined client-side but never sent, so they stayed null on the board).
    progress: {
      totalPhases: phases.length,
      completed: completedPhases,
      failed: failedPhases,
      totalTasks,
      completedTasks,
      failedTasks,
    },
    lastError,
    multiBoard: graph.multiBoard ?? false,
    verifyTasks: graph.verifyTasks ?? false,
    chimeraReview: graph.chimeraReview ?? false,
    budget: graph.budget ?? null,
    budgetUsage: graph.budgetUsage ? { ...graph.budgetUsage } : null,
    finalVerification: graph.finalVerification ? structuredClone(graph.finalVerification) : null,
    status: normalizedStatus,
  };
}
