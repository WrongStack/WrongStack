/**
 * Append-only JSONL log of every HQ event envelope, with tail-first reads.
 *
 * Split out of `hq/persistence.ts`; see that module for the shared design
 * constraints (file-lock + atomic writes, best-effort semantics, FIFO write
 * chain).
 *
 * @module hq/persistence/event-log
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SECRET_FILE_MODE } from '../../security/file-permissions.js';
import { atomicReplaceWithWriter, withFileLock } from '../../utils/atomic-write.js';
import type { HqEventEnvelope } from '../protocol.js';
import { BestEffortBatchQueue } from '../write-queues.js';
import {
  copyTailToHandle,
  findTailStartOffset,
  LINE_COUNT_CHUNK_BYTES,
  RECENT_READ_CHUNK_BYTES,
} from './jsonl-io.js';

/** Maximum event-log lines before a rotation compacts it down to the tail. */
const DEFAULT_EVENT_LOG_MAX_LINES = 50_000;
/** How many lines to retain after a rotation. */
const DEFAULT_EVENT_LOG_ROTATE_KEEP = 20_000;
/**
 * Maximum event-log *bytes* before rotation, and how many bytes to retain.
 *
 * A line cap alone does not bound this file: envelope size varies by three
 * orders of magnitude across event types, so 50k lines has meant anywhere from
 * a few MB to ~700 MB in practice (measured: 429 MB at 30,809 lines, average
 * line 14.5 KB — the line cap had never once fired). Rotation now triggers on
 * whichever cap binds first, and the retained tail is bounded the same way.
 *
 * Defaults per HQ Evolution 2026-08 §10.3: cap lowered from 64 MB to 32 MB
 * to keep on-disk footprint bounded for VPS deployments; still safely above
 * the 1 MB tail-scan threshold. Both numbers remain configurable per HQ
 * instance via {@link HqEventLogOptions}.
 */
const DEFAULT_EVENT_LOG_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_EVENT_LOG_ROTATE_KEEP_BYTES = 16 * 1024 * 1024;
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

export interface HqEventLogOptions {
  dataDir: string;
  maxLines?: number;
  rotateKeep?: number;
  maxBytes?: number;
  rotateKeepBytes?: number;
}

/**
 * Named presets for the byte cap. The default (no preset) is the 32 MB cap
 * per HQ Evolution 2026-08 §10.3. Pick a preset when you want to make
 * the override path explicit in code review.
 *
 *   - `'vps8'`    — 8 MB cap, 2 MB retained. Tightest cap for memory-constrained
 *                    VPS deployments.
 *   - `'vps32'`   — 32 MB cap, 16 MB retained. Same as the default.
 *   - `'desktop'` — 64 MB cap, 24 MB retained. The pre-§10.3 default; for
 *                    workstations with disk to spare.
 */
export type HqEventLogPreset = 'vps8' | 'vps32' | 'desktop';

export const HQ_EVENT_LOG_PRESETS: Readonly<
  Record<
    HqEventLogPreset,
    {
      maxBytes: number;
      rotateKeepBytes: number;
    }
  >
> = Object.freeze({
  vps8: { maxBytes: 8 * 1024 * 1024, rotateKeepBytes: 2 * 1024 * 1024 },
  vps32: { maxBytes: 32 * 1024 * 1024, rotateKeepBytes: 16 * 1024 * 1024 },
  desktop: { maxBytes: 64 * 1024 * 1024, rotateKeepBytes: 24 * 1024 * 1024 },
});

/**
 * Return the byte-cap fields for a named preset. Throws on unknown preset
 * names so callers get a clear error at construction time rather than
 * silently falling back to the default.
 */
export function hqEventLogPresetFields(preset: HqEventLogPreset): {
  maxBytes: number;
  rotateKeepBytes: number;
} {
  const fields = HQ_EVENT_LOG_PRESETS[preset];
  if (fields === undefined) {
    throw new Error(
      `Unknown HqEventLogPreset: ${String(preset)}. Allowed: ${Object.keys(HQ_EVENT_LOG_PRESETS).join(', ')}.`,
    );
  }
  return fields;
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
  private readonly maxBytes: number;
  private readonly rotateKeepBytes: number;
  private lineCount = 0;
  private byteCount = 0;
  private counted = false;
  private hydration: Promise<void> | undefined;

  constructor(opts: HqEventLogOptions) {
    this.filePath = path.join(opts.dataDir, 'events.jsonl');
    this.maxLines = opts.maxLines ?? DEFAULT_EVENT_LOG_MAX_LINES;
    this.rotateKeep = opts.rotateKeep ?? DEFAULT_EVENT_LOG_ROTATE_KEEP;
    this.maxBytes = opts.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES;
    this.rotateKeepBytes = opts.rotateKeepBytes ?? DEFAULT_EVENT_LOG_ROTATE_KEEP_BYTES;
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
    // WS-035: HQ events carry session content; create owner-only.
    await fs.appendFile(this.filePath, lines, { encoding: 'utf8', mode: SECRET_FILE_MODE });
    this.lineCount += events.length;
    this.byteCount += Buffer.byteLength(lines, 'utf8');
    if (this.lineCount >= this.maxLines || this.byteCount >= this.maxBytes) {
      await this.rotate();
    }
  }

  /**
   * Compact the log down to its most recent lines.
   *
   * Streams the retained tail straight from the old file into the replacement
   * rather than materializing it. The previous implementation read the tail
   * into a `string[]`, `join`ed it, and handed the result to `atomicWrite` —
   * at the observed 14.5 KB average line that is ~277 MB of UTF-8 inflated to
   * ~555 MB of JS strings, plus another ~555 MB for the join, all allocated
   * inside the file lock. Rotation is now O(one chunk) no matter how much is
   * retained, so the operation that exists to *reclaim* space stops being the
   * largest allocation the process ever makes.
   */
  private async rotate(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      try {
        const retainCount = Math.max(0, Math.floor(this.rotateKeep));
        const { offset, size } = await findTailStartOffset(
          this.filePath,
          retainCount,
          this.rotateKeepBytes,
        );
        // offset 0 means the file is already at or under the keep-count and
        // within the byte budget — nothing to reclaim. Re-sync the counters
        // (another process may have rotated underneath us) and stop.
        if (offset === 0) {
          this.byteCount = size;
          this.lineCount = await this.countLines();
          return;
        }
        const copied = await atomicReplaceWithWriter(this.filePath, (handle) =>
          copyTailToHandle(this.filePath, offset, handle),
        );
        this.lineCount = copied.lines;
        this.byteCount = copied.bytes;
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
    // Seed the byte counter alongside the line counter, otherwise a process
    // that restarts against an already-oversized log would count up from zero
    // and never trip the byte cap.
    this.hydration ??= Promise.all([
      this.countLines(),
      fs.stat(this.filePath).then(
        (stat) => stat.size,
        () => 0,
      ),
    ]).then(([count, size]) => {
      this.lineCount = count;
      this.byteCount = size;
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
