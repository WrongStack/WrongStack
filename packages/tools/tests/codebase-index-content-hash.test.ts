/**
 * xxHash64 known-answer tests.
 *
 * The xxHash64 algorithm has a canonical reference implementation. Any
 * divergence between WrongStack installs (or between this code and the
 * reference) would mean a single file gets two different `content_hash`
 * values, which silently degrades the incremental indexer's hit rate.
 *
 * Vectors were verified against `xxhash-wasm@1.1.0` (the trusted WASM
 * build of the reference C implementation). The empty-input case and a
 * 1-byte case anchor the buffer boundary conditions; the 240-byte case
 * covers the multi-block path. Numbers are seed=0, lowercase hex.
 */

import { describe, expect, it } from 'vitest';
import {
  parseContentHash,
  xxhash64Hex,
  xxhash64String,
} from '../src/codebase-index/content-hash.js';

describe('xxHash64 — known-answer vectors (seed 0)', () => {
  it.each([
    // [label, input bytes as a string, expected hex]
    // Verified against xxhash-wasm@1.1.0 reference implementation.
    ['empty', '', 'ef46db3751d8e999'],
    ['one byte (\\0)', '\0', 'e934a84adb052768'],
    ['one byte (a)', 'a', 'd24ec4f1a98c6e5b'],
    ['hello', 'hello', '26c7827d889f6da3'],
    ['world', 'world', 'e778fbfe66ee51ef'],
    ['240 bytes (cycle pattern)', 'A'.repeat(240), '39e3213f48f0c087'],
  ])('hashes %s correctly', (_label, input, expected) => {
    expect(xxhash64String(input)).toBe(expected);
  });

  it('matches byte-string and UTF-8 inputs of the same byte sequence', () => {
    const text = 'héllo';
    const utf8 = new TextEncoder().encode(text);
    expect(xxhash64String(text)).toBe(xxhash64Hex(utf8));
  });

  it('produces different hashes for different inputs of the same length', () => {
    expect(xxhash64String('hello')).not.toBe(xxhash64String('world'));
  });

  it('produces the same hash for two buffers that differ only in capacity', () => {
    const a = new Uint8Array([104, 101, 108, 108, 111]); // "hello", no slack
    const b = new Uint8Array(16);
    b.set([104, 101, 108, 108, 111]);
    // Pass explicitLen so only the first 5 bytes are hashed.
    expect(xxhash64Hex(a)).toBe(xxhash64Hex(b, 5));
  });
});

describe('parseContentHash', () => {
  it('parses a valid hex string back to a 64-bit BigInt', () => {
    expect(parseContentHash('ef46db3751d8e999')).toBe(0xef46db3751d8e999n);
  });

  it('returns undefined for empty / null / undefined', () => {
    expect(parseContentHash('')).toBeUndefined();
    expect(parseContentHash(null)).toBeUndefined();
    expect(parseContentHash(undefined)).toBeUndefined();
  });

  it('returns undefined for malformed input rather than throwing', () => {
    expect(parseContentHash('not-hex')).toBeUndefined();
    expect(parseContentHash('0xef46db3751d8e999')).toBeUndefined(); // BigInt won't parse the 0x prefix here
  });
});
