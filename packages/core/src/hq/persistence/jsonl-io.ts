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
