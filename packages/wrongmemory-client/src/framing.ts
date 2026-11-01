// Vendored from WrongMemory (https://github.com/WrongStack/wrongmemory) commit 1799ad0,
// file packages/client-ts/src/framing.ts. Do not edit here; update upstream and re-vendor.
/**
 * Newline-delimited JSON framing (architecture §9): one compact JSON value
 * per line. The byte limit is enforced while buffering, before an oversized
 * line is fully accumulated.
 */

import { MAX_FRAME_BYTES } from './contracts.js';
import { WrongMemoryError } from './errors.js';

export function encodeFrame(value: unknown, max = MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length + 1 > max) {
    throw new WrongMemoryError('INVALID_REQUEST', `frame exceeds the ${max}-byte limit`);
  }
  return Buffer.concat([body, Buffer.from('\n')]);
}

/** Incremental line decoder. `push` returns complete decoded frames. */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly max = MAX_FRAME_BYTES) {}

  push(data: Buffer): unknown[] {
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const nl = data.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = data.subarray(start);
        if (this.size + rest.length > this.max) {
          throw new WrongMemoryError('PROTOCOL', `frame exceeds the ${this.max}-byte limit`);
        }
        if (rest.length > 0) {
          this.chunks.push(rest);
          this.size += rest.length;
        }
        return out;
      }
      const piece = data.subarray(start, nl);
      if (this.size + piece.length > this.max) {
        throw new WrongMemoryError('PROTOCOL', `frame exceeds the ${this.max}-byte limit`);
      }
      let line = this.size === 0 ? piece : Buffer.concat([...this.chunks, piece]);
      this.chunks = [];
      this.size = 0;
      start = nl + 1;
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      const text = line.toString('utf8');
      if (text.trim() === '') continue;
      try {
        out.push(JSON.parse(text));
      } catch (e) {
        throw new WrongMemoryError('PROTOCOL', `invalid frame: ${(e as Error).message}`);
      }
    }
  }

  /** Bytes buffered for an incomplete line (non-zero at EOF means truncated). */
  get pending(): number {
    return this.size;
  }
}
