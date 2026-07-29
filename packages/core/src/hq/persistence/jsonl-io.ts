/**
 * Shared JSONL read primitives for the HQ persistence stores.
 *
 * Every HQ store is backed by an append-only JSONL file, so they all need the
 * same three reads: "give me the last N non-empty lines", "stream me every
 * line without holding the file", and "how many non-empty lines are there".
 * They live here so {@link module:hq/persistence} stays a facade.
 *
 * All three speak `fs/promises` FileHandles and chunked reads rather than
 * streams: peak memory stays at one chunk plus the longest single line, and
 * there is no stream teardown to get wrong on the error path.
 *
 * @module hq/persistence/jsonl-io
 */
import * as fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/** Read recent JSONL records from the tail without loading the whole log. */
export const RECENT_READ_CHUNK_BYTES = 64 * 1024;
export const LINE_COUNT_CHUNK_BYTES = 256 * 1024;

export async function readTailNonEmptyLines(
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

/**
 * Byte offset at which the retained tail of a JSONL file begins.
 *
 * The counterpart to {@link readTailNonEmptyLines} for callers that want to
 * *keep* a tail rather than read it: this returns a line-aligned offset and
 * never materializes the tail itself. Peak memory is one chunk, regardless of
 * how large the retained region is — the whole point, since the tail of a
 * rotation-sized log is exactly what must not be buffered.
 *
 * The retained region is bounded by both `keepLines` and `maxBytes`; whichever
 * binds first wins. A single line longer than `maxBytes` is still retained
 * whole rather than dropped, so rotation can never empty the file outright.
 *
 * Returns `offset === 0` when the file has fewer than `keepLines` lines (no
 * rotation needed) and the file's size, sampled once, for the caller.
 */
export async function findTailStartOffset(
  filePath: string,
  keepLines: number,
  maxBytes: number,
): Promise<{ offset: number; size: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return { offset: 0, size };

    // A trailing newline terminates the last line; without one, the last
    // newline in the file *opens* the final line. That shifts which newline
    // from the end marks the start of the retained region by exactly one.
    const tailByte = Buffer.allocUnsafe(1);
    await handle.read(tailByte, 0, 1, size - 1);
    const target = keepLines + (tailByte[0] === 0x0a ? 1 : 0);
    if (target <= 0) return { offset: size, size };

    const buffer = Buffer.allocUnsafe(LINE_COUNT_CHUNK_BYTES);
    let position = size;
    let seen = 0;
    // Best line-aligned boundary found so far. Walks backwards from "retain
    // nothing" as newlines are discovered.
    let boundary = size;
    while (position > 0) {
      const length = Math.min(LINE_COUNT_CHUNK_BYTES, position);
      position -= length;
      let read = 0;
      while (read < length) {
        const result = await handle.read(buffer, read, length - read, position + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      if (read === 0) break;
      for (let index = read - 1; index >= 0; index--) {
        if (buffer[index] !== 0x0a) continue;
        const candidate = position + index + 1;
        if (size - candidate > maxBytes) {
          // Past the byte budget. Keep the last boundary that fit — or this
          // one when nothing has fit yet, so an oversized final line survives.
          return { offset: boundary < size ? boundary : candidate, size };
        }
        boundary = candidate;
        seen++;
        if (seen >= target) return { offset: boundary, size };
      }
    }
    // Fewer lines than requested: the whole file is already the tail.
    return { offset: 0, size };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Copy `sourcePath` from `offset` to EOF into an open destination handle,
 * chunk by chunk. Peak memory is one chunk. Returns the bytes copied and the
 * number of newlines seen, so a caller rotating a log can reset its counters
 * without a second pass.
 */
export async function copyTailToHandle(
  sourcePath: string,
  offset: number,
  destination: fs.FileHandle,
): Promise<{ bytes: number; lines: number }> {
  const handle = await fs.open(sourcePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(LINE_COUNT_CHUNK_BYTES);
    let position = offset;
    let bytes = 0;
    let lines = 0;
    let lineHasBytes = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      for (let index = 0; index < bytesRead; index++) {
        if (chunk[index] === 0x0a) {
          if (lineHasBytes) lines++;
          lineHasBytes = false;
        } else {
          lineHasBytes = true;
        }
      }
      await destination.write(chunk);
      bytes += bytesRead;
    }
    return { bytes, lines: lines + (lineHasBytes ? 1 : 0) };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Yield non-empty lines of a JSONL file without ever holding the whole file.
 *
 * Deliberately not `readline`/`createReadStream`: this module already speaks
 * `fs/promises` FileHandles (see {@link countNonEmptyLines}) and a chunked read
 * keeps the peak at one chunk plus the longest single line, with no stream
 * teardown to get wrong on the error path. Callers get a plain async iterable
 * they can `break` out of; the handle is closed either way.
 *
 * `StringDecoder` — not `buffer.toString('utf8')` — because a chunk boundary
 * lands mid-character sooner or later, and a bare decode turns that character
 * into U+FFFD before any carry logic could rescue it. The decoder holds the
 * incomplete byte sequence until the next chunk completes it.
 *
 * Throws only if the file cannot be opened — malformed content is the caller's
 * problem, one line at a time.
 */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(LINE_COUNT_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let position = 0;
    let carry = '';
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) break;
        const line = text.slice(start, newline).trim();
        start = newline + 1;
        if (line) yield line;
      }
      carry = text.slice(start);
    }
    const last = (carry + decoder.end()).trim();
    if (last) yield last;
  } finally {
    await handle.close();
  }
}

export async function countNonEmptyLines(filePath: string): Promise<number> {
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
