import {
  type Ast,
  Budget,
  type CharSet,
  Cursor,
  MAX_COPIES,
  parseAlt,
} from './regex-ambiguity-parser.js';

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
      if (node.set.length > 0) this.add(s, a, node.set);
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
        if (
          diverged &&
          acceptReachable.has(e1.to) &&
          acceptReachable.has(e2.to) &&
          !completions.has(k)
        ) {
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
  let level: Array<{ config: Set<number>; s: string }> = [{ config: new Set(startClosure), s: '' }];
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
 * widens dot, and `u`/`v` selects code points rather than legacy UTF-16
 * code units for raw literals and classes. Unrecognized flags are ignored.
 */
export function detectQuantifiedAmbiguity(content: string, flags = ''): AmbiguityResult {
  const foldCase = /i/.test(flags);
  const dotAll = /s/.test(flags);
  // Out-of-subset gate (ADR-004: never over-reject). Without the u flag,
  // `\u{...}` is an Annex B identity escape — the literal text `u` with the
  // brace run as interval quantifier or literal — NOT the codepoint the
  // parser below models. Model ≠ engine here would let the stages prove
  // overlaps on text the real branches cannot share ('ambiguous' with an
  // unmatched witness). Declare such content unparsable: allow.
  if (!/[uv]/.test(flags) && /(?:^|[^\\])(?:\\\\)*\\u\{/.test(content)) {
    return { verdict: 'unparsable' };
  }
  const budget = new Budget();
  const cursor = new Cursor(content);
  const ast = parseAlt(cursor, budget, foldCase, dotAll, /[uv]/.test(flags));
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
