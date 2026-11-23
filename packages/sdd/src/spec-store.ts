import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SpecApiEndpoint,
  Specification,
  SpecRequirement,
  SpecSection,
  SpecStatus,
} from '@wrongstack/contracts/types';
import { atomicWrite, ensureDir, withFileLock } from '@wrongstack/core/utils';

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

const SPEC_STATUSES: ReadonlySet<string> = new Set<SpecStatus>([
  'draft',
  'review',
  'approved',
  'implemented',
  'deprecated',
]);
const SPEC_REQUIREMENT_TYPES: ReadonlySet<string> = new Set([
  'functional',
  'non-functional',
  'security',
  'performance',
  'ux',
]);
const SPEC_PRIORITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);
const SPEC_SECTION_TYPES: ReadonlySet<string> = new Set([
  'overview',
  'requirements',
  'architecture',
  'api',
  'data',
  'security',
  'acceptance',
]);
const SPEC_API_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSpecRequirement(value: unknown): value is SpecRequirement {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false;
  if (typeof value['type'] !== 'string' || !SPEC_REQUIREMENT_TYPES.has(value['type'])) return false;
  if (typeof value['priority'] !== 'string' || !SPEC_PRIORITIES.has(value['priority']))
    return false;
  if (typeof value['description'] !== 'string') return false;
  if (!isStringArray(value['acceptanceCriteria'])) return false;
  if (value['blockedBy'] !== undefined && !isStringArray(value['blockedBy'])) return false;
  if (value['implements'] !== undefined && !isStringArray(value['implements'])) return false;
  return true;
}

function isSpecSection(value: unknown, depth = 0): value is SpecSection {
  if (depth > 64 || !isRecord(value)) return false;
  if (typeof value['type'] !== 'string' || !SPEC_SECTION_TYPES.has(value['type'])) return false;
  if (typeof value['title'] !== 'string' || typeof value['content'] !== 'string') return false;
  if (typeof value['level'] !== 'number' || !Number.isFinite(value['level'])) return false;
  const children = value['children'];
  if (
    children !== undefined &&
    (!Array.isArray(children) || !children.every((child) => isSpecSection(child, depth + 1)))
  ) {
    return false;
  }
  return true;
}

function isSpecApiEndpoint(value: unknown): value is SpecApiEndpoint {
  if (!isRecord(value)) return false;
  if (typeof value['method'] !== 'string' || !SPEC_API_METHODS.has(value['method'])) return false;
  if (typeof value['path'] !== 'string' || typeof value['description'] !== 'string') return false;
  if (value['request'] !== undefined && !isRecord(value['request'])) return false;
  if (value['response'] !== undefined && !isRecord(value['response'])) return false;
  if (value['auth'] !== undefined && typeof value['auth'] !== 'boolean') return false;
  return true;
}

function isSpecification(value: unknown): value is Specification {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false;
  if (typeof value['title'] !== 'string' || typeof value['version'] !== 'string') return false;
  if (typeof value['status'] !== 'string' || !SPEC_STATUSES.has(value['status'])) return false;
  if (typeof value['overview'] !== 'string') return false;
  if (!Array.isArray(value['sections']) || !value['sections'].every((s) => isSpecSection(s)))
    return false;
  if (
    !Array.isArray(value['requirements']) ||
    !value['requirements'].every((r) => isSpecRequirement(r))
  )
    return false;
  if (
    value['apiEndpoints'] !== undefined &&
    (!Array.isArray(value['apiEndpoints']) || !value['apiEndpoints'].every(isSpecApiEndpoint))
  ) {
    return false;
  }
  if (value['dependencies'] !== undefined && !isStringArray(value['dependencies'])) return false;
  if (typeof value['createdAt'] !== 'number' || !Number.isFinite(value['createdAt'])) return false;
  if (typeof value['updatedAt'] !== 'number' || !Number.isFinite(value['updatedAt'])) return false;
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) return false;
  return true;
}

/**
 * File-backed spec storage. Each spec is a JSON file under `baseDir/`.
 * An index file (`_index.json`) tracks all specs for fast listing.
 */
export class SpecStore {
  private readonly baseDir: string;
  private readonly indexPath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: SpecStoreOptions) {
    this.baseDir = opts.baseDir;
    this.indexPath = path.join(this.baseDir, '_index.json');
  }

  async save(spec: Specification): Promise<void> {
    const snapshot = structuredClone(spec);
    await this.enqueueWrite(() => this.writeSnapshot(snapshot));
  }

  async load(id: string): Promise<Specification | null> {
    await this.writeChain;
    return this.loadFile(id);
  }

  private async loadFile(id: string): Promise<Specification | null> {
    // Resolve the path OUTSIDE the read try/catch so a containment
    // failure (H-6 regression) propagates as a caller-visible error
    // instead of being silently coerced to "not found".
    const filePath = this.filePath(id);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      // A spec file is user-visible and hand-editable. Valid JSON with the
      // wrong shape is as unusable as invalid JSON: returning it as a
      // Specification let `SpecVersioning.diff` crash on a missing
      // `requirements` array and let an id-mismatched file answer for another
      // spec. Treat both as absent, exactly like a parse failure.
      return isSpecification(parsed) && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<SpecIndexEntry[]> {
    await this.writeChain;
    const index = await this.readIndex();
    return index.entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string): Promise<boolean> {
    // Same separation as `load`: validate the id first, then handle the
    // I/O errors that mean "this id is not present" as a clean false.
    const filePath = this.filePath(id);
    return this.enqueueWrite(async () => {
      let removed = false;
      try {
        await fsp.unlink(filePath);
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Repair a stale index even when a previous delete removed the file
      // but failed before the derived index update completed.
      await this.removeFromIndex(id);
      return removed;
    });
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
    return this.enqueueWrite(async () => {
      const spec = await this.loadFile(id);
      if (!spec) return null;
      const updated: Specification = {
        ...spec,
        ...patch,
        id: spec.id,
        createdAt: spec.createdAt,
        updatedAt: Date.now(),
      };
      await this.writeSnapshot(updated);
      return updated;
    });
  }

  /** Serialize every read-modify-write across this process and other store instances. */
  private enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writeChain.then(async () => {
      await ensureDir(this.baseDir);
      return withFileLock(this.indexPath, work);
    });
    this.writeChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async writeSnapshot(snapshot: Specification): Promise<void> {
    const filePath = this.filePath(snapshot.id);
    await atomicWrite(filePath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await this.updateIndex(snapshot);
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
    if (typeof id === 'string' && id.toLowerCase() === '_index') {
      throw new Error(`Invalid spec id: ${JSON.stringify(id)}`);
    }
    if (typeof id !== 'string' || id.length === 0 || id.length > 200 || /[\0/\\]/.test(id)) {
      throw new Error(`Invalid spec id: ${JSON.stringify(id)}`);
    }
    const dir = path.resolve(this.baseDir);
    const resolved = path.resolve(dir, `${id}.json`);
    const rel = path.relative(dir, resolved);
    // Canonical escape test: `..hidden` is a legal single-segment id; a bare
    // startsWith('..') misreads it as a traversal.
    if (
      rel === '..' ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel) ||
      rel.includes(path.sep)
    ) {
      throw new Error(`Invalid spec id: ${JSON.stringify(id)}`);
    }
    return resolved;
  }

  private async readIndex(): Promise<SpecIndex> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.rebuildIndex();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as SpecIndex;
      if (
        parsed?.version === 1 &&
        Array.isArray(parsed.entries) &&
        parsed.entries.every(
          (entry) =>
            entry &&
            typeof entry.id === 'string' &&
            typeof entry.title === 'string' &&
            typeof entry.version === 'string' &&
            typeof entry.status === 'string' &&
            Number.isFinite(entry.updatedAt) &&
            typeof entry.filePath === 'string',
        )
      )
        return parsed;
    } catch {
      // The spec files are authoritative; rebuild a malformed derived index.
    }
    return this.rebuildIndex();
  }

  private async rebuildIndex(): Promise<SpecIndex> {
    let files: import('node:fs').Dirent[];
    try {
      files = await fsp.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
      throw error;
    }
    const entries: SpecIndexEntry[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name === '_index.json') continue;
      const id = file.name.slice(0, -'.json'.length);
      const spec = await this.loadFile(id);
      if (!spec || spec.id !== id) continue;
      entries.push({
        id,
        title: spec.title,
        version: spec.version,
        status: spec.status,
        updatedAt: spec.updatedAt,
        filePath: this.filePath(id),
      });
    }
    return { version: 1, entries };
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
    await this.writeIndex(index);
  }

  private async removeFromIndex(id: string): Promise<void> {
    const index = await this.readIndex();
    index.entries = index.entries.filter((e) => e.id !== id);
    await this.writeIndex(index);
  }

  private async writeIndex(index: SpecIndex): Promise<void> {
    try {
      await atomicWrite(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
    } catch (error) {
      // The spec mutation is already durable. Invalidate the derived index so
      // the next reader rebuilds it from the authoritative specification files.
      await fsp.unlink(this.indexPath).catch(() => undefined);
      throw error;
    }
  }
}
