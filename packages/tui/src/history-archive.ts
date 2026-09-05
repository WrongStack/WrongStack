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
 * Token bucket for serializing file writes. Multiple callers can request a
 * flush concurrently; only one drains at a time and later callers batch
 * into the same drain, so every queued line is written exactly once.
 */
interface DrainToken {
  buffer: string[];
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * A JSONL line counts as blank when it holds only whitespace — the ASCII
 * range is decided on bytes (cheap, per-chunk); a line containing high bytes
 * falls back to String#trim so Unicode-whitespace-only lines stay blank.
 */
function isBlankLine(line: Buffer): boolean {
  let sawHighByte = false;
  for (let i = 0; i < line.length; i++) {
    const byte = line[i] ?? 0;
    if (byte >= 0x80) {
      sawHighByte = true;
      break;
    }
    // 0x09..0x0d = \t \n \v \f \r; 0x20 = space
    if (byte !== 0x20 && (byte < 0x09 || byte > 0x0d)) return false;
  }
  if (!sawHighByte) return true;
  return line.toString('utf8').trim().length === 0;
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
  /** In-flight `fsp.open`, so concurrent first-uses share one handle. */
  private opening: Promise<fsp.FileHandle> | null = null;

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
    // append() is fire-and-forget, so a page requested right after appends
    // must order against the write chain — otherwise the index below is
    // built from a file that does not yet contain this page's own lines.
    await this.writeChain;
    // close() may have raced the await above: a closed archive must not
    // reopen its file (the handle close() released could not be reclaimed).
    if (this.closed) return [];
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
    // Drain queued writes and let any in-flight open land so the handle it
    // adopts is released below instead of leaking past close().
    await this.writeChain;
    await this.opening?.catch(() => undefined);
    this.opening = null;
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
    const existing = this.handle;
    if (existing) return existing;
    // Memoize the in-flight open: two concurrent first-uses (e.g. a write
    // draining while a page loads) must not each open their own handle —
    // the loser would only be closed by garbage collection. The open is
    // always adopted; close() awaits it and releases the handle.
    this.opening ??= (async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fsp.open(this.filePath, 'a+', 0o600);
      this.handle = handle;
      return handle;
    })();
    return this.opening;
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

    // Stream the file in bounded chunks instead of materializing it: RSS
    // must not grow with archive size (the whole point of the index is to
    // avoid whole-file scans on every page load). Newline bytes are safe to
    // scan for directly — UTF-8 continuation bytes are always >= 0x80.
    const CHUNK_BYTES = 1024 * 1024;
    const idx: OffsetIndexEntry[] = [];
    const pushLine = (line: Buffer, offset: number, length: number): void => {
      if (isBlankLine(line)) return;
      idx.push({ index: idx.length, offset, length });
    };

    let read = 0; // absolute file offset of the next chunk
    let lineStart = 0; // absolute offset where the current line begins
    let pending: Buffer | null = null; // carries a line spanning chunks
    let chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size));
    while (read < stat.size) {
      const want = Math.min(CHUNK_BYTES, stat.size - read);
      // One reusable buffer: fresh allocations per chunk would let RSS grow
      // with the file until garbage collection runs.
      if (chunk.length !== want) chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(chunk, 0, want, read);
      if (bytesRead <= 0) break; // short read: treat as EOF, retry rebuilds
      let cursor = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline === -1) break;
        const line = pending
          ? Buffer.concat([pending, chunk.subarray(cursor, newline)])
          : chunk.subarray(cursor, newline);
        pending = null;
        pushLine(line, lineStart, read + newline + 1 - lineStart);
        cursor = newline + 1;
        lineStart = read + cursor;
      }
      if (cursor < bytesRead) {
        // The chunk buffer is reused below, so a spanning line tail must be
        // copied out (bounded by the chunk size).
        const tail = Buffer.from(chunk.subarray(cursor, bytesRead));
        pending = pending ? Buffer.concat([pending, tail]) : tail;
      }
      read += bytesRead;
      if (bytesRead < want) break;
    }
    if (pending !== null && pending.length > 0) {
      // Unterminated trailing line (append always terminates; hand-edited
      // files may not). Counted with its TRUE length — the whole-file read
      // used to overshoot by one byte and drop it as a corrupt record.
      pushLine(pending, lineStart, read - lineStart);
    }
    this.index = idx;
  }

  /** Serialise writes through a FIFO promise chain with per-drain batching. */
  private enqueueWrite(line: string): void {
    // A drain in flight? Accumulate into the same batch — every queued line
    // is written; dropping "superseded" lines would lose entries from this
    // append-only log.
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
