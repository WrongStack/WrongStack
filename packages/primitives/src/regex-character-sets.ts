/**
 * Ambiguous quantified alternation — `(a|a)*`, `(a|ab)+` — backtracks
 * exponentially with a SINGLE outer quantifier because two branches can
 * consume the same prefix (measured: 7s on a 27-char subject, synchronous
 * and uninterruptible). The DANGEROUS_PATTERNS rule above only rejects a
 * DOUBLED quantifier after the group, so this class sailed through. Flag
 * a quantified group whose top-level branches are identical, prefix-related,
 * or empty; disjoint branches (`(foo|bar)+`) stay allowed. Overlapping
 * char sets are detected per token position — single-token (round 13) and
 * fixed-length multi-token sequences (round 14, `(\w\w|ab)+`).
 * Variable-length token sequences and self-decomposition ambiguity
 * (`((?:a+)|b)+`) remain undetected — the durable fix is a step-budgeted
 * matcher.
 */
/**
 * Strip a group prefix — `(?:`, lookarounds `(?= (?<=` / `(?! (?<!`, and named
 * capture groups `(?<name>` — leaving only the alternation branches to
 * compare. Named groups use the full JS identifier grammar so Unicode names
 * like `(?<ñ>…)` cannot dodge the strip (round 11).
 */
export const GROUP_PREFIX_RE =
  /^\?(?::|[=!]|<[=!]|<[$_\p{ID_Start}][$_\p{ID_Continue}\u200C\u200D]*>)/u;

// ---------------------------------------------------------------------------
// Round 13: single-token character sets
// ---------------------------------------------------------------------------

/** Inclusive code-point ranges, sorted ascending and disjoint. */
export type CharSet = readonly (readonly [number, number])[];

export const MAX_CP = 0x10ffff;

/**
 * Deep-freeze a shared CharSet: the range tuples AND the array holding them.
 *
 * These tables are handed out by reference (`singleTokenCharSet` returns
 * DOT_SET / NAMED_CLASS_SETS[...] outright, `parseCharClass` and
 * `fixedTokenSets` spread their tuples into working lists). `readonly` in the
 * type only stops the compiler; `as` casts have already been shown to erase
 * that once (the 2026-09-02 DIGIT_SET corruption — see `mergeRanges`). After
 * freezing, any future write through such a borrowed reference throws a
 * TypeError in strict-mode ESM at the offending line instead of quietly
 * widening a global class for every later verdict in the process. Fail fast
 * and locally, never leak globally.
 */
export function freezeSet(set: CharSet): CharSet {
  for (const range of set) Object.freeze(range);
  return Object.freeze(set);
}

export const WORD_SET: CharSet = freezeSet([
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
]);

export const DIGIT_SET: CharSet = freezeSet([[48, 57]]);

/** Exact JS `\s` (ASCII + the Unicode spaces ECMAScript defines). */
export const SPACE_SET: CharSet = freezeSet([
  [9, 13],
  [32, 32],
  [0x00a0, 0x00a0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);

/** `.` without the dotAll flag: everything except the ECMAScript line
 * terminators — LF (0x0a), CR (0x0d), LS (0x2028), PS (0x2029) (ECMA-262
 * `LineTerminator`). Modeling dot as [^\n] made this set a SUPERSET of the
 * real dot class, so the branch-overlap comparisons could claim intersections
 * through CR/LS/PS that the real engine refuses — e.g. `(?:\r|.)+` was
 * falsely rejected although the branches' languages are exactly disjoint
 * (no shared char → no exponential choice tree). */
export const DOT_SET: CharSet = freezeSet([
  [0, 9],
  [11, 12],
  [14, 0x2027],
  [0x202a, MAX_CP],
]);

// `.` WITH dotAll: every code point, LF/CR/LS/PS included.
export const DOT_ALL_SET: CharSet = freezeSet([[0, MAX_CP]]);

/**
 * ASCII case-fold closure of a charset (mirrors the ambiguity module's
 * foldForCompare): the set plus the upper↔lower ASCII counterpart ranges of
 * every cased ASCII member. Deliberately an UNDER-approximation of full
 * Unicode simple folding — under the `i` flag the modeled language never
 * exceeds the real flagged language, so a flagged intersection proves a real
 * overlap (no false rejections), while exotic non-ASCII case pairs remain an
 * acknowledged bypass (sound under-rejection).
 */
export function foldForCompare(set: CharSet): CharSet {
  const ranges: (readonly [number, number])[] = [];
  for (const [lo, hi] of set) {
    ranges.push([lo, hi]);
    const upLo = Math.max(lo, 65);
    const upHi = Math.min(hi, 90);
    if (upLo <= upHi) ranges.push([upLo + 32, upHi + 32]);
    const lowLo = Math.max(lo, 97);
    const lowHi = Math.min(hi, 122);
    if (lowLo <= lowHi) ranges.push([lowLo - 32, lowHi - 32]);
  }
  return mergeRanges(ranges);
}

export function complementOf(set: CharSet): CharSet {
  const out: [number, number][] = [];
  let next = 0;
  for (const [lo, hi] of set) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CP) out.push([next, MAX_CP]);
  return out;
}

export function mergeRanges(ranges: readonly (readonly [number, number])[]): CharSet {
  if (ranges.length === 0) return [];
  // COPY every range before sorting and merging. Two callers hand us tuples
  // that are not theirs to give: `parseCharClass` spreads the module-level
  // `NAMED_CLASS_SETS` entries (`\d` -> DIGIT_SET, `\w` -> WORD_SET, `\S` ->
  // the cached complementOf(WORD_SET), …) straight into its range list, and
  // the merge below widens `last[1]` in place. Doing that to a shared tuple
  // permanently grew a global character class for the rest of the process —
  // `(?:[\d:]|x)+` folded `:` (0x3a) into DIGIT_SET, after which the unrelated
  // pattern `(?:\d|:)+` was rejected as ambiguous even though V8 proves its
  // branches share no character. In-place `sort()` also reordered the caller's
  // own array. Merging now owns private copies, so no verdict can depend on
  // which patterns were compiled earlier.
  const sorted: [number, number][] = ranges.map(([lo, hi]) => [lo, hi]);
  sorted.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [sorted[0] as [number, number]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1] as [number, number];
    const r = sorted[i] as [number, number];
    if (r[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      out.push(r);
    }
  }
  return out;
}

export function charSetsIntersect(a: CharSet, b: CharSet): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [alo, ahi] = a[i] as [number, number];
    const [blo, bhi] = b[j] as [number, number];
    if (alo <= bhi && blo <= ahi) return true;
    if (ahi < bhi) i++;
    else j++;
  }
  return false;
}

// Every value here is a shared object handed out by reference and spread into
// working range lists by `parseCharClass`, so the cached complements are
// frozen exactly like the base sets — folding `_` into `\W`'s [91,94] tuple
// was one of the proven corruption paths.
export const NAMED_CLASS_SETS: Readonly<Record<string, CharSet>> = Object.freeze({
  w: WORD_SET,
  W: freezeSet(complementOf(WORD_SET)),
  d: DIGIT_SET,
  D: freezeSet(complementOf(DIGIT_SET)),
  s: SPACE_SET,
  S: freezeSet(complementOf(SPACE_SET)),
});

export interface EscapedToken {
  readonly kind: 'literal' | 'named';
  readonly cp: number;
  readonly name: string;
  readonly next: number;
}

export const SIMPLE_ESCAPES: Record<string, number> = {
  n: 10,
  r: 13,
  t: 9,
  f: 12,
  v: 11,
  b: 8, // backspace inside a class; outside, a lone `\b` is caught by matchesEmptyToken first
};

export function hexAt(s: string, start: number, len: number): number | null {
  if (start + len > s.length) return null;
  const chunk = s.slice(start, start + len);
  if (!/^[0-9a-fA-F]+$/.test(chunk)) return null;
  const cp = Number.parseInt(chunk, 16);
  return Number.isFinite(cp) ? cp : null;
}

/** Parse the escape sequence starting AT the backslash `s[i]`. Returns the
 * token and the index just past it, or null for unknown escapes (`\p`, `\k`,
 * `\c`, …) — callers treat null as "not comparable" (sound under-rejection).
 * `inClass` selects the class-context semantics of digit escapes: Annex B
 * legacy octal there, a backreference in branch position. */
export function parseEscape(
  s: string,
  i: number,
  unicode = false,
  inClass = false,
): EscapedToken | null {
  const ch = s[i + 1];
  if (ch === undefined) return null;
  if (NAMED_CLASS_SETS[ch] !== undefined) {
    return { kind: 'named', cp: -1, name: ch, next: i + 2 };
  }
  if (ch === '0') {
    // Annex B legacy octal: `\0` followed by up to two octal digits is ONE
    // codepoint (`\01` = U+0001, `\012` = LF) — not NUL plus literal digits.
    // Non-octal followers (`\08`, `\09`) stay NUL + literal. Mirrors the
    // ambiguity module's escapeAt/escapeWidth rule.
    let cp = 0;
    let next = i + 2;
    for (let k = 0; k < 2; k++) {
      const d = s[next];
      if (d === undefined || d < '0' || d > '7') break;
      cp = cp * 8 + (d.codePointAt(0)! - 48);
      next++;
    }
    return { kind: 'literal', cp, name: '', next };
  }
  const simple = SIMPLE_ESCAPES[ch];
  if (simple !== undefined) {
    return { kind: 'literal', cp: simple, name: '', next: i + 2 };
  }
  if (ch === 'x') {
    const cp = hexAt(s, i + 2, 2);
    if (cp === null) return null;
    return { kind: 'literal', cp, name: '', next: i + 4 };
  }
  if (ch === 'u') {
    if (s[i + 2] === '{') {
      if (!unicode) return null;
      const close = s.indexOf('}', i + 3);
      if (close === -1 || close - (i + 3) > 6) return null;
      const cp = hexAt(s, i + 3, close - (i + 3));
      if (cp === null || cp > MAX_CP) return null;
      return { kind: 'literal', cp, name: '', next: close + 1 };
    }
    const cp = hexAt(s, i + 2, 4);
    if (cp === null) return null;
    return { kind: 'literal', cp, name: '', next: i + 6 };
  }
  if (/[1-7]/.test(ch)) {
    // `\1`–`\7`: Annex B legacy octal INSIDE a class (non-unicode mode) —
    // `[\1]` is U+0001 plus up to two following octal digits, never the
    // literal character '1'. Outside a class the same escape is a
    // backreference, which this context-free parser does not model, and in
    // unicode mode it is a SyntaxError. All three are reasons not to claim
    // a literal digit: the old fall-through modeled `[\1]` as {0x31} while
    // V8 matched U+0001, so engine-identical branches (`(?:[\1]|[\x01])+`)
    // compared as disjoint sets and the (a|a)+ exponential class compiled.
    if (unicode || !inClass) return null;
    let cp = ch.codePointAt(0)! - 48;
    let next = i + 2;
    for (let k = 0; k < 2; k++) {
      const d = s[next];
      if (d === undefined || d < '0' || d > '7') break;
      cp = cp * 8 + (d.codePointAt(0)! - 48);
      next++;
    }
    return { kind: 'literal', cp, name: '', next };
  }
  if (/[89]/.test(ch)) {
    // `\8`/`\9`: Annex B IdentityEscape — the literal digit — in non-unicode
    // mode; a SyntaxError in unicode mode (RegExp rejects it anyway).
    if (unicode) return null;
    return { kind: 'literal', cp: ch.codePointAt(0) ?? -1, name: '', next: i + 2 };
  }
  if (/[A-Za-z]/.test(ch)) return null; // \p{…}, \k<…>, \c…, invalid — unknown
  // Escaped punctuation and separators are literals of that character.
  return { kind: 'literal', cp: ch.codePointAt(0) ?? -1, name: '', next: i + 2 };
}

/** Find the index of the `)` closing the group that opens at `s[open]`,
 * escape- and class-aware; -1 when unbalanced. */
export function groupCloseIndex(s: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let j = open; j < s.length; j++) {
    const c = s[j] as string;
    if (c === '\\') {
      j++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Strip redundant full group wraps — `(x)`, `(?:x)`, `(?<name>x)` — down to
 * the content; `((x))` → `x`. Lookarounds are zero-width and never unwrapped;
 * a wrap that is not the whole branch is left alone. */
export function unwrapGroupBranch(branch: string): string {
  let s = branch;
  for (;;) {
    if (!s.startsWith('(') || !s.endsWith(')')) return s;
    const close = groupCloseIndex(s, 0);
    if (close !== s.length - 1) return s; // not a full wrap
    let inner = s.slice(1, -1);
    if (inner.startsWith('?')) {
      if (/^(?:=|!|<=|<!)/.test(inner.slice(1))) return s; // lookaround
      const prefix = GROUP_PREFIX_RE.exec(inner);
      if (!prefix) return s;
      inner = inner.slice(prefix[0].length);
    }
    s = inner;
  }
}

/** True when the branch is exactly one zero-width token — an anchor, a word
 * boundary, or a lone lookaround — i.e. it can match the empty string. */
export function matchesEmptyToken(branch: string): boolean {
  return (
    branch === '^' ||
    branch === '$' ||
    branch === '\\b' ||
    branch === '\\B' ||
    /^\(\?(?:=|!|<=|<!)[\s\S]*\)$/.test(branch)
  );
}

/** Parse `[...]` (the branch must be exactly one class) into a char set.
 * Supports negation, ranges, named and literal escapes, empty classes, and
 * literal `-` at the edges; anything else yields null. */
export function parseCharClass(s: string, unicode = false): CharSet | null {
  if (!s.startsWith('[') || !s.endsWith(']') || s.length < 2) return null;
  let i = 1;
  let negated = false;
  if (s[i] === '^') {
    negated = true;
    i++;
  }
  // Readonly tuple ELEMENTS on purpose: the named-class branch below pushes
  // the shared frozen tables' tuples in as-is, so nothing here may write
  // through them. The removed `as [number, number][]` cast is exactly what
  // let the 2026-09-02 DIGIT_SET corruption compile.
  const ranges: (readonly [number, number])[] = [];
  // An unescaped `]` closes a class, including `[]` and `[^]`.
  while (i < s.length - 1 && s[i] !== ']') {
    const ch = s[i] as string;
    let lo: number;
    let width: number;
    if (ch === '\\') {
      const tok = parseEscape(s, i, unicode, true);
      if (!tok) return null;
      if (tok.kind === 'named') {
        // No cast: `Record<string, CharSet>` under noUncheckedIndexedAccess
        // yields `CharSet | undefined`, which the old `as [number, number][]`
        // silently erased along with the mutability guarantee. Unknown named
        // classes are NOT modellable, so yield null (sound under-rejection)
        // rather than spreading an empty set, which would claim a class we
        // have silently emptied and could under-reject a real catastrophe.
        const shared = NAMED_CLASS_SETS[tok.name];
        if (shared === undefined) return null;
        ranges.push(...shared);
        i = tok.next;
        continue; // named classes cannot be range endpoints
      }
      lo = tok.cp;
      width = tok.next - i;
    } else {
      // Astral literals are surrogate PAIRS: read from the full class text
      // at i (codePointAt combines the pair there) and advance by the code
      // point's UTF-16 width — one unit re-parses the low surrogate as a
      // phantom lone-surrogate member (round-6 sibling of df8040684).
      const cp = s.codePointAt(i) ?? -1;
      lo = cp;
      width = cp > 0xffff ? 2 : 1;
    }
    const nextCh = s[i + width];
    if (nextCh === '-' && i + width + 1 < s.length - 1 && s[i + width + 1] !== ']') {
      // range: lo-hi where hi is a single literal/escape member
      const hiStart = i + width + 1;
      let hi: number;
      if (s[hiStart] === '\\') {
        const tok = parseEscape(s, hiStart, unicode, true);
        if (tok?.kind !== 'literal') return null;
        hi = tok.cp;
        i = tok.next;
      } else {
        // Same surrogate-pair rule for the range's hi endpoint.
        hi = s.codePointAt(hiStart) ?? -1;
        i = hiStart + (hi > 0xffff ? 2 : 1);
      }
      if (hi < lo) return null;
      ranges.push([lo, hi]);
    } else {
      ranges.push([lo, lo]);
      i += width;
    }
  }
  if (i !== s.length - 1) return null; // a class followed by more tokens
  if (ranges.length === 0) return negated ? complementOf([]) : [];
  const merged = mergeRanges(ranges);
  return negated ? complementOf(merged) : merged;
}

/** Conservative char set for a branch that is EXACTLY one single-character
 * token: `.`, a literal, an escape, or a `[...]` class. Null for anything
 * else (multi-token, quantified, zero-width, unknown escape) — callers then
 * skip the set comparison, which can only under-reject, never over-reject. */
export function singleTokenCharSet(
  branch: string,
  dotAll: boolean,
  unicode = false,
): CharSet | null {
  if (branch === '.') return dotAll ? DOT_ALL_SET : DOT_SET;
  if (branch.startsWith('\\')) {
    const tok = parseEscape(branch, 0, unicode);
    if (!tok || tok.next !== branch.length) return null;
    if (tok.kind === 'named') return NAMED_CLASS_SETS[tok.name] ?? null;
    return [[tok.cp, tok.cp]];
  }
  if (branch.length === 1) {
    const cp = branch.codePointAt(0);
    return cp === undefined ? null : [[cp, cp]];
  }
  if (branch.startsWith('[')) return parseCharClass(branch, unicode);
  return null;
}

/** Round 14: per-position token char sets for a branch that is a plain
 * concatenation of single-character tokens — literals, `.`, escape classes,
 * `[...]` classes — with fixed-count `{n}` quantifiers (1 ≤ n ≤ 16)
 * expanded. Null for anything else (variable quantifiers `* + ?` `{n,}`,
 * groups, anchors, backreferences, unknown escapes): callers then skip the
 * sequence comparison, which can only under-reject, never over-reject. For
 * two such sequences language intersection is EXACT: they match a common
 * string iff lengths are equal and every position's sets intersect. */
export function fixedTokenSets(branch: string, dotAll: boolean, unicode = false): CharSet[] | null {
  const sets: CharSet[] = [];
  let i = 0;
  while (i < branch.length) {
    const ch = branch[i] as string;
    let set: CharSet | null;
    let next: number;
    if (ch === '.') {
      set = dotAll ? DOT_ALL_SET : DOT_SET;
      next = i + 1;
    } else if (ch === '\\') {
      const tok = parseEscape(branch, i, unicode);
      if (!tok) return null;
      set = tok.kind === 'named' ? (NAMED_CLASS_SETS[tok.name] ?? null) : [[tok.cp, tok.cp]];
      next = tok.next;
    } else if (ch === '[') {
      let end = i + 1;
      if (branch[end] === '^') end++;
      if (branch[end] === ']') end++; // first-position `]` is a literal member
      while (end < branch.length && branch[end] !== ']') {
        if (branch[end] === '\\') end++;
        end++;
      }
      if (end >= branch.length) return null; // unclosed class
      set = parseCharClass(branch.slice(i, end + 1), unicode);
      next = end + 1;
    } else if ('^$()*+?{|'.includes(ch)) {
      return null; // anchors, groups, quantifier starters — out of scope
    } else {
      // Astral literals are surrogate PAIRS: read the code point from the
      // full branch at i (codePointAt combines the pair there) and advance by
      // its UTF-16 width — advancing one unit re-parses the low surrogate as
      // a phantom lone-surrogate token and every per-position comparison
      // misfires for patterns containing raw astral literals.
      const cp = branch.codePointAt(i);
      if (cp === undefined) return null;
      set = [[cp, cp]];
      next = i + (cp > 0xffff ? 2 : 1);
    }
    if (set === null) return null;
    const q = branch[next];
    if (q === undefined) {
      sets.push(set);
      break;
    }
    if (q === '*' || q === '+' || q === '?') return null; // variable repetition
    if (q === '{') {
      const close = branch.indexOf('}', next);
      if (close === -1) return null; // engine treats a lone `{` as literal — bail
      const body = branch.slice(next + 1, close);
      if (!/^\d+$/.test(body)) return null; // `{n,}` / `{,m}` — variable; bail
      const n = Number.parseInt(body, 10);
      if (n < 1 || n > 16 || sets.length + n > 64) return null; // `{0}` matches ε — bail
      for (let k = 0; k < n; k++) sets.push(set);
      i = close + 1;
      continue;
    }
    sets.push(set);
    i = next;
  }
  return sets.length > 0 && sets.length <= 64 ? sets : null;
}

/** Contents of every depth-0 `(...)` group inside `s` (escape- and
 * class-aware). Used to find groups nested within a single branch; an
 * unbalanced span ends the scan — `new RegExp()` rejects the pattern anyway. */
export function directChildGroupContents(s: string): string[] {
  const children: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      for (i++; i < s.length && s[i] !== ']'; i++) {
        if (s[i] === '\\') i++;
      }
      i++; // past ']'
      continue;
    }
    if (ch !== '(') {
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '[') {
        for (j++; j < s.length && s[j] !== ']'; j++) {
          if (s[j] === '\\') j++;
        }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= s.length) break; // unbalanced — engine will reject
    children.push(s.slice(i + 1, j));
    i = j + 1;
  }
  return children;
}
