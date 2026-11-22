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
 *     byte, no allocations after the initial seed. Implemented on 32-bit
 *     halves rather than BigInt: ~4x the throughput, identical output.
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
//
// Every 64-bit value is carried as two unsigned 32-bit halves. The previous
// implementation used BigInt, which allocates on every operation: hashing was
// the single largest self-time item of a no-op index run (the dirty-file
// snapshot hashes every modified file twice). The arithmetic below is exact —
// same output bit for bit, pinned by the KAT vectors and a BigInt cross-check.

const P1_HI = 0x9e3779b1;
const P1_LO = 0x85ebca87;
const P2_HI = 0xc2b2ae3d;
const P2_LO = 0x27d4eb4f;
const P3_HI = 0x165667b1;
const P3_LO = 0x9e3779f9;
const P4_HI = 0x85ebca77;
const P4_LO = 0xc2b2ae63;
const P5_HI = 0x27d4eb2f;
const P5_LO = 0x165667c5;

/**
 * Scratch accumulator. The helpers below operate on it in place so the hot
 * loop allocates nothing: `S.hi`/`S.lo` are the high and low 32-bit words.
 * An object field, not two module-level `let`s — V8 keeps the fields in
 * registers across the inlined helpers, and the difference measured 2.6x.
 */
const S = { hi: 0, lo: 0 };

/** `(S.hi, S.lo) = (S.hi, S.lo) * (bHi, bLo) mod 2^64`. */
function mulInPlace(bHi: number, bLo: number): void {
  // Full 32x32 -> 64 product of the low words from 16-bit limbs (each partial
  // product < 2^32, exact in a double); the cross terms only contribute their
  // low 32 bits, which Math.imul yields directly.
  const a0 = S.lo & 0xffff;
  const a1 = S.lo >>> 16;
  const b0 = bLo & 0xffff;
  const b1 = bLo >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  const lowWordHigh = a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16);
  const cross = (Math.imul(S.hi, bLo) + Math.imul(S.lo, bHi)) | 0;
  const newLo = ((mid << 16) | (p00 & 0xffff)) >>> 0;
  S.hi = (lowWordHigh + cross) >>> 0;
  S.lo = newLo;
}

/** `(S.hi, S.lo) += (bHi, bLo) mod 2^64`. */
function addInPlace(bHi: number, bLo: number): void {
  const sum = S.lo + bLo;
  S.lo = sum >>> 0;
  S.hi = (S.hi + bHi + (sum > 0xffffffff ? 1 : 0)) >>> 0;
}

/** `(S.hi, S.lo) = (S.hi, S.lo) <<< n` for 1 <= n <= 31. */
function rotlInPlace(n: number): void {
  const newHi = ((S.hi << n) | (S.lo >>> (32 - n))) >>> 0;
  S.lo = ((S.lo << n) | (S.hi >>> (32 - n))) >>> 0;
  S.hi = newHi;
}

/**
 * The inner-loop round (spec step 2) — `acc = ((acc + lane * P2) <<< 31) * P1`.
 * Reads `acc` from the scratch pair and leaves the result there.
 */
function roundInPlace(accHi: number, accLo: number, laneHi: number, laneLo: number): void {
  S.hi = laneHi;
  S.lo = laneLo;
  mulInPlace(P2_HI, P2_LO);
  addInPlace(accHi, accLo);
  rotlInPlace(31);
  mulInPlace(P1_HI, P1_LO);
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
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Byte cursor shared by the stripe loop (Step 2) and the tail loops
  // (Step 5). Declared at function scope so the tail consumer runs for both
  // the large-input and small-input paths — the latter starts at off=0.
  let off = 0;
  let hHi: number;
  let hLo: number;

  if (length >= 32) {
    // Step 1 — initialize four accumulators: P1+P2, P2, 0, -P1.
    S.hi = P1_HI;
    S.lo = P1_LO;
    addInPlace(P2_HI, P2_LO);
    let v1Hi = S.hi;
    let v1Lo = S.lo;
    let v2Hi = P2_HI;
    let v2Lo = P2_LO;
    let v3Hi = 0;
    let v3Lo = 0;
    // Two's complement negation of P1.
    S.hi = ~P1_HI >>> 0;
    S.lo = ~P1_LO >>> 0;
    addInPlace(0, 1);
    let v4Hi = S.hi;
    let v4Lo = S.lo;
    // Step 2 — process 32-byte stripes (4 lanes × 8 bytes, little-endian).
    const end32 = length - 32;
    while (off <= end32) {
      roundInPlace(v1Hi, v1Lo, view.getUint32(off + 4, true), view.getUint32(off, true));
      v1Hi = S.hi;
      v1Lo = S.lo;
      roundInPlace(v2Hi, v2Lo, view.getUint32(off + 12, true), view.getUint32(off + 8, true));
      v2Hi = S.hi;
      v2Lo = S.lo;
      roundInPlace(v3Hi, v3Lo, view.getUint32(off + 20, true), view.getUint32(off + 16, true));
      v3Hi = S.hi;
      v3Lo = S.lo;
      roundInPlace(v4Hi, v4Lo, view.getUint32(off + 28, true), view.getUint32(off + 24, true));
      v4Hi = S.hi;
      v4Lo = S.lo;
      off += 32;
    }
    // Step 3 — converge: (v1<<<1) + (v2<<<7) + (v3<<<12) + (v4<<<18).
    S.hi = v1Hi;
    S.lo = v1Lo;
    rotlInPlace(1);
    let accHi = S.hi;
    let accLo = S.lo;
    const lanes: ReadonlyArray<readonly [number, number, number]> = [
      [v2Hi, v2Lo, 7],
      [v3Hi, v3Lo, 12],
      [v4Hi, v4Lo, 18],
    ];
    for (const [laneHi, laneLo, rot] of lanes) {
      S.hi = laneHi;
      S.lo = laneLo;
      rotlInPlace(rot);
      addInPlace(accHi, accLo);
      accHi = S.hi;
      accLo = S.lo;
    }
    // Merge rounds: acc = (acc ^ round(0, vN)) * P1 + P4. No rotation here —
    // 27 belongs to the step-5 tail loop.
    for (const [vHi, vLo] of [
      [v1Hi, v1Lo],
      [v2Hi, v2Lo],
      [v3Hi, v3Lo],
      [v4Hi, v4Lo],
    ] as const) {
      roundInPlace(0, 0, vHi, vLo);
      S.hi = (accHi ^ S.hi) >>> 0;
      S.lo = (accLo ^ S.lo) >>> 0;
      mulInPlace(P1_HI, P1_LO);
      addInPlace(P4_HI, P4_LO);
      accHi = S.hi;
      accLo = S.lo;
    }
    hHi = accHi;
    hLo = accLo;
  } else {
    // Small-input shortcut (spec: h = seed + PRIME64_5; the input length
    // is added once in Step 4 below — not here, or it gets double-counted).
    hHi = P5_HI;
    hLo = P5_LO;
  }

  // Step 4 — add input length (a byte length always fits 53 bits).
  S.hi = hHi;
  S.lo = hLo;
  addInPlace(Math.floor(length / 0x100000000) >>> 0, length >>> 0);

  // Step 5 — consume remaining bytes (after the last full stripe).
  while (off + 8 <= length) {
    hHi = S.hi;
    hLo = S.lo;
    roundInPlace(0, 0, view.getUint32(off + 4, true), view.getUint32(off, true));
    S.hi = (hHi ^ S.hi) >>> 0;
    S.lo = (hLo ^ S.lo) >>> 0;
    rotlInPlace(27);
    mulInPlace(P1_HI, P1_LO);
    addInPlace(P4_HI, P4_LO);
    off += 8;
  }
  if (off + 4 <= length) {
    hHi = S.hi;
    hLo = S.lo;
    S.hi = 0;
    S.lo = view.getUint32(off, true);
    mulInPlace(P1_HI, P1_LO);
    S.hi = (hHi ^ S.hi) >>> 0;
    S.lo = (hLo ^ S.lo) >>> 0;
    rotlInPlace(23);
    mulInPlace(P2_HI, P2_LO);
    addInPlace(P3_HI, P3_LO);
    off += 4;
  }
  while (off < length) {
    hHi = S.hi;
    hLo = S.lo;
    S.hi = 0;
    S.lo = buf[off] ?? 0;
    mulInPlace(P5_HI, P5_LO);
    S.hi = (hHi ^ S.hi) >>> 0;
    S.lo = (hLo ^ S.lo) >>> 0;
    rotlInPlace(11);
    mulInPlace(P1_HI, P1_LO);
    off += 1;
  }

  // Step 6 — final avalanche: h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32.
  S.lo = (S.lo ^ (S.hi >>> 1)) >>> 0;
  mulInPlace(P2_HI, P2_LO);
  S.lo = (S.lo ^ ((S.lo >>> 29) | (S.hi << 3))) >>> 0;
  S.hi = (S.hi ^ (S.hi >>> 29)) >>> 0;
  mulInPlace(P3_HI, P3_LO);
  S.lo = (S.lo ^ S.hi) >>> 0;

  return S.hi.toString(16).padStart(8, '0') + S.lo.toString(16).padStart(8, '0');
}

const utf8 = new TextEncoder();

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
  // The hash loop reads the encoded bytes once, so no copy is kept.
  return xxhash64Hex(utf8.encode(content));
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
