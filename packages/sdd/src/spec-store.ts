import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, ensureDir } from '@wrongstack/core/utils';
import type { Specification, SpecStatus } from '@wrongstack/core/types';

export interface SpecStoreOptions {
  /** Directory where spec files are stored. Defaults to `.wrongstack/specs`. */
  baseDir: string;
}

export interface SpecIndexEntry {
  id: string;
  title: string;
  version: string;
  status: SpecStatus;
  updatedAt: number;
  filePath: string;
}

interface SpecIndex {
  version: 1;
  entries: SpecIndexEntry[];
}

/**
 * File-backed spec storage. Each spec is a JSON file under `baseDir/`.
 * An index file (`_index.json`) tracks all specs for fast listing.
 */
export class SpecStore {
  private readonly baseDir: string;
  private readonly indexPath: string;

  constructor(opts: SpecStoreOptions) {
    this.baseDir = opts.baseDir;
    this.indexPath = path.join(this.baseDir, '_index.json');
  }

  async save(spec: Specification): Promise<void> {
    await ensureDir(this.baseDir);
    const filePath = this.filePath(spec.id);
    await atomicWrite(filePath, JSON.stringify(spec, null, 2), { mode: 0o600 });
    await this.updateIndex(spec);
  }

  async load(id: string): Promise<Specification | null> {
    // Resolve the path OUTSIDE the read try/catch so a containment
    // failure (H-6 regression) propagates as a caller-visible error
    // instead of being silently coerced to "not found".
    const filePath = this.filePath(id);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      return JSON.parse(raw) as Specification;
    } catch {
      return null;
    }
  }

  async list(): Promise<SpecIndexEntry[]> {
    const index = await this.readIndex();
    return index.entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string): Promise<boolean> {
    // Same separation as `load`: validate the id first, then handle the
    // I/O errors that mean "this id is not present" as a clean false.
    const filePath = this.filePath(id);
    try {
      await fsp.unlink(filePath);
      await this.removeFromIndex(id);
      return true;
    } catch {
      return false;
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fsp.access(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Create a new spec with defaults, assign ID, and persist. */
  async createDraft(title: string, overview?: string): Promise<Specification> {
    const now = Date.now();
    const spec: Specification = {
      id: randomUUID(),
      title,
      version: '0.1.0',
      status: 'draft',
      overview: overview ?? '',
      sections: [],
      requirements: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.save(spec);
    return spec;
  }

  /** Update spec fields and persist. */
  async update(
    id: string,
    patch: Partial<Omit<Specification, 'id' | 'createdAt'>>,
  ): Promise<Specification | null> {
    const spec = await this.load(id);
    if (!spec) return null;
    const updated: Specification = {
      ...spec,
      ...patch,
      id: spec.id,
      createdAt: spec.createdAt,
      updatedAt: Date.now(),
    };
    await this.save(updated);
    return updated;
  }

  /**
   * Resolve a spec id to its file, refusing anything that escapes `baseDir`.
   * `id` arrives from a WebSocket frame (`specs-ws-handler.ts:96-97,152`,
   * raw `as string` casts) and from any persisted spec JSON. A bare
   * `path.join` was the traversal primitive: `id = "../../../secret"`
   * resolved outside the store and `load()` returned its contents. Mirrors
   * the same containment `task-graph-store.ts:134-145` applies to its ids.
   */
  private filePath(id: string): string {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200 || /[\0/\\]/.test(id)) {
      throw new Error(`Invalid spec id: ${JSON.stringify(id)}`);
    }
    const dir = path.resolve(this.baseDir);
    const resolved = path.resolve(dir, `${id}.json`);
    const rel = path.relative(dir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw new Error(`Invalid spec id: ${JSON.stringify(id)}`);
    }
    return resolved;
  }

  private async readIndex(): Promise<SpecIndex> {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as SpecIndex;
      if (parsed?.version === 1) return parsed;
    } catch {
      /* no index yet */
    }
    return { version: 1, entries: [] };
  }

  private async updateIndex(spec: Specification): Promise<void> {
    const index = await this.readIndex();
    const entry: SpecIndexEntry = {
      id: spec.id,
      title: spec.title,
      version: spec.version,
      status: spec.status,
      updatedAt: spec.updatedAt,
      filePath: this.filePath(spec.id),
    };
    const idx = index.entries.findIndex((e) => e.id === spec.id);
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
