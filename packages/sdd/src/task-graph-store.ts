import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskStore } from '@wrongstack/core/tasking';
import type { TaskGraph, TaskNode } from '@wrongstack/core/types';
import { atomicWrite, ensureDir } from '@wrongstack/core/utils';

export interface TaskGraphStoreOptions {
  /** Directory where task graph files are stored. Defaults to `.wrongstack/task-graphs`. */
  baseDir: string;
}

export interface TaskGraphIndexEntry {
  id: string;
  specId: string;
  title: string;
  nodeCount: number;
  completedCount: number;
  updatedAt: number;
  filePath: string;
}

interface TaskGraphIndex {
  version: 1;
  entries: TaskGraphIndexEntry[];
}

/**
 * JSON serialisation helpers for TaskGraph (Map → Array round-trip).
 */
function graphToJSON(graph: TaskGraph): string {
  const serialisable = {
    ...graph,
    nodes: Array.from(graph.nodes.entries()),
  };
  return JSON.stringify(serialisable, null, 2);
}

function graphFromJSON(raw: string): TaskGraph {
  const parsed = JSON.parse(raw) as Omit<TaskGraph, 'nodes'> & { nodes: [string, TaskNode][] };
  return {
    ...parsed,
    nodes: new Map(parsed.nodes),
  };
}

/**
 * File-backed task graph storage. Each graph is a JSON file under `baseDir/`.
 * An index file (`_index.json`) tracks all graphs for fast listing.
 */
export class TaskGraphStore implements TaskStore {
  private readonly baseDir: string;
  private readonly indexPath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: TaskGraphStoreOptions) {
    this.baseDir = opts.baseDir;
    this.indexPath = path.join(this.baseDir, '_index.json');
  }

  async save(graph: TaskGraph): Promise<void> {
    const snapshot = graphFromJSON(graphToJSON(graph));
    const pending = this.writeChain.then(async () => {
      await ensureDir(this.baseDir);
      const filePath = this.filePath(snapshot.id);
      await atomicWrite(filePath, graphToJSON(snapshot), { mode: 0o600 });
      await this.updateIndex(snapshot);
    });
    this.writeChain = pending.catch(() => undefined);
    await pending;
  }

  async load(id: string): Promise<TaskGraph | null> {
    await this.writeChain;
    try {
      const raw = await fsp.readFile(this.filePath(id), 'utf8');
      return graphFromJSON(raw);
    } catch {
      return null;
    }
  }

  async list(): Promise<TaskGraphIndexEntry[]> {
    await this.writeChain;
    const index = await this.readIndex();
    return index.entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string): Promise<boolean> {
    await this.writeChain;
    try {
      await fsp.unlink(this.filePath(id));
      await this.removeFromIndex(id);
      return true;
    } catch {
      return false;
    }
  }

  async exists(id: string): Promise<boolean> {
    await this.writeChain;
    try {
      await fsp.access(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  saveGraph(graph: TaskGraph): Promise<void> {
    return this.save(graph);
  }

  loadGraph(id: string): Promise<TaskGraph | null> {
    return this.load(id);
  }

  async listGraphs(): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    return (await this.list()).map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  async deleteGraph(id: string): Promise<void> {
    await this.delete(id);
  }

  /**
   * Resolve a graph id to its file, refusing anything that escapes `baseDir`.
   *
   * `id` arrives straight from a WebSocket payload (`specs.taskStatus` casts it
   * with no validation), and this used to be a bare `path.join` — so
   * `../../../Users/me/secret` resolved outside the store and `load()` returned
   * its contents to the caller. Mirrors the containment `kanban/storage.ts`
   * already applies to board ids.
   */
  private filePath(id: string): string {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200 || /[\0]/.test(id)) {
      throw new Error(`Invalid task-graph id: ${JSON.stringify(id)}`);
    }
    const dir = path.resolve(this.baseDir);
    const resolved = path.resolve(dir, `${id}.json`);
    const rel = path.relative(dir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw new Error(`Invalid task-graph id: ${JSON.stringify(id)}`);
    }
    return resolved;
  }

  private async readIndex(): Promise<TaskGraphIndex> {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as TaskGraphIndex;
      if (parsed?.version === 1) return parsed;
    } catch {
      /* no index yet */
    }
    return { version: 1, entries: [] };
  }

  private async updateIndex(graph: TaskGraph): Promise<void> {
    const index = await this.readIndex();
    const completedCount = Array.from(graph.nodes.values()).filter(
      (n) => n.status === 'completed',
    ).length;
    const entry: TaskGraphIndexEntry = {
      id: graph.id,
      specId: graph.specId,
      title: graph.title,
      nodeCount: graph.nodes.size,
      completedCount,
      updatedAt: graph.updatedAt,
      filePath: this.filePath(graph.id),
    };
    const idx = index.entries.findIndex((e) => e.id === graph.id);
    if (idx >= 0) {
      index.entries[idx] = entry;
    } else {
      index.entries.push(entry);
    }
    await atomicWrite(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  }

  private async removeFromIndex(id: string): Promise<void> {
    const index = await this.readIndex();
    index.entries = index.entries.filter((e) => e.id !== id);
    await atomicWrite(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  }
}
