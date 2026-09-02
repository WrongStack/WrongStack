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

type CharSet = readonly (readonly [number, number])[];
const MAX_CP = 0x10ffff;

function complementOf(set: CharSet): CharSet {
  const out: [number, number][] = [];
  let next = 0;
  for (const [lo, hi] of set) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CP) out.push([next, MAX_CP]);
  return out;
}
function intersect(a: CharSet, b: CharSet): CharSet {
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]![0]!, b[j]![0]!);
    const hi = Math.min(a[i]![1]!, b[j]![1]!);
    if (lo <= hi) out.push([lo, hi]);
    if (a[i]![1]! < b[j]![1]!) i++;
    else j++;
  }
  return out;
}
function anyMember(set: CharSet): number {
  return set[0]![0]!;
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
function freezeSet(set: CharSet): CharSet {
  for (const range of set) Object.freeze(range);
  return Object.freeze(set);
}
const WORD: CharSet = freezeSet([
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
]);
const DIGIT: CharSet = freezeSet([[48, 57]]);
const SPACE: CharSet = freezeSet([
  [9, 13],
  [32, 32],
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
const DOT: CharSet = freezeSet([
  [0, 9],
  [11, 12],
  [14, 0x2027],
  [0x202a, MAX_CP],
]);
// `.` WITH dotAll: every code point, LF/CR/LS/PS included.
const DOT_ALL: CharSet = freezeSet([[0, MAX_CP]]);

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
function foldForCompare(set: CharSet): CharSet {
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
const CHECKER_BUDGET = 60_000;

class Budget {
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

type Ast =
  | { k: 'alt'; parts: Ast[] }
  | { k: 'seq'; parts: Ast[] }
  | { k: 'rep'; node: Ast; min: number; max: number }
  | { k: 'cls'; set: CharSet };

const MAX_COPIES = 64; // per rep node — under-approximates huge {n,m} soundly

class Cursor {
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

function parseAlt(c: Cursor, budget: Budget, foldCase: boolean, dotAll: boolean): Ast | null {
  const first = parseSeq(c, budget, foldCase, dotAll);
  if (first === null) return null;
  const parts: Ast[] = [first];
  while (c.eat('|')) {
    const p = parseSeq(c, budget, foldCase, dotAll);
    if (p === null) return null;
    parts.push(p);
  }
  return parts.length === 1 ? parts[0]! : { k: 'alt', parts };
}

function parseSeq(c: Cursor, budget: Budget, foldCase: boolean, dotAll: boolean): Ast | null {
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
      const node = parseAlt(c, budget, foldCase, dotAll);
      if (node === null || !c.eat(')')) return null;
      atom = node;
    } else if (ch === '[') {
      const set = parseClass(c, foldCase);
      if (set === null) return null;
      atom = { k: 'cls', set };
    } else if (ch === '\\') {
      const t = parseEscape(c);
      if (t === null) return null;
      atom = { k: 'cls', set: foldCase ? foldForCompare(t) : t };
    } else if (ch === '.') {
      c.i++;
      atom = { k: 'cls', set: dotAll ? DOT_ALL : DOT };
    } else if (ch === '^' || ch === '$' || ch === '{' || ch === '*' || ch === '+' || ch === '?') {
      return null; // anchors / dangling quantifiers — outside the subset
    } else {
      // Astral literals are surrogate PAIRS: read from the full source at
      // c.i (codePointAt combines the pair there) and advance by the code
      // point's UTF-16 width — one unit modeled the low surrogate as a
      // phantom atom and hid raw-vs-escape branch identity (round-6 sibling
      // of df8040684).
      const cp = c.s.codePointAt(c.i)!;
      c.i += cp > 0xffff ? 2 : 1;
      atom = { k: 'cls', set: foldCase ? foldForCompare([[cp, cp]]) : [[cp, cp]] };
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
      const max =
        m[2] === undefined ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number.parseInt(m[3]!, 10);
      if (max < min || min > MAX_COPIES || max > MAX_COPIES) return null;
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

function parseClass(c: Cursor, foldCase: boolean): CharSet | null {
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
  let first = true;
  while (i < s.length && (s[i] !== ']' || first)) {
    first = false;
    let lo: number;
    if (s[i] === '\\') {
      const t = escapeAt(s, i);
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
      i += escapeWidth(s, i);
    } else {
      // Astral literals are surrogate PAIRS: read from the full class text
      // at i and advance by the code point's UTF-16 width (round-6 sibling
      // of df8040684) — applies to the range hi endpoint below too.
      lo = s.codePointAt(i)!;
      i += lo > 0xffff ? 2 : 1;
    }
    if (s[i] === '-' && s[i + 1] !== ']' && s[i + 1] !== undefined) {
      i++;
      let hi: number;
      if (s[i] === '\\') {
        const t = escapeAt(s, i);
        if (t === null || typeof t !== 'number') return null;
        hi = t;
        i += escapeWidth(s, i);
      } else {
        hi = s.codePointAt(i)!;
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
  if (ranges.length === 0) return null;
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

function escapeWidth(s: string, i: number): number {
  const ch = s[i + 1];
  if (ch === 'x') return 4;
  if (ch === 'u') return s[i + 2] === '{' ? (s.indexOf('}', i + 3) - i + 1) : 6;
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
function escapeAt(s: string, i: number): number | string | null {
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
    const cp = Number.parseInt(s.slice(i + 2, i + 4), 16);
    return Number.isFinite(cp) ? cp : null;
  }
  if (ch === 'u') {
    if (s[i + 2] === '{') {
      const close = s.indexOf('}', i + 3);
      if (close === -1) return null;
      const cp = Number.parseInt(s.slice(i + 3, close), 16);
      return Number.isFinite(cp) && cp <= MAX_CP ? cp : null;
    }
    const cp = Number.parseInt(s.slice(i + 2, i + 6), 16);
    return Number.isFinite(cp) ? cp : null;
  }
  if (/[A-Za-z0-9]/.test(ch)) return null; // \b \p \k \1 … — outside the subset
  return ch.codePointAt(0)!;
}
function parseEscape(c: Cursor): CharSet | null {
  const t = escapeAt(c.s, c.i);
  if (t === null) return null;
  const w = escapeWidth(c.s, c.i);
  c.i += w;
  return typeof t === 'number' ? [[t, t]] : NAMED_SETS[t]!;
}

export interface AmbiguityResult {
  readonly verdict: 'ambiguous' | 'unambiguous' | 'unparsable' | 'budget';
  /** Present iff verdict === 'ambiguous': a string with ≥2 decompositions. */
  readonly witness?: string | undefined;
}

// ---------------------------------------------------------------------------
// Thompson NFA (fragment-based; recursion only on strictly smaller sub-ASTs)
// ---------------------------------------------------------------------------

interface Edge {
  readonly to: number;
  readonly set: CharSet | null; // null = ε
}
interface Frag {
  readonly start: number;
  readonly accept: number;
}

const MAX_NFA_STATES = 600;

class Nfa {
  readonly edges: Edge[][] = [];
  start = -1;
  accept = -1;

  newState(): number {
    this.edges.push([]);
    return this.edges.length - 1;
  }
  add(from: number, to: number, set: CharSet | null): void {
    this.edges[from]!.push({ to, set });
  }
  chain(f1: Frag, f2: Frag): Frag {
    this.add(f1.accept, f2.start, null);
    return { start: f1.start, accept: f2.accept };
  }
  opt(f: Frag): Frag {
    const s = this.newState();
    const a = this.newState();
    this.add(s, f.start, null);
    this.add(f.accept, a, null);
    this.add(s, a, null);
    return { start: s, accept: a };
  }
  star(node: Ast, budget: Budget): Frag | null {
    const inner = this.build(node, budget);
    if (inner === null) return null;
    const s = this.newState();
    const a = this.newState();
    this.add(s, inner.start, null);
    this.add(s, a, null); // skip (0 repetitions)
    this.add(inner.accept, inner.start, null); // loop
    this.add(inner.accept, a, null);
    return { start: s, accept: a };
  }
  build(node: Ast, budget: Budget): Frag | null {
    if (this.edges.length > MAX_NFA_STATES || !budget.spend()) return null;
    if (node.k === 'cls') {
      const s = this.newState();
      const a = this.newState();
      this.add(s, a, node.set);
      return { start: s, accept: a };
    }
    if (node.k === 'seq') {
      if (node.parts.length === 0) {
        const s = this.newState();
        return { start: s, accept: s }; // ε
      }
      let frag: Frag | null = null;
      for (const p of node.parts) {
        const f = this.build(p, budget);
        if (f === null) return null;
        frag = frag === null ? f : this.chain(frag, f);
      }
      return frag;
    }
    if (node.k === 'alt') {
      const s = this.newState();
      const a = this.newState();
      for (const p of node.parts) {
        const f = this.build(p, budget);
        if (f === null) return null;
        this.add(s, f.start, null);
        this.add(f.accept, a, null);
      }
      return { start: s, accept: a };
    }
    // rep — fragment level, never a self-referential expansion
    if (node.max === Number.POSITIVE_INFINITY) {
      if (node.min === 0) return this.star(node.node, budget);
      let frag: Frag | null = null;
      for (let i = 0; i < Math.min(node.min, MAX_COPIES); i++) {
        const copy = this.build(node.node, budget);
        if (copy === null) return null;
        frag = frag === null ? copy : this.chain(frag, copy);
      }
      const tail = this.star(node.node, budget);
      if (tail === null || frag === null) return null;
      return this.chain(frag, tail);
    }
    let frag: Frag | null = null;
    for (let i = 0; i < node.max; i++) {
      let copy = this.build(node.node, budget);
      if (copy === null) return null;
      if (i >= node.min) copy = this.opt(copy);
      frag = frag === null ? copy : this.chain(frag, copy);
    }
    if (frag === null) {
      const s = this.newState(); // a{0} — ε
      return { start: s, accept: s };
    }
    return frag;
  }
}

// ---------------------------------------------------------------------------
// ε-analysis
// ---------------------------------------------------------------------------

function epsilonClosure(nfa: Nfa, from: Iterable<number>): Set<number> {
  const out = new Set<number>(from);
  const stack = [...from];
  while (stack.length > 0) {
    const p = stack.pop()!;
    for (const e of nfa.edges[p]!) {
      if (e.set === null && !out.has(e.to)) {
        out.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 1: squared product over char-source pairs (parse ambiguity)
// ---------------------------------------------------------------------------

/**
 * Two parses of the same string differ in which branch consumed a character
 * iff the product walk reaches a configuration whose HISTORY contains a pair
 * of DISTINCT char-source states and from which both tracks can complete.
 * Product nodes are (source, source) pairs — ε-timing never appears (the
 * spike's false-positive class). Divergence is PROPAGATED: two tracks that
 * chose different branches earlier may pass through equal sources later,
 * and the ambiguity must still fire when they both complete.
 */
function parseAmbiguity(
  nfa: Nfa,
  startSources: Set<number>,
  acceptReachable: ReadonlySet<number>,
  budget: Budget,
): { ambiguous: boolean; witness?: string } {
  const n = nfa.edges.length;
  const key = (p: number, q: number): number => p * n + q;
  // key → [parentKey, stepChar, historyDiverged] (null parent = initial)
  const seen = new Map<number, [number, string, boolean] | null>();
  const completions = new Map<number, string>(); // key → char that completed both tracks
  let head = 0;
  const queue: Array<{ p: number; q: number; diverged: boolean }> = [];
  for (const p of startSources) {
    for (const q of startSources) {
      const k = key(p, q);
      if (!seen.has(k)) {
        seen.set(k, null);
        queue.push({ p, q, diverged: p !== q });
      }
    }
  }
  while (head < queue.length) {
    if (!budget.spend(4)) return { ambiguous: false };
    const { p, q, diverged } = queue[head++]!;
    const k = key(p, q);
    const nextSources = (target: number): number[] =>
      [...epsilonClosure(nfa, [target])].filter((s) => nfa.edges[s]!.some((e) => e.set !== null));
    for (const e1 of nfa.edges[p]!) {
      if (e1.set === null) continue;
      for (const e2 of nfa.edges[q]!) {
        if (e2.set === null) continue;
        const both = intersect(e1.set, e2.set);
        if (both.length === 0) continue;
        if (diverged && acceptReachable.has(e1.to) && acceptReachable.has(e2.to) && !completions.has(k)) {
          completions.set(k, String.fromCodePoint(anyMember(both)));
        }
        const from1 = nextSources(e1.to);
        const from2 = nextSources(e2.to);
        const stepChar = String.fromCodePoint(anyMember(both));
        for (const p2 of from1) {
          for (const q2 of from2) {
            const k2 = key(p2, q2);
            if (!seen.has(k2)) {
              const childDiverged = diverged || p2 !== q2;
              seen.set(k2, [k, stepChar, childDiverged]);
              queue.push({ p: p2, q: q2, diverged: childDiverged });
            }
          }
        }
      }
    }
  }
  if (completions.size === 0) return { ambiguous: false };
  // Reconstruct: chars along the parent chain of a completed pair, plus the
  // completing character — a string with two distinct parses through X.
  const [doneKey, doneChar] = completions.entries().next().value as [number, string];
  let witness = doneChar;
  let cur: [number, string, boolean] | null | undefined = seen.get(doneKey);
  while (cur !== null && cur !== undefined) {
    witness = cur[1] + witness;
    cur = seen.get(cur[0]);
  }
  return { ambiguous: true, witness };
}

// ---------------------------------------------------------------------------
// Stage 2: decomposition ambiguity — the Sardinas–Patterson code question
// ---------------------------------------------------------------------------

/**
 * `X+` is unambiguous iff L(X) is a code (uniquely decodable) — the question
 * the Sardinas–Patterson algorithm decides. L is approximated by a FINITE
 * word set W: all L-words up to WORD_MAX over a representative alphabet.
 * Sound in one direction only: if W is not a code, some string has two
 * W-decompositions, hence two L-decompositions → ambiguous. If W is a
 * code, L may not be → under-reject (never a false rejection). The SP
 * recurrence on W: S1 = {v ≠ ε : u·v ∈ W}, S_{k+1} = S_k⁻¹W ∪ W⁻¹S_k,
 * violation iff ε ∈ S_k or S_k ∩ W ≠ ∅; residuals are suffixes of W-words,
 * so the visited-set terminates. ε ∈ L is an immediate ambiguity — empty
 * iterations are insertable anywhere (empty-branch doctrine).
 */
const WORD_MAX = 6;
const MAX_WORDS = 120;

function decompositionAmbiguity(
  nfa: Nfa,
  startClosure: Set<number>,
  acceptClosureOf: ReadonlySet<number>,
  budget: Budget,
): { ambiguous: boolean; witness?: string } {
  if (startClosure.has(nfa.accept)) {
    return { ambiguous: true, witness: 'ε (empty iterations insertable)' };
  }
  // Representative alphabet: points from pairwise label intersections plus
  // one member per label — enough to realize any overlap the sets allow.
  const labels: CharSet[] = [];
  for (const edges of nfa.edges) {
    for (const e of edges) {
      if (e.set !== null && !labels.some((l) => l === e.set)) labels.push(e.set);
    }
  }
  const repsSet = new Set<number>();
  for (let i = 0; i < labels.length; i++) {
    repsSet.add(anyMember(labels[i]!));
    for (let j = i + 1; j < labels.length; j++) {
      const ov = intersect(labels[i]!, labels[j]!);
      if (ov.length > 0) repsSet.add(anyMember(ov));
    }
  }
  const reps = [...repsSet].slice(0, 8);
  if (reps.length === 0) return { ambiguous: false };

  const step = (config: ReadonlySet<number>, ch: number): Set<number> => {
    const next = new Set<number>();
    for (const p of config) {
      for (const e of nfa.edges[p]!) {
        if (e.set?.some(([lo, hi]) => ch >= lo && ch <= hi)) {
          for (const s of epsilonClosure(nfa, [e.to])) next.add(s);
        }
      }
    }
    return next;
  };
  // Enumerate W: ALL accepting strings over reps up to WORD_MAX. No config
  // dedup — different strings reaching the same config are different WORDS,
  // and dropping them shrinks W below what the SP derivation needs (a
  // config-dedup variant silently missed `(\w\w|abc)`, whose violation uses
  // the plain 2-char words 'ca'/'bc'). Breadth is bounded by the budget
  // alone; exhaustion under-rejects (sound), never invents violations.
  const words: string[] = [];
  let level: Array<{ config: Set<number>; s: string }> = [
    { config: new Set(startClosure), s: '' },
  ];
  for (let len = 1; len <= WORD_MAX && level.length > 0 && words.length < MAX_WORDS; len++) {
    if (!budget.spend(level.length * reps.length)) return { ambiguous: false };
    const nextLevel: Array<{ config: Set<number>; s: string }> = [];
    for (const { config, s } of level) {
      for (const rep of reps) {
        const next = step(config, rep);
        if (next.size === 0) continue;
        const ns = s + String.fromCodePoint(rep);
        if ([...next].some((p) => acceptClosureOf.has(p))) words.push(ns);
        nextLevel.push({ config: next, s: ns });
      }
    }
    level = nextLevel;
  }
  if (words.length === 0) return { ambiguous: false };
  const wordSet = new Set(words);

  // Sardinas–Patterson on the finite set W.
  const residualsOf = (sources: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    for (const u of sources) {
      for (const x of words) {
        // S⁻¹W: u·v ∈ W
        if (x.length > u.length && x.startsWith(u)) out.add(x.slice(u.length));
      }
    }
    return out;
  };
  const leftDiv = (src: ReadonlySet<string>): Set<string> => {
    const out = new Set<string>();
    for (const l of words) {
      for (const t of src) {
        // W⁻¹S: l·v ∈ S
        if (t.length > l.length && t.startsWith(l)) out.add(t.slice(l.length));
      }
    }
    return out;
  };
  let frontier = residualsOf(words);
  const visited = new Set<string>();
  while (frontier.size > 0) {
    if (!budget.spend(words.length)) return { ambiguous: false };
    const frozen = [...frontier].sort().join('\u0001');
    if (visited.has(frozen)) break;
    visited.add(frozen);
    for (const v of frontier) {
      if (v === '' || wordSet.has(v)) {
        return { ambiguous: true, witness: `Sardinas–Patterson residual '${v || 'ε'}'` };
      }
    }
    const next = residualsOf(frontier);
    for (const v of leftDiv(frontier)) next.add(v);
    frontier = next;
  }
  return { ambiguous: false };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Does `(?:content)+` admit a string with two or more distinct parses?
 * 'ambiguous' is a proof (witness included); 'budget' and 'unparsable'
 * both mean "allow" — the layer can only under-reject, never over-reject.
 *
 * `flags` selects which RegExp flag semantics the analysis models: `i`
 * case-folds charsets (an ASCII under-approximation of full folding), `s`
 * widens dot to every code point. Other flags do not change branch
 * languages; unrecognized flags are ignored.
 */
export function detectQuantifiedAmbiguity(content: string, flags = ''): AmbiguityResult {
  const foldCase = /i/.test(flags);
  const dotAll = /s/.test(flags);
  const budget = new Budget();
  const cursor = new Cursor(content);
  const ast = parseAlt(cursor, budget, foldCase, dotAll);
  if (ast === null || cursor.i !== content.length) return { verdict: 'unparsable' };
  const nfa = new Nfa();
  const frag = nfa.build(ast, budget);
  if (frag === null) return { verdict: budget.exhausted ? 'budget' : 'unparsable' };
  nfa.start = frag.start;
  nfa.accept = frag.accept;

  const startClosure = epsilonClosure(nfa, [nfa.start]);
  const charSources = new Set<number>();
  for (let p = 0; p < nfa.edges.length; p++) {
    if (nfa.edges[p]!.some((e) => e.set !== null)) charSources.add(p);
  }
  const acceptClosureOf = new Set<number>();
  for (let p = 0; p < nfa.edges.length; p++) {
    if (epsilonClosure(nfa, [p]).has(nfa.accept)) acceptClosureOf.add(p);
  }
  const startSources = new Set<number>();
  for (const p of startClosure) {
    if (charSources.has(p)) startSources.add(p);
  }

  // Stage 1 — parse ambiguity within one iteration.
  const s1 = parseAmbiguity(nfa, startSources, acceptClosureOf, budget);
  if (s1.ambiguous) return { verdict: 'ambiguous', witness: s1.witness };

  // Stage 2 — decomposition ambiguity across iterations (code question).
  const s2 = decompositionAmbiguity(nfa, startClosure, acceptClosureOf, budget);
  if (s2.ambiguous) return { verdict: 'ambiguous', witness: s2.witness };

  return { verdict: budget.exhausted ? 'budget' : 'unambiguous' };
}
