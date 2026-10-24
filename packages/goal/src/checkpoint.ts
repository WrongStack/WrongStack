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

    this.checkpoints.set(checkpoint.id, checkpoint);

    // Save to disk.
    await this.saveToDisk(checkpoint);

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

    // Restore the phase status from the checkpoint.
    const phase = graph.phases.get(checkpoint.phaseId);
    if (phase) {
      phase.status = checkpoint.phaseStatus;
      phase.updatedAt = Date.now();

      // Restore task statuses.
      for (const ts of checkpoint.taskStatuses) {
        const task = phase.taskGraph.nodes.get(ts.taskId);
        if (task) {
          task.status = ts.status as import('@wrongstack/contracts/types/task-graph').TaskStatus;
          task.updatedAt = Date.now();
        }
      }
    }

    graph.updatedAt = Date.now();
    return graph;
  }

  listCheckpoints(graphId?: string): Checkpoint[] {
    const all = Array.from(this.checkpoints.values());
    const filtered = graphId ? all.filter((c) => c.graphId === graphId) : all;
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  }

  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
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
