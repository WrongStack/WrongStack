import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, ensureDir, withFileLock } from '@wrongstack/core/utils';
import type { SddBoardSnapshot } from './board-types.js';

const DEFAULT_EVENT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_EVENT_KEEP_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENT_SIZE_CHECK_EVERY = 100;

export interface SddBoardStoreOptions {
  /** Directory for board snapshots + event logs (wpaths.projectSddBoards). */
  baseDir: string;
  /** Rotate an event log after this many bytes. Default 16 MiB. */
  eventMaxBytes?: number | undefined;
  /** Tail bytes retained after event-log rotation. Default 8 MiB. */
  eventKeepBytes?: number | undefined;
  /** Amortize event-log size stats across this many appends. Default 100. */
  eventSizeCheckEvery?: number | undefined;
  /** Injectable control-queue file operations for fault testing. */
  controlFileIO?: SddBoardControlFileIO | undefined;
}

interface SddBoardControlFileIO {
  stat(filePath: string): Promise<{ size: number }>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  truncate(filePath: string, length: number): Promise<void>;
}

export interface SddBoardIndexEntry {
  runId: string;
  specId?: string | undefined;
  title: string;
  status: string;
  total: number;
  completed: number;
  updatedAt: number;
}

interface SddBoardIndex {
  version: 1;
  entries: SddBoardIndexEntry[];
}

interface IndexSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/** One appended line in a board's JSONL event log. */
export interface SddBoardEvent {
  ts: number;
  type: string;
  payload?: unknown;
}

/**
 * Legacy-compatible SDD board storage. A board (= one parallel run) may have:
 *   - `<runId>.json`        — legacy snapshot imported into Kanban workflow state
 *   - `<runId>.events.jsonl`— bounded tail event log (audit / recent replay)
 *   - `<runId>.control.jsonl` — legacy command queue imported once by new runs
 * plus legacy `_index.json`. Production snapshot/control authority lives in the
 * project-scoped Kanban daemon; JSONL remains the append-only audit stream.
 */
export class SddBoardStore {
  private readonly baseDir: string;
  private readonly indexPath: string;
  private readonly eventMaxBytes: number;
  private readonly eventKeepBytes: number;
  private readonly eventSizeCheckEvery: number;
  private readonly controlFileIO: SddBoardControlFileIO;
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly eventWritesSinceCheck = new Map<string, number>();
  private readonly controlDrains = new Map<
    string,
    Promise<Array<{ ts: number; type: string; payload?: unknown }>>
  >();
  private baseDirReady: Promise<void> | undefined;
  private cachedIndex: SddBoardIndex | undefined;
  private cachedIndexSignature: IndexSignature | null = null;
  private indexNeedsRebuild = false;

  constructor(opts: SddBoardStoreOptions) {
    this.baseDir = opts.baseDir;
    this.indexPath = path.join(this.baseDir, '_index.json');
    this.eventMaxBytes = Math.max(1024, Math.floor(opts.eventMaxBytes ?? DEFAULT_EVENT_MAX_BYTES));
    this.eventKeepBytes = Math.min(
      this.eventMaxBytes,
      Math.max(0, Math.floor(opts.eventKeepBytes ?? DEFAULT_EVENT_KEEP_BYTES)),
    );
    this.eventSizeCheckEvery = Math.max(
      1,
      Math.floor(opts.eventSizeCheckEvery ?? DEFAULT_EVENT_SIZE_CHECK_EVERY),
    );
    this.controlFileIO = opts.controlFileIO ?? fsp;
  }

  snapshotPath(runId: string): string {
    return path.join(this.baseDir, `${this.safe(runId)}.json`);
  }
  eventsPath(runId: string): string {
    return path.join(this.baseDir, `${this.safe(runId)}.events.jsonl`);
  }
  controlPath(runId: string): string {
    return path.join(this.baseDir, `${this.safe(runId)}.control.jsonl`);
  }

  async saveSnapshot(snapshot: SddBoardSnapshot): Promise<void> {
    await this.ensureBaseDir();
    await atomicWrite(this.snapshotPath(snapshot.runId), JSON.stringify(snapshot, null, 2), {
      mode: 0o600,
    });
    await this.updateIndex(snapshot);
  }

  async load(runId: string): Promise<SddBoardSnapshot | null> {
    try {
      const raw = (await fsp.readFile(this.snapshotPath(runId), 'utf8')).replace(/^\uFEFF/, '');
      const value = JSON.parse(raw);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as SddBoardSnapshot;
      }
      return null;
    } catch {
      return null;
    }
  }

  async list(): Promise<SddBoardIndexEntry[]> {
    const index = await this.readIndex();
    return index.entries.map((entry) => ({ ...entry }));
  }

  /** Latest board metadata without cloning/sorting the complete index. */
  async latest(): Promise<SddBoardIndexEntry | undefined> {
    const entry = (await this.readIndex()).entries[0];
    return entry ? { ...entry } : undefined;
  }

  async loadLatestForSpec(specId: string): Promise<SddBoardSnapshot | null> {
    const entry = (await this.list()).find((e) => e.specId === specId);
    return entry ? this.load(entry.runId) : null;
  }

  /** Append one line to the board's JSONL event log (best-effort, never throws). */
  async appendEvent(runId: string, event: SddBoardEvent): Promise<void> {
    const filePath = this.eventsPath(runId);
    const previous = this.eventChains.get(filePath) ?? Promise.resolve();
    const write = previous
      .then(() => this.appendEventInternal(filePath, event))
      .catch(() => undefined);
    this.eventChains.set(filePath, write);
    await write;
    if (this.eventChains.get(filePath) === write) this.eventChains.delete(filePath);
  }

  /** Append a legacy control command. Production readers use Kanban IPC. */
  async appendControl(
    runId: string,
    command: { ts: number; type: string; payload?: unknown },
  ): Promise<void> {
    await this.ensureBaseDir();
    const filePath = this.controlPath(runId);
    await withFileLock(filePath, () =>
      fsp.appendFile(filePath, `${JSON.stringify(command)}\n`, { mode: 0o600 }),
    );
  }

  /** Read + truncate the legacy control queue for one-time migration. */
  async drainControl(
    runId: string,
  ): Promise<Array<{ ts: number; type: string; payload?: unknown }>> {
    const filePath = this.controlPath(runId);
    const active = this.controlDrains.get(filePath);
    if (active) {
      await active;
      return [];
    }
    const drain = this.drainControlInternal(filePath);
    this.controlDrains.set(filePath, drain);
    try {
      return await drain;
    } finally {
      this.controlDrains.delete(filePath);
    }
  }

  async delete(runId: string): Promise<void> {
    const eventPath = this.eventsPath(runId);
    await this.eventChains.get(eventPath);
    this.eventChains.delete(eventPath);
    await Promise.allSettled([
      fsp.unlink(this.snapshotPath(runId)),
      fsp.unlink(eventPath),
      fsp.unlink(this.controlPath(runId)),
    ]);
    this.eventWritesSinceCheck.delete(eventPath);
    await this.removeFromIndex(runId);
  }

  // ── internal ────────────────────────────────────────────────────────────

  private safe(runId: string): string {
    const cleaned = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (
      cleaned.length === 0 ||
      cleaned === '.' ||
      cleaned === '..' ||
      cleaned.toLowerCase() === '_index'
    ) {
      return `_run_${cleaned}`;
    }
    return cleaned;
  }

  private async ensureBaseDir(): Promise<void> {
    this.baseDirReady ??= ensureDir(this.baseDir).catch((error: unknown) => {
      this.baseDirReady = undefined;
      throw error;
    });
    await this.baseDirReady;
  }

  private async appendEventInternal(filePath: string, event: SddBoardEvent): Promise<void> {
    await this.ensureBaseDir();
    await withFileLock(filePath, async () => {
      await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });

      const writes = (this.eventWritesSinceCheck.get(filePath) ?? 0) + 1;
      if (writes < this.eventSizeCheckEvery) {
        this.eventWritesSinceCheck.set(filePath, writes);
        return;
      }
      this.eventWritesSinceCheck.set(filePath, 0);

      const stat = await fsp.stat(filePath);
      if (stat.size <= this.eventMaxBytes) return;
      await this.compactEventTail(filePath, stat.size);
    });
  }

  private async compactEventTail(filePath: string, size: number): Promise<void> {
    if (this.eventKeepBytes === 0) {
      await atomicWrite(filePath, '', { mode: 0o600 });
      return;
    }
    const handle = await fsp.open(filePath, 'r');
    let retained: Buffer;
    try {
      const length = Math.min(size, this.eventKeepBytes);
      const start = size - length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      retained = buffer.subarray(0, bytesRead);

      const previous = Buffer.allocUnsafe(1);
      await handle.read(previous, 0, 1, start - 1);
      if (previous[0] !== 0x0a) {
        retained = retained.subarray(retained.indexOf(0x0a) + 1);
      }
    } finally {
      await handle.close();
    }
    // Close the reader before replacing the file. Windows rejects rename over
    // an open destination handle (EPERM/EBUSY), turning rotation into repeated
    // retry delays and leaving the log unbounded.
    await atomicWrite(filePath, retained, { mode: 0o600 });
  }

  private async drainControlInternal(
    filePath: string,
  ): Promise<Array<{ ts: number; type: string; payload?: unknown }>> {
    try {
      const stat = await this.controlFileIO.stat(filePath);
      if (stat.size === 0) return [];
    } catch {
      return [];
    }

    return withFileLock(filePath, async () => {
      let raw: string;
      try {
        const stat = await this.controlFileIO.stat(filePath);
        if (stat.size === 0) return [];
        raw = await this.controlFileIO.readFile(filePath, 'utf8');
      } catch {
        return [];
      }
      const parseCommands = (s: string) =>
        s
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line) as { ts: number; type: string; payload?: unknown };
            } catch {
              return null;
            }
          })
          .filter(
            (command): command is { ts: number; type: string; payload?: unknown } =>
              command !== null,
          );
      try {
        await this.controlFileIO.truncate(filePath, 0);
      } catch {
        // Truncate failed — the file still holds every command we just read.
        // Returning them now would re-deliver the identical batch on the next
        // drain (the file was NOT emptied; "the next drain finds an empty
        // file" only holds if the truncate had succeeded). Retry once through
        // the atomic-replace path, which clears the file under lock conditions
        // that defeat in-place truncation. If that also fails, leave the
        // commands queued in the file: a later drain delivers them — delayed,
        // never duplicated.
        try {
          await atomicWrite(filePath, '', { mode: 0o600 });
        } catch {
          return [];
        }
      }
      return parseCommands(raw);
    });
  }

  private async readIndex(): Promise<SddBoardIndex> {
    const signature = await this.indexSignature();
    if (this.cachedIndex && sameIndexSignature(signature, this.cachedIndexSignature)) {
      return this.cachedIndex;
    }
    try {
      const raw = (await fsp.readFile(this.indexPath, 'utf8')).replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as SddBoardIndex;
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
        parsed.entries.sort((a, b) => b.updatedAt - a.updatedAt);
        this.cachedIndex = parsed;
        this.cachedIndexSignature = signature;
        this.indexNeedsRebuild = false;
        return parsed;
      }
    } catch {
      /* no index yet */
    }
    this.cachedIndex = { version: 1, entries: [] };
    this.cachedIndexSignature = signature;
    this.indexNeedsRebuild = true;
    return this.cachedIndex;
  }

  private async rebuildIndexEntries(): Promise<SddBoardIndexEntry[]> {
    let files: import('node:fs').Dirent[];
    try {
      files = await fsp.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: SddBoardIndexEntry[] = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json') || file.name === '_index.json') continue;
      const fileStem = file.name.slice(0, -'.json'.length);
      let snapshot: SddBoardSnapshot | null = null;
      try {
        const raw = await fsp.readFile(path.join(this.baseDir, file.name), 'utf8');
        const value = JSON.parse(raw);
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          snapshot = value as SddBoardSnapshot;
        }
      } catch {
        snapshot = null;
      }
      if (
        !snapshot ||
        typeof snapshot.runId !== 'string' ||
        this.safe(snapshot.runId) !== fileStem ||
        typeof snapshot.title !== 'string' ||
        typeof snapshot.status !== 'string' ||
        !Number.isFinite(snapshot.updatedAt) ||
        !snapshot.progress ||
        !Number.isFinite(snapshot.progress.total) ||
        !Number.isFinite(snapshot.progress.completed)
      )
        continue;
      entries.push({
        runId: snapshot.runId,
        specId: snapshot.specId,
        title: snapshot.title,
        status: snapshot.status,
        total: snapshot.progress.total,
        completed: snapshot.progress.completed,
        updatedAt: snapshot.updatedAt,
      });
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async updateIndex(snapshot: SddBoardSnapshot): Promise<void> {
    await withFileLock(this.indexPath, async () => {
      const current = await this.readIndex();
      const index: SddBoardIndex = {
        version: 1,
        entries: this.indexNeedsRebuild
          ? await this.rebuildIndexEntries()
          : current.entries.map((entry) => ({ ...entry })),
      };
      const entry: SddBoardIndexEntry = {
        runId: snapshot.runId,
        specId: snapshot.specId,
        title: snapshot.title,
        status: snapshot.status,
        total: snapshot.progress.total,
        completed: snapshot.progress.completed,
        updatedAt: snapshot.updatedAt,
      };
      const idx = index.entries.findIndex((e) => e.runId === snapshot.runId);
      if (idx >= 0) index.entries[idx] = entry;
      else index.entries.push(entry);
      index.entries.sort((a, b) => b.updatedAt - a.updatedAt);
      await atomicWrite(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
      this.cachedIndex = index;
      this.cachedIndexSignature = await this.indexSignature();
      this.indexNeedsRebuild = false;
    });
  }

  private async removeFromIndex(runId: string): Promise<void> {
    await withFileLock(this.indexPath, async () => {
      const current = await this.readIndex();
      const index: SddBoardIndex = {
        version: 1,
        entries: (this.indexNeedsRebuild ? await this.rebuildIndexEntries() : current.entries)
          .filter((entry) => entry.runId !== runId)
          .map((entry) => ({ ...entry })),
      };
      await atomicWrite(this.indexPath, JSON.stringify(index, null, 2), { mode: 0o600 });
      this.cachedIndex = index;
      this.cachedIndexSignature = await this.indexSignature();
      this.indexNeedsRebuild = false;
    });
  }

  private async indexSignature(): Promise<IndexSignature | null> {
    try {
      const stat = await fsp.stat(this.indexPath);
      return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    } catch {
      return null;
    }
  }
}

export function sameIndexSignature(a: IndexSignature | null, b: IndexSignature | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
