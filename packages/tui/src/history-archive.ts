/**
 * history-archive — Disk-backed JSONL store for TUI chat history.
 *
 * Keeps RAM usage low by paging old HistoryEntry objects to disk while
 * retaining only a recent window in memory. Entries are appended to a
 * JSONL file as they are created; when the in-memory window exceeds
 * MAX_MEMORY_ENTRIES, the oldest entries are dropped from the reducer
 * state (they remain on disk). Scrolling past the in-memory window
 * triggers a load from the archive.
 *
 * The archive maintains a byte-offset index so range loads are O(1)
 * seeks instead of scanning the entire file.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { HistoryEntry } from './history-entry.js';

/** How many recent entries to keep in memory at all times. */
export const MAX_MEMORY_ENTRIES = 150;

/** Number of entries loaded from disk per scroll-back page. */
export const ARCHIVE_PAGE_SIZE = 100;

interface OffsetIndexEntry {
  /** Sequential index of the entry in the archive file (0-based). */
  index: number;
  /** Byte offset where this entry's JSONL line starts in the file. */
  offset: number;
  /** Byte length of the JSONL line (including newline). */
  length: number;
}

/**
 * Thread-safe token bucket for serializing file writes. Multiple callers
 * can request a flush token concurrently; only one drains at a time,
 * and the freshest pending write replaces any queued one.
 */
interface DrainToken {
  buffer: string[];
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Disk-backed archive of TUI history entries.
 *
 * Usage:
 * ```ts
 * const archive = new HistoryArchive(sessionDir);
 * await archive.append(entry);       // write to JSONL
 * const entries = await archive.loadRange(0, 100); // load by index
 * await archive.close();
 * ```
 *
 * The archive file lives at `<sessionDir>/history-archive.jsonl`.
 * It is append-only; entries are never removed (they are the durable
 * record). The in-memory window management is handled by the reducer.
 */
export class HistoryArchive {
  private readonly filePath: string;
  private handle: fsp.FileHandle | null = null;
  private closed = false;

  /** Byte-offset index: index → { offset, length }. Built on first load. */
  private index: OffsetIndexEntry[] | null = null;
  /** Total entries written so far (monotonic counter). */
  // ── Write serialisation ──────────────────────────────────────────────

  private writeChain: Promise<void> = Promise.resolve();
  private drainToken: DrainToken | null = null;

  constructor(sessionDir: string) {
    this.filePath = path.join(sessionDir, 'history-archive.jsonl');
  }

  /**
   * Append an entry to the archive. Fire-and-forget: the write is queued
   * on an internal promise chain so callers never block. Returns immediately.
   */
  append(entry: HistoryEntry): void {
    if (this.closed) return;
    const line = JSON.stringify(entry) + '\n';
    this.enqueueWrite(line);
  }

  /**
   * Load a range of entries by index. Indices are 0-based and sequential
   * across the entire file (index 0 = oldest archived entry).
   *
   * Returns the loaded entries in chronological order (oldest first).
   * When the range exceeds the available data, returns whatever fits.
   */
  async loadRange(startIndex: number, count: number): Promise<HistoryEntry[]> {
    if (this.closed || count <= 0) return [];
    await this.buildIndex();
    if (!this.index) return [];

    const clampedStart = Math.max(0, startIndex);
    const clampedEnd = Math.min(clampedStart + count, this.index.length);
    if (clampedStart >= clampedEnd) return [];

    const handle = await this.ensureOpen();
    const slice = this.index.slice(clampedStart, clampedEnd);
    const entries: HistoryEntry[] = [];

    for (const slot of slice) {
      const buf = Buffer.allocUnsafe(slot.length);
      await handle.read(buf, 0, slot.length, slot.offset);
      const text = buf.toString('utf8').trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as HistoryEntry;
        entries.push(parsed);
      } catch {
        // A corrupt line skips silently — durable archive invariant
        // means earlier entries are still recoverable.
      }
    }
    return entries;
  }

  /** How many entries are archived on disk. */
  get archivedCount(): number {
    return this.index?.length ?? 0;
  }

  /**
   * Close the file handle and release resources. Idempotent.
   * The write chain is drained before closing so no in-flight write
   * is lost.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Drain any pending write
    await this.writeChain;
    if (this.handle) {
      try {
        await this.handle.close();
      } catch {
        // Best-effort: handle may already be closed.
      }
      this.handle = null;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async ensureOpen(): Promise<fsp.FileHandle> {
    if (this.handle) return this.handle;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await fsp.open(this.filePath, 'a+', 0o600);
    return this.handle;
  }

  /**
   * Build the byte-offset index by scanning the archive file.
   * Rebuilds when `this.index` is null (first use or after rotation).
   * The index is cached for the lifetime of the archive object.
   */
  private async buildIndex(): Promise<void> {
    if (this.index !== null) return;
    const handle = await this.ensureOpen();
    const stat = await handle.stat();
    if (stat.size === 0) {
      this.index = [];
      return;
    }

    const buf = Buffer.allocUnsafe(stat.size);
    await handle.read(buf, 0, stat.size, 0);
    const text = buf.toString('utf8');
    const lines = text.split('\n');

    const idx: OffsetIndexEntry[] = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // JSONL line includes the newline. split('\n') strips it, so add 1 back.
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (line.trim().length === 0) {
        offset += lineBytes;
        continue;
      }
      idx.push({ index: idx.length, offset, length: lineBytes });
      offset += lineBytes;
    }
    this.index = idx;
  }

  /** Serialise writes through a FIFO promise chain with fresh-token coalescing. */
  private enqueueWrite(line: string): void {
    // If a drain is already in flight, replace its buffer content.
    // Only keep the freshest data — intermediate lines are superseded
    // by the latest append (monotonic entry stream).
    if (this.drainToken) {
      this.drainToken.buffer.push(line);
      return;
    }

    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.drainToken = { buffer: [line], promise, resolve: resolve! };

    const doWrite = async (): Promise<void> => {
      const token = this.drainToken!;
      this.drainToken = null;
      try {
        const batch = token.buffer.join('');
        const handle = await this.ensureOpen();
        await handle.appendFile(batch, 'utf8');
        // Invalidate the index since new data was appended.
        this.index = null;
      } catch {
        // Best-effort: a write failure must never crash the TUI.
        // The entry is lost from the archive but remains in the
        // in-memory window until it scrolls out.
      } finally {
        token.resolve();
      }
    };
    this.writeChain = this.writeChain.then(doWrite, doWrite);
  }
}

/**
 * Build the archive file path from a session directory.
 * Exported so the TUI can create the archive path from the session dir
 * without importing the class.
 */
export function historyArchivePath(sessionDir: string): string {
  return path.join(sessionDir, 'history-archive.jsonl');
}
