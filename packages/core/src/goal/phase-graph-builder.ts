import { DefaultTaskStore, TaskTracker, type TaskStore } from '../tasking/index.js';
import type { TaskGraph, TaskPriority } from '../types/task-graph.js';
import type { PhaseGraph, PhaseNode, PhaseTemplate } from './types.js';

export interface PhaseGraphBuilderOptions {
  title: string;
  description?: string | undefined;
  /** Ordered phase templates. */
  phases: PhaseTemplate[];
  /** Autonomous mode. */
  autonomous?: boolean | undefined;
  /** Stop on failure. */
  stopOnFailure?: boolean | undefined;
  /** Optional external TaskStore. */
  externalTaskStore?: TaskStore | undefined;
  /** Split into separate kanban boards per phase. */
  multiBoard?: boolean | undefined;
  /** Run typecheck/lint verification after each task. */
  verifyTasks?: boolean | undefined;
  /** Enable chimera auto-review for this run. */
  chimeraReview?: boolean | undefined;
}

/**
 * PhaseGraphBuilder - builds project phases and a task graph for each phase.
 *
 * Usage:
 *   const builder = new PhaseGraphBuilder({
 *     title: 'Auth System Refactor',
 *     phases: [
 *       { name: 'Discovery', description: '...', priority: 'high', estimateHours: 2, parallelizable: false },
 *       { name: 'Design', description: '...', priority: 'critical', estimateHours: 4, parallelizable: false },
 *       { name: 'Implementation', description: '...', priority: 'critical', estimateHours: 12, parallelizable: false },
 *       { name: 'Testing', description: '...', priority: 'high', estimateHours: 6, parallelizable: true },
 *       { name: 'Deployment', description: '...', priority: 'medium', estimateHours: 2, parallelizable: false },
 *     ]
 *   });
 *   const graph = await builder.build();
 */
export class PhaseGraphBuilder {
  constructor(private readonly opts: PhaseGraphBuilderOptions) {}

  async build(): Promise<PhaseGraph> {
    const graphId = crypto.randomUUID();
    const phases = new Map<string, PhaseNode>();
    const phaseIds: string[] = [];

    // Create a PhaseNode from each phase template.
    for (let i = 0; i < this.opts.phases.length; i++) {
      const tmpl = this.opts.phases[i] ?? {
        name: '',
        description: '',
        tasks: [],
        taskTemplates: [],
        parallelizable: false,
        priority: 'medium' as const,
        estimateHours: 0,
      };
      const phaseId = crypto.randomUUID();
      phaseIds.push(phaseId);

      // Use the external store or create a new in-memory task store.
      const store = this.opts.externalTaskStore ?? new DefaultTaskStore();
      const tracker = new TaskTracker({ store });
      const taskGraph = await tracker.createGraph(phaseId, `${tmpl.name} Tasks`);

      // Add task templates when present.
      if (tmpl.taskTemplates && tmpl.taskTemplates.length > 0) {
        for (const tt of tmpl.taskTemplates) {
          tracker.addNode({
            title: tt.title,
            description: tt.description,
            type: tt.type,
            priority: tt.priority,
            status: 'pending',
            estimateHours: tt.estimateHours,
            tags: tt.tags ?? [],
          });
        }
      }

      const phase: PhaseNode = {
        id: phaseId,
        name: tmpl.name,
        description: tmpl.description,
        status: 'pending',
        taskGraph,
        dependsOn: i > 0 ? [phaseIds[i - 1] ?? ''] : [],
        nextPhases: i < this.opts.phases.length - 1 ? [phaseIds[i + 1] ?? ''] : [],
        parallelizable: tmpl.parallelizable,
        priority: tmpl.priority,
        estimateHours: tmpl.estimateHours,
        assignedAgents: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      phases.set(phaseId, phase);
    }

    // Second pass: fill in the forward `nextPhases` links — the next phase id was
    // not yet known while each phase was created. `dependsOn` (the backward link)
    // is already correct from the first pass (the previous id always exists), so
    // it is intentionally NOT recomputed here.
    const phaseArray = Array.from(phases.values());
    for (let i = 0; i < phaseArray.length; i++) {
      const phase = phaseArray[i];
      if (!phase) continue;
      phase.nextPhases = i < phaseArray.length - 1 ? [phaseArray[i + 1]?.id ?? ''] : [];
    }

    const graph: PhaseGraph = {
      id: graphId,
      title: this.opts.title,
      description: this.opts.description ?? '',
      phases,
      rootPhaseIds: phaseIds.length > 0 ? [phaseIds[0] ?? ''] : [],
      activePhaseIds: [],
      completedPhaseIds: [],
      failedPhaseIds: [],
      autonomous: this.opts.autonomous ?? true,
      stopOnComplete: true,
      multiBoard: this.opts.multiBoard,
      verifyTasks: this.opts.verifyTasks,
      chimeraReview: this.opts.chimeraReview,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    return graph;
  }

  /**
   * Create phases from an existing TaskGraph.
   * Groups tasks into phases using topological sort so dependencies
   * stay in the same phase wherever possible.
   */
  static fromTaskGraph(
    taskGraph: TaskGraph,
    options: Omit<PhaseGraphBuilderOptions, 'phases'> & {
      /** Number of tasks per phase. Defaults to 5. */
      tasksPerPhase?: number | undefined;
    },
  ): Promise<PhaseGraph> {
    const tasksPerPhase = options.tasksPerPhase ?? 5;
    const nodes = Array.from(taskGraph.nodes.values());

    // Build adjacency: for each node, which nodes depend on it.
    const dependents = new Map<string, string[]>();
    for (const edge of taskGraph.edges) {
      const list = dependents.get(edge.from) ?? [];
      list.push(edge.to);
      dependents.set(edge.from, list);
    }

    // Topological sort (Kahn's algorithm) — tasks that are depended-on come first.
    const inDegree = new Map<string, number>();
    for (const node of nodes) inDegree.set(node.id, 0);
    for (const edge of taskGraph.edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const prioOrder: Record<TaskPriority, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };

    const topoSorted: string[] = [];
    while (queue.length > 0) {
      // Prioritize by critical → high → medium → low within the same level.
      queue.sort((a, b) => {
        const na = taskGraph.nodes.get(a);
        const nb = taskGraph.nodes.get(b);
        const naPrio = na ? prioOrder[na.priority] : 4;
        const nbPrio = nb ? prioOrder[nb.priority] : 4;
        return naPrio - nbPrio;
      });
      const id = queue.shift()!;
      topoSorted.push(id);
      for (const depId of dependents.get(id) ?? []) {
        const deg = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, deg);
        if (deg === 0) queue.push(depId);
      }
    }

    // Group topologically-sorted nodes into phases, keeping dependent
    // tasks close together.
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    const assigned = new Set<string>();

    for (const id of topoSorted) {
      if (assigned.has(id)) continue;
      assigned.add(id);
      currentGroup.push(id);

      // Collect any direct dependents of this task into the same phase
      // as long as we haven't exceeded the size limit.
      const deps = dependents.get(id) ?? [];
      for (const depId of deps) {
        if (!assigned.has(depId) && currentGroup.length < tasksPerPhase) {
          assigned.add(depId);
          currentGroup.push(depId);
        }
      }

      if (currentGroup.length >= tasksPerPhase) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    const phaseTemplates: PhaseTemplate[] = groups.map((groupIds, idx) => {
      const group = groupIds
        .map((id) => taskGraph.nodes.get(id))
        .filter((n): n is NonNullable<typeof n> => n != null);
      const hasCritical = group.some((t) => t.priority === 'critical');
      const totalHours = group.reduce((sum, t) => sum + (t.estimateHours ?? 2), 0);

      return {
        name: `Phase ${idx + 1}: ${group[0]?.title.slice(0, 30) ?? 'Tasks'}`,
        description: group.map((t) => t.title).join(', '),
        priority: hasCritical ? 'critical' : 'high',
        estimateHours: totalHours,
        parallelizable: false,
        taskTemplates: group.map((t) => ({
          title: t.title,
          description: t.description,
          type: t.type,
          priority: t.priority,
          estimateHours: t.estimateHours ?? 2,
          tags: t.tags ?? [],
        })),
      };
    });

    const builder = new PhaseGraphBuilder({
      ...options,
      phases: phaseTemplates,
    });

    return builder.build();
  }
}
