/**
 * Tests for the ADR-004 step-budgeted ambiguity matcher.
 *
 * Three layers of evidence:
 *  1. Unit battery — both residual classes, subsumption of rounds 11-14's
 *     catches, static-layer misses the semantic layer must now catch, and
 *     precision pins that must stay allowed.
 *  2. Witness contract — every 'ambiguous' verdict carries a witness.
 *  3. Property test — random small contents against an INDEPENDENT oracle:
 *     brute-force decomposition counting over a fixed alphabet, with word
 *     membership via the real RegExp engine. Hard assertions both ways for
 *     decided verdicts (no false positives ever; no misses within the
 *     oracle's bound), permissive verdicts skipped.
 *
 * @module regex-ambiguity
 * @see docs/adr/adr-004-step-budgeted-regex-ambiguity-matcher.md
 */

import { describe, expect, it } from 'vitest';
import { detectQuantifiedAmbiguity } from '../src/regex-ambiguity.js';

describe('detectQuantifiedAmbiguity — residual classes (ADR-004 targets)', () => {
  it('detects self-decomposition ambiguity behind wraps', () => {
    expect(detectQuantifiedAmbiguity(String.raw`(?:a+)|b`).verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('(?<g>a+)').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity(String.raw`((?:a+)|b)`).verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('a+').verdict).toBe('ambiguous');
  });

  it('detects variable-length token sequences', () => {
    expect(detectQuantifiedAmbiguity('a{1,2}|b').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('ab?|a').verdict).toBe('ambiguous');
  });

  it('detects ε-matching content (insertable empty iterations)', () => {
    expect(detectQuantifiedAmbiguity('a*').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('a?|b').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('a|').verdict).toBe('ambiguous');
  });
});

describe('detectQuantifiedAmbiguity — subsumption of rounds 11-14', () => {
  it('still detects every class the static layers catch', () => {
    expect(detectQuantifiedAmbiguity('a|a').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity(String.raw`\w|a`).verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity(String.raw`\w\w|ab`).verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('(a|a)').verdict).toBe('ambiguous');
  });
});

describe('detectQuantifiedAmbiguity — static-layer misses now caught', () => {
  it('catches quantifier-amplified 1-vs-2 char overlap', () => {
    // Round 13 pinned `(\w|ab)+` as allowed ("a 1-char branch can never
    // equal a 2+-char branch") — true pairwise, but TWO iterations of the
    // 1-char branch equal ONE iteration of the 2-char branch: 'ab' =
    // [\w→a][\w→b] = [ab]. Genuinely catastrophic; the semantic layer
    // catches it via Sardinas–Patterson.
    expect(detectQuantifiedAmbiguity(String.raw`\w|ab`).verdict).toBe('ambiguous');
  });

  it('catches quantifier-amplified length mismatch', () => {
    // Round 14 pinned `(\w\w|abc)+` as allowed (length 2 vs 3 pairwise) —
    // but 'abcabc' = [abc][abc] = [\w\w][\w\w][\w\w]. Catastrophic.
    expect(detectQuantifiedAmbiguity(String.raw`\w\w|abc`).verdict).toBe('ambiguous');
  });
});

describe('detectQuantifiedAmbiguity — precision pins (must stay allowed)', () => {
  it('allows codes and per-position-disjoint shapes', () => {
    expect(detectQuantifiedAmbiguity('foo|bar').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('x(y|z)').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('a{2}').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity(String.raw`\w\d|ab`).verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('ab|cd').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('a|b').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('ab|ac').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('[a-z]{3}|[0-9]{5}').verdict).toBe('unambiguous');
  });

  it('allows the Sardinas–Patterson code shapes the prefix heuristic over-blocks', () => {
    // {a, ab} and {\wa, ab} are CODES: no string has two decompositions.
    expect(detectQuantifiedAmbiguity('a|ab').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity(String.raw`\wa|ab`).verdict).toBe('unambiguous');
  });

  it('is permissive for out-of-subset content (under-reject only)', () => {
    const permissive = (v: string): boolean =>
      v === 'unambiguous' || v === 'unparsable' || v === 'budget';
    expect(permissive(detectQuantifiedAmbiguity(String.raw`(?=a)a|b`).verdict)).toBe(true);
    expect(permissive(detectQuantifiedAmbiguity(String.raw`\1a|b`).verdict)).toBe(true);
    expect(permissive(detectQuantifiedAmbiguity(String.raw`a\kb|c`).verdict)).toBe(true);
  });
});

describe('detectQuantifiedAmbiguity — witness contract', () => {
  it('every ambiguous verdict carries a non-empty witness', () => {
    for (const content of [String.raw`(?:a+)|b`, 'a{1,2}|b', 'a|a', String.raw`\w|ab`, 'a*']) {
      const r = detectQuantifiedAmbiguity(content);
      expect(r.verdict, content).toBe('ambiguous');
      expect(typeof r.witness === 'string' && r.witness.length > 0, content).toBe(true);
    }
  });
});

describe('detectQuantifiedAmbiguity — dot models the real JS dot', () => {
  // The default (non-dotAll) JS dot excludes CR (U+000D), LS (U+2028), and
  // PS (U+2029) — not just LF. Modeling dot as [^\n] made the module's
  // language a super-language of the real one and let the product stage
  // "prove" a false overlap (e.g. `\r|.` flagged ambiguous with witness
  // '\r', although the real engine gives '\r' exactly one parse). These
  // pins were proven failing before the fix (round-owned repro in
  // .temp_files, 2026-09-01); the real-overlap pins below keep the fix
  // from over-tightening.
  it('does not flag dot-vs-CR overlap (false positive class)', () => {
    expect(detectQuantifiedAmbiguity('\\r|.').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('.|\\r').verdict).toBe('unambiguous');
  });

  it('does not flag dot-vs-LS/PS overlap (false positive class)', () => {
    expect(detectQuantifiedAmbiguity('\\u2028|.').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('\\u2029|.').verdict).toBe('unambiguous');
  });

  it('still detects real dot overlaps (dot genuinely matches ordinary chars)', () => {
    expect(detectQuantifiedAmbiguity('.|a').verdict).toBe('ambiguous');
    // \s contains CR, which dot must NOT match — but space is in both, so
    // the overlap must be found via space, not via the excluded CR.
    expect(detectQuantifiedAmbiguity('\\s|.').verdict).toBe('ambiguous');
  });

  it('witness contract holds for real dot overlaps', () => {
    const r = detectQuantifiedAmbiguity('.|a');
    expect(r.verdict).toBe('ambiguous');
    expect(typeof r.witness === 'string' && r.witness.length > 0).toBe(true);
    expect(new RegExp(`^(?:.|a)$`).test(r.witness ?? '')).toBe(true);
  });
});

describe('detectQuantifiedAmbiguity — legacy octal escapes (Annex B)', () => {
  // `\0` followed by 1-2 octal digits is ONE codepoint (`\01` = U+0001,
  // `\012` = LF; ECMA-262 Annex B LegacyOctalEscapeSequence) — not NUL
  // followed by literal digits. The old model made `\01` a phantom
  // two-char sequence, so `\01|\x001` looked like two IDENTICAL branches
  // (false 'ambiguous', witness NUL+'1') while the real branches are
  // exactly disjoint (1 char vs 2 chars). Proven failing pre-fix in the
  // 2026-09-01 round-owned repro. fromCharCode-style escapes only: raw
  // invisible codepoints in test sources get mangled by tooling.
  it('parses \\0 + octal digits as a single codepoint', () => {
    expect(detectQuantifiedAmbiguity('\\01|\\x001').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('\\012|\\x0012').verdict).toBe('unambiguous');
  });

  it('keeps the NUL + literal model for non-octal followers', () => {
    // '8' is not an octal digit, so `\08` really is NUL + '8' and
    // `\08|\x008` IS two identical branches — genuinely ambiguous.
    expect(detectQuantifiedAmbiguity('\\08|\\x008').verdict).toBe('ambiguous');
  });
});

describe('detectQuantifiedAmbiguity — flags-aware analysis', () => {
  // Same defect class as the dot/octal pins: the analysis modeled the
  // pattern WITHOUT its flags. Under `i`, 'ab' and 'aB' are the same word,
  // so every (?:ab|aB)+ occurrence is a 2-way choice (the (a|a)+ class);
  // under `s`, dot consumes LF so '.a' and '\na' overlap. Both were proven
  // false negatives pre-fix in the 2026-09-02 round-owned repro. The ASCII
  // fold is a deliberate under-approximation of full Unicode folding (the
  // layer can only under-reject); non-ASCII case pairs remain a documented
  // bypass. Flags-off verdicts must be untouched.
  it('honors the i flag (case-folded branch identity)', () => {
    expect(detectQuantifiedAmbiguity('ab|aB', 'i').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('aB|ab', 'i').verdict).toBe('ambiguous');
  });

  it('honors the s flag (dotAll dot-vs-LF overlap)', () => {
    expect(detectQuantifiedAmbiguity('.a|\\na', 's').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('\\r|.', 's').verdict).toBe('ambiguous');
  });

  it('flags-off verdicts are unchanged', () => {
    expect(detectQuantifiedAmbiguity('ab|aB').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('\\r|.').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('.a|\\na').verdict).toBe('unambiguous');
  });
});

describe('detectQuantifiedAmbiguity — character-class merge never mutates NAMED_SETS', () => {
  // `parseClass` spreads the module-level NAMED_SETS tuples (`\d` -> DIGIT,
  // `\w` -> WORD, the cached complements, …) into its working range list, and
  // the merge loop widens `last[1]` in place. Writing through one of those
  // shared tuples grows a global class for the rest of the process, so a
  // LATER unrelated content gets a false 'ambiguous' verdict — the exact
  // over-rejection ADR-004 forbids. Verdicts must depend only on the content
  // handed in, never on what was parsed before it.
  it('parsing [\\d:] does not make \\d|: ambiguous', () => {
    // V8 oracle: a colon is never a digit, so the two branches share no
    // character and every string has exactly one parse.
    expect(/^\d$/.test(':')).toBe(false);
    expect(detectQuantifiedAmbiguity(String.raw`[\d:]x`).verdict).not.toBe('ambiguous');
    expect(detectQuantifiedAmbiguity(String.raw`\d|:`).verdict).toBe('unambiguous');
  });

  it('parsing [\\w{] does not make \\w|{ ambiguous', () => {
    expect(/^\w$/.test('{')).toBe(false);
    expect(detectQuantifiedAmbiguity(String.raw`[\w{]!`).verdict).not.toBe('ambiguous');
    expect(detectQuantifiedAmbiguity(String.raw`\w|\{`).verdict).toBe('unambiguous');
  });

  it('still proves genuine ambiguity after those classes are parsed', () => {
    // The copy-on-merge fix must not weaken the layer: `\d|\x30` really does
    // overlap ('0' is a digit), so it stays ambiguous.
    expect(detectQuantifiedAmbiguity(String.raw`\d|\x30`).verdict).toBe('ambiguous');
  });
});

describe('detectQuantifiedAmbiguity — property test vs brute-force oracle', () => {
  // Deterministic PRNG so a failure reproduces exactly.
  function lcg(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  const ALPHABET = ['a', 'b', 'c'] as const;
  const ORACLE_MAX = 5; // strings up to this length (module WORD_MAX is 6)

  /** Random content over a small grammar, depth-bounded. */
  function randomContent(rand: () => number, depth: number): string {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const atom = (): string => {
      const choice = rand();
      if (choice < 0.45) return pick(['a', 'b', 'c']);
      if (choice < 0.6) return pick(['[ab]', '[bc]', '[a-c]']);
      if (choice < 0.75) return String.raw`\w`;
      return pick(['a', 'b']); // bias toward overlap-prone literals
    };
    const quantified = (d: number): string => {
      const base = d <= 0 ? atom() : rand() < 0.25 ? `(${expr(d - 1)})` : atom();
      return base + pick(['', '', '', '?', '*', '+', '{1,2}', '{2}']);
    };
    const seq = (d: number): string => {
      const n = 1 + Math.floor(rand() * 2);
      let out = '';
      for (let i = 0; i < n; i++) out += quantified(d);
      return out;
    };
    const expr = (d: number): string =>
      rand() < 0.55
        ? `${seq(d)}|${seq(d)}`
        : rand() < 0.3
          ? `${seq(d)}|${seq(d)}|${seq(d)}`
          : seq(d);
    return expr(depth);
  }

  /**
   * Independent oracle: does `(?:content)+` admit a string (over the fixed
   * alphabet, length ≤ ORACLE_MAX) with ≥2 decompositions into L-words?
   * Word membership via the REAL RegExp engine, memoized per substring.
   * ε ∈ L counts as ambiguous immediately (insertable empty iterations).
   */
  function oracleAmbiguous(content: string): boolean {
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${content})$`);
    } catch {
      return false; // invalid — the layer bails too; nothing to compare
    }
    const memo = new Map<string, boolean>();
    const inL = (w: string): boolean => {
      const hit = memo.get(w);
      if (hit !== undefined) return hit;
      const ok = re.test(w);
      memo.set(w, ok);
      return ok;
    };
    if (inL('')) return true;
    const strings: string[] = [''];
    for (let len = 1; len <= ORACLE_MAX; len++) {
      for (const prefix of strings.filter((s) => s.length === len - 1)) {
        for (const ch of ALPHABET) strings.push(prefix + ch);
      }
    }
    for (const s of strings) {
      if (s.length < 2) continue; // need ≥2 words → ≥2 chars
      const ways = new Array<number>(s.length + 1).fill(0);
      ways[0] = 1;
      for (let j = 1; j <= s.length; j++) {
        for (let i = 0; i < j; i++) {
          if (ways[i]! > 0 && inL(s.slice(i, j))) ways[j]! += ways[i]!;
        }
      }
      if (ways[s.length]! >= 2) return true;
    }
    return false;
  }

  /**
   * Deep oracle pass for disagreement resolution: Sardinas–Patterson
   * violations can require witnesses LONGER than ORACLE_MAX (real case:
   * `([bc]+|…)…` — an 11-char witness of two ~5-char words). Enumerate the
   * engine-verified word dictionary over the alphabet plus '0' (anyMember
   * of \w — chars the module may use in its own witnesses), then look for
   * a word-pair concatenation with ≥2 dictionary decompositions.
   */
  function oracleAmbiguousDeep(content: string): boolean {
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${content})$`);
    } catch {
      return false;
    }
    const deepAlphabet = [...ALPHABET, '0'];
    const words: string[] = [];
    let level = [''];
    for (let len = 1; len <= 6 && words.length < 200; len++) {
      const next: string[] = [];
      for (const s of level) {
        for (const ch of deepAlphabet) {
          const ns = s + ch;
          if (re.test(ns)) words.push(ns);
          next.push(ns);
        }
      }
      level = next;
    }
    const wordSet = new Set(words);
    const ways = (s: string): number => {
      const dp = new Array<number>(s.length + 1).fill(0);
      dp[0] = 1;
      for (let j = 1; j <= s.length; j++) {
        for (let i = 0; i < j; i++) {
          if (dp[i]! > 0 && wordSet.has(s.slice(i, j))) dp[j]! += dp[i]!;
        }
      }
      return dp[s.length]!;
    };
    for (const wi of words) {
      for (const wj of words) {
        if (ways(wi + wj) >= 2) return true;
      }
    }
    return false;
  }

  /**
   * Parse-ambiguity oracle: any two branches of an alternation — at ANY
   * nesting depth — that both match the same word make every occurrence of
   * that word a 2-way engine choice: the `(a|a)+` class. Top-level only
   * misses nested cases (`c*(b|b)` — identical branches one group down), so
   * branch-sets are collected recursively. The decomposition oracles are
   * blind to this class (they count splits, not parses).
   */
  /** Split a fragment on top-level `|` (paren- and class-aware). */
  function splitTopLevel(frag: string): string[] {
    const branches: string[] = [];
    let depth = 0;
    let cls = false;
    let current = '';
    for (let k = 0; k < frag.length; k++) {
      const ch = frag[k]!;
      if (ch === '\\') {
        current += ch + (frag[k + 1] ?? '');
        k++;
        continue;
      }
      if (cls) {
        if (ch === ']') cls = false;
        current += ch;
        continue;
      }
      if (ch === '[') {
        cls = true;
        current += ch;
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === '|' && depth === 0) {
        branches.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    branches.push(current);
    return branches;
  }

  function branchSets(frag: string, depth = 0): string[][] {
    if (depth > 4) return [];
    const sets: string[][] = [];
    const topLevel = splitTopLevel(frag);
    if (topLevel.length >= 2) sets.push(topLevel);
    for (const b of topLevel) {
      let i = 0;
      while (i < b.length) {
        const ch = b[i]!;
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[') {
          i++;
          while (i < b.length && b[i] !== ']') {
            if (b[i] === '\\') i++;
            i++;
          }
          i++;
          continue;
        }
        if (ch === '(') {
          let d = 0;
          let j = i;
          for (; j < b.length; j++) {
            const c = b[j]!;
            if (c === '\\') {
              j++;
              continue;
            }
            if (c === '[') {
              j++;
              while (j < b.length && b[j] !== ']') {
                if (b[j] === '\\') j++;
                j++;
              }
              continue;
            }
            if (c === '(') d++;
            else if (c === ')') {
              d--;
              if (d === 0) break;
            }
          }
          if (j >= b.length) break;
          let inner = b.slice(i + 1, j);
          if (inner.startsWith('?')) {
            if (/^[=!]/.test(inner.slice(1))) {
              i = j + 1;
              continue; // lookaround — assertions, not consuming branches
            }
            const m = /^\?(?::|<[=!]|<[$_\p{ID_Start}][$_\p{ID_Continue}\u200C\u200D]*>)/u.exec(
              inner,
            );
            if (!m) {
              i = j + 1;
              continue;
            }
            inner = inner.slice(m[0].length);
          }
          sets.push(...branchSets(inner, depth + 1));
          i = j + 1;
          continue;
        }
        i++;
      }
    }
    return sets;
  }

  function oracleAmbiguousParse(content: string): boolean {
    const sets = branchSets(content);
    const deepAlphabet = [...ALPHABET, '0'];
    const words: string[] = [''];
    for (let len = 1; len <= 4; len++) {
      for (const s of words.filter((w) => w.length === len - 1)) {
        for (const ch of deepAlphabet) words.push(s + ch);
      }
    }
    for (const branches of sets) {
      const compiled = branches.map((b) => {
        try {
          return new RegExp(`^(?:${b})$`);
        } catch {
          return null;
        }
      });
      for (let i = 0; i < compiled.length; i++) {
        for (let j = i + 1; j < compiled.length; j++) {
          const ri = compiled[i];
          const rj = compiled[j];
          if (!ri || !rj) continue;
          for (const w of words) {
            if (ri.test(w) && rj.test(w)) return true;
          }
        }
      }
    }
    return false;
  }

  it('agrees with the oracle on 250 random contents (seeded)', () => {
    const rand = lcg(0xad04_2026);
    let checked = 0;
    for (let iter = 0; iter < 250; iter++) {
      const content = randomContent(rand, 2);
      const verdict = detectQuantifiedAmbiguity(content).verdict;
      if (verdict === 'unparsable' || verdict === 'budget') continue; // permissive skip
      const oracle = oracleAmbiguous(content);
      checked++;
      if (verdict === 'ambiguous') {
        // Soundness: the layer must NEVER flag what the oracles prove clean.
        // Deep pass covers long SP witnesses; parse pass covers same-word
        // branch equivalence the decomposition oracles cannot see.
        const verified = oracle || oracleAmbiguousDeep(content) || oracleAmbiguousParse(content);
        expect(verified, `false positive on ${content}`).toBe(true);
      } else {
        // Completeness within the oracle bound: no misses on decided cases.
        expect(oracle, `missed ambiguity on ${content}`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(100); // the generator must stay in-subset
  });
});

describe('detectQuantifiedAmbiguity — checker cost sanity', () => {
  it('decides a large alternation well under 50ms', () => {
    const content = Array.from(
      { length: 40 },
      (_, i) => `x{1,2}${String.fromCharCode(97 + (i % 26))}`,
    ).join('|');
    const t0 = performance.now();
    const r = detectQuantifiedAmbiguity(content);
    const dt = performance.now() - t0;
    expect(['ambiguous', 'unambiguous', 'budget']).toContain(r.verdict);
    expect(dt).toBeLessThan(50);
  });
});

describe('detectQuantifiedAmbiguity — raw astral literals model as one atom', () => {
  it('flags raw-vs-escaped astral identity in sequences and classes', () => {
    // parseSeq/parseClass advanced one UTF-16 unit per raw astral literal,
    // so the low surrogate became a phantom atom and raw-vs-escaped
    // identical branches looked disjoint: 😀a|\u{1F600}a and
    // 😀|[\u{1F600}] were reported unambiguous though both branches match
    // the same word (the (a|a)+ class under (?:X)+). Proven failing
    // pre-fix in the 2026-09-02 round-6 repro.
    expect(detectQuantifiedAmbiguity('\u{1F600}a|\\u{1F600}a').verdict).toBe('ambiguous');
    expect(detectQuantifiedAmbiguity('\u{1F600}|[\\u{1F600}]').verdict).toBe('ambiguous');
  });

  it('keeps genuinely disjoint astral branches unambiguous', () => {
    expect(detectQuantifiedAmbiguity('\u{1F600}a|\u{1F601}a').verdict).toBe('unambiguous');
    expect(detectQuantifiedAmbiguity('\u{1F600}a|\u{1F600}b').verdict).toBe('unambiguous');
  });
});
