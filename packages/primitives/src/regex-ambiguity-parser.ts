/**
 * Step-budgeted regex ambiguity matcher — ADR-004.
 *
 * The final semantic layer of the ReDoS guard (packages/primitives/src/
 * regex-guard.ts, wired additively after the static layers from rounds
 * 11-14). It answers, for the CONTENT of a quantified group X:
 *
 *   does `(?:X)+` admit a string with two or more distinct parses?
 *
 * Two mechanisms, both bounded by a checker-side step budget:
 *
 *  1. PARSE AMBIGUITY (within one iteration) — build a Thompson NFA of X,
 *    ε-eliminate onto CHAR-SOURCE states (states that own an outgoing
 *    consuming edge; ε-closure is folded into transition targets), then run
 *    the squared-product construction: product nodes are (p, q) source
 *    pairs; steps consume one character synchronously through both tracks;
 *    ambiguity = a divergent pair (p ≠ q — a different branch choice)
 *    from which both tracks can still complete to acceptance. Keying the
 *    product on SOURCE states is what removes the ε-timing false positives
 *    that falsified the naive asynchronous-ε product in the ADR-004 spike:
 *    the same parse paused at different ε-points never appears.
 *
 *  2. DECOMPOSITION AMBIGUITY (across iterations) — the Sardinas–Patterson
 *    code question: `X+` is unambiguous iff L(X) is a code (uniquely
 *    decodable). This is the only mechanism that can see `(a+)+`-style
 *    self-decomposition, where the ambiguity lives BETWEEN iterations and
 *    both iterations consume through the same edges. L(X) is approximated
 *    by a finite word set W (all L-words up to WORD_MAX over a
 *    representative alphabet) and the SP residual recurrence runs on W —
 *    sound in the flagging direction: a non-code W proves L(X) not a code.
 *    Beyond the word bound or the budget the stage UNDER-REJECTS.
 *
 * Verdict doctrine (guard-wide): rejection requires a proof — an 'ambiguous'
 * verdict always carries a witness string with two decompositions. Budget
 * exhaustion ('budget') and out-of-subset content ('unparsable') both
 * ALLOW the pattern: the layer can only under-reject, never over-reject
 * relative to its subset.
 *
 * Deliberately self-contained (its own CharSet/parser copies) so the guard
 * file keeps its committed shape; the duplication is documented isolation,
 * not drift — the parity test in tools/ pins the guard entry points, and
 * this module has its own property test against a brute-force oracle.
 *
 * @module regex-ambiguity
 * @see docs/adr/adr-004-step-budgeted-regex-ambiguity-matcher.md
 */

// ---------------------------------------------------------------------------
// Char sets (compact local copy — see module doc for the isolation note)
// ---------------------------------------------------------------------------

export type CharSet = readonly (readonly [number, number])[];

export const MAX_CP = 0x10ffff;

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

/**
 * Deep-freeze a shared CharSet (tuples + array). `parseClass` spreads these
 * tables' tuples directly into its working range list and the merge loop
 * widens `last[1]` in place, so writing through a borrowed tuple used to grow
 * a global class for the rest of the process and hand later contents a false
 * 'ambiguous' verdict (see the 2026-09-02 `[\\d:]` -> DIGIT case). Frozen:
 * a reintroduced write now throws a TypeError at the offending line instead
 * of leaking state into unrelated verdicts.
 */
export function freezeSet(set: CharSet): CharSet {
  for (const range of set) Object.freeze(range);
  return Object.freeze(set);
}

export const WORD: CharSet = freezeSet([
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
]);

export const DIGIT: CharSet = freezeSet([[48, 57]]);

/** Exact JS `\s` (ASCII + the Unicode spaces ECMAScript defines). */
export const SPACE: CharSet = freezeSet([
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

// Typed Readonly on top of Object.freeze, so a key write into this table is a
// compile error (TS2542) and not merely a runtime TypeError.
const NAMED_SETS: Readonly<Record<string, CharSet>> = Object.freeze({
  w: WORD,
  W: freezeSet(complementOf(WORD)),
  d: DIGIT,
  D: freezeSet(complementOf(DIGIT)),
  s: SPACE,
  S: freezeSet(complementOf(SPACE)),
});

// `.` without dotAll: everything except the ECMAScript line terminators —
// LF (0x0a), CR (0x0d), LS (0x2028), PS (0x2029) (ECMA-262 `LineTerminator`).
// Modeling dot as [^\n] made the module's language a SUPER-language of the
// real one: the product and Sardinas–Patterson stages could "prove" overlaps
// through CR/LS/PS that the real engine refuses (e.g. `\r|.`), producing
// false 'ambiguous' verdicts — over-rejection, which this layer forbids.
export const DOT: CharSet = freezeSet([
  [0, 9],
  [11, 12],
  [14, 0x2027],
  [0x202a, MAX_CP],
]);

// `.` WITH dotAll: every code point, LF/CR/LS/PS included.
export const DOT_ALL: CharSet = freezeSet([[0, MAX_CP]]);

/**
 * ASCII case-fold closure of a charset: the set plus the upper↔lower ASCII
 * counterpart ranges of every cased ASCII member it contains.
 *
 * Deliberately an UNDER-approximation of full Unicode simple case folding:
 * non-ASCII case pairs (ñ/Ñ, ſ/s, K/K) are not expanded. Under the `i` flag
 * the modeled language therefore stays ⊆ the real flagged language, so the
 * product and Sardinas–Patterson stages can only under-reject — they may miss
 * exotic Unicode case overlaps (sound), but never invent an overlap the real
 * engine would refuse (the over-rejection this layer forbids).
 */
export function foldForCompare(set: CharSet): CharSet {
  const ranges: [number, number][] = [];
  for (const [lo, hi] of set) {
    ranges.push([lo, hi]);
    const upLo = Math.max(lo, 65);
    const upHi = Math.min(hi, 90);
    if (upLo <= upHi) ranges.push([upLo + 32, upHi + 32]);
    const lowLo = Math.max(lo, 97);
    const lowHi = Math.min(hi, 122);
    if (lowLo <= lowHi) ranges.push([lowLo - 32, lowHi - 32]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [ranges[0]!];
  for (let k = 1; k < ranges.length; k++) {
    const last = merged[merged.length - 1]!;
    if (ranges[k]![0] <= last[1] + 1) last[1] = Math.max(last[1], ranges[k]![1]!);
    else merged.push(ranges[k]!);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Total checker steps across parse + NFA + product + enumeration. */
export const CHECKER_BUDGET = 60_000;

export class Budget {
  private left = CHECKER_BUDGET;
  spend(n = 1): boolean {
    this.left -= n;
    return this.left >= 0;
  }
  get exhausted(): boolean {
    return this.left < 0;
  }
}

// ---------------------------------------------------------------------------
// Parser: regex subset → AST (bails on anything outside the subset)
// ---------------------------------------------------------------------------

export type Ast =
  | { k: 'alt'; parts: Ast[] }
  | { k: 'seq'; parts: Ast[] }
  | { k: 'rep'; node: Ast; min: number; max: number }
  | { k: 'cls'; set: CharSet };

export const MAX_COPIES = 64;
// per rep node — under-approximates huge {n,m} soundly

export class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  peek(): string | undefined {
    return this.s[this.i];
  }
  eat(ch: string): boolean {
    if (this.s[this.i] === ch) {
      this.i++;
      return true;
    }
    return false;
  }
}

export function parseAlt(
  c: Cursor,
  budget: Budget,
  foldCase: boolean,
  dotAll: boolean,
  unicode: boolean,
): Ast | null {
  const first = parseSeq(c, budget, foldCase, dotAll, unicode);
  if (first === null) return null;
  const parts: Ast[] = [first];
  while (c.eat('|')) {
    const p = parseSeq(c, budget, foldCase, dotAll, unicode);
    if (p === null) return null;
    parts.push(p);
  }
  return parts.length === 1 ? parts[0]! : { k: 'alt', parts };
}

export function parseSeq(
  c: Cursor,
  budget: Budget,
  foldCase: boolean,
  dotAll: boolean,
  unicode: boolean,
): Ast | null {
  const parts: Ast[] = [];
  for (;;) {
    const ch = c.peek();
    if (ch === undefined || ch === '|' || ch === ')') break;
    if (!budget.spend()) return null;
    let atom: Ast;
    if (ch === '(') {
      c.i++;
      if (c.s[c.i] === '?') {
        const n = c.s[c.i + 1];
        if (n === ':') {
          c.i += 2;
        } else if (n === '<' && /[A-Za-z_$]/.test(c.s[c.i + 2] ?? '')) {
          const close = c.s.indexOf('>', c.i + 2);
          if (close === -1) return null;
          c.i = close + 1;
        } else {
          return null; // lookaround or (?X — outside the subset
        }
      }
      const node = parseAlt(c, budget, foldCase, dotAll, unicode);
      if (node === null || !c.eat(')')) return null;
      atom = node;
    } else if (ch === '[') {
      const set = parseClass(c, foldCase, unicode);
      if (set === null) return null;
      atom = { k: 'cls', set };
    } else if (ch === '\\') {
      const t = parseEscape(c, unicode);
      if (t === null) return null;
      atom = { k: 'cls', set: foldCase ? foldForCompare(t) : t };
    } else if (ch === '.') {
      c.i++;
      atom = { k: 'cls', set: dotAll ? DOT_ALL : DOT };
    } else if (ch === '^' || ch === '$' || ch === '{' || ch === '*' || ch === '+' || ch === '?') {
      return null; // anchors / dangling quantifiers — outside the subset
    } else {
      // Unicode mode combines surrogate pairs into one atom. Legacy mode must
      // keep code units separate: a following quantifier applies only to the low
      // surrogate, not the whole astral character.
      const cp = unicode ? c.s.codePointAt(c.i)! : c.s.charCodeAt(c.i);
      c.i += cp > 0xffff ? 2 : 1;
      atom = { k: 'cls', set: foldCase ? foldForCompare([[cp, cp]]) : [[cp, cp]] };
    }
    // Complements, named classes and dot use shared code-point tables. Legacy
    // regexes can consume only UTF-16 units; phantom supplementary members must
    // not supply a witness for an ambiguity that the real engine cannot have.
    if (!unicode && atom.k === 'cls' && atom.set.some(([, hi]) => hi > 0xffff)) {
      atom = {
        k: 'cls',
        set: atom.set.filter(([lo]) => lo <= 0xffff).map(([lo, hi]) => [lo, Math.min(hi, 0xffff)]),
      };
    }
    const q = c.peek();
    if (q === '*') {
      c.i++;
      atom = { k: 'rep', node: atom, min: 0, max: Number.POSITIVE_INFINITY };
    } else if (q === '+') {
      c.i++;
      atom = { k: 'rep', node: atom, min: 1, max: Number.POSITIVE_INFINITY };
    } else if (q === '?') {
      c.i++;
      atom = { k: 'rep', node: atom, min: 0, max: 1 };
    } else if (q === '{') {
      const close = c.s.indexOf('}', c.i);
      if (close === -1) return null; // engine treats a lone `{` as literal — bail
      const m = /^(\d+)(,(\d*)?)?$/.exec(c.s.slice(c.i + 1, close));
      if (!m) return null;
      const min = Number.parseInt(m[1]!, 10);
      // `{n}` → max = min. `{n,}` → the `(\d*)?` group does NOT participate
      // (`m[3]` is null, not ''), and parseInt(null) is NaN — which slipped
      // past the validity guard below (NaN comparisons are false) and made
      // Nfa.build's `i < max` loop run ZERO copies, silently compiling the
      // repetition to ε and analyzing a language the pattern does not have
      // (false 'ambiguous' verdicts with invalid witnesses). Any missing or
      // empty upper bound is unbounded — the same representation the `+`
      // quantifier above already uses, which the NFA star path models.
      const max =
        m[2] === undefined ? min : m[3] ? Number.parseInt(m[3], 10) : Number.POSITIVE_INFINITY;
      if (max < min || min > MAX_COPIES || (max !== Number.POSITIVE_INFINITY && max > MAX_COPIES)) {
        return null;
      }
      c.i = close + 1;
      atom = { k: 'rep', node: atom, min, max };
    }
    parts.push(atom);
  }
  return parts.length === 0
    ? { k: 'seq', parts: [] } // ε — e.g. an empty alternation branch
    : parts.length === 1
      ? parts[0]!
      : { k: 'seq', parts };
}

export function parseClass(c: Cursor, foldCase: boolean, unicode: boolean): CharSet | null {
  const s = c.s;
  let i = c.i + 1;
  let negated = false;
  if (s[i] === '^') {
    negated = true;
    i++;
  }
  // Readonly tuple ELEMENTS, and no `as [number, number][]` cast on the
  // named-class spread below: that cast is what let a borrowed global tuple be
  // written through in 2026-09-02's DIGIT_SET corruption. The tables are
  // frozen now too, so a reintroduced write throws instead of leaking.
  const ranges: (readonly [number, number])[] = [];
  // ECMAScript closes even an empty class at its first unescaped `]`.
  while (i < s.length && s[i] !== ']') {
    let lo: number;
    if (s[i] === '\\') {
      const t = escapeAt(s, i, unicode);
      if (t === null) return null;
      if (typeof t !== 'number') {
        // No `as [number, number][]` cast (it hid both the mutability and the
        // `CharSet | undefined` from noUncheckedIndexedAccess). An unknown
        // named class is not modellable -> null = sound under-rejection.
        const shared = NAMED_SETS[t as string];
        if (shared === undefined) return null;
        ranges.push(...shared);
        i += 2;
        continue;
      }
      lo = t;
      i += escapeWidth(s, i, unicode);
    } else {
      // A legacy character class contains the two surrogate code units;
      // Unicode classes contain the combined code point (including range ends).
      lo = unicode ? s.codePointAt(i)! : s.charCodeAt(i);
      i += lo > 0xffff ? 2 : 1;
    }
    if (s[i] === '-' && s[i + 1] !== ']' && s[i + 1] !== undefined) {
      i++;
      let hi: number;
      if (s[i] === '\\') {
        const t = escapeAt(s, i, unicode);
        if (t === null || typeof t !== 'number') return null;
        hi = t;
        i += escapeWidth(s, i, unicode);
      } else {
        hi = unicode ? s.codePointAt(i)! : s.charCodeAt(i);
        i += hi > 0xffff ? 2 : 1;
      }
      if (hi < lo) return null;
      ranges.push([lo, hi]);
    } else {
      ranges.push([lo, lo]);
    }
  }
  if (s[i] !== ']') return null;
  c.i = i + 1;
  if (ranges.length === 0) return negated ? complementOf([]) : [];
  // Private copies before sorting/merging — `ranges` can hold tuples borrowed
  // from the module-level NAMED_SETS (`\d` -> DIGIT, `\w` -> WORD, …) via the
  // spread in the escape branch above. Widening `last[1]` in place there grew
  // a global class for the rest of the process, so a later unrelated content
  // (`\d|:`) was proven 'ambiguous' after an earlier one (`[\d:]`) had been
  // parsed, even though V8 keeps `\d` and `:` disjoint.
  const sorted: [number, number][] = ranges.map(([lo, hi]) => [lo, hi]);
  sorted.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]!];
  for (let k = 1; k < sorted.length; k++) {
    const last = merged[merged.length - 1]!;
    if (sorted[k]![0] <= last[1] + 1) last[1] = Math.max(last[1], sorted[k]![1]!);
    else merged.push(sorted[k]!);
  }
  // `i` folds the POSITIVE set before negation: JS `[^a]` with the i flag
  // excludes both 'a' and 'A', so the fold must precede complementOf.
  const final = foldCase ? foldForCompare(merged) : merged;
  return negated ? complementOf(final) : final;
}

// Only adjacent fixed-width Unicode escapes combine; braced escapes and
// group boundaries deliberately leave their surrogate values separate.
function surrogateEscapePair(s: string, i: number, unicode: boolean): number | null {
  if (
    !unicode ||
    !/^\\u[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(s.slice(i, i + 12))
  ) {
    return null;
  }
  const high = Number.parseInt(s.slice(i + 2, i + 6), 16);
  const low = Number.parseInt(s.slice(i + 8, i + 12), 16);
  return 0x10000 + (high - 0xd800) * 0x400 + low - 0xdc00;
}

export function escapeWidth(s: string, i: number, unicode = false): number {
  if (surrogateEscapePair(s, i, unicode) !== null) return 12;
  const ch = s[i + 1];
  if (ch === 'x') return 4;
  if (ch === 'u') return s[i + 2] === '{' ? s.indexOf('}', i + 3) - i + 1 : 6;
  if (ch === '0') {
    // Annex B legacy octal: `\0` + up to two octal digits is ONE codepoint.
    let w = 2;
    while (w < 4) {
      const d = s[i + w];
      if (d === undefined || d < '0' || d > '7') break;
      w++;
    }
    return w;
  }
  return 2;
}

export function escapeAt(s: string, i: number, unicode = false): number | string | null {
  const pair = surrogateEscapePair(s, i, unicode);
  if (pair !== null) return pair;
  const ch = s[i + 1];
  if (ch === undefined) return null;
  if (NAMED_SETS[ch] !== undefined) return ch;
  if (ch === '0') {
    // Annex B LegacyOctalEscapeSequence: `\0` followed by up to two octal
    // digits is ONE codepoint (`\01` = U+0001, `\012` = LF) — not NUL plus
    // literal digits. Non-octal followers (`\08`, `\09`) stay NUL + literal
    // (escapeWidth applies the same rule).
    let cp = 0;
    for (let k = 0; k < 2; k++) {
      const d = s[i + 2 + k];
      if (d === undefined || d < '0' || d > '7') break;
      cp = cp * 8 + (d.codePointAt(0)! - 48);
    }
    return cp;
  }
  const simple: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, v: 11 };
  if (simple[ch] !== undefined) return simple[ch]!;
  if (ch === 'x') {
    const chunk = s.slice(i + 2, i + 4);
    if (!/^[0-9a-fA-F]{2}$/.test(chunk)) return null;
    const cp = Number.parseInt(chunk, 16);
    return Number.isFinite(cp) ? cp : null;
  }
  if (ch === 'u') {
    if (s[i + 2] === '{') {
      const close = s.indexOf('}', i + 3);
      if (close === -1) return null;
      const chunk = s.slice(i + 3, close);
      if (!/^[0-9a-fA-F]+$/.test(chunk)) return null;
      const cp = Number.parseInt(chunk, 16);
      return Number.isFinite(cp) && cp <= MAX_CP ? cp : null;
    }
    const chunk = s.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(chunk)) return null;
    const cp = Number.parseInt(chunk, 16);
    return Number.isFinite(cp) ? cp : null;
  }
  if (/[A-Za-z0-9]/.test(ch)) return null; // \b \p \k \1 … — outside the subset
  return ch.codePointAt(0)!;
}

export function parseEscape(c: Cursor, unicode = false): CharSet | null {
  const t = escapeAt(c.s, c.i, unicode);
  if (t === null) return null;
  const w = escapeWidth(c.s, c.i, unicode);
  c.i += w;
  return typeof t === 'number' ? [[t, t]] : NAMED_SETS[t]!;
}
