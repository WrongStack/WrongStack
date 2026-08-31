/**
 * Float32Array <-> SQLite BLOB codec.
 *
 * Mirrors the pattern used by `packages/tools/src/codebase-index/vector-search.ts`
 * so that the on-disk byte layout is portable between the codebase-index
 * and vector-memory stores. node:sqlite returns `Uint8Array` for BLOB columns,
 * so we copy the visible byte range regardless of the runtime type.
 */

export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeVector(buf: Buffer | Uint8Array): Float32Array {
  if (buf.byteLength === 0) return new Float32Array(0);
  if (buf.byteLength % 4 !== 0) {
    throw new Error(`decodeVector: invalid vector byteLength ${buf.byteLength} (must be a multiple of 4)`);
  }
  const copy = new Float32Array(buf.byteLength / 4);
  new Uint8Array(copy.buffer).set(buf);
  return copy;
}
