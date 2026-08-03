/**
 * Requirements Intake — file-backed store.
 *
 * Layout (mirrors SpecStore conventions):
 *   baseDir/<id>.json        — one record per file
 *   baseDir/_index.json      — listing index
 *   baseDir/_idempotency.json — create-idempotency key map
 *
 * Safety properties:
 *  - Optimistic concurrency: every write must pass `expectedVersion`; a
 *    mismatch throws `IntakeConflictError` and nothing is overwritten.
 *  - Writes are serialized per file via `withFileLock` (exclusive-create
 *    lock file), which works within and across processes.
 *  - All file writes go through `atomicWrite` (temp + rename).
 *  - Records are never hard-deleted; archival is the soft-delete path.
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  atomicWrite,
  ensureDir,
  resolveWstackPaths,
  ulid,
  withFileLock,
} from '@wrongstack/core/utils';
import { MAX_HISTORY_ENTRIES, type IntakeStatus } from './constants.js';
import { IntakeConflictError, IntakeNotFoundError } from './errors.js';
import type { ChangeHistoryEntry, RequirementIntakeRecord } from './types.js';

export interface IntakeIndexEntry {
  id: string;
  projectId: string;
  title: string;
  status: IntakeStatus;
  requestType: RequirementIntakeRecord['requestType'];
  priority: RequirementIntakeRecord['priority'];
  requestedBy: string;
  updatedAt: number;
  createdAt: number;
}

interface IntakeIndexFile {
  version: 1;
  entries: IntakeIndexEntry[];
}

interface IdempotencyFile {
  version: 1;
  entries: Record<string, { intakeId: string; createdAt: number }>;
}

export interface RequirementIntakeStoreOptions {
  /**
   * Directory where intake records are stored. Defaults to
   * `resolveWstackPaths({ projectRoot: process.cwd() }).projectRequirementIntakes`
   * (`~/.wrongstack/projects/<slug>/requirement-intakes`).
   */
  baseDir?: string | undefined;
  /** Cap on retained idempotency-key entries; oldest are pruned. Default 10_000. */
  maxIdempotencyEntries?: number | undefined;
  /** Timeout for acquiring the per-record write lock, in ms. Default 15_000. */
  lockTimeoutMs?: number | undefined;
}

export interface StoreUpdateOptions {
  /** Enforce optimistic concurrency. Undefined = unconditional write. */
  expectedVersion?: number | undefined;
  actorId?: string | undefined;
  actorType?: string | undefined;
  action?: string | undefined;
  fields?: string[] | undefined;
  from?: IntakeStatus | undefined;
  to?: IntakeStatus | undefined;
}

export interface StoreCreateResult {
  record: RequirementIntakeRecord;
  created: boolean;
  idempotent: boolean;
}

const INDEX_PATH = '_index.json';
const IDEMPOTENCY_PATH = '_idempotency.json';

function hashIdempotencyKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export class RequirementIntakeStore {
  private readonly baseDir: string;
  private readonly indexPath: string;
  private readonly idempotencyPath: string;
  private readonly maxIdempotencyEntries: number;
  private readonly lockTimeoutMs: number;

  constructor(options: RequirementIntakeStoreOptions) {
    this.baseDir =
      options.baseDir ??
      resolveWstackPaths({ projectRoot: process.cwd() }).projectRequirementIntakes;
    this.indexPath = path.join(this.baseDir, INDEX_PATH);
    this.idempotencyPath = path.join(this.baseDir, IDEMPOTENCY_PATH);
    this.maxIdempotencyEntries = options.maxIdempotencyEntries ?? 10_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
  }

  get directory(): string {
    return this.baseDir;
  }

  private recordPath(id: string): string {
    return path.join(this.baseDir, `${id}.json`);
  }

  // -------------------------------------------------------------------------
  // Reads (lock-free — atomic writes make a torn read impossible)
  // -------------------------------------------------------------------------

  async load(id: string): Promise<RequirementIntakeRecord | null> {
    try {
      const raw = await fsp.readFile(this.recordPath(id), 'utf8');
      return JSON.parse(raw) as RequirementIntakeRecord;
    } catch {
      return null;
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fsp.access(this.recordPath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** List full records for a project, newest-updated first. */
  async list(
    projectId?: string | undefined,
    filter?: { statuses?: readonly IntakeStatus[] | undefined } | undefined,
  ): Promise<RequirementIntakeRecord[]> {
    const entries = await this.listIndex(projectId, filter);
    const records = await Promise.all(entries.map((entry) => this.load(entry.id)));
    return records.filter((record): record is RequirementIntakeRecord => record !== null);
  }

  /** Cheap listing via the index — no record file reads. */
  async listIndex(
    projectId?: string | undefined,
    filter?: { statuses?: readonly IntakeStatus[] | undefined } | undefined,
  ): Promise<IntakeIndexEntry[]> {
    const index = await this.readIndex();
    const statuses = filter?.statuses ? new Set(filter.statuses) : undefined;
    return index.entries
      .filter((entry) => projectId === undefined || entry.projectId === projectId)
      .filter((entry) => statuses === undefined || statuses.has(entry.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async findByIdempotencyKey(key: string): Promise<RequirementIntakeRecord | null> {
    const map = await this.readIdempotency();
    const entry = map.entries[hashIdempotencyKey(key)];
    if (!entry) return null;
    return this.load(entry.intakeId);
  }

  // -------------------------------------------------------------------------
  // Writes (serialized per file)
  // -------------------------------------------------------------------------

  /**
   * Persist a new record. When `idempotencyKey` is given, a second create
   * with the same key returns the existing record instead of duplicating it.
   */
  async create(
    record: RequirementIntakeRecord,
    idempotencyKey?: string,
  ): Promise<StoreCreateResult> {
    await ensureDir(this.baseDir);

    if (idempotencyKey !== undefined && idempotencyKey.trim().length > 0) {
      const key = idempotencyKey.trim();
      return withFileLock(
        this.idempotencyPath,
        async () => {
          const existing = await this.findByIdempotencyKey(key);
          if (existing) {
            return { record: existing, created: false, idempotent: true };
          }
          const map = await this.readIdempotency();
          map.entries[hashIdempotencyKey(key)] = {
            intakeId: record.id,
            createdAt: record.createdAt,
          };
          await this.pruneIdempotency(map);
          await atomicWrite(this.idempotencyPath, JSON.stringify(map, null, 2), { mode: 0o600 });
          const toWrite: RequirementIntakeRecord = { ...record, idempotencyKey: key };
          await this.writeRecord(toWrite);
          await this.updateIndexFor(toWrite);
          return { record: toWrite, created: true, idempotent: false };
        },
        { timeoutMs: this.lockTimeoutMs },
      );
    }

    await this.writeRecord(record);
    await this.updateIndexFor(record);
    return { record, created: true, idempotent: false };
  }

  /**
   * Read-modify-write with optimistic concurrency. `mutate` receives a
   * mutable copy; the store bumps `version`, refreshes `updatedAt`, appends
   * the history entry, and persists atomically under the record lock.
   */
  async update(
    id: string,
    options: StoreUpdateOptions,
    mutate: (record: RequirementIntakeRecord) => void | Promise<void>,
  ): Promise<RequirementIntakeRecord> {
    return withFileLock(
      this.recordPath(id),
      async () => {
        const current = await this.load(id);
        if (!current) throw new IntakeNotFoundError(id);

        if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
          throw new IntakeConflictError(id, options.expectedVersion, current.version);
        }

        const next: RequirementIntakeRecord = structuredClone(current);
        await mutate(next);

        next.version = current.version + 1;
        next.updatedAt = Date.now();
        this.appendHistory(next, options);

        await this.writeRecord(next);
        await this.updateIndexFor(next);
        return next;
      },
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async writeRecord(record: RequirementIntakeRecord): Promise<void> {
    await atomicWrite(this.recordPath(record.id), JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  private appendHistory(record: RequirementIntakeRecord, options: StoreUpdateOptions): void {
    const entry: ChangeHistoryEntry = {
      at: Date.now(),
      actor: options.actorId,
      actorType: options.actorType,
      action: options.action ?? 'updated',
      fields: options.fields,
      from: options.from,
      to: options.to,
    };
    record.history.push(entry);
    if (record.history.length > MAX_HISTORY_ENTRIES) {
      record.history = record.history.slice(record.history.length - MAX_HISTORY_ENTRIES);
    }
  }

  private async readIndex(): Promise<IntakeIndexFile> {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as IntakeIndexFile;
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // No index yet.
    }
    return { version: 1, entries: [] };
  }

  private async updateIndexFor(record: RequirementIntakeRecord): Promise<void> {
    return withFileLock(
      this.indexPath,
      async () => {
        const index = await this.readIndex();
        const entry: IntakeIndexEntry = {
          id: record.id,
          projectId: record.projectId,
          title: record.title,
          status: record.status,
          requestType: record.requestType,
          priority: record.priority,
          requestedBy: record.requestedBy,
          updatedAt: record.updatedAt,
          createdAt: record.createdAt,
        };
        const position = index.entries.findIndex((candidate) => candidate.id === record.id);
        if (position >= 0) {
          index.entries[position] = entry;
        } else {
          index.entries.push(entry);
        }
        await atomicWrite(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
      },
      { timeoutMs: this.lockTimeoutMs },
    );
  }

  private async readIdempotency(): Promise<IdempotencyFile> {
    try {
      const raw = await fsp.readFile(this.idempotencyPath, 'utf8');
      const parsed = JSON.parse(raw) as IdempotencyFile;
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object')
        return parsed;
    } catch {
      // No map yet.
    }
    return { version: 1, entries: {} };
  }

  private async pruneIdempotency(map: IdempotencyFile): Promise<void> {
    const entries = Object.entries(map.entries);
    if (entries.length <= this.maxIdempotencyEntries) return;
    entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
    const keep = new Set(
      entries.slice(entries.length - this.maxIdempotencyEntries).map(([key]) => key),
    );
    for (const key of Object.keys(map.entries)) {
      if (!keep.has(key)) delete map.entries[key];
    }
  }
}

/** Generate a store-compatible record id (`reqi_<ulid>`). */
export function newIntakeId(): string {
  return `reqi_${ulid()}`;
}
