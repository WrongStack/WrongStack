import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskEdge, TaskGraph, TaskNode } from '../types/task-graph.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import type { PhaseGraph, PhaseNode } from './types.js';

export interface PhaseStoreOptions {
  baseDir: string;
  /** Previous directories read and migrated into baseDir on load/list. */
  legacyBaseDirs?: string[] | undefined;
}

/** Current schema version for SerializedPhaseGraph. Increment on breaking changes. */
const PHASE_STORE_VERSION = 1;

interface SerializedPhaseGraph {
  /** Schema version for forward-compatibility. Missing/0 means pre-v1. */
  version: number;
  id: string;
  title: string;
  description: string;
  phases: SerializedPhaseNode[];
  rootPhaseIds: string[];
  activePhaseIds: string[];
  completedPhaseIds: string[];
  failedPhaseIds: string[];
  autonomous: boolean;
  stopOnComplete: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
}

interface SerializedPhaseNode {
  id: string;
  name: string;
  description: string;
  status: PhaseNode['status'];
  taskGraph: SerializedTaskGraph;
  dependsOn: string[];
  nextPhases: string[];
  parallelizable: boolean;
  priority: PhaseNode['priority'];
  estimateHours: number;
  actualDurationMs?: number | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  assignedAgents: string[];
  metadata?: Record<string, unknown> | undefined;
  createdAt: number;
  updatedAt: number;
}

interface SerializedTaskGraph {
  id: string;
  specId: string;
  title: string;
  nodes: SerializedTaskNode[];
  edges: TaskEdge[];
  rootNodes: string[];
  createdAt: number;
  updatedAt: number;
}

interface SerializedTaskNode {
  id: string;
  title: string;
  description: string;
  type: TaskNode['type'];
  priority: TaskNode['priority'];
  status: TaskNode['status'];
  assignee?: string | undefined;
  estimateHours?: number | undefined;
  actualHours?: number | undefined;
  tags?: string[] | undefined;
  specRequirementId?: string | undefined;
  parentId?: string | undefined;
  children?: string[] | undefined;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * PhaseStore - persistence layer for saving and loading PhaseGraph objects on disk.
 */
export class PhaseStore {
  readonly baseDir: string;
  private readonly legacyBaseDirs: string[];

  constructor(opts: PhaseStoreOptions) {
    this.baseDir = opts.baseDir;
    this.legacyBaseDirs = (opts.legacyBaseDirs ?? []).filter(
      (dir) => path.resolve(dir) !== path.resolve(this.baseDir),
    );
  }

  async save(graph: PhaseGraph): Promise<void> {
    const filePath = this.getFilePath(graph.id);
    const serialized = this.serializeGraph(graph);

    await withFileLock(filePath, async () => {
      await atomicWrite(filePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
    });
  }

  async load(graphId: string): Promise<PhaseGraph | null> {
    const filePath = this.getFilePath(graphId);
    const current = await this.loadFromPath(filePath);
    if (current) return current;
    for (const legacyDir of this.legacyBaseDirs) {
      const legacyPath = path.join(legacyDir, `${graphId}.json`);
      const legacy = await this.loadFromPath(legacyPath);
      if (!legacy) continue;
      try {
        await this.save(legacy);
        await this.removeMigratedLegacyFile(legacyDir, legacyPath);
      } catch {
        return null;
      }
      return legacy;
    }
    return null;
  }

  async delete(graphId: string): Promise<void> {
    const paths = [
      this.getFilePath(graphId),
      ...this.legacyBaseDirs.map((dir) => path.join(dir, `${graphId}.json`)),
    ];
    await Promise.all(paths.map((filePath) => fsp.unlink(filePath).catch(() => undefined)));
  }

  async list(): Promise<Array<{ id: string; title: string; updatedAt: number; status: string }>> {
    try {
      await this.migrateLegacyGraphs();
      const entries = await fsp.readdir(this.baseDir, { withFileTypes: true });
      const graphs: Array<{ id: string; title: string; updatedAt: number; status: string }> = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const raw = await fsp.readFile(path.join(this.baseDir, entry.name), 'utf8');
          const serialized = JSON.parse(raw) as SerializedPhaseGraph;
          const done = serialized.completedPhaseIds.length;
          const total = serialized.phases.length;
          graphs.push({
            id: serialized.id,
            title: serialized.title,
            updatedAt: serialized.updatedAt,
            status: done === total ? 'completed' : done > 0 ? 'in_progress' : 'pending',
          });
        } catch {
          // Skip invalid files
        }
      }

      return graphs.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  private getFilePath(graphId: string): string {
    return path.join(this.baseDir, `${graphId}.json`);
  }

  private async loadFromPath(filePath: string): Promise<PhaseGraph | null> {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const serialized = JSON.parse(raw) as SerializedPhaseGraph;
      return this.deserializeGraph(serialized);
    } catch {
      return null;
    }
  }

  private async migrateLegacyGraphs(): Promise<void> {
    for (const legacyDir of this.legacyBaseDirs) {
      const entries = await fsp.readdir(legacyDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const legacyPath = path.join(legacyDir, entry.name);
        const currentPath = this.getFilePath(path.basename(entry.name, '.json'));
        if (await this.pathExists(currentPath)) {
          await this.removeMigratedLegacyFile(legacyDir, legacyPath);
          continue;
        }
        const graph = await this.loadFromPath(legacyPath);
        if (!graph) continue;
        await this.save(graph);
        await this.removeMigratedLegacyFile(legacyDir, legacyPath);
      }
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async removeMigratedLegacyFile(legacyDir: string, legacyPath: string): Promise<void> {
    await fsp.unlink(legacyPath).catch(() => undefined);
    await fsp.rmdir(legacyDir).catch(() => undefined);
  }

  private serializeGraph(graph: PhaseGraph): SerializedPhaseGraph {
    return {
      version: PHASE_STORE_VERSION,
      id: graph.id,
      title: graph.title,
      description: graph.description,
      phases: Array.from(graph.phases.values()).map((p) => this.serializePhase(p)),
      rootPhaseIds: graph.rootPhaseIds,
      activePhaseIds: graph.activePhaseIds,
      completedPhaseIds: graph.completedPhaseIds,
      failedPhaseIds: graph.failedPhaseIds,
      autonomous: graph.autonomous,
      stopOnComplete: graph.stopOnComplete,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
      startedAt: graph.startedAt,
      completedAt: graph.completedAt,
    };
  }

  private serializePhase(phase: PhaseNode): SerializedPhaseNode {
    return {
      id: phase.id,
      name: phase.name,
      description: phase.description,
      status: phase.status,
      taskGraph: this.serializeTaskGraph(phase.taskGraph),
      dependsOn: phase.dependsOn,
      nextPhases: phase.nextPhases,
      parallelizable: phase.parallelizable,
      priority: phase.priority,
      estimateHours: phase.estimateHours,
      actualDurationMs: phase.actualDurationMs,
      startedAt: phase.startedAt,
      completedAt: phase.completedAt,
      assignedAgents: phase.assignedAgents,
      metadata: phase.metadata,
      createdAt: phase.createdAt,
      updatedAt: phase.updatedAt,
    };
  }

  private serializeTaskGraph(graph: TaskGraph): SerializedTaskGraph {
    return {
      id: graph.id,
      specId: graph.specId,
      title: graph.title,
      nodes: Array.from(graph.nodes.values()).map((n) => this.serializeTaskNode(n)),
      edges: graph.edges,
      rootNodes: graph.rootNodes,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
    };
  }

  private serializeTaskNode(node: TaskNode): SerializedTaskNode {
    return { ...node };
  }

  private deserializeGraph(serialized: SerializedPhaseGraph): PhaseGraph {
    // Validate schema version for forward-compatibility.
    const fileVersion = serialized.version ?? 0;
    if (fileVersion > PHASE_STORE_VERSION) {
      throw new Error(
        `Cannot load phase graph: file version ${fileVersion} is newer than ` +
          `supported version ${PHASE_STORE_VERSION}. Upgrade WrongStack to load this file.`,
      );
    }
    // Future: add per-version migration logic here when fileVersion < PHASE_STORE_VERSION.
    const phases = new Map<string, PhaseNode>();
    for (const sp of serialized.phases) {
      phases.set(sp.id, this.deserializePhase(sp));
    }

    return {
      id: serialized.id,
      title: serialized.title,
      description: serialized.description,
      phases,
      rootPhaseIds: serialized.rootPhaseIds,
      activePhaseIds: serialized.activePhaseIds,
      completedPhaseIds: serialized.completedPhaseIds,
      failedPhaseIds: serialized.failedPhaseIds,
      autonomous: serialized.autonomous,
      stopOnComplete: serialized.stopOnComplete,
      createdAt: serialized.createdAt,
      updatedAt: serialized.updatedAt,
      startedAt: serialized.startedAt,
      completedAt: serialized.completedAt,
    };
  }

  private deserializePhase(serialized: SerializedPhaseNode): PhaseNode {
    return {
      id: serialized.id,
      name: serialized.name,
      description: serialized.description,
      status: serialized.status,
      taskGraph: this.deserializeTaskGraph(serialized.taskGraph),
      dependsOn: serialized.dependsOn,
      nextPhases: serialized.nextPhases,
      parallelizable: serialized.parallelizable,
      priority: serialized.priority,
      estimateHours: serialized.estimateHours,
      actualDurationMs: serialized.actualDurationMs,
      startedAt: serialized.startedAt,
      completedAt: serialized.completedAt,
      assignedAgents: serialized.assignedAgents,
      metadata: serialized.metadata,
      createdAt: serialized.createdAt,
      updatedAt: serialized.updatedAt,
    };
  }

  private deserializeTaskGraph(serialized: SerializedTaskGraph): TaskGraph {
    const nodes = new Map<string, TaskNode>();
    for (const sn of serialized.nodes) {
      nodes.set(sn.id, sn as TaskNode);
    }

    return {
      id: serialized.id,
      specId: serialized.specId,
      title: serialized.title,
      nodes,
      edges: serialized.edges ?? [],
      rootNodes: serialized.rootNodes ?? [],
      createdAt: serialized.createdAt,
      updatedAt: serialized.updatedAt,
    };
  }
}
