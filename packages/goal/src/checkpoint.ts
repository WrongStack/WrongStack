import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import type { PhaseStore } from './phase-store.js';
import type { PhaseGraph, PhaseNode } from './types.js';

export interface Checkpoint {
  id: string;
  graphId: string;
  phaseId: string;
  phaseStatus: PhaseNode['status'];
  taskStatuses: Array<{ taskId: string; status: string; title: string }>;
  timestamp: number;
  label?: string | undefined;
}

export interface CheckpointManagerOptions {
  store: PhaseStore;
  maxCheckpoints?: number | undefined;
  /** Max age in ms before a checkpoint is eligible for TTL-based pruning. Default: 7 days. */
  maxCheckpointAgeMs?: number | undefined;
  baseDir?: string | undefined;
}

interface SerializedCheckpoint {
  id: string;
  graphId: string;
  phaseId: string;
  phaseStatus: PhaseNode['status'];
  taskStatuses: Array<{ taskId: string; status: string; title: string }>;
  timestamp: number;
  label?: string | undefined;
}

/**
 * CheckpointManager - saves and restores snapshots of the phase graph.
 *
 * Usage:
 *   const cm = new CheckpointManager({ store });
 *   await cm.saveCheckpoint(graph, 'Before risky refactor');
 *   // ... if something goes wrong ...
 *   const restored = await cm.restoreCheckpoint(checkpointId);
 */
export class CheckpointManager {
  private store: PhaseStore;
  private maxCheckpoints: number;
  private maxCheckpointAgeMs: number;
  private checkpoints = new Map<string, Checkpoint>();
  private baseDir: string;
  private loadedFromDisk = false;

  constructor(opts: CheckpointManagerOptions) {
    this.store = opts.store;
    this.maxCheckpoints = opts.maxCheckpoints ?? 10;
    this.maxCheckpointAgeMs = opts.maxCheckpointAgeMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.baseDir = opts.baseDir ?? path.join(opts.store.baseDir, '.checkpoints');
    // Directory creation is lazy — happens on first save
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    await this.loadFromDisk();
  }

  async saveCheckpoint(graph: PhaseGraph, label?: string): Promise<Checkpoint> {
    if (!this.loadedFromDisk) {
      await this.loadFromDisk();
    }
    // Save the graph first.
    await this.store.save(graph);

    // Extract checkpoint information from the active phase (falling back to the root phase).
    const activePhase =
      Array.from(graph.phases.values()).find(
        (p) => p.status === 'running' || p.status === 'paused',
      ) ?? (graph.rootPhaseIds[0] ? graph.phases.get(graph.rootPhaseIds[0]) : undefined);

    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      graphId: graph.id,
      phaseId: activePhase?.id ?? graph.rootPhaseIds[0] ?? '',
      phaseStatus: activePhase?.status ?? 'pending',
      taskStatuses: activePhase
        ? Array.from(activePhase.taskGraph.nodes.values()).map((t) => ({
            taskId: t.id,
            status: t.status,
            title: t.title,
          }))
        : [],
      timestamp: Date.now(),
      label,
    };

    // Save to disk before updating in-memory state.
    await this.saveToDisk(checkpoint);
    this.checkpoints.set(checkpoint.id, checkpoint);

    // Clean up old checkpoints for this graph only.
    await this.pruneCheckpoints(graph.id);

    return checkpoint;
  }

  async restoreCheckpoint(checkpointId: string): Promise<PhaseGraph | null> {
    let checkpoint = this.checkpoints.get(checkpointId);

    // Load from disk if the checkpoint is not in memory.
    if (!checkpoint) {
      await this.loadFromDisk();
      checkpoint = this.checkpoints.get(checkpointId);
    }

    if (!checkpoint) return null;

    const graph = await this.store.load(checkpoint.graphId);
    if (!graph) return null;

    const clearIntegrationMeta = (target: PhaseNode): void => {
      if (!target.metadata) return;
      const nextMeta = { ...target.metadata };
      delete nextMeta['integrationStatus'];
      delete nextMeta['integrationBranch'];
      delete nextMeta['integrationWorktreeDir'];
      delete nextMeta['integrationConflictFiles'];
      delete nextMeta['integrationError'];
      delete nextMeta['integrationUpdatedAt'];
      target.metadata = Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
    };

    // Restore the phase status from the checkpoint.
    const now = Date.now();
    const phase = graph.phases.get(checkpoint.phaseId);
    if (phase) {
      phase.status = checkpoint.phaseStatus;
      phase.updatedAt = now;
      if (checkpoint.phaseStatus !== 'completed' && checkpoint.phaseStatus !== 'failed') {
        phase.completedAt = undefined;
      }
      if (checkpoint.phaseStatus !== 'completed') {
        clearIntegrationMeta(phase);
      }
      if (checkpoint.phaseStatus === 'pending') {
        phase.startedAt = undefined;
        phase.actualDurationMs = undefined;
      }

      // Remove tasks added to this phase after the checkpoint was captured.
      const allowedTaskIds = new Set(checkpoint.taskStatuses.map((ts) => ts.taskId));
      for (const existingTaskId of [...phase.taskGraph.nodes.keys()]) {
        if (!allowedTaskIds.has(existingTaskId)) {
          phase.taskGraph.nodes.delete(existingTaskId);
        }
      }
      phase.taskGraph.rootNodes = phase.taskGraph.rootNodes.filter((id) => allowedTaskIds.has(id));
      phase.taskGraph.edges = phase.taskGraph.edges.filter(
        (e) => allowedTaskIds.has(e.from) && allowedTaskIds.has(e.to),
      );
      for (const survivingTask of phase.taskGraph.nodes.values()) {
        if (survivingTask.children) {
          const filteredChildren = survivingTask.children.filter((id) => allowedTaskIds.has(id));
          survivingTask.children = filteredChildren.length > 0 ? filteredChildren : undefined;
        }
        if (survivingTask.parentId && !allowedTaskIds.has(survivingTask.parentId)) {
          survivingTask.parentId = undefined;
          if (!phase.taskGraph.rootNodes.includes(survivingTask.id)) {
            phase.taskGraph.rootNodes.push(survivingTask.id);
          }
        }
      }

      // Restore task statuses.
      for (const ts of checkpoint.taskStatuses) {
        const task = phase.taskGraph.nodes.get(ts.taskId);
        if (task) {
          task.status = ts.status as import('@wrongstack/contracts/types/task-graph').TaskStatus;
          task.updatedAt = now;
          if (task.status !== 'completed' && task.status !== 'failed') {
            task.completedAt = undefined;
          }
          if (task.status === 'pending') {
            task.startedAt = undefined;
          }
        }
      }

      // If the restored phase is not completed/skipped, reset any downstream phases that transitively depend on it.
      if (checkpoint.phaseStatus !== 'completed' && checkpoint.phaseStatus !== 'skipped') {
        const invalidatedPhaseIds = new Set<string>([checkpoint.phaseId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of graph.phases.values()) {
            if (invalidatedPhaseIds.has(candidate.id)) continue;
            if (candidate.dependsOn.some((depId) => invalidatedPhaseIds.has(depId))) {
              invalidatedPhaseIds.add(candidate.id);
              changed = true;
            }
          }
        }
        invalidatedPhaseIds.delete(checkpoint.phaseId);
        for (const depPhaseId of invalidatedPhaseIds) {
          const depPhase = graph.phases.get(depPhaseId);
          if (!depPhase || depPhase.status === 'pending') continue;
          depPhase.status = 'pending';
          depPhase.startedAt = undefined;
          depPhase.completedAt = undefined;
          depPhase.actualDurationMs = undefined;
          depPhase.updatedAt = now;
          clearIntegrationMeta(depPhase);
          for (const task of depPhase.taskGraph.nodes.values()) {
            task.status = 'pending';
            task.startedAt = undefined;
            task.completedAt = undefined;
            task.updatedAt = now;
          }
          depPhase.taskGraph.updatedAt = now;
        }
      }
    }

    const allPhases = Array.from(graph.phases.values());
    graph.completedPhaseIds = allPhases.filter((p) => p.status === 'completed').map((p) => p.id);
    graph.failedPhaseIds = allPhases.filter((p) => p.status === 'failed').map((p) => p.id);
    graph.activePhaseIds = allPhases.filter((p) => p.status === 'running').map((p) => p.id);
    if (
      allPhases.length === 0 ||
      !allPhases.every((p) => p.status === 'completed' || p.status === 'skipped')
    ) {
      graph.completedAt = undefined;
      graph.finalVerification = undefined;
    }
    if (graph.failedPhaseIds.length === 0 && graph.runState === 'failed') {
      graph.runState =
        checkpoint.phaseStatus === 'running'
          ? 'running'
          : checkpoint.phaseStatus === 'paused'
            ? 'paused'
            : undefined;
      graph.runError = undefined;
    }

    graph.updatedAt = now;
    await this.store.save(graph);
    return graph;
  }

  listCheckpoints(graphId?: string): Checkpoint[] {
    const all = Array.from(this.checkpoints.values());
    const filtered = graphId ? all.filter((c) => c.graphId === graphId) : all;
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  }

  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    if (!this.checkpoints.has(checkpointId) && !this.loadedFromDisk) {
      await this.loadFromDisk();
    }
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return false;

    this.checkpoints.delete(checkpointId);
    // Await disk deletion to avoid split-brain between memory and disk
    await this.deleteFromDisk(checkpointId);
    return true;
  }

  private async saveToDisk(checkpoint: Checkpoint): Promise<void> {
    const filePath = path.join(this.baseDir, `${checkpoint.graphId}.json`);
    const serialized: SerializedCheckpoint = {
      ...checkpoint,
    };

    await withFileLock(filePath, async () => {
      // Read current on-disk state first
      let existing: SerializedCheckpoint[] = [];
      try {
        const raw = await fsp.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          existing = parsed as SerializedCheckpoint[];
        }
      } catch {
        // File doesn't exist or is invalid — start fresh
      }

      // Write to disk BEFORE updating in-memory state — ensures consistency
      existing.push(serialized);
      await atomicWrite(filePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    });
  }

  private async deleteFromDisk(checkpointId: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.baseDir);
    } catch {
      return; // Directory doesn't exist — nothing to delete
    }

    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;

      const filePath = path.join(this.baseDir, filename);
      try {
        await withFileLock(filePath, async () => {
          const raw = await fsp.readFile(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return;
          const existing = parsed as SerializedCheckpoint[];
          const filtered = existing.filter((c) => c.id !== checkpointId);

          if (filtered.length !== existing.length) {
            if (filtered.length === 0) {
              await fsp.unlink(filePath);
            } else {
              await atomicWrite(filePath, JSON.stringify(filtered, null, 2), { mode: 0o600 });
            }
          }
        });
      } catch {
        // Skip invalid files
      }
    }
  }

  private async loadFromDisk(): Promise<void> {
    this.loadedFromDisk = true;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.baseDir);
    } catch {
      // Directory doesn't exist yet — nothing to load
      return;
    }

    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;

      const filePath = path.join(this.baseDir, filename);
      try {
        const raw = await fsp.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        const checkpoints = parsed as SerializedCheckpoint[];

        for (const sc of checkpoints) {
          const checkpoint: Checkpoint = {
            id: sc.id,
            graphId: sc.graphId,
            phaseId: sc.phaseId,
            phaseStatus: sc.phaseStatus,
            taskStatuses: sc.taskStatuses,
            timestamp: sc.timestamp,
            label: sc.label,
          };
          this.checkpoints.set(checkpoint.id, checkpoint);
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  private async pruneCheckpoints(graphId: string): Promise<void> {
    const now = Date.now();
    const graphCheckpoints = Array.from(this.checkpoints.values())
      .filter((checkpoint) => checkpoint.graphId === graphId)
      .sort((a, b) => a.timestamp - b.timestamp);

    // TTL-based pruning: evict checkpoints older than maxCheckpointAgeMs.
    for (const cp of graphCheckpoints) {
      if (now - cp.timestamp > this.maxCheckpointAgeMs) {
        this.checkpoints.delete(cp.id);
        await this.deleteFromDisk(cp.id);
      }
    }

    // Count-based pruning: keep only the newest maxCheckpoints.
    const remaining = Array.from(this.checkpoints.values())
      .filter((checkpoint) => checkpoint.graphId === graphId)
      .sort((a, b) => a.timestamp - b.timestamp);
    while (remaining.length > this.maxCheckpoints) {
      const oldest = remaining.shift();
      if (oldest) {
        this.checkpoints.delete(oldest.id);
        await this.deleteFromDisk(oldest.id);
      }
    }
  }
}
