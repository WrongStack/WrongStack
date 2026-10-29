import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskEdge, TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import { type GoalSummary, summarizeGoal } from './goal-summary.js';
import type { PhaseGraph, PhaseNode } from './types.js';

export interface PhaseStoreOptions {
  baseDir: string;
  /** Previous directories read and migrated into baseDir on load/list. */
  legacyBaseDirs?: string[] | undefined;
}

/** Current schema version for SerializedPhaseGraph. Increment on breaking changes. */
const PHASE_STORE_VERSION = 1;
const RUN_LEASE_FILE = '.active-run.lock';
const INCOMPLETE_LEASE_GRACE_MS = 30_000;

interface SerializedRunLease {
  ownerId: string;
  pid: number;
  acquiredAt: string;
}

export class GoalRunLeaseBusyError extends Error {
  constructor(readonly ownerId?: string | undefined) {
    super(
      ownerId
        ? `Another Goal run already owns this project (${ownerId}).`
        : 'Another Goal run already owns this project.',
    );
    this.name = 'GoalRunLeaseBusyError';
  }
}

interface SerializedPhaseGraph {
  /** Schema version for forward-compatibility. Missing/0 means pre-v1. */
  version: number;
  id: string;
  sessionId?: string | undefined;
  runState?: PhaseGraph['runState'];
  leaseScope?: PhaseGraph['leaseScope'];
  runError?: PhaseGraph['runError'];
  workspace?: PhaseGraph['workspace'];
  title: string;
  description: string;
  phases: SerializedPhaseNode[];
  rootPhaseIds: string[];
  activePhaseIds: string[];
  completedPhaseIds: string[];
  failedPhaseIds: string[];
  autonomous: boolean;
  stopOnComplete: boolean;
  multiBoard?: boolean | undefined;
  verifyTasks?: boolean | undefined;
  chimeraReview?: boolean | undefined;
  worktrees?: boolean | undefined;
  runBase?: PhaseGraph['runBase'];
  budget?: PhaseGraph['budget'];
  budgetUsage?: PhaseGraph['budgetUsage'];
  finalVerification?: PhaseGraph['finalVerification'];
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
  requiredRequirementIds?: string[] | undefined;
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

  /**
   * Acquire the one active Goal-run lease for this project/store.
   *
   * The lease is process-backed rather than time-only: a live PID keeps the
   * lease indefinitely, while a crashed process is reclaimed on the next
   * acquire. This prevents CLI and WebUI hosts from concurrently mutating the
   * same repository even though they own separate in-memory orchestrators.
   */
  async acquireRunLease(ownerId: string): Promise<() => Promise<void>> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    return withFileLock(path.join(this.baseDir, '.run-admission'), async () => {
      const leaseRoot = path.join(this.baseDir, '.goal-leases');
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsp.readdir(leaseRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entries = [];
      }
      for (const entry of entries) {
        if (entry.isDirectory())
          await this.assertLeaseInactive(path.join(leaseRoot, entry.name, RUN_LEASE_FILE));
      }
      return this.acquireLease(ownerId);
    });
  }

  private async assertLeaseInactive(leasePath: string): Promise<void> {
    const lease = await this.readRunLease(leasePath);
    if (lease) {
      if (this.isProcessAlive(lease.pid)) throw new GoalRunLeaseBusyError(lease.ownerId);
      return;
    }
    let stat: import('node:fs').Stats | null = null;
    try {
      stat = await fsp.stat(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    // Unparseable lease body (a writer crashed between the `wx` open and
    // writeFile): honor the same grace window as acquireLease, then self-heal
    // by unlinking so a torn write cannot permanently block admission.
    if (Date.now() - stat.mtimeMs < INCOMPLETE_LEASE_GRACE_MS) {
      throw new GoalRunLeaseBusyError('unknown lease owner');
    }
    await fsp.unlink(leasePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  private async acquireLease(ownerId: string): Promise<() => Promise<void>> {
    if (!ownerId.trim()) throw new Error('Goal run lease ownerId must not be empty.');
    await fsp.mkdir(this.baseDir, { recursive: true });
    const leasePath = path.join(this.baseDir, RUN_LEASE_FILE);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fsp.open(leasePath, 'wx', 0o600);
        const lease: SerializedRunLease = {
          ownerId,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        };
        try {
          await handle.writeFile(JSON.stringify(lease), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }

        let released = false;
        return async () => {
          if (released) return;
          released = true;
          const current = await this.readRunLease(leasePath).catch(() => null);
          if (current?.ownerId !== ownerId) return;
          await fsp.unlink(leasePath).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err;
          });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const current = await this.readRunLease(leasePath);
        if (current && this.isProcessAlive(current.pid)) {
          throw new GoalRunLeaseBusyError(current.ownerId);
        }
        if (!current) {
          const stat = await fsp.stat(leasePath).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs < INCOMPLETE_LEASE_GRACE_MS) {
            throw new GoalRunLeaseBusyError();
          }
        }
        await fsp.unlink(leasePath).catch((unlinkErr: NodeJS.ErrnoException) => {
          if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
        });
      }
    }
    throw new GoalRunLeaseBusyError();
  }

  async save(graph: PhaseGraph): Promise<void> {
    const filePath = this.getFilePath(graph.id);
    const serialized = this.serializeGraph(graph);

    await withFileLock(filePath, async () => {
      await atomicWrite(filePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
    });
  }

  /** Isolated goal checkouts can run concurrently, while one goal keeps one owner. */
  async acquireGoalRunLease(goalId: string, ownerId: string): Promise<() => Promise<void>> {
    const goalStore = this.goalLeaseStore(goalId);
    await fsp.mkdir(this.baseDir, { recursive: true });
    return withFileLock(path.join(this.baseDir, '.run-admission'), async () => {
      await this.assertLeaseInactive(path.join(this.baseDir, RUN_LEASE_FILE));
      return goalStore.acquireLease(ownerId);
    });
  }

  async listGoals(): Promise<GoalSummary[]> {
    const entries = await this.list();
    const summaries: GoalSummary[] = [];
    for (const entry of entries) {
      const graph = await this.load(entry.id);
      if (!graph) continue;
      summaries.push(summarizeGoal(graph, await this.goalRunOwner(graph)));
    }
    return summaries;
  }

  async goalRunOwner(graph: PhaseGraph): Promise<string | null> {
    const isolated = graph.workspace || graph.leaseScope === 'goal';
    const leaseStore = isolated ? this.goalLeaseStore(graph.id) : this;
    const leasePath = path.join(leaseStore.baseDir, RUN_LEASE_FILE);
    let lease: SerializedRunLease | null;
    try {
      lease = await this.readRunLease(leasePath);
    } catch {
      return 'unknown';
    }
    if (lease)
      return this.isProcessAlive(lease.pid) && (isolated || lease.ownerId.endsWith(`:${graph.id}`))
        ? lease.ownerId
        : null;
    try {
      await fsp.stat(leasePath);
      return 'unknown';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private goalLeaseStore(goalId: string): PhaseStore {
    this.getFilePath(goalId);
    const key = createHash('sha256').update(goalId).digest('hex');
    return new PhaseStore({ baseDir: path.join(this.baseDir, '.goal-leases', key) });
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
          const done = serialized.phases.filter(
            (phase) => phase.status === 'completed' || phase.status === 'skipped',
          ).length;
          const total = serialized.phases.length;
          const failed =
            serialized.finalVerification?.status === 'failed' ||
            serialized.phases.some((phase) => phase.status === 'failed');
          const running = serialized.phases.some((phase) => phase.status === 'running');
          // Finished phases are progress, not success: only a run that reached
          // completion (completedAt, set after final verification) is completed.
          const completed = total > 0 && done === total && serialized.completedAt !== undefined;
          graphs.push({
            id: serialized.id,
            title: serialized.title,
            updatedAt: serialized.updatedAt,
            status: failed
              ? 'failed'
              : completed
                ? 'completed'
                : running || done > 0
                  ? 'in_progress'
                  : 'pending',
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

  /**
   * Resolve a phase-graph id to its file, refusing anything that escapes
   * `baseDir`. `graphId` arrives from a WebSocket frame
   * (`goal-ws-handler.ts:254-256`, raw `as string` casts) and from any
   * persisted graph JSON. A bare `path.join` was the traversal primitive:
   * `graphId = "../../../secret"` resolved outside the store and
   * `loadGraph()` returned its contents (broadcast as `goal.state`).
   * Mirrors the same containment `task-graph-store.ts:134-145` applies
   * to its ids.
   */
  private getFilePath(graphId: string): string {
    if (
      typeof graphId !== 'string' ||
      graphId.length === 0 ||
      graphId.length > 200 ||
      /[\0/\\]/.test(graphId)
    ) {
      throw new Error(`Invalid phase-graph id: ${JSON.stringify(graphId)}`);
    }
    const dir = path.resolve(this.baseDir);
    const resolved = path.resolve(dir, `${graphId}.json`);
    const rel = path.relative(dir, resolved);
    if (
      rel === '..' ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel) ||
      rel.includes(path.sep)
    ) {
      throw new Error(`Invalid phase-graph id: ${JSON.stringify(graphId)}`);
    }
    return resolved;
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

  private async readRunLease(leasePath: string): Promise<SerializedRunLease | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(leasePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Unreadable right now (EBUSY/EPERM) is not a torn write: the stale-lease
      // path would unlink a live lease and admit a second run. Treat as held.
      throw new GoalRunLeaseBusyError();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SerializedRunLease>;
      if (
        typeof parsed.ownerId !== 'string' ||
        typeof parsed.pid !== 'number' ||
        !Number.isInteger(parsed.pid) ||
        typeof parsed.acquiredAt !== 'string'
      ) {
        return null;
      }
      return parsed as SerializedRunLease;
    } catch {
      return null;
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
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
      sessionId: graph.sessionId,
      runState: graph.runState,
      leaseScope: graph.leaseScope,
      runError: graph.runError,
      workspace: graph.workspace,
      title: graph.title,
      description: graph.description,
      phases: Array.from(graph.phases.values()).map((p) => this.serializePhase(p)),
      rootPhaseIds: graph.rootPhaseIds,
      activePhaseIds: graph.activePhaseIds,
      completedPhaseIds: graph.completedPhaseIds,
      failedPhaseIds: graph.failedPhaseIds,
      autonomous: graph.autonomous,
      stopOnComplete: graph.stopOnComplete,
      multiBoard: graph.multiBoard,
      verifyTasks: graph.verifyTasks,
      chimeraReview: graph.chimeraReview,
      worktrees: graph.worktrees,
      runBase: graph.runBase,
      budget: graph.budget,
      budgetUsage: graph.budgetUsage,
      finalVerification: graph.finalVerification,
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
      requiredRequirementIds: graph.requiredRequirementIds,
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
      sessionId: serialized.sessionId,
      runState: serialized.runState,
      leaseScope: serialized.leaseScope,
      runError: serialized.runError,
      workspace: serialized.workspace,
      title: serialized.title,
      description: serialized.description,
      phases,
      rootPhaseIds: serialized.rootPhaseIds,
      activePhaseIds: serialized.activePhaseIds,
      completedPhaseIds: serialized.completedPhaseIds,
      failedPhaseIds: serialized.failedPhaseIds,
      autonomous: serialized.autonomous,
      stopOnComplete: serialized.stopOnComplete,
      multiBoard: serialized.multiBoard,
      verifyTasks: serialized.verifyTasks,
      chimeraReview: serialized.chimeraReview,
      worktrees: serialized.worktrees,
      runBase: serialized.runBase,
      budget: serialized.budget,
      budgetUsage: serialized.budgetUsage,
      finalVerification: serialized.finalVerification,
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
      requiredRequirementIds: serialized.requiredRequirementIds,
      title: serialized.title,
      nodes,
      edges: serialized.edges ?? [],
      rootNodes: serialized.rootNodes ?? [],
      createdAt: serialized.createdAt,
      updatedAt: serialized.updatedAt,
    };
  }
}
