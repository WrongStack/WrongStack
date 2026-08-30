/**
 * Float32Array <-> Buffer codec tests (zero-statement ratchet coverage
 * for packages/vector-memory/src/vector-codec.ts).
 */
import { describe, expect, it } from 'vitest';

import { decodeVector, encodeVector } from '../src/vector-codec.js';

describe('vector codec', () => {
  it('round-trips a Float32Array through a Buffer', () => {
    const vec = new Float32Array([1.5, -2.25, 0, 3.75]);
    const buf = encodeVector(vec);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBe(16);
    const decoded = decodeVector(buf);
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(Array.from(decoded)).toEqual([1.5, -2.25, 0, 3.75]);
  });

  it('encodes little-endian float32 bytes, portable with codebase-index', () => {
    const buf = encodeVector(new Float32Array([1]));
    // Float32 1.0 little-endian: 00 00 80 3f
    expect([...buf]).toEqual([0x00, 0x00, 0x80, 0x3f]);
  });

  it('decodes Uint8Array blobs as node:sqlite returns them', () => {
    const vec = new Float32Array([0.5, -0.5]);
    const buf = encodeVector(vec);
    const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const decoded = decodeVector(uint8);
    expect(Array.from(decoded)).toEqual([0.5, -0.5]);
  });

  it('respects non-zero byteOffset views (subarray)', () => {
    const all = new Float32Array([99, 1.25, -3, 7]);
    const sub = all.subarray(1, 3); // byteOffset 4, 8 bytes
    const decoded = decodeVector(encodeVector(sub));
    expect(Array.from(decoded)).toEqual([1.25, -3]);
  });

  it('handles empty buffers and rejects malformed lengths', () => {
    expect(decodeVector(Buffer.alloc(0)).length).toBe(0);
    expect(() => decodeVector(Buffer.alloc(3))).toThrow(/invalid vector byteLength/);
  });
});
