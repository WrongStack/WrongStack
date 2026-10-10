import type { SecretScrubber } from '../types/secret-scrubber.js';
import { PATTERNS } from './secret-scrubber-patterns.js';

/**
 * `high_entropy_env` is the one pattern that needs special replacement logic
 * (it preserves the key name), so it runs in its own pass. Every other pattern
 * is folded into a single combined regex. Derive the split by type rather than
 * by hard-coded indices so adding/removing a pattern can't silently drop one.
 */
const SIMPLE_PATTERNS = PATTERNS.filter(
  (p) =>
    p.type !== 'high_entropy_env' &&
    p.type !== 'json_credential_key' &&
    p.type !== 'url_credentials',
);

/**
 * Combined single-pass regex for all simple patterns. Each alternative is a
 * capturing group so the callback can determine which original pattern fired
 * (only one group is non-undefined at match time). Order matches SIMPLE_PATTERNS
 * (longer/more-specific prefixes first). Relies on each simple pattern source
 * containing no internal capturing groups — only `(?:...)` and lookarounds.
 */
const COMBINED_REGEX = new RegExp(SIMPLE_PATTERNS.map((p) => `(${p.regex.source})`).join('|'), 'g');

/** Separate pattern for high_entropy_env (different replacement logic). */
const HIGH_ENTROPY_REGEX = PATTERNS.find((p) => p.type === 'high_entropy_env')!.regex;

/**
 * Separate pattern for json_credential_key — like high_entropy_env, it preserves
 * the key so the redacted output stays valid, readable JSON.
 */
const JSON_CREDENTIAL_REGEX = PATTERNS.find((p) => p.type === 'json_credential_key')!.regex;

/** Separate pattern for url_credentials — preserves scheme and user. */
const URL_CREDENTIALS_REGEX = PATTERNS.find((p) => p.type === 'url_credentials')!.regex;

/**
 * Replacements for the combined patterns, parallel to SIMPLE_PATTERNS. The
 * combined-regex callback indexes into this with the matched group's position.
 */
const COMBINED_REPLACEMENTS = SIMPLE_PATTERNS.map((p) => `[REDACTED:${p.type}]`);

/**
 * Private copies of every pattern, used only to find a match that straddles a
 * chunk boundary. Separate instances because a `g` regex carries `lastIndex`.
 */
const BOUNDARY_PROBES = PATTERNS.map((p) => new RegExp(p.regex.source, p.regex.flags));

/**
 * Per-chunk cap. Splits long inputs into 64 KB chunks to keep scrub() memory
 * bounded. Real scrub() inputs (LLM responses, tool outputs) are typically
 * much smaller; this cap handles edge cases without impacting normal usage.
 */
const SCRUB_CHUNK_BYTES = 64 * 1024;

/**
 * Overlap window used to nudge a chunk boundary onto a safe separator so a
 * secret straddling the 64 KB cut isn't split in half (which would leave
 * neither half matching, leaking the secret verbatim).
 *
 * Sized above the longest BOUNDED credential pattern: `high_entropy_env`
 * caps its value at 512 chars (+ key name + quotes ≈ 560) and `bearer_token`
 * at 512; every prefix-keyed pattern is far shorter. Because all of these
 * patterns are whitespace-free, the first whitespace at/after the nominal cut
 * is guaranteed to sit *past the end* of any such secret — so snapping the
 * boundary forward to it keeps every bounded secret wholly inside one chunk.
 * 1 KB gives comfortable headroom over the 560-char worst case.
 */
const SCRUB_OVERLAP_BYTES = 1024;

/**
 * Extra room past the overlap window for one whitespace-free token.
 * Prefix patterns such as `ghp_` and `eyJ` have no upper bound, so a token
 * longer than {@link SCRUB_OVERLAP_BYTES} that straddles the 64KB cut used
 * to be hard-split. Neither half matched, and the secret was emitted whole.
 * One extra chunk covers real JWTs and long PATs; a longer run is hostile
 * and still falls back to the hard cut.
 */
const SCRUB_TOKEN_SPAN_BYTES = 64 * 1024;

/**
 * Marker + shape for the one multi-line credential pattern (`private_key`).
 *
 * The whitespace-snap invariant above does NOT hold for this pattern: a PEM
 * block is newline-delimited throughout its body, so the first whitespace at
 * or after the nominal cut inside a PEM is a `\n` *within the key*. Snapping
 * there splits `-----BEGIN …` from `… -----END -----` across two chunks;
 * neither half matches the pattern and both halves leak verbatim (SEC-003).
 * {@link extendChunkBoundaryPastPem} moves such a boundary past the block's
 * closing marker instead.
 */
const PEM_PRIVATE_KEY_BEGIN_RE = /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END_MARKER = '-----END';
/**
 * Hard bound on how far a chunk boundary may extend to keep a PEM block
 * inside one chunk. Real PEMs are ≤ a few KB (a 16 KB certificate at 64
 * chars/line is ~250 lines); anything longer than this is pathological or
 * hostile, and we fall back to the hard cut rather than growing unboundedly.
 */
const MAX_PEM_BLOCK_BYTES = 64 * 1024;

/**
 * Tolerance on the END-marker position check. A block whose length sits just
 * past {@link MAX_PEM_BLOCK_BYTES} (END starting in (cap, cap+64]) would
 * otherwise be rejected knife-edge style even though extending past its
 * closing line is bounded by one line (~31 bytes). Blocks whose END starts
 * beyond this are pathological/hostile — hard cut.
 */
const PEM_END_LINE_TOLERANCE = 64;

/**
 * Move a proposed chunk boundary past a PEM private-key block that the cut
 * would otherwise split. Pure: returns `proposedEnd` unchanged unless the
 * chunk `[chunkStart, proposedEnd)` ends strictly inside an opened
 * `-----BEGIN … PRIVATE KEY-----` block whose closing marker exists within
 * {@link MAX_PEM_BLOCK_BYTES} of the opening one.
 *
 * Marker-line cuts (chimera follow-up to SEC-003): the marker test must run
 * against the FULL text, not the head — a cut landing inside the BEGIN or
 * END marker line itself leaves only a prefix of the marker in the head, and
 * a head-only match test would miss the block and leak both halves. Never
 * shrinks a boundary: when the block already ends inside the head, the
 * whitespace-snapped boundary is kept as-is.
 */
function findWhitespace(text: string, from: number, until: number): number {
  for (let j = from; j < until; j++) {
    const ch = text.charCodeAt(j);
    // space, \t, \n, \r
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) return j;
  }
  return -1;
}

/**
 * Move a proposed chunk boundary past any credential match that straddles it.
 *
 * The whitespace snap assumes a credential contains no whitespace, which holds
 * for the prefix-keyed tokens but not for `Bearer <token>`, `KEY = value` or a
 * pretty-printed `"key": "value"`: a cut inside the key word snaps to the
 * separator *inside* the match, neither chunk matches, and a prefix-less secret
 * is emitted verbatim. Probing a window around the boundary with the real
 * patterns finds those matches wherever the whitespace sits. The window is the
 * overlap size, which exceeds every bounded pattern; a longer match is the
 * hostile case the hard cut already accepts.
 */
function extendChunkBoundaryPastSpanningMatch(
  text: string,
  chunkStart: number,
  proposedEnd: number,
): number {
  const from = Math.max(chunkStart, proposedEnd - SCRUB_OVERLAP_BYTES);
  const to = Math.min(text.length, proposedEnd + SCRUB_OVERLAP_BYTES);
  const window = text.slice(from, to);
  const boundary = proposedEnd - from;
  let end = proposedEnd;
  for (const probe of BOUNDARY_PROBES) {
    probe.lastIndex = 0;
    for (let m = probe.exec(window); m !== null; m = probe.exec(window)) {
      if (m[0].length === 0) {
        probe.lastIndex++;
        continue;
      }
      const matchEnd = m.index + m[0].length;
      if (m.index < boundary && matchEnd > boundary) end = Math.max(end, from + matchEnd);
    }
  }
  return end;
}

function extendChunkBoundaryPastPem(text: string, chunkStart: number, proposedEnd: number): number {
  const head = text.slice(chunkStart, proposedEnd);
  const lastBegin = head.lastIndexOf('-----BEGIN ');
  if (lastBegin === -1) return proposedEnd;
  const fromBegin = text.slice(chunkStart + lastBegin);
  const marker = PEM_PRIVATE_KEY_BEGIN_RE.exec(fromBegin);
  // A stray "-----BEGIN " in prose that never completes into a private-key
  // marker must not grow the chunk.
  if (marker?.index !== 0) return proposedEnd;
  const bodyStart = marker[0].length;
  const cap = Math.min(text.length, chunkStart + lastBegin + MAX_PEM_BLOCK_BYTES);
  const closeIdx = fromBegin.indexOf(PEM_END_MARKER, bodyStart);
  // END must START within cap + one marker line; then the boundary extends
  // past the closing line unclamped (worst-case overshoot ~31 bytes).
  if (closeIdx === -1 || chunkStart + lastBegin + closeIdx >= cap + PEM_END_LINE_TOLERANCE) {
    return proposedEnd;
  }
  // The END marker starts within the cap — extend past its closing line even
  // when that overshoots `cap` by one line (~31 bytes). Clamping to `cap`
  // here could cut mid-`-----END` (block length in (cap-30, cap] window),
  // which fails the pattern's END tail and re-leaks the whole key body
  // (review follow-up to SEC-003). Worst-case overshoot is one marker line.
  const lineEnd = fromBegin.indexOf('\n', closeIdx);
  const end = lineEnd === -1 ? text.length : chunkStart + lastBegin + lineEnd + 1;
  return Math.max(proposedEnd, end);
}

/**
 * Quick pre-scan: check if the text contains any substring that MUST be
 * present for a credential pattern to match. If none are found, the text
 * is guaranteed clean — skip all regex passes (2 total: 16-pattern combined + high_entropy_env).
 *
 * Each anchor is the shortest unique substring from the corresponding pattern.
 * V8's `String.includes()` is hand-tuned C++ — O(n) with near-zero overhead
 * for typical tool-output lengths (100–5000 chars). A single combined regex
 * via `text.search()` is consistently slower for this many alternatives.
 */
/**
 * Anchors derived from {@link PATTERNS}, plus JSON key names.
 *
 * WS-034: this set used to be a hand-written parallel list of
 * `text.includes(...)` calls, and it had already drifted from the pattern
 * table — `twilio_sid` had no anchor at all, so that pattern could never fire.
 * Because the anchors gate ALL regex work, a missing entry silently disables a
 * pattern with no failing test. Deriving the set from the table makes that
 * class of drift impossible: `Pattern.anchor` is required, so a new pattern
 * cannot compile without declaring one.
 */
const PATTERN_ANCHORS: readonly string[] = [
  ...new Set(
    PATTERNS.flatMap((pattern) =>
      typeof pattern.anchor === 'string' ? [pattern.anchor] : [...pattern.anchor],
    ),
  ),
];

/**
 * Every anchor now comes from the pattern table.
 *
 * There used to be a second, hand-maintained `JSON_KEY_ANCHORS` list here for
 * JSON-style credential keys, described as belonging "to no single pattern".
 * That was the bug: an anchor with no backing pattern does not redact anything,
 * it only tells the pre-scan to stop short-circuiting. `{"apiKey":"…"}` cleared
 * the anchor check, matched no pattern, and went out verbatim — the exact drift
 * the `Pattern.anchor` docblock warns about, in the one place the derivation was
 * bypassed. The list is now `json_credential_key`'s declared anchor, so a
 * pattern and its anchors cannot separate again.
 */
const ALL_ANCHORS: readonly string[] = PATTERN_ANCHORS;

/** Escape a literal anchor for embedding in {@link ANCHOR_PRESCAN}. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * All {@link ALL_ANCHORS} as one alternation, built once at module load.
 *
 * Matches exactly when some anchor is a substring — the same predicate the
 * per-anchor `includes()` loop computed, in ONE pass over the text instead of
 * one pass per anchor.
 */
const ANCHOR_PRESCAN = new RegExp(ALL_ANCHORS.map(escapeLiteral).join('|'));

/**
 * RFC 6750 scheme spelling is case-insensitive. The combined scrub regex
 * cannot take the `i` flag (it would also fold `AKIA` and the other
 * case-sensitive prefixes), so the bearer alternative uses per-letter
 * classes and this pre-scan admits every casing. No `g` flag: a shared
 * global regex would skip the next text after a match.
 */
const BEARER_WORD = /bearer/i;

/**
 * Quick pre-scan: does the text contain any substring that MUST be present for
 * some credential pattern to match? If not, the text is guaranteed clean and
 * every regex pass is skipped.
 *
 * One combined regex, not a loop of `String.includes()`.
 *
 * The loop was chosen when the anchor set was small and the inputs were single
 * tool outputs: `includes()` is hand-tuned C++ and beats a regex at that size.
 * But the set is derived from the pattern table and has grown to 48 anchors,
 * and the heaviest caller is not a tool output — it is a session resume, which
 * runs this over every string in a journal. Measured on a real 133 MB journal
 * (309k strings, 124 MB of text, of which FOUR needed redacting): 48 sequential
 * `includes()` passes cost 1492 ms, one combined-alternation `test()` costs
 * 627 ms. That is 865 ms off every large resume, for an identical predicate —
 * a regex alternation of literals matches iff one of the literals occurs.
 *
 * Anchor-set growth used to make this quadratically worse; now it costs one
 * more alternative in a single scan.
 */
function hasCredentialAnchors(text: string): boolean {
  return BEARER_WORD.test(text) || ANCHOR_PRESCAN.test(text);
}

export class DefaultSecretScrubber implements SecretScrubber {
  scrub(text: string): string {
    if (!text) return text;

    // Fast path: if no credential anchor substrings exist in the text,
    // none of the 17 regex patterns can match. Skip all regex work.
    // This covers the vast majority of tool outputs (~95% of calls on
    // typical sessions are file paths, status messages, diffs, etc.).
    if (!hasCredentialAnchors(text)) return text;

    // For oversize inputs, scrub in fixed chunks to keep memory bounded.
    // The boundary is snapped FORWARD to the next whitespace so a secret
    // straddling the nominal 64 KB cut is not split in half. The first
    // overlap window covers the bounded patterns; the token span covers
    // unbounded single-line patterns (a long `ghp_` or JWT).
    if (text.length <= SCRUB_CHUNK_BYTES) {
      return this.scrubOne(text);
    }
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + SCRUB_CHUNK_BYTES, text.length);
      if (end < text.length) {
        // Look for the first whitespace at/after the nominal cut, bounded by
        // the overlap window. Extending forward (not backward) ensures any
        // secret that began before `end` finishes before the new boundary.
        const overlapLimit = Math.min(end + SCRUB_OVERLAP_BYTES, text.length);
        const tokenCap = Math.min(end + SCRUB_TOKEN_SPAN_BYTES, text.length);
        let safe = findWhitespace(text, end, overlapLimit);
        if (safe === -1 && tokenCap > overlapLimit) {
          safe = findWhitespace(text, overlapLimit, tokenCap);
        }
        // Snap onto the whitespace if found within the token span; otherwise
        // fall back to the hard cut.
        end = safe === -1 ? end : safe + 1;
        // ...and it assumes credentials hold no whitespace, which `Bearer x`,
        // `KEY = x` and `"key": "x"` do: keep such a match in one chunk.
        end = extendChunkBoundaryPastSpanningMatch(text, i, end);
        // The whitespace snap assumes whitespace-free secrets. A PEM private
        // key is multi-line: when the cut lands inside one, the snap above
        // splits it and both halves leak (SEC-003). Move the boundary past
        // the block's closing marker instead — bounded by MAX_PEM_BLOCK_BYTES.
        end = extendChunkBoundaryPastPem(text, i, end);
      }
      out.push(this.scrubOne(text.slice(i, end)));
      i = end;
    }
    return out.join('');
  }

  private scrubOne(text: string): string {
    // Redundant guard: if we reached scrubOne via the chunked path, the
    // chunk may have been small enough to anchor-skip independently.
    if (!hasCredentialAnchors(text)) return text;

    // Pass 1: combined single-pass regex for all simple patterns. Each
    // alternative is a capturing group; only the group that matched is
    // non-undefined. The trailing offset/string args replace() appends are
    // always defined, so the matched group (which precedes them) is found first.
    let out = text.replace(COMBINED_REGEX, function (match) {
      for (let i = 1; i <= SIMPLE_PATTERNS.length; i++) {
        // biome-ignore lint/complexity/noArguments: Performance-critical hot path to avoid 20+ element array allocation per secret token
        if (arguments[i] !== undefined) {
          const replacement = COMBINED_REPLACEMENTS[i - 1];
          return replacement !== undefined ? replacement : match;
        }
      }
      return match;
    });

    // Pass 2: high_entropy_env needs special handling — preserve the key name.
    // Groups: 1=leading delimiter (re-emitted so adjacent-secret separators
    // aren't collapsed), 2=key name, 3=value (redacted).
    out = out.replace(HIGH_ENTROPY_REGEX, (_match, lead, key, _value) => {
      return `${lead}${key}=[REDACTED:high_entropy_env]`;
    });

    // Pass 3: json_credential_key — preserve the key and both quotes so the
    // redacted text is still parseable JSON. Groups: 1=key with its punctuation
    // and opening quote, 2=value (redacted), 3=closing quote.
    out = out.replace(JSON_CREDENTIAL_REGEX, (_match, keyPrefix, _value, closingQuote) => {
      return `${keyPrefix}[REDACTED:json_credential_key]${closingQuote}`;
    });

    // Pass 4: url_credentials — only the password between `user:` and `@`.
    if (out.includes('://')) {
      out = out.replace(URL_CREDENTIALS_REGEX, (_match, user) => {
        return `://${user}:[REDACTED:url_credentials]`;
      });
    }

    return out;
  }

  /**
   * Recursively scrub every string value in an object/array graph. Secrets can
   * appear under any key — a URL query param, an `authorization` header, an
   * arbitrarily-named nested field — so we don't gate recursion on key names.
   * The per-string `scrub()` fast-path (anchor pre-scan) keeps this cheap: any
   * value without a credential anchor returns immediately without regex work.
   */
  scrubObject<T>(obj: T): T {
    const copies = new WeakMap<object, unknown>();
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') return this.scrub(v);
      if (v === null || typeof v !== 'object') return v;
      const source = v as object;
      if (copies.has(source)) return copies.get(source);
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        copies.set(source, out);
        for (const item of v) out.push(visit(item));
        return out;
      }
      const out: Record<string, unknown> = {};
      copies.set(source, out);
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        Object.defineProperty(out, k, {
          value: visit(val),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    };
    return visit(obj) as T;
  }

  /**
   * Copy-on-write {@link scrubObject}: clean subtrees come back by reference.
   *
   * `scrubObject` rebuilds the entire graph unconditionally — a new object for
   * every node, a new array for every array — whether or not anything was
   * redacted. On the read path that is almost all waste: measured over a real
   * 133 MB journal, 488k nodes and 309k strings were rebuilt so that FOUR
   * strings could be redacted, costing ~480 ms of allocation and the GC
   * pressure that comes with it. Rebuilding only the spine above an actual
   * redaction gives the same output for a fraction of the garbage.
   *
   * The sharing is why this is a separate method rather than a change to
   * `scrubObject`: see the contract note on `SecretScrubber.scrubObjectShared`.
   */
  scrubObjectShared<T>(obj: T): T {
    const completed = new WeakMap<object, unknown>();
    const active = new WeakSet<object>();
    let hasCycle = false;
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') return this.scrub(v);
      if (v === null || typeof v !== 'object') return v;
      const sourceObject = v as object;
      // An active node is a back-edge. Defer cyclic graphs to the full
      // cycle-aware copier after this pass; completed aliases can safely reuse
      // their scrubbed (or unchanged) result.
      if (active.has(sourceObject)) {
        hasCycle = true;
        return v;
      }
      if (completed.has(sourceObject)) return completed.get(sourceObject);
      active.add(sourceObject);
      if (Array.isArray(v)) {
        let out: unknown[] | undefined;
        for (let i = 0; i < v.length; i++) {
          const before = v[i];
          const after = visit(before);
          if (after === before) continue;
          // First change in this array: copy it, then patch. Later elements
          // already sit in the copy at their original (unchanged) values.
          out ??= [...v];
          out[i] = after;
        }
        const result = out ?? v;
        active.delete(sourceObject);
        completed.set(sourceObject, result);
        return result;
      }
      const source = v as Record<string, unknown>;
      let out: Record<string, unknown> | undefined;
      for (const k of Object.keys(source)) {
        const before = source[k];
        const after = visit(before);
        if (after === before) continue;
        out ??= { ...source };
        Object.defineProperty(out, k, {
          value: after,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const result = out ?? v;
      active.delete(sourceObject);
      completed.set(sourceObject, result);
      return result;
    };
    const result = visit(obj);
    return (hasCycle ? this.scrubObject(obj) : result) as T;
  }
}
