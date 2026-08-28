/**
 * Content-Addressable Hashing for incremental reindex (Phase 2).
 *
 * A 64-bit xxHash over file contents lets the indexer skip re-parsing when
 * `touch` or `git checkout` rewrites `mtime_ms` without changing actual bytes.
 * The corresponding SQLite column `files.content_hash` is added by Phase 2 to
 * the existing `files` table; see `writer-schema.ts`.
 *
 * Why xxHash64 and not SHA-256 / BLAKE3 / crypto:
 *
 *   - Non-cryptographic — we're not authenticating anything, just fingerprinting.
 *   - 64-bit output — collision probability for a million files is ~1e-13,
 *     which is well below the indexer error budget. SHA-256 is overkill.
 *   - Constant-time on small inputs — the inner loop is a few ALU ops per
 *     byte, no allocations after the initial seed.
 *   - Zero dependency — keeps `packages/tools` slim. The alternative
 *     (`hash-wasm`, `blake3-wasm`) would add ~150 KB to the bundle for a
 *     function we call once per file.
 *   - Deterministic across runs and platforms — the canonical xxHash64
 *     reference implementation is byte-identical regardless of endianness.
 *
 * Algorithm: Yann Collet's xxHash64 (BSD-2-Clause), seed `0`. The constants
 * and round/merge functions are reproduced from the xxhash spec at
 * https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md — any
 * change here must be validated against the KAT vectors in
 * `codebase-index-content-hash.test.ts`, or two different installs of
 * WrongStack will report different hashes for the same file and trigger
 * spurious re-indexing.
 *
 * Spec notations:
 *   - `<<<` = rotate-left (circular shift), NOT logical shift
 *   - `*`   = modular multiplication mod 2^64 (full 64x64 -> 64)
 *   - All multi-byte reads are little-endian
 */

// ─── xxHash64 reference constants (BSD-2-Clause, Yann Collet) ────────────────

const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

/** 64-bit mask — every operation is reduced mod 2^64. */
const MASK64 = 0xffffffffffffffffn;

/** 64-bit modular multiplication: `(a * b) mod 2^64`. */
function mul64(a: bigint, b: bigint): bigint {
  return ((a & MASK64) * (b & MASK64)) & MASK64;
}

/**
 * Rotate-left a 64-bit value by `n` bits (1 <= n <= 63).
 *
 * Spec definition: `X <<< n = (X << n) | (X >> (64 - n))`. BigInt supports
 * the full 64-bit shift; we must NOT decompose into 32-bit halves (the
 * previous implementation did that and silently moved bits across the
 * 32-bit boundary in the wrong direction).
 */
function rotl64(x: bigint, n: number): bigint {
  const v = x & MASK64;
  return ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64;
}

/** Read 8 bytes from `buf` at byte offset `off` as a little-endian BigInt. */
function readU64LE(buf: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(buf[off + i] ?? 0);
  }
  return v & MASK64;
}

/** Read 4 bytes from `buf` at byte offset `off` as a little-endian BigInt. */
function readU32LE(buf: Uint8Array, off: number): bigint {
  return (
    (BigInt(buf[off] ?? 0) |
      (BigInt(buf[off + 1] ?? 0) << 8n) |
      (BigInt(buf[off + 2] ?? 0) << 16n) |
      (BigInt(buf[off + 3] ?? 0) << 24n)) &
    MASK64
  );
}

/**
 * Mix an input accumulator — the inner-loop round function (spec step 2).
 *
 *   accN = accN + laneN * PRIME64_2
 *   accN = accN <<< 31
 *   return accN * PRIME64_1
 *
 * All three operations are 64-bit modular. The previous implementation
 * masked lane to 32 bits — that is wrong: the spec multiplies full 64x64.
 */
function xxh64Round(acc: bigint, lane: bigint): bigint {
  return mul64(rotl64((acc + mul64(lane, PRIME64_2)) & MASK64, 31), PRIME64_1);
}

/**
 * Merge an accumulator into the convergence value (spec step 3).
 *
 *   acc = acc xor round(0, accN)
 *   acc = acc * PRIME64_1
 *   return acc + PRIME64_4
 *
 * NO rotation here. The previous implementation rotated by 27 — that
 * constant belongs to the step-5 tail loop, not the merge.
 */
function xxh64MergeRound(acc: bigint, val: bigint): bigint {
  return (mul64(acc ^ xxh64Round(0n, val), PRIME64_1) + PRIME64_4) & MASK64;
}

/**
 * Compute xxHash64 of `buf` with seed `0`. Returns a 16-character lowercase
 * hex string.
 *
 * The string format is what gets stored in `files.content_hash`. Keeping it
 * hex (vs. raw BigInt) means the SQLite column can be a plain TEXT and is
 * debuggable from the `sqlite3` CLI without bespoke formatters.
 */
export function xxhash64Hex(buf: Uint8Array, explicitLen?: number): string {
  const length = explicitLen ?? buf.length;
  let h: bigint;
  // Byte cursor shared by the stripe loop (Step 2) and the tail loops
  // (Step 5). Declared at function scope so the tail consumer runs for both
  // the large-input and small-input paths — the latter starts at off=0.
  let off = 0;

  if (length >= 32) {
    // Step 1 — initialize four accumulators.
    let v1 = (PRIME64_1 + PRIME64_2) & MASK64;
    let v2 = PRIME64_2;
    let v3 = 0n;
    let v4 = (0n - PRIME64_1) & MASK64;
    // Step 2 — process 32-byte stripes (4 lanes × 8 bytes).
    const end32 = length - 32;
    while (off <= end32) {
      v1 = xxh64Round(v1, readU64LE(buf, off));
      v2 = xxh64Round(v2, readU64LE(buf, off + 8));
      v3 = xxh64Round(v3, readU64LE(buf, off + 16));
      v4 = xxh64Round(v4, readU64LE(buf, off + 24));
      off += 32;
    }
    // Step 3 — converge the four accumulators.
    h = (rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18)) & MASK64;
    h = xxh64MergeRound(h, v1);
    h = xxh64MergeRound(h, v2);
    h = xxh64MergeRound(h, v3);
    h = xxh64MergeRound(h, v4);
  } else {
    // Small-input shortcut (spec: h = seed + PRIME64_5; the input length
    // is added once in Step 4 below — not here, or it gets double-counted).
    h = PRIME64_5;
  }

  // Step 4 — add input length.
  h = (h + BigInt(length)) & MASK64;

  // Step 5 — consume remaining bytes (after the last full stripe).
  while (off + 8 <= length) {
    const k1 = xxh64Round(0n, readU64LE(buf, off));
    h = (mul64(rotl64(h ^ k1, 27), PRIME64_1) + PRIME64_4) & MASK64;
    off += 8;
  }
  if (off + 4 <= length) {
    h =
      (mul64(rotl64(h ^ mul64(readU32LE(buf, off), PRIME64_1), 23), PRIME64_2) + PRIME64_3) &
      MASK64;
    off += 4;
  }
  while (off < length) {
    h = mul64(rotl64(h ^ mul64(BigInt(buf[off] ?? 0), PRIME64_5), 11), PRIME64_1) & MASK64;
    off += 1;
  }

  // Step 6 — final avalanche.
  h = (h ^ (h >> 33n)) & MASK64;
  h = mul64(h, PRIME64_2);
  h = (h ^ (h >> 29n)) & MASK64;
  h = mul64(h, PRIME64_3);
  h = (h ^ (h >> 32n)) & MASK64;

  return h.toString(16).padStart(16, '0');
}

/**
 * Convenience wrapper: hash a UTF-8 string. The indexer feeds file contents
 * as `string` (Node.js convention) rather than `Buffer`, so this is the
 * common entry point.
 *
 * Note: the buffer capacity does NOT participate in the hash — only the
 * bytes up to `content.length` do. The caller is responsible for passing a
 * `Uint8Array` whose `.length` is the byte count of the content.
 */
export function xxhash64String(content: string): string {
  // TextEncoder is the canonical UTF-8 path and produces a fresh typed array
  // each call — the hash loop reads it once, so no copy is kept.
  return xxhash64Hex(new TextEncoder().encode(content));
}

/** Sentinel value stored in `files.content_hash` for a never-indexed file. */
const CONTENT_HASH_EMPTY = '';

/**
 * Parse a stored `content_hash` value (from SQLite) and return the
 * equivalent BigInt, or `undefined` for empty / unknown values.
 *
 * Used by the indexer's incremental path: when both the stored and the fresh
 * hash parse cleanly, they're compared as 64-bit integers in O(1) without
 * string allocation. The hex-string storage format is the on-disk contract;
 * this function is the in-memory helper.
 */
export function parseContentHash(value: string | null | undefined): bigint | undefined {
  if (!value || value === CONTENT_HASH_EMPTY) return undefined;
  try {
    return BigInt(`0x${value}`);
  } catch {
    return undefined;
  }
}
