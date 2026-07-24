/**
 * HQ persistence layer — survives HQ server restarts so the command center
 * keeps its event history, snapshot state, cost/activity trends, and (later)
 * alert + command-audit logs across reboots.
 *
 * Three stores, all file-backed under the HQ dataDir
 * (`~/.wrongstack/hq/` by default — see {@link resolveHqDataDir}):
 *
 *  - {@link HqEventLog}       — append-only JSONL of every received event
 *                               envelope, rotated when it exceeds a cap.
 *  - {@link HqSnapshotStore}  — atomic checkpoint of the latest snapshot,
 *                               written on every debounced broadcast.
 *  - {@link HqTimeseriesStore}— time-bucketed cost + activity samples for
 *                               trend charts.
 *
 * Design constraints (mirrors the codebase conventions):
 *  - All disk writes go through {@link withFileLock} + {@link atomicWrite}
 *    (shared primitives from `utils/atomic-write.ts`) for cross-process safety.
 *  - Every write is best-effort and never throws into the HQ server hot path —
 *    callers wrap in try/catch and degrade to in-memory-only on failure.
 *  - Appends use a FIFO write chain (single in-flight writer) so concurrent
 *    event arrivals don't interleave lines.
 *
 * @module hq/persistence
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import {
  type HqEventEnvelope,
  type HqKanbanSnapshotPayload,
  type HqSnapshot,
  isHqKanbanSnapshotPayload,
} from './protocol.js';

/** Maximum event-log lines before a rotation compacts it down to the tail. */
const DEFAULT_EVENT_LOG_MAX_LINES = 50_000;
/** How many lines to retain after a rotation. */
const DEFAULT_EVENT_LOG_ROTATE_KEEP = 20_000;
/** Read recent JSONL records from the tail without loading the whole log. */
const RECENT_READ_CHUNK_BYTES = 64 * 1024;
/** Switch to one bulk prefix read when a selective filter requires a deep scan. */
const RECENT_TAIL_SCAN_BYTES = 1024 * 1024;
const FILTERED_RECENT_TAIL_SCAN_BYTES = 256 * 1024;
/**
 * Cap on the bulk prefix read used when a tail scan cannot satisfy `limit`.
 * Without a cap, a multi-GB event log would allocate one giant buffer per
 * `recent()` call. 8 MiB keeps the worst-case allocation bounded while still
 * scanning deep enough for practical filtered queries; older events beyond
 * the cap are simply not returned in that one call.
 */
const BULK_PREFIX_READ_CAP = 8 * 1024 * 1024;
const LINE_COUNT_CHUNK_BYTES = 256 * 1024;

/**
 * Collect fire-and-forget writes issued in the same event-loop turn and send
 * them to storage as one batch. The FIFO promise still serializes batches,
 * while drain() observes batches queued during an in-flight write as well.
 */
class BestEffortBatchQueue<T> {
  private readonly pending: T[] = [];
  private activeWrite: Promise<void> | null = null;
  private drainScheduled = false;
  private static readonly MAX_PENDING = 10_000;

  constructor(private readonly writeBatch: (items: T[]) => Promise<void>) {}

  enqueue(item: T): void {
    if (this.pending.length >= BestEffortBatchQueue.MAX_PENDING) this.pending.shift();
    this.pending.push(item);
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.flushPending());
  }

  async drain(): Promise<void> {
    for (;;) {
      this.flushPending();
      const observed = this.activeWrite;
      if (observed) await observed;
      if (!this.activeWrite && this.pending.length === 0) return;
    }
  }

  private flushPending(): void {
    this.drainScheduled = false;
    if (this.activeWrite || this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    const active = this.writeBatch(batch)
      .catch((err: unknown) => {
        /* best-effort: a failed batch must not break the write chain, but
         * surface the error to stderr so a silent write death is observable.
         * Programmer errors (TypeError, etc.) should not go unnoticed. */
        console.error(
          `[BestEffortBatchQueue] failed to write batch of ${batch.length} item(s):`,
          err,
        );
      })
      .finally(() => {
        if (this.activeWrite === active) this.activeWrite = null;
        if (this.pending.length > 0) this.flushPending();
      });
    this.activeWrite = active;
  }
}

/** Coalesce queued checkpoints so only the newest not-yet-started value writes. */
class BestEffortLatestQueue<T> {
  private pending: T | undefined;
  private activeWrite: Promise<void> | null = null;
  private drainScheduled = false;

  constructor(private readonly writeLatest: (value: T) => Promise<void>) {}

  enqueue(value: T): void {
    this.pending = value;
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.flushPending());
  }

  async drain(): Promise<void> {
    for (;;) {
      this.flushPending();
      const observed = this.activeWrite;
      if (observed) await observed;
      if (!this.activeWrite && this.pending === undefined) return;
    }
  }

  private flushPending(): void {
    this.drainScheduled = false;
    if (this.activeWrite || this.pending === undefined) return;
    const latest = this.pending;
    this.pending = undefined;
    const active = this.writeLatest(latest)
      .catch((err: unknown) => {
        /* best-effort: a failed write must not break the write chain, but
         * surface the error to stderr so a silent write death is observable.
         * Programmer errors (TypeError, etc.) should not go unnoticed. */
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'hq.persistence_latest_write_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      })
      .finally(() => {
        if (this.activeWrite === active) this.activeWrite = null;
        if (this.pending !== undefined) this.flushPending();
      });
    this.activeWrite = active;
  }
}

// ── HqEventLog ──────────────────────────────────────────────────────────────

export interface HqEventLogOptions {
  dataDir: string;
  maxLines?: number;
  rotateKeep?: number;
}

/**
 * Append-only JSONL event log. Every received event envelope is appended to
 * `events.jsonl`; when the file exceeds `maxLines` it is rotated under a file
 * lock to keep only the most recent `rotateKeep` lines.
 *
 * Writes are serialized through a FIFO chain so concurrent appends never
 * interleave. All operations are best-effort: a rejected append resolves
 * (never rejects) and the caller's `await` never breaks the server loop.
 */
export class HqEventLog {
  private readonly filePath: string;
  private readonly maxLines: number;
  private readonly rotateKeep: number;
  private readonly writer: BestEffortBatchQueue<HqEventEnvelope>;
  private lineCount = 0;
  private counted = false;
  private hydration: Promise<void> | undefined;

  constructor(opts: HqEventLogOptions) {
    this.filePath = path.join(opts.dataDir, 'events.jsonl');
    this.maxLines = opts.maxLines ?? DEFAULT_EVENT_LOG_MAX_LINES;
    this.rotateKeep = opts.rotateKeep ?? DEFAULT_EVENT_LOG_ROTATE_KEEP;
    this.writer = new BestEffortBatchQueue((events) => this.appendInternal(events));
  }

  /** Append an event envelope as one JSON line. Best-effort, never rejects. */
  append(event: HqEventEnvelope): void {
    this.writer.enqueue(event);
  }

  /** Resolves once all queued appends have settled. For tests. */
  async drain(): Promise<void> {
    await this.writer.drain();
  }

  private async appendInternal(events: HqEventEnvelope[]): Promise<void> {
    await this.ensureLineCount();
    const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    await fs.appendFile(this.filePath, lines, { encoding: 'utf8' });
    this.lineCount += events.length;
    if (this.lineCount >= this.maxLines) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      try {
        const retainCount = Math.max(0, Math.floor(this.rotateKeep));
        // Probe one line beyond the keep-count so we can detect the boundary
        // case where the file has exactly `retainCount` lines (no rotation
        // needed) vs. `retainCount + 1+` (rotation required). The over-read
        // is bounded because `readTailNonEmptyLines` clips to `limit`.
        const newest = await readTailNonEmptyLines(this.filePath, retainCount + 1, this.lineCount);
        if (newest.length <= retainCount) {
          this.lineCount = newest.length;
          return;
        }
        const kept = newest.slice(0, retainCount).reverse();
        await atomicWrite(this.filePath, kept.join('\n') + '\n');
        this.lineCount = kept.length;
      } catch {
        /* best-effort */
      }
    });
  }

  private async countLines(): Promise<number> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.filePath, 'r');
    } catch {
      return 0;
    }
    try {
      const buffer = Buffer.allocUnsafe(LINE_COUNT_CHUNK_BYTES);
      let count = 0;
      let position = 0;
      let lineHasBytes = false;
      // `lineHasBytes` is the "the current open line has at least one
      // non-newline byte" flag — it survives chunk boundaries by design.
      // Invariants:
      //   - Reset to `false` after every newline we encounter inside the chunk.
      //   - Set to `true` if we see a non-newline byte in the chunk's trailing
      //     bytes (everything after the last `\n` of the chunk).
      //   - Carried across `handle.read()` boundaries so a multi-chunk line
      //     that spans a partial read is counted exactly once. Without this
      //     carry, a 200 KB line straddling two 256 KB reads would either be
      //     double-counted (both halves look like non-empty trailing bytes)
      //     or under-counted (neither half clears the flag).
      //   - After the loop, `true` means "the last line in the file had no
      //     trailing newline", which contributes one final line.
      // The trailing-bytes special case below mirrors `split('\n').filter(Boolean)`
      // exactly: a chunk that ends with `\n` (or a run of newlines) must not
      // yield an extra empty line.
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        let start = 0;
        for (;;) {
          const newline = buffer.indexOf(0x0a, start);
          if (newline < 0 || newline >= bytesRead) {
            // Trailing bytes after the last newline in this chunk. Mark the
            // partial line as "has content" only when at least one non-newline
            // byte remains — a chunk that ends with `\n` (or a run of newlines)
            // contributes no extra line, matching `split('\n').filter(Boolean)`.
            for (let index = start; index < bytesRead; index++) {
              if (buffer[index] !== 0x0a) {
                lineHasBytes = true;
                break;
              }
            }
            break;
          }
          if (lineHasBytes || newline > start) count++;
          lineHasBytes = false;
          start = newline + 1;
        }
      }
      return count + (lineHasBytes ? 1 : 0);
    } catch {
      return 0;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private async ensureLineCount(): Promise<void> {
    if (this.counted) return;
    this.hydration ??= this.countLines().then((count) => {
      this.lineCount = count;
      this.counted = true;
    });
    try {
      await this.hydration;
    } catch {
      // Defensive: countLines currently swallows IO errors, but a future
      // change could let one reject. Reset the cache so the next call
      // retries instead of re-throwing a cached rejection forever.
      this.hydration = undefined;
      throw new Error('ensureLineCount hydration rejected; cache cleared');
    }
  }

  /**
   * Read the most recent `limit` events, optionally filtered by envelope
   * `type`. Newest first. Returns `[]` if the file doesn't exist yet.
   *
   * Reads are best-effort against a concurrent appender: the file size is
   * sampled once at entry and may return one duplicate or miss one tail
   * line if another process appends during the scan. When a `typeFilter`
   * is set and matches are sparse, the scan walks the whole file in
   * bounded windows but is still guaranteed to reach every line.
   */
  async recent(limit: number, typeFilter?: string): Promise<HqEventEnvelope[]> {
    return readRecentEvents(this.filePath, limit, typeFilter);
  }

  /** Initialize the line count cache from disk (call once at boot). */
  async hydrate(): Promise<void> {
    await this.ensureLineCount();
  }
}

async function readTailNonEmptyLines(
  filePath: string,
  limit: number,
  estimatedLineCount: number,
): Promise<string[]> {
  if (!(limit > 0)) return [];
  const handle = await fs.open(filePath, 'r');
  try {
    const size = (await handle.stat()).size;
    let position = size;
    const chunks: Buffer[] = [];
    // Track the accumulated newline count across chunks without doing a full
    // concat+decode+split on every iteration. We only pay the O(N) decode
    // cost once — when we have enough lines (or hit the start of file).
    let totalNewlines = 0;
    // The in-memory line count lets rotation jump directly to the likely tail
    // boundary in one read. Keep 10% headroom plus one block for variable-size
    // records; if the estimate is short, expand backwards geometrically.
    let nextReadBytes = Math.min(
      size,
      Math.max(
        RECENT_READ_CHUNK_BYTES,
        estimatedLineCount > 0
          ? Math.ceil((size * limit * 1.1) / estimatedLineCount) + RECENT_READ_CHUNK_BYTES
          : Math.ceil(limit * 512) + RECENT_READ_CHUNK_BYTES,
      ),
    );
    while (position > 0) {
      const length = Math.min(nextReadBytes, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const result = await handle.read(
          buffer,
          bytesRead,
          length - bytesRead,
          position + bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead === 0) break;
      const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      // Byte-scan the newest chunk only — totalNewlines is an overcount of
      // non-empty lines (consecutive newlines don't add a line) so when it
      // crosses `limit` we are guaranteed to have enough to return.
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] === 0x0a) totalNewlines++;
      }
      if (position === 0 || totalNewlines >= limit) {
        const lines = Buffer.concat(chunks)
          .toString('utf8')
          .split('\n')
          .filter((line) => line.length > 0);
        return lines.slice(-limit).reverse();
      }
      nextReadBytes = Math.min(position, nextReadBytes * 2);
    }
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readRecentEvents(
  filePath: string,
  limit: number,
  typeFilter?: string,
): Promise<HqEventEnvelope[]> {
  if (!(limit > 0)) return [];
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return [];
  }

  const out: HqEventEnvelope[] = [];
  const acceptText = (raw: string): boolean => {
    const line = raw.trim();
    if (!line) return false;
    try {
      const event = JSON.parse(line) as HqEventEnvelope;
      if (typeFilter === undefined || event.type === typeFilter) out.push(event);
    } catch {
      /* skip malformed lines */
    }
    return out.length >= limit;
  };
  const acceptLine = (parts: Buffer[]): boolean =>
    acceptText(Buffer.concat(parts).toString('utf8'));

  try {
    let position = (await handle.stat()).size;
    // Byte slices are retained until a complete line is found. Splitting on
    // the ASCII newline byte before UTF-8 decoding keeps multibyte characters
    // valid even when a block boundary lands in the middle of one.
    let carry: Buffer[] = [];
    let tailBytesRead = 0;
    const tailScanLimit =
      typeFilter === undefined ? RECENT_TAIL_SCAN_BYTES : FILTERED_RECENT_TAIL_SCAN_BYTES;
    while (position > 0) {
      const length = Math.min(RECENT_READ_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      tailBytesRead += bytesRead;
      const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      let lineEnd = chunk.length;
      for (let index = chunk.length - 1; index >= 0; index--) {
        if (chunk[index] !== 0x0a) continue;
        if (acceptLine([chunk.subarray(index + 1, lineEnd), ...carry])) return out;
        carry = [];
        lineEnd = index;
      }
      if (lineEnd > 0) carry.unshift(chunk.subarray(0, lineEnd));
      if (position > 0 && tailBytesRead >= tailScanLimit) {
        // A rare type filter can require most of the file. One bulk read and
        // native UTF-8 split is faster than hundreds of small reads and a
        // JavaScript byte walk, while common tail hits retain the bounded
        // 64 KiB fast path above. We slice the remaining prefix into
        // `BULK_PREFIX_READ_CAP`-sized windows (newest first) so a multi-GB
        // event log still yields up to `limit` matches without one allocation
        // spanning the whole file.
        let sliceEnd = position;
        // The first iteration's seam line is the line bridging `carry` (head
        // bytes from the tail scan) and `prefixRead`; it has not been
        // accepted before. On subsequent iterations, `carry` already holds
        // the FULL bytes of that same seam line, and re-decoding +
        // re-accepting it would count it twice. We track the seam string so
        // we can skip the duplicate acceptText on iteration 1+.
        let priorSeam = '';
        while (sliceEnd > 0) {
          const readLen = Math.min(sliceEnd, BULK_PREFIX_READ_CAP);
          const readOffset = sliceEnd - readLen;
          const prefix = Buffer.allocUnsafe(readLen);
          let offset = 0;
          while (offset < readLen) {
            const result = await handle.read(prefix, offset, readLen - offset, readOffset + offset);
            if (result.bytesRead === 0) break;
            offset += result.bytesRead;
          }
          const prefixRead = offset === prefix.length ? prefix : prefix.subarray(0, offset);
          // The boundary between `prefixRead` and `carry` may split a multibyte
          // UTF-8 character; joining at the buffer level keeps that character
          // intact across the seam. Stitch the oldest line of THIS slice with
          // the carry from the previous (newer) slice so the window-boundary
          // line is decoded once. All subsequent lines in the slice are
          // processed standalone.
          const text = Buffer.concat([prefixRead, ...carry]).toString('utf8');
          carry = [];
          const lines = text.split('\n');
          for (let index = lines.length - 1; index >= 1; index--) {
            const line = lines[index];
            if (line === undefined) continue;
            if (acceptText(line)) return out;
          }
          // Stitch the oldest line of this slice with the carry from the
          // previous iteration (already in `text` via the concat above) so
          // the window-boundary line is decoded exactly once. lines[0] has
          // already been combined with carry at the buffer level.
          // On iteration 1+ the same seam line reappears (carry holds its
          // full bytes); skip re-accepting because `priorSeam` matches.
          const boundary = lines[0] ?? '';
          if (boundary !== priorSeam && acceptText(boundary)) return out;
          if (readOffset === 0) break;
          // Save the boundary line text in its buffer form so the next slice
          // can stitch with it at the byte level (preserving any multibyte
          // UTF-8 split character at the new seam).
          carry = [Buffer.from(boundary, 'utf8')];
          priorSeam = boundary;
          sliceEnd = readOffset;
        }
        return out;
      }
    }
    if (carry.length > 0) acceptLine(carry);
    return out;
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => {});
  }
}

// ── HqSnapshotStore ──────────────────────────────────────────────────────────

export interface HqSnapshotStoreOptions {
  dataDir: string;
}

/**
 * Atomic checkpoint of the latest snapshot, written to `snapshot.json`.
 * The HQ server writes on every debounced broadcast and reads on boot to
 * re-seed its in-memory state. Best-effort, never rejects.
 */
export class HqSnapshotStore {
  private readonly filePath: string;
  private readonly writer: BestEffortLatestQueue<HqSnapshot>;

  constructor(opts: HqSnapshotStoreOptions) {
    this.filePath = path.join(opts.dataDir, 'snapshot.json');
    this.writer = new BestEffortLatestQueue((snapshot) =>
      atomicWrite(this.filePath, JSON.stringify(snapshot), { mode: 0o600 }),
    );
  }

  /** Persist a snapshot. Best-effort, never rejects. */
  save(snapshot: HqSnapshot): void {
    this.writer.enqueue(snapshot);
  }

  /** Resolves once all queued saves have settled. For tests. */
  async drain(): Promise<void> {
    await this.writer.drain();
  }

  /** Read the last persisted snapshot, or `null` if none. */
  async load(): Promise<HqSnapshot | null> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(content) as HqSnapshot;
    } catch {
      return null;
    }
  }
}

// ── HqKanbanStore ────────────────────────────────────────────────────────────

export class HqKanbanStore {
  private readonly dirPath: string;
  private readonly cache = new Map<string, HqKanbanSnapshotPayload>();
  private readonly writers = new Map<string, BestEffortLatestQueue<HqKanbanSnapshotPayload>>();
  private readonly mergeChains = new Map<string, Promise<HqKanbanSnapshotPayload>>();

  constructor(dataDir: string) {
    this.dirPath = path.join(dataDir, 'kanban');
  }

  async load(projectId: string): Promise<HqKanbanSnapshotPayload> {
    const cached = this.cache.get(projectId);
    if (cached !== undefined) return structuredClone(cached);
    try {
      const content = await fs.readFile(this.filePath(projectId), 'utf8');
      const snapshot: unknown = JSON.parse(content);
      if (!isHqKanbanSnapshotPayload(snapshot) || snapshot.projectId !== projectId) {
        return emptyKanbanSnapshot(projectId);
      }
      this.cache.set(projectId, snapshot);
      return structuredClone(snapshot);
    } catch {
      return emptyKanbanSnapshot(projectId);
    }
  }

  /** Merge by revision, then timestamp. HQ never lets a stale writer win. */
  merge(incoming: HqKanbanSnapshotPayload): Promise<HqKanbanSnapshotPayload> {
    const previous = this.mergeChains.get(incoming.projectId) ?? Promise.resolve(emptyKanbanSnapshot(incoming.projectId));
    const next = previous.catch(() => emptyKanbanSnapshot(incoming.projectId)).then(() => this.mergeNow(incoming));
    this.mergeChains.set(incoming.projectId, next);
    void next.then(
      () => {
        if (this.mergeChains.get(incoming.projectId) === next) {
          this.mergeChains.delete(incoming.projectId);
        }
      },
      () => {
        if (this.mergeChains.get(incoming.projectId) === next) {
          this.mergeChains.delete(incoming.projectId);
        }
      },
    );
    return next;
  }

  private async mergeNow(incoming: HqKanbanSnapshotPayload): Promise<HqKanbanSnapshotPayload> {
    const current = await this.load(incoming.projectId);
    const records = new Map<string, HqKanbanSnapshotPayload['boards'][number] | HqKanbanSnapshotPayload['tombstones'][number]>();
    for (const record of [...current.boards, ...current.tombstones]) records.set(record.boardId, record);
    for (const record of [...incoming.boards, ...incoming.tombstones]) {
      const existing = records.get(record.boardId);
      if (existing === undefined || compareKanbanRecord(record, existing) > 0) {
        records.set(record.boardId, record);
      }
    }
    const merged: HqKanbanSnapshotPayload = {
      projectId: incoming.projectId,
      generatedAt: new Date().toISOString(),
      boards: [],
      tombstones: [],
    };
    for (const record of records.values()) {
      if ('board' in record) merged.boards.push(record);
      else merged.tombstones.push(record);
    }
    merged.boards.sort((a, b) => a.boardId.localeCompare(b.boardId));
    merged.tombstones.sort((a, b) => a.boardId.localeCompare(b.boardId));
    // One defensive clone, not two: the cache entry is only ever read through
    // `load()` (which clones on the way out) and the writer only serializes,
    // so both may share `merged`. Cloning per merge is O(full project set) —
    // with thousands of run-mirror boards that was measurable churn on every
    // delta. The returned clone keeps callers isolated from the cache.
    this.cache.set(incoming.projectId, merged);
    this.writer(incoming.projectId).enqueue(merged);
    return structuredClone(merged);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.mergeChains.values());
    await Promise.all([...this.writers.values()].map((writer) => writer.drain()));
  }

  private writer(projectId: string): BestEffortLatestQueue<HqKanbanSnapshotPayload> {
    let writer = this.writers.get(projectId);
    if (writer === undefined) {
      writer = new BestEffortLatestQueue(async (snapshot) => {
        await fs.mkdir(this.dirPath, { recursive: true });
        await atomicWrite(this.filePath(projectId), JSON.stringify(snapshot), { mode: 0o600 });
      });
      this.writers.set(projectId, writer);
    }
    return writer;
  }

  private filePath(projectId: string): string {
    const safe = createHash('sha256').update(projectId).digest('hex');
    return path.join(this.dirPath, `${safe}.json`);
  }
}

function emptyKanbanSnapshot(projectId: string): HqKanbanSnapshotPayload {
  return { projectId, generatedAt: new Date(0).toISOString(), boards: [], tombstones: [] };
}

function compareKanbanRecord(
  a: HqKanbanSnapshotPayload['boards'][number] | HqKanbanSnapshotPayload['tombstones'][number],
  b: HqKanbanSnapshotPayload['boards'][number] | HqKanbanSnapshotPayload['tombstones'][number],
): number {
  if (a.revision !== b.revision) return a.revision - b.revision;
  const aTime = 'board' in a ? a.updatedAt : a.deletedAt;
  const bTime = 'board' in b ? b.updatedAt : b.deletedAt;
  if (aTime !== bTime) return aTime.localeCompare(bTime);
  if ('board' in a === 'board' in b) return 0;
  return 'board' in a ? -1 : 1;
}

// ── HqTimeseriesStore ────────────────────────────────────────────────────────

export interface HqTimeseriesSample {
  /** Bucket start (epoch ms, floored to the bucket width). */
  ts: number;
  /** Total cost (USD) accumulated in this bucket. */
  costUsd: number;
  /** Total input tokens in this bucket. */
  inputTokens: number;
  /** Total output tokens in this bucket. */
  outputTokens: number;
  /** Number of tool executions in this bucket. */
  toolCalls: number;
  /** Snapshot of active agents at bucket close (last-write per bucket). */
  activeAgents?: number;
  /** Per-dimension cost/token breakdowns for richer trend charts. */
  byModel?: Record<string, HqTimeseriesBreakdownEntry>;
  byProvider?: Record<string, HqTimeseriesBreakdownEntry>;
}

/**
 * One row of a per-dimension breakdown inside a {@link HqTimeseriesSample}
 * (e.g. the cost + tokens attributed to a single model or provider within the
 * bucket). Sums of these across a dimension equal the bucket's totals when
 * every cost signal carried that dimension.
 */
export interface HqTimeseriesBreakdownEntry {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

export interface HqTimeseriesStoreOptions {
  dataDir: string;
  /** Bucket width in ms. Default 5 minutes. */
  bucketMs?: number;
  /** How many buckets to retain. Default 2016 (1 week of 5-min buckets). */
  maxBuckets?: number;
}

/**
 * Time-bucketed cost + activity samples for trend charts. Each {@link record}
 * call folds a cost/tool signal into the current bucket; {@link flush} writes
 * the accumulated buckets to `timeseries.jsonl` (append under lock) and prunes
 * to `maxBuckets`.
 *
 * The store keeps an in-memory ring of buckets for cheap reads; {@link load}
 * rehydrates them on boot.
 */
export class HqTimeseriesStore {
  private readonly filePath: string;
  private readonly bucketMs: number;
  private readonly maxBuckets: number;
  private readonly buckets = new Map<number, HqTimeseriesSample>();
  private readonly dirtyVersions = new Map<number, number>();
  private readonly writer: BestEffortLatestQueue<{
    samples: HqTimeseriesSample[];
    versions: Map<number, number>;
  }>;
  private nextDirtyVersion = 0;
  private diskLineCount: number | undefined;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;

  constructor(opts: HqTimeseriesStoreOptions) {
    this.filePath = path.join(opts.dataDir, 'timeseries.jsonl');
    this.bucketMs = opts.bucketMs ?? 5 * 60 * 1000;
    this.maxBuckets = opts.maxBuckets ?? 2016;
    this.writer = new BestEffortLatestQueue((snapshot) => this.flushInternal(snapshot));
  }

  private bucketStart(ts: number): number {
    return Math.floor(ts / this.bucketMs) * this.bucketMs;
  }

  /** Fold a cost/tool signal into the current bucket. Best-effort. */
  record(signal: {
    ts?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    activeAgents?: number;
    /** When present, this signal is also attributed to a model dimension. */
    model?: string;
    /** When present, this signal is also attributed to a provider dimension. */
    provider?: string;
    cacheRead?: number;
    cacheWrite?: number;
  }): void {
    const start = this.bucketStart(signal.ts ?? Date.now());
    let bucket = this.buckets.get(start);
    if (!bucket) {
      bucket = { ts: start, costUsd: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
      this.buckets.set(start, bucket);
    }
    if (signal.costUsd !== undefined) bucket.costUsd += signal.costUsd;
    if (signal.inputTokens !== undefined) bucket.inputTokens += signal.inputTokens;
    if (signal.outputTokens !== undefined) bucket.outputTokens += signal.outputTokens;
    if (signal.toolCalls !== undefined) bucket.toolCalls += signal.toolCalls;
    if (signal.activeAgents !== undefined) bucket.activeAgents = signal.activeAgents;
    // Attribute this cost signal to its model / provider dimension when known,
    // so trend charts can break spend down without scraping the event log.
    if (signal.model !== undefined || signal.provider !== undefined) {
      const entry: HqTimeseriesBreakdownEntry = {
        costUsd: signal.costUsd ?? 0,
        inputTokens: signal.inputTokens ?? 0,
        outputTokens: signal.outputTokens ?? 0,
        ...(signal.cacheRead !== undefined ? { cacheRead: signal.cacheRead } : {}),
        ...(signal.cacheWrite !== undefined ? { cacheWrite: signal.cacheWrite } : {}),
      };
      if (signal.model !== undefined) {
        bucket.byModel = foldBreakdown(bucket.byModel, signal.model, entry);
      }
      if (signal.provider !== undefined) {
        bucket.byProvider = foldBreakdown(bucket.byProvider, signal.provider, entry);
      }
    }
    this.dirtyVersions.set(start, ++this.nextDirtyVersion);
    // Prune in-memory buckets beyond retention so a long-lived HQ doesn't
    // accumulate unbounded history. Keep the most-recent maxBuckets.
    if (this.buckets.size > this.maxBuckets) {
      const sorted = Array.from(this.buckets.keys()).sort((a, b) => a - b);
      while (this.buckets.size > this.maxBuckets && sorted.length > 0) {
        const oldest = sorted.shift();
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
        this.dirtyVersions.delete(oldest);
      }
    }
  }

  /**
   * Persist accumulated buckets to disk (append under lock), prune to maxBuckets.
   *
   * Note: this dispatcher coalesces — if `flush()` is called multiple times
   * before the previous flush settles, only the most-recent snapshot is
   * written. The dropped snapshots came from the same in-memory `buckets`
   * map, so their data is folded into the surviving snapshot rather than
   * lost. Callers that need every intermediate window on disk should use a
   * BestEffortBatchQueue instead of BestEffortLatestQueue here.
   */
  flush(): void {
    if (this.dirtyVersions.size === 0) return;
    const versions = new Map(this.dirtyVersions);
    for (const [timestamp, version] of versions) {
      if (this.buckets.has(timestamp)) continue;
      versions.delete(timestamp);
      if (this.dirtyVersions.get(timestamp) === version) this.dirtyVersions.delete(timestamp);
    }
    const samples = Array.from(versions.keys())
      .map((timestamp) => this.buckets.get(timestamp))
      .filter((sample): sample is HqTimeseriesSample => sample !== undefined)
      .map(cloneTimeseriesSample)
      .sort((a, b) => a.ts - b.ts);
    if (samples.length === 0) return;
    this.writer.enqueue({ samples, versions });
  }

  /** Resolves once all queued flushes have settled. For tests. */
  async drain(): Promise<void> {
    await this.writer.drain();
  }

  private async flushInternal(snapshot: {
    samples: HqTimeseriesSample[];
    versions: Map<number, number>;
  }): Promise<void> {
    const lines = snapshot.samples.map((bucket) => JSON.stringify(bucket)).join('\n') + '\n';
    await withFileLock(this.filePath, async () => {
      this.diskLineCount ??= await countNonEmptyLines(this.filePath);
      await fs.appendFile(this.filePath, lines, { encoding: 'utf8' });
      this.diskLineCount += snapshot.samples.length;
      const compactAt = Math.max(this.maxBuckets + 1, this.maxBuckets * 4);
      if (this.diskLineCount >= compactAt) {
        const retained = Array.from(this.buckets.values())
          .map(cloneTimeseriesSample)
          .sort((a, b) => a.ts - b.ts);
        await atomicWrite(
          this.filePath,
          retained.map((bucket) => JSON.stringify(bucket)).join('\n') + '\n',
          { mode: 0o600 },
        );
        this.diskLineCount = retained.length;
      }
    });
    for (const [timestamp, version] of snapshot.versions) {
      if (this.dirtyVersions.get(timestamp) === version) this.dirtyVersions.delete(timestamp);
    }
    // Prune in-memory buckets beyond retention.
    const sorted = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = sorted.shift();
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  /** Read buckets within `[since, now]`, oldest-first. */
  async read(sinceMs?: number): Promise<HqTimeseriesSample[]> {
    // Prefer in-memory (always most current); supplement from disk on first call.
    if (!this.loaded && this.buckets.size === 0) await this.load();
    const since = sinceMs ?? 0;
    return Array.from(this.buckets.values())
      .filter((b) => b.ts >= since)
      .sort((a, b) => a.ts - b.ts);
  }

  /** Rehydrate buckets from disk (deduped, latest-per-bucket wins). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadInternal();
    await this.loadPromise;
  }

  private async loadInternal(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch {
      this.diskLineCount = 0;
      this.loaded = true;
      return;
    }
    let lineCount = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lineCount++;
      try {
        const sample = JSON.parse(trimmed) as HqTimeseriesSample;
        // Last-write-wins per bucket (file is append-only, so later lines win).
        this.buckets.set(sample.ts, sample);
      } catch {
        /* skip malformed */
      }
    }
    this.diskLineCount = lineCount;
    this.loaded = true;
    // Prune to retention.
    const sorted = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = sorted.shift();
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

function cloneTimeseriesSample(sample: HqTimeseriesSample): HqTimeseriesSample {
  return {
    ...sample,
    ...(sample.byModel
      ? {
          byModel: Object.fromEntries(
            Object.entries(sample.byModel).map(([key, value]) => [key, { ...value }]),
          ),
        }
      : {}),
    ...(sample.byProvider
      ? {
          byProvider: Object.fromEntries(
            Object.entries(sample.byProvider).map(([key, value]) => [key, { ...value }]),
          ),
        }
      : {}),
  };
}

async function countNonEmptyLines(filePath: string): Promise<number> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return 0;
  }
  try {
    const buffer = Buffer.allocUnsafe(LINE_COUNT_CHUNK_BYTES);
    let count = 0;
    let position = 0;
    let lineHasBytes = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline < 0 || newline >= bytesRead) {
          if (start < bytesRead) lineHasBytes = true;
          break;
        }
        if (lineHasBytes || newline > start) count++;
        lineHasBytes = false;
        start = newline + 1;
      }
    }
    return count + (lineHasBytes ? 1 : 0);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Fold a breakdown entry into a per-dimension map (model or provider), summing
 * cost/token fields and merging cache counts. Returns a new map so the caller
 * can assign it back immutably.
 */
function foldBreakdown(
  map: Record<string, HqTimeseriesBreakdownEntry> | undefined,
  key: string,
  entry: HqTimeseriesBreakdownEntry,
): Record<string, HqTimeseriesBreakdownEntry> {
  const next: Record<string, HqTimeseriesBreakdownEntry> = { ...map };
  const existing = next[key];
  if (existing === undefined) {
    next[key] = { ...entry };
  } else {
    next[key] = {
      costUsd: existing.costUsd + entry.costUsd,
      inputTokens: existing.inputTokens + entry.inputTokens,
      outputTokens: existing.outputTokens + entry.outputTokens,
      cacheRead:
        existing.cacheRead !== undefined || entry.cacheRead !== undefined
          ? (existing.cacheRead ?? 0) + (entry.cacheRead ?? 0)
          : undefined,
      cacheWrite:
        existing.cacheWrite !== undefined || entry.cacheWrite !== undefined
          ? (existing.cacheWrite ?? 0) + (entry.cacheWrite ?? 0)
          : undefined,
    };
  }
  return next;
}

// ── HqSimpleLog (generic append-only JSONL for audit/alert records) ──────────

/**
 * A minimal append-only JSONL log used for records that don't need rotation
 * compaction — command-audit entries and fired alerts. Each record is one
 * JSON line appended under a FIFO write chain; {@link readAll} parses them
 * oldest-first. Best-effort: a rejected append resolves (never rejects) so the
 * HQ server hot path is never broken.
 */
export interface HqSimpleLogOptions {
  dataDir: string;
  filename: string;
  maxLines?: number;
  rotateKeep?: number;
  readLimit?: number;
}

export class HqSimpleLog<T> {
  private readonly filePath: string;
  private readonly maxLines: number;
  private readonly rotateKeep: number;
  private readonly readLimit: number;
  private readonly writer: BestEffortBatchQueue<T>;
  private lineCount = 0;
  private counted = false;
  private hydration: Promise<void> | undefined;

  constructor(opts: HqSimpleLogOptions) {
    this.filePath = path.join(opts.dataDir, opts.filename);
    this.maxLines = opts.maxLines ?? Infinity;
    this.rotateKeep = opts.rotateKeep ?? this.maxLines;
    this.readLimit = opts.readLimit ?? Infinity;
    this.writer = new BestEffortBatchQueue((records) => this.appendInternal(records));
  }

  /** Append one record as a JSON line. Best-effort, never rejects. */
  append(record: T): void {
    this.writer.enqueue(record);
  }

  /** Resolves once all queued appends have settled. For tests. */
  async drain(): Promise<void> {
    await this.writer.drain();
  }

  private async appendInternal(records: T[]): Promise<void> {
    if (Number.isFinite(this.maxLines)) await this.ensureLineCount();
    await fs.appendFile(
      this.filePath,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      { encoding: 'utf8' },
    );
    this.lineCount += records.length;
    if (this.lineCount < this.maxLines) return;
    await withFileLock(this.filePath, async () => {
      const retainCount = Math.max(0, Math.floor(this.rotateKeep));
      const newest = await readTailNonEmptyLines(this.filePath, retainCount + 1, this.lineCount);
      if (newest.length <= retainCount) {
        this.lineCount = newest.length;
        return;
      }
      const kept = newest.slice(0, retainCount).reverse();
      await atomicWrite(this.filePath, kept.join('\n') + '\n', { mode: 0o600 });
      this.lineCount = kept.length;
    });
  }

  private async ensureLineCount(): Promise<void> {
    if (this.counted) return;
    this.hydration ??= countNonEmptyLines(this.filePath)
      .catch(() => 0)
      .then((count) => {
        this.lineCount = count;
        this.counted = true;
      });
    await this.hydration;
  }

  /** Read all records oldest-first. Returns `[]` if the file doesn't exist. */
  async readAll(): Promise<T[]> {
    let lines: string[];
    try {
      lines = (
        await readTailNonEmptyLines(
          this.filePath,
          this.readLimit,
          this.counted ? this.lineCount : 0,
        )
      ).reverse();
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        /* skip malformed lines */
      }
    }
    return out;
  }
}

// ── Aggregate persistence facade ─────────────────────────────────────────────

export interface HqPersistence {
  eventLog: HqEventLog;
  snapshotStore: HqSnapshotStore;
  timeseries: HqTimeseriesStore;
  kanban: HqKanbanStore;
  commandLog: HqSimpleLog<unknown>;
  alertLog: HqSimpleLog<unknown>;
}

export function createHqPersistence(dataDir: string): HqPersistence {
  return {
    eventLog: new HqEventLog({ dataDir }),
    snapshotStore: new HqSnapshotStore({ dataDir }),
    timeseries: new HqTimeseriesStore({ dataDir }),
    kanban: new HqKanbanStore(dataDir),
    commandLog: new HqSimpleLog({
      dataDir,
      filename: 'commands.jsonl',
      maxLines: 8_000,
      rotateKeep: 4_000,
      readLimit: 4_000,
    }),
    alertLog: new HqSimpleLog({
      dataDir,
      filename: 'alerts.jsonl',
      maxLines: 2_000,
      rotateKeep: 1_000,
      readLimit: 1_000,
    }),
  };
}
