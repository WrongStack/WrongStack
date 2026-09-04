import type { Specification, SpecRequirement, TaskGraph, TaskNode } from '@wrongstack/core/types';
import { assertNever } from '@wrongstack/core/utils';

export interface SpecVersion {
  version: string;
  spec: Specification;
  timestamp: number;
  changeDescription?: string | undefined;
}

export interface SpecDiff {
  added: SpecRequirement[];
  removed: SpecRequirement[];
  modified: Array<{
    requirement: SpecRequirement;
    previousVersion: SpecRequirement;
    changes: string[];
  }>;
  summary: string;
}

/**
 * Track spec versions and compute diffs between versions.
 */
export class SpecVersioning {
  private versions = new Map<string, SpecVersion[]>();

  /** Record a new version of a spec. */
  recordVersion(spec: Specification, changeDescription?: string): SpecVersion {
    const version: SpecVersion = {
      version: spec.version,
      // Deep snapshot: a shallow spread leaves `requirements`/`sections`
      // aliased to the caller's object, so later edits to that object would
      // retroactively rewrite recorded history.
      spec: structuredClone(spec),
      timestamp: Date.now(),
      changeDescription,
    };

    const history = this.versions.get(spec.id) ?? [];
    history.push(version);
    this.versions.set(spec.id, history);

    return version;
  }

  /** Get version history for a spec. */
  getHistory(specId: string): SpecVersion[] {
    return this.versions.get(specId) ?? [];
  }

  /** Get a specific version of a spec. */
  getVersion(specId: string, version: string): SpecVersion | undefined {
    const history = this.versions.get(specId) ?? [];
    return history.find((v) => v.version === version);
  }

  /** Get the latest version of a spec. */
  getLatest(specId: string): SpecVersion | undefined {
    const history = this.versions.get(specId) ?? [];
    return history[history.length - 1];
  }

  /** Compute diff between two versions of a spec. */
  diff(oldSpec: Specification, newSpec: Specification): SpecDiff {
    const oldReqs = new Map(oldSpec.requirements.map((r) => [r.id, r]));
    const newReqs = new Map(newSpec.requirements.map((r) => [r.id, r]));

    const added: SpecRequirement[] = [];
    const removed: SpecRequirement[] = [];
    const modified: SpecDiff['modified'] = [];

    // Find added and modified
    for (const [id, newReq] of newReqs) {
      const oldReq = oldReqs.get(id);
      if (!oldReq) {
        added.push(newReq);
      } else {
        const changes = this.compareRequirements(oldReq, newReq);
        if (changes.length > 0) {
          modified.push({
            requirement: newReq,
            previousVersion: oldReq,
            changes,
          });
        }
      }
    }

    // Find removed
    for (const [id, oldReq] of oldReqs) {
      if (!newReqs.has(id)) {
        removed.push(oldReq);
      }
    }

    const parts: string[] = [];
    if (added.length > 0) parts.push(`${added.length} added`);
    if (removed.length > 0) parts.push(`${removed.length} removed`);
    if (modified.length > 0) parts.push(`${modified.length} modified`);

    return {
      added,
      removed,
      modified,
      summary: parts.length > 0 ? parts.join(', ') : 'No changes',
    };
  }

  /**
   * Update a task graph incrementally based on spec changes.
   * - Added requirements → new tasks
   * - Removed requirements → remove tasks
   * - Modified requirements → update task descriptions
   * Returns the updated graph and list of changes made.
   */
  updateTaskGraph(
    graph: TaskGraph,
    oldSpec: Specification,
    newSpec: Specification,
  ): { graph: TaskGraph; changes: string[] } {
    const specDiff = this.diff(oldSpec, newSpec);
    const changes: string[] = [];

    // Map requirement IDs to task nodes
    const reqToTask = new Map<string, TaskNode>();
    for (const node of graph.nodes.values()) {
      if (node.specRequirementId) {
        reqToTask.set(node.specRequirementId, node);
      }
    }

    // Remove tasks for removed requirements
    for (const req of specDiff.removed) {
      const task = reqToTask.get(req.id);
      if (task) {
        graph.nodes.delete(task.id);
        graph.edges = graph.edges.filter((e) => e.from !== task.id && e.to !== task.id);
        changes.push(`Removed task: ${task.title}`);
      }
    }

    // Update tasks for modified requirements
    for (const mod of specDiff.modified) {
      const task = reqToTask.get(mod.requirement.id);
      if (task) {
        task.title = mod.requirement.description;
        task.description = this.buildTaskDescription(mod.requirement);
        task.priority = mod.requirement.priority;
        task.updatedAt = Date.now();
        changes.push(`Updated task: ${task.title} (${mod.changes.join(', ')})`);
      }
    }

    // Add tasks for new requirements
    for (const req of specDiff.added) {
      const now = Date.now();
      const newTask: TaskNode = {
        id: crypto.randomUUID(),
        title: req.description,
        description: this.buildTaskDescription(req),
        type: this.mapReqType(req.type),
        priority: req.priority,
        status: 'pending',
        specRequirementId: req.id,
        tags: [req.type, req.priority],
        createdAt: now,
        updatedAt: now,
      };
      graph.nodes.set(newTask.id, newTask);
      graph.rootNodes.push(newTask.id);
      changes.push(`Added task: ${newTask.title}`);
    }

    graph.updatedAt = Date.now();
    return { graph, changes };
  }

  private compareRequirements(old: SpecRequirement, current: SpecRequirement): string[] {
    const changes: string[] = [];
    if (old.description !== current.description) changes.push('description');
    if (old.priority !== current.priority) changes.push('priority');
    if (old.type !== current.type) changes.push('type');
    if (JSON.stringify(old.acceptanceCriteria) !== JSON.stringify(current.acceptanceCriteria)) {
      changes.push('acceptance criteria');
    }
    if (JSON.stringify(old.blockedBy) !== JSON.stringify(current.blockedBy)) {
      changes.push('dependencies');
    }
    return changes;
  }

  private buildTaskDescription(req: SpecRequirement): string {
    const lines = [req.description, '', `**Type:** ${req.type}`, `**Priority:** ${req.priority}`];
    if (req.acceptanceCriteria.length > 0) {
      lines.push('', '**Acceptance Criteria:**');
      for (const ac of req.acceptanceCriteria) {
        lines.push(`- ${ac}`);
      }
    }
    return lines.join('\n');
  }

  private mapReqType(type: SpecRequirement['type']): TaskNode['type'] {
    switch (type) {
      case 'functional':
        return 'feature';
      case 'non-functional':
        return 'feature';
      case 'security':
        return 'feature';
      case 'performance':
        return 'feature';
      case 'ux':
        return 'feature';
      default:
        return assertNever(type);
    }
  }
}
