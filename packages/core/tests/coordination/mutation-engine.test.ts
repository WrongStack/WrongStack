import { describe, expect, it } from 'vitest';
import {
  applyMutation,
  parseMutationReport,
  planMutations,
} from '../../src/coordination/mutation-engine.js';

const SAMPLE = [
  'export function clamp(n: number, lo: number, hi: number): number {',
  '  if (n < lo) return lo;',
  '  if (n > hi) return hi;',
  '  const total = n + 1;',
  '  const diff = total - 2;',
  '  const enabled = true;',
  '  const disabled = false;',
  '  if (enabled && total >= 3) {',
  '    return total;',
  '  }',
  '  return diff;',
  '}',
  '',
  '// comment with > and + and true — must not mutate',
  '/** doc comment with > and + and true — must not mutate */',
  "  const s = 'a > b + true'; // masked string",
].join('\n');

describe('planMutations', () => {
  it('plans boundary, arithmetic, boolean and return-null mutants on real code', () => {
    const plan = planMutations('src/clamp.ts', SAMPLE);
    const kinds = [...new Set(plan.map((m) => m.kind))];

    expect(kinds).toEqual(
      expect.arrayContaining([
        'relax-boundary',
        'tighten-boundary',
        'arith-plus-to-minus',
        'arith-minus-to-plus',
        'negate-boolean',
        'return-null',
      ]),
    );
  });

  it('never plans mutants inside comments (line, JSDoc) or string literals', () => {
    const plan = planMutations('src/masked.ts', SAMPLE);
    // Dogfood finding 2026-08-20: `/** … */` openers were not masked, so the
    // planner emitted dead mutants inside doc comments. Lines 14 (// …),
    // 15 (/** … */) and 16 (masked string) must yield nothing.
    const masked = plan.filter((m) => m.line === 14 || m.line === 15 || m.line === 16);
    expect(masked).toEqual([]);
  });

  it('plans mutations for false literals, not only true', () => {
    // Dogfood finding: the negate-boolean regex `true|false` mutated to
    // `true|true` survived — no test pinned false-literal planning.
    const plan = planMutations('src/bool.ts', SAMPLE);
    const falseMutant = plan.find((m) => m.kind === 'negate-boolean' && m.line === 7);
    expect(falseMutant).toBeDefined();
    expect(falseMutant!.original).toBe('false');
    expect(falseMutant!.replacement).toBe('true');
  });

  it('produces stable, position-anchored ids', () => {
    const a = planMutations('src/x.ts', SAMPLE);
    const b = planMutations('src/x.ts', SAMPLE);
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
    for (const m of a) {
      expect(m.id).toBe(`${m.kind}#${m.line}#${m.column}`);
    }
  });

  it('caps mutants per file when maxPerFile is set', () => {
    const plan = planMutations('src/big.ts', SAMPLE, { maxPerFile: 3 });
    expect(plan.length).toBeLessThanOrEqual(3);
  });
});

describe('applyMutation', () => {
  it('applies a planned mutant exactly once at the anchored position', () => {
    const plan = planMutations('src/clamp.ts', SAMPLE);
    const relax = plan.find((m) => m.kind === 'relax-boundary');
    expect(relax).toBeDefined();
    const mutated = applyMutation(SAMPLE, relax!);
    const mutatedLine = mutated.split('\n')[relax!.line - 1]!;
    expect(mutatedLine.slice(relax!.column - 1, relax!.column - 1 + 2)).toBe('>=');
    // Exactly one line differs.
    const changedLines = mutated
      .split('\n')
      .map((l, i) => (l === SAMPLE.split('\n')[i] ? null : i))
      .filter((i): i is number => i !== null);
    expect(changedLines).toEqual([relax!.line - 1]);
  });

  it('flips boolean literals and return statements', () => {
    const plan = planMutations('src/clamp.ts', SAMPLE);
    const bool = plan.find((m) => m.kind === 'negate-boolean')!;
    expect(applyMutation(SAMPLE, bool).split('\n')[bool.line - 1]).toContain('false');
    // Find by content, not line number — SAMPLE edits shift anchors.
    const ret = plan.find((m) => m.kind === 'return-null' && m.original.includes('total'))!;
    expect(applyMutation(SAMPLE, ret).split('\n')[ret.line - 1]!.trim()).toBe('return null;');
  });

  it('is pure — same inputs give byte-identical outputs', () => {
    const plan = planMutations('src/p.ts', SAMPLE);
    for (const m of plan) {
      expect(applyMutation(SAMPLE, m)).toBe(applyMutation(SAMPLE, m));
    }
  });

  it('returns the original source when the site has drifted', () => {
    const plan = planMutations('src/d.ts', SAMPLE);
    const drifted = SAMPLE.replace('n > hi', 'n !== hi');
    const m = plan.find((x) => x.original === '>')!;
    expect(applyMutation(drifted, m)).toBe(drifted);
  });

  it('returns the original source unchanged for a line beyond end of file', () => {
    // Dogfood finding: the EOF line guard `return source` mutated to
    // `return null` survived — out-of-range lines were never tested.
    const plan = planMutations('src/eof.ts', SAMPLE);
    expect(plan.length).toBeGreaterThan(0);
    const beyond = { ...plan[0]!, line: SAMPLE.split('\n').length + 50 };
    expect(applyMutation(SAMPLE, beyond)).toBe(SAMPLE);
  });
});

describe('parseMutationReport', () => {
  it('parses a fenced JSON report', () => {
    const text =
      'Report:\n```json\n{"summary":"done","mutants":[{"id":"relax-boundary#3#9","file":"src/a.ts","line":3,"kind":"relax-boundary","status":"killed"}]}\n```';
    const r = parseMutationReport(text);
    expect(r?.summary).toBe('done');
    expect(r?.mutants).toHaveLength(1);
    expect(r?.mutants[0]?.status).toBe('killed');
  });

  it('parses a bare JSON object embedded in prose', () => {
    const text =
      'Final answer {"mutants":[{"id":"x#1#1","status":"survived","evidence":"tests still green"}]} thanks';
    const r = parseMutationReport(text);
    expect(r?.mutants[0]?.status).toBe('survived');
    expect(r?.mutants[0]?.evidence).toBe('tests still green');
  });

  it('drops entries with unknown status and returns undefined without a mutants array', () => {
    expect(parseMutationReport('{"mutants":[{"id":"x","status":"weird"}]}')?.mutants).toEqual([]);
    expect(parseMutationReport('no json here')).toBeUndefined();
    expect(parseMutationReport('{"summary":"no mutants key"}')).toBeUndefined();
  });

  it('accepts killed-by-hang as a valid outcome status', () => {
    // A hung test command is a kill detected by non-termination, not an
    // unknown: the parser must keep the row (pre-fix, "weird"-status
    // dropping would have discarded it, silently converting a kill into
    // an unreported unknown).
    const text =
      'Report:\n```json\n{"summary":"done","mutants":[{"id":"arith-plus-to-minus#299#21","file":"src/e.ts","line":299,"kind":"arith-plus-to-minus","status":"killed-by-hang","evidence":"test command exceeded timeout (60000ms)"}]}\n```';
    const r = parseMutationReport(text);
    expect(r?.mutants).toHaveLength(1);
    expect(r?.mutants[0]?.status).toBe('killed-by-hang');
    expect(r?.mutants[0]?.evidence).toBe('test command exceeded timeout (60000ms)');
  });

  // ── parseMutationReport edge-case hardening ───────────────────────────
  // The chaos subagent wraps its JSON in prose with arbitrary escaping;
  // the parser must remain robust against all of these so a
  // `mutation_test` pass never silently discards a real report.

  it('returns the first fenced-JSON block and ignores a second one', () => {
    const text = [
      'first:',
      '```json',
      JSON.stringify({
        summary: 'first',
        mutants: [{ id: 'a#1#1', file: 'a.ts', line: 1, kind: 'X', status: 'killed' }],
      }),
      '```',
      'later:',
      '```json',
      JSON.stringify({
        summary: 'second',
        mutants: [{ id: 'b#1#1', file: 'b.ts', line: 1, kind: 'X', status: 'survived' }],
      }),
      '```',
    ].join('\n');
    const r = parseMutationReport(text);
    expect(r?.summary).toBe('first');
    expect(r?.mutants).toHaveLength(1);
    expect(r?.mutants[0]?.id).toBe('a#1#1');
  });

  it('returns undefined when the only JSON candidates are malformed', () => {
    // The parser tries (1) the fenced block as-is and (2) the balanced
    // object at the first `{` in the whole text. If both candidates are
    // invalid JSON, the parser must return undefined rather than guess.
    // The first fence fails (trailing comma); the first brace-scanned
    // candidate is the SAME malformed object (still trailing comma),
    // so neither parses.
    const fenceOnly =
      'Noise\n```json\n{"mutants":[{"id":"x","status":"killed"}],}\n```\nLater text';
    expect(parseMutationReport(fenceOnly)).toBeUndefined();

    // A valid fence followed by trailing prose should still work — the
    // scanner doesn't have to scan the whole document when a fence
    // already parses cleanly.
    const valid = '```json\n{"mutants":[{"id":"ok","status":"killed"}]}\n``` trailing';
    const r = parseMutationReport(valid);
    expect(r?.mutants).toHaveLength(1);
    expect(r?.mutants[0]?.id).toBe('ok');
  });

  it('accepts an empty mutants array and a non-string summary as missing', () => {
    const empty = parseMutationReport('{"mutants":[],"summary":"ok"}');
    expect(empty?.mutants).toEqual([]);
    expect(empty?.summary).toBe('ok');

    // Non-string summary must not crash and must not be reported.
    const numeric = parseMutationReport('{"mutants":[],"summary":42}');
    expect(numeric?.summary).toBeUndefined();
    expect(numeric?.mutants).toEqual([]);
  });

  it('preserves brace-escaped evidence strings while extracting the object', () => {
    // Evidence contains quotes and curly braces; the balanced-brace scan
    // must respect the JSON string state and not terminate early.
    const text =
      'Result: {"mutants":[{"id":"m#3#5","file":"a.ts","line":3,"kind":"X","status":"killed","evidence":"expected { a: 1 } got { a: 2 }"}]} end';
    const r = parseMutationReport(text);
    expect(r?.mutants[0]?.evidence).toBe('expected { a: 1 } got { a: 2 }');
  });
});

// ── mutation-engine edge cases ─────────────────────────────────────
// These pin behavior the dogfood findings kept surfacing: arrow-fn `=>`,
// `>>`, `+=`/`-=`, JSX, switch default, and the unique quirks of the
// `return-null` family (self-equivalent `return null;` and the
// `return undefined;` → `return null;` case).

describe('planMutations — edge cases', () => {
  const FEATURES = [
    'export function run(x: number, items: number[]): number {',
    '  const bigger = x >= 10;',
    '  const rightShift = items.length >> 1;',
    '  const unsigned = x >>> 1;',
    '  const added = x += 5;', // -> triggers binary+plus regex check
    '  const subbed = x -= 1;', // -> triggers binary-minus regex check
    '  const arrow = (a: number, b: number) => a > b ? a : b;', // embedded > must NOT mutate
    '  switch (x) {',
    '    default: return -1;', // `default:` keyword must NOT mutate
    '  }',
    '  return arrow(x, items.length);',
    '}',
    '',
    '// a JSDoc with default: and >= must not mutate',
    '/** default case returns >>> when >= 0 */',
    "  const s = 'x >= 0 must not mutate';",
    '',
    '// Multi-line return must not match (regex is single-line).',
    '  return foo(',
    '    1,',
    '    2,',
    '  );',
    '',
    '// Bare `return;` (no value) must not match `return-null`.',
    'function early(): void { return; }',
  ].join('\n');

  it('never mutates arrow-fn `=>`, right-shift `>>`, or unsigned `>>>`', () => {
    const plan = planMutations('src/features.ts', FEATURES);
    // `>>` and `>>>` contain a `>` that's part of a shift operator: the
    // relaxation regex excludes trailing `>` and `=>`, so zero mutants
    // should land on lines 3 or 4.
    const shiftMutants = plan.filter((m) => m.line === 3 || m.line === 4);
    expect(shiftMutants).toEqual([]);
    // The `=>` token on line 7 is excluded by the lookahead `(?!=|>)`.
    // The same line carries a ternary `a > b` which IS a legitimate
    // boundary and so WILL produce one relax-boundary mutant — pin that
    // the `=>` itself isn't picked but a `>` elsewhere on the line can be.
    const line7 = plan.filter((m) => m.line === 7);
    expect(line7.every((m) => m.kind === 'relax-boundary')).toBe(true);
    expect(line7.length).toBe(1);
    // The one mutant must not sit on the `=>` itself (column where `=>` is,
    // i.e. we know `=>` is at ~column 39 — the actual `>` should be the
    // ternary one further along the line).
    const arrowCol = line7[0]!.column;
    expect(arrowCol).toBeGreaterThan(35);
  });

  it('never mutates `+=` / `-=` as binary `+` / `-`', () => {
    const plan = planMutations('src/features.ts', FEATURES);
    const arith = plan.filter((m) => m.line === 5 || m.line === 6);
    expect(arith).toEqual([]);
  });

  it('masks JSDoc and masked strings — produces zero mutants on those lines', () => {
    const plan = planMutations('src/features.ts', FEATURES);
    // Lines 14 (JSDoc with `>=`, `>>>`) and 15 (masked single-quoted
    // string with `>=`) must yield no mutants.
    expect(plan.filter((m) => m.line === 14)).toEqual([]);
    expect(plan.filter((m) => m.line === 15)).toEqual([]);
    // Line 9 (`default: return -1;`) DOES legitimately contain code
    // (`return -1;` and a unary-style `-`); the keyword `default:`
    // contributes no mutant, but the rest of the line does. Pin that
    // the mask only protects the keyword — the rule is "don't plan on
    // a bare keyword token", not "drop everything on the same line".
    expect(plan.filter((m) => m.line === 9).length).toBeGreaterThan(0);
  });

  it('does not match multi-line `return foo(...);` as return-null', () => {
    const plan = planMutations('src/features.ts', FEATURES);
    // Multi-line return spans lines 17-20. The regex is single-line so
    // none of these lines should produce a return-null mutant.
    const multiLine = plan.filter((m) => m.kind === 'return-null' && m.line >= 17 && m.line <= 20);
    expect(multiLine).toEqual([]);
  });

  it('does not plan a mutant on bare `return;`', () => {
    const plan = planMutations('src/features.ts', FEATURES);
    const bareReturn = plan.filter((m) => m.kind === 'return-null' && m.line === 22);
    expect(bareReturn).toEqual([]);
  });

  it('skips `return null;` because the replacement equals the original', () => {
    // The `return-null` kind guards against self-equivalent replacements;
    // if a file contains `return null;`, the guard must skip it.
    const source = ['export function noop(): null {', '  return null;', '}'].join('\n');
    const plan = planMutations('src/noop.ts', source);
    expect(plan).toEqual([]);
  });

  it('plans a mutant for `return undefined;` (replacement is `return null;`)', () => {
    // `return undefined;` is NOT self-equivalent after apply (replacement
    // is `return null;`), so the engine must plan it. This is the only
    // way to catch a "test didn't notice the function swallowed the
    // real undefined and returned null" mutation — so pinning it matters.
    const source = ['export function maybe(): undefined {', '  return undefined;', '}'].join('\n');
    const plan = planMutations('src/maybe.ts', source);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.kind).toBe('return-null');
    expect(plan[0]!.original).toBe('return undefined;');
    expect(plan[0]!.replacement).toBe('return null;');
  });

  it('pins exact 1-based column of the mutated token', () => {
    // Construct a single-line sample where the boundary token starts at a
    // known column; verify column exactly.
    // Line "  return n > 0;" — chars (0-based): ' ', ' ', 'r', 'e', 't',
    // 'u', 'r', 'n', ' ', 'n', ' ', '>'. The `>` is at index 11,
    // so the 1-based column is 12.
    const source = ['export function f(n: number): boolean {', '  return n > 0;', '}'].join('\n');
    const plan = planMutations('src/col.ts', source);
    const relax = plan.find((m) => m.kind === 'relax-boundary' && m.line === 2);
    expect(relax).toBeDefined();
    expect(relax!.column).toBe(12);
  });

  it('mutates boundary tokens with zero whitespace between operands', () => {
    const source = [
      'export function tight(a: number, b: number): boolean {',
      '  return a>=b;',
      '}',
    ].join('\n');
    const plan = planMutations('src/tight.ts', source);
    expect(plan.find((m) => m.kind === 'tighten-boundary' && m.line === 2)).toBeDefined();
  });

  // ── Golden-table dogfood pass ───────────────────────────────────────
  // This file is the actual input a chaos-monkey run would hand to the
  // planner. Hand-deriving the expected plan (every id, kind, line,
  // column, original, replacement) gives us a regression net that
  // catches any future mutation-engine change which would silently
  // break a real chaos pass — without needing to spawn the subagent.
  it('dogfood: golden plan for a representative subject file', () => {
    // Five-line sample; constructed to exhibit three common mutation
    // families on code lines (relax-boundary, arith-plus-to-minus,
    // return-null), while leaving masked lines (// comment, doc
    // comment, masked string) inert. NB: the engine's `relax-boundary`
    // regex matches `>` / `>=` only — `<` / `<=` would need an explicit
    // tighter fixture to pin a different kind.
    const source = [
      'export function subject(n: number, xs: number[]): number {',
      '  if (xs.length > 0) return -1;', // relax-boundary on `>`, return-null on `return -1;`
      '  const total = n + 1;', // arith-plus-to-minus on `+`
      '  const ok = xs.length >= 1;', // tighten-boundary on `>=` (>= → >)
      '  return ok ? total : 0;', // no standalone boolean literal → no negate-boolean
      '}',
      '',
      '// comment with > and + must not mutate',
      '/** doc comment with >= and + must not mutate */',
      "  const s = 'a > b';",
    ].join('\n');

    const plan = planMutations('src/dogfood.ts', source);

    // Helper: pull one expected mutant out of the plan.
    const findOne = (kind: string, line: number): (typeof plan)[number] => {
      const matches = plan.filter((p) => p.kind === kind && p.line === line);
      expect(matches).toHaveLength(1);
      return matches[0]!;
    };

    // Line 2 — `if (xs.length > 0) return -1;` produces a
    // relax-boundary on `>` (becomes `>=`) AND a return-null on
    // `return -1;` (becomes `return null;`).
    expect(findOne('relax-boundary', 2).original).toBe('>');
    expect(findOne('relax-boundary', 2).replacement).toBe('>=');
    expect(findOne('return-null', 2).original).toBe('return -1;');
    expect(findOne('return-null', 2).replacement).toBe('return null;');

    // Line 3 — `n + 1` produces one arith-plus-to-minus mutant (`+` → `-`).
    expect(findOne('arith-plus-to-minus', 3).original).toBe('+');
    expect(findOne('arith-plus-to-minus', 3).replacement).toBe('-');

    // Line 4 — `xs.length >= 1` produces one tighten-boundary mutant
    // (`>=` → `>`); the engine pairs `>↔>=` so this is its symmetric
    // complement of line 2.
    expect(findOne('tighten-boundary', 4).original).toBe('>=');
    expect(findOne('tighten-boundary', 4).replacement).toBe('>');

    // No negate-boolean on a truthy literal because this fixture uses
    // ternaries (`? :`) with no standalone `true`/`false` literals.
    expect(plan.filter((m) => m.kind === 'negate-boolean')).toEqual([]);

    // Comment / JSDoc / masked-string lines stay inert.
    expect(plan.filter((m) => m.line === 8 || m.line === 9 || m.line === 10)).toEqual([]);

    // id format must remain stable: <kind>#<line>#<col1based>.
    for (const m of plan) {
      expect(m.id).toBe(`${m.kind}#${m.line}#${m.column}`);
    }
  });
});

// ── Template-literal & block-comment masking (cross-line scanner) ────
// Dogfood finding 2026-08-20 (review follow-up): the old per-line
// `isMasked` could not see backticks or block comments that span lines,
// so tokens inside template text were planned as if they were code —
// mutating string content and reporting fake survivors. planMutations
// now runs one forward scanner (computeLineMasks) that tracks
// template/string/comment state ACROSS lines, with a frame stack so
// interpolation contents stay mutable code.

describe('planMutations — template & block-comment masking', () => {
  it('masks tokens inside a single-line template literal', () => {
    const source = [
      'export function f(): string {',
      '  const s = `a > b + true`;',
      '  return s;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t1.ts', source);
    expect(plan.filter((m) => m.line === 2)).toEqual([]);
    // return s; is real code and still planned.
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('masks tokens inside a multi-line template literal', () => {
    const source = [
      'export function f(): string {',
      '  const s = `start',
      '   b > c + true',
      '   d >= e',
      '  end`;',
      '  return s;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t2.ts', source);
    // Template text on lines 2-5 must yield nothing — the old per-line
    // mask leaked exactly these.
    expect(plan.filter((m) => m.line >= 2 && m.line <= 5)).toEqual([]);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 6)).toBe(true);
  });

  it('treats an escaped backtick as template text, not a terminator', () => {
    const source = [
      'export function f(): string {',
      '  const s = `a \\` b > c`;',
      '  const n = 1 > 0;',
      '  return s + String(n);',
      '}',
    ].join('\n');
    const plan = planMutations('src/t3.ts', source);
    // `>` inside the template after the escaped backtick stays masked…
    expect(plan.filter((m) => m.line === 2)).toEqual([]);
    // …and scanner state survives so line 3 remains mutable.
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 3)).toBe(true);
  });

  it('does not open a template from backticks inside strings or comments', () => {
    const source = [
      'export function f(): string {',
      "  const q = 'not ` a template';",
      '  // comment with ` backtick > and +',
      '  const n = 2 > 1;',
      '  return q + String(n);',
      '}',
    ].join('\n');
    const plan = planMutations('src/t4.ts', source);
    // If the string backtick had opened a template, line 4 would be
    // masked as template text and the `>` would silently vanish.
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 4)).toBe(true);
  });

  it('keeps interpolation contents mutable while masking template text', () => {
    const source = [
      'export function f(n: number): string {',
      '  const msg = `v=${n > 0 ? 1 : 2} end`;',
      '  return msg;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t5.ts', source);
    const interp = plan.find((m) => m.kind === 'relax-boundary' && m.line === 2);
    expect(interp).toBeDefined(); // `n > 0` is code inside ${...}
    // Template text `v=` / ` end` must contribute nothing — the only
    // line-2 mutant is the interpolation's boundary.
    expect(plan.filter((m) => m.line === 2)).toHaveLength(1);
  });

  it('handles nested templates inside interpolations', () => {
    const source = [
      'export function f(x: number): string {',
      '  const t = `a${`b${x + 1}c`}d`;',
      '  return t;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t6.ts', source);
    // `x + 1` sits in a code frame two templates deep — still mutable.
    expect(plan.some((m) => m.kind === 'arith-plus-to-minus' && m.line === 2)).toBe(true);
  });

  it('closes an interpolation only after inner object literals close', () => {
    const source = [
      'export function f(): string {',
      '  const y = `${ { a: 2 }.a + 1 } tail`;',
      '  return y;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t7.ts', source);
    expect(plan.some((m) => m.kind === 'arith-plus-to-minus' && m.line === 2)).toBe(true);
  });

  it('masks tokens inside a multi-line block comment', () => {
    const source = [
      'export function f(): number {',
      '  /* block with > and + and true',
      '     more > text',
      '  */',
      '  const n = 3 > 2;',
      '  return n;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t8.ts', source);
    expect(plan.filter((m) => m.line >= 2 && m.line <= 4)).toEqual([]);
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 5)).toBe(true);
  });

  it('keeps code after a same-line block-comment closer mutable', () => {
    const source = [
      'export function f(): number {',
      '  /* note */ const n = 4 > 3;',
      '  return n;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t9.ts', source);
    // The old whole-line `startsWith("/*")` guard dropped the entire
    // line; the scanner must mask only the comment span itself.
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 2)).toBe(true);
  });

  it('masks a template opened inside an interpolation that spans lines', () => {
    const source = [
      'export function f(n: number): string {',
      '  const z = `start ${',
      '    n >= 5',
      '  } end`;',
      '  return z;',
      '}',
    ].join('\n');
    const plan = planMutations('src/t10.ts', source);
    // `n >= 5` on line 3 is code inside a multi-line interpolation.
    expect(plan.some((m) => m.kind === 'tighten-boundary' && m.line === 3)).toBe(true);
    // The template text lines contribute nothing.
    expect(plan.filter((m) => m.line === 2 || m.line === 4)).toEqual([]);
  });

  it('plans return-null for a return of a template literal (start-anchored containment)', () => {
    // Regression (review follow-up): the return-null token spans the whole
    // `return <expr>;` match, which legitimately CROSSES masked template
    // text. Full-span containment silently dropped these mutants; the
    // check now anchors at the token start. NB: the fixture must be a
    // brace-free template — the return-null regex's expression class
    // excludes `{`/`}`, so `${...}` interpolations never match at all
    // (pre-existing engine limitation, unrelated to containment).
    const source = ['export function greet(): string {', '  return `hello > world`;', '}'].join(
      '\n',
    );
    const plan = planMutations('src/t11.ts', source);
    const ret = plan.find((m) => m.kind === 'return-null' && m.line === 2);
    expect(ret).toBeDefined();
    expect(ret!.original).toBe('return `hello > world`;');
    expect(ret!.replacement).toBe('return null;');
  });

  it('does not plan mutants for `return` appearing inside template text', () => {
    // The mirror case: a bare `return` word in template TEXT must not
    // become a return-null mutant just because start-anchored containment
    // is more permissive — the token must BEGIN in code.
    const source = [
      'export function doc(): string {',
      '  const t = `usage:',
      '    return early > 0;',
      '  `;',
      '  const n = 1 > 0;',
      '  return t + String(n);',
      '}',
    ].join('\n');
    const plan = planMutations('src/t12.ts', source);
    expect(plan.filter((m) => m.line >= 2 && m.line <= 4)).toEqual([]);
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 5)).toBe(true);
  });
});

// ── Regex-literal masking ───────────────────────────────────────────
// Review follow-up: the scanner had no regex-literal awareness, so a
// regex containing braces inside a template interpolation corrupted the
// interpolation depth counter — `/\{/` inflated depth (interpolation
// never closed; template text mutated as code) and `/}/` popped it
// early (real interpolation code masked). A regex whose body contained
// `/*` could even mimic a block-comment opener and swallow following
// lines. Regex literals are now skipped wholesale via a prev-token
// heuristic: a `/` starts a regex when the previous significant token
// cannot END an operand.

describe('planMutations — regex-literal masking', () => {
  it('keeps a { inside an interpolation regex from inflating the depth counter', () => {
    // Old failure: `/\{/g` incremented depth, the interpolation's real
    // closing `}` was consumed as an object-literal close, and the
    // template tail ` > b` mutated as if it were code — while the real
    // `return t;` after the template was swallowed by a phantom frame.
    const source = [
      'export function f(s: string): string {',
      '  const t = `a ${s.replace(/\\{/g, "")} > b`;',
      '  return t;',
      '}',
    ].join('\n');
    const plan = planMutations('src/r1.ts', source);
    // No mutants from the template text tail (the ` > b` is not code).
    expect(plan.filter((m) => m.line === 2)).toEqual([]);
    // The scanner resynced: the return after the template is live code.
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('keeps a } inside an interpolation regex from closing the interpolation early', () => {
    // Old failure: `/}/g` popped the interpolation frame at the regex's
    // `}`, so the REAL code after it (`|| n > 1`) was masked as template
    // text and its comparison never planned.
    const source = [
      'export function g(s: string, n: number): string {',
      '  const u = `x ${s.replace(/}/g, "") || n > 1} + y`;',
      '  return u;',
      '}',
    ].join('\n');
    const plan = planMutations('src/r2.ts', source);
    // `n > 1` lives in the interpolation → its boundary mutant is planned.
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 2)).toBe(true);
    // The template tail ` + y` is still masked — no arithmetic mutant.
    expect(plan.filter((m) => m.kind === 'arith-plus-to-minus' && m.line === 2)).toEqual([]);
  });

  it('does not let a regex character class mimic a block-comment opener', () => {
    // Old failure: `/[/*]{2}/g` — the `/*` inside the class opened a
    // phantom block comment with no `*/` closer, masking every
    // following line until one appeared.
    const source = [
      'export function h(s: string): boolean {',
      '  const clean = s.replace(/[/*]{2}/g, "");',
      '  return clean.length > 1;',
      '}',
    ].join('\n');
    const plan = planMutations('src/r3.ts', source);
    // The regex body itself yields nothing…
    expect(plan.filter((m) => m.line === 2)).toEqual([]);
    // …and the following line stays plannable (no phantom comment).
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 3)).toBe(true);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('consumes escaped slashes inside a regex literal and keeps trailing code live', () => {
    // The `> c` sits INSIDE the regex body, after the escaped slash. An
    // implementation that wrongly terminates the regex at `\/` would
    // treat it as code and plan a relax-boundary mutant there — so this
    // fixture actually detects premature termination. Only the `>` in
    // `n > 2` (after the real closing slash) may be planned.
    const source = [
      'export function k(s: string, n: number): boolean {',
      '  const ok = /a\\/b > c/.test(s) && n > 2;',
      '  return ok;',
      '}',
    ].join('\n');
    const plan = planMutations('src/r4.ts', source);
    const relax = plan.filter((m) => m.kind === 'relax-boundary' && m.line === 2);
    expect(relax).toHaveLength(1); // only the `n > 2` boundary
    expect(relax[0]!.column).toBe(38); // positioned after the real regex close
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('treats a slash after an identifier as division, not a regex literal', () => {
    // Over-masking division would swallow the rest of the line as a
    // phantom regex and drop its mutants.
    const source = [
      'export function d(total: number): boolean {',
      '  const ok = total / 2 > 1;',
      '  return ok;',
      '}',
    ].join('\n');
    const plan = planMutations('src/r5.ts', source);
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 2)).toBe(true);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });
});

// ── return-null endpoint containment ────────────────────────────────
// Review follow-up (chimera finding 2 of 2): the return-null regex is
// lazy — `[^;{}\n]+?` stops at the FIRST semicolon, which can sit
// inside string or template text. Start-anchored containment let that
// partial-token match through, and applyMutation spliced `return null;`
// mid-string, producing syntactically invalid code whose compile
// failure could be falsely recorded as a kill. The family is now
// flagged `endpointsInCode`: BOTH the token's first and last
// characters must sit in code ranges.

describe('planMutations — return-null endpoint containment', () => {
  it('never plans a return-null whose terminating semicolon is inside a string', () => {
    const source = [
      'export function quote(): string {',
      "  return 'a;b';",
      '}',
    ].join('\n');
    const plan = planMutations('src/e1.ts', source);
    // Old behavior: token `return 'a;` planned; splicing it produced
    // `return null;b';` — invalid code, false kill risk.
    expect(plan.filter((m) => m.kind === 'return-null')).toEqual([]);
  });

  it('still plans a clean return whose terminating semicolon is code', () => {
    const source = [
      'export function id(s: string): string {',
      '  return s;',
      '}',
    ].join('\n');
    const plan = planMutations('src/e2.ts', source);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 2)).toBe(true);
  });

  it('skips a return-null call whose first semicolon hides in a string argument', () => {
    const source = [
      'export function pick2(): string {',
      "  return pick('x;', 'y');",
      '}',
    ].join('\n');
    const plan = planMutations('src/e3.ts', source);
    // The lazy match is `return pick('x;` — terminating `;` masked.
    expect(plan.filter((m) => m.kind === 'return-null')).toEqual([]);
  });

  it('skips a return-null whose terminating semicolon is inside template text', () => {
    const source = ['export function doc2(): string {', '  return `a;b`;', '}'].join('\n');
    const plan = planMutations('src/e4.ts', source);
    // Match is `return `a;` — the `;` lives in template text (masked).
    expect(plan.filter((m) => m.kind === 'return-null')).toEqual([]);
  });
});

// ── Slash-context classification (paren-kind + cross-line token) ────
// Hardening follow-up: the regex heuristic classified a `/` by the
// previous token on the SAME line only, and treated every `)` as
// operand-ending. Two failures: `if (ok) /re > ex/.test(s)` read the
// regex body as code (the unsafe direction — a `>` inside a regex
// became a planned mutant), and a line-leading `/ 2` continuing a
// division from the previous line was masked as a phantom regex (lost
// coverage). The scanner now tracks the paren KIND (control header vs
// expression) per frame and carries the last significant token ACROSS
// lines: a control-header `)` does not end an operand (if-body may
// start with a regex), an identifier before a line break does
// (continued division).

describe('planMutations — slash context (paren-kind, cross-line)', () => {
  it('masks an if-body regex literal — control-header `)` does not end an operand', () => {
    const source = [
      'export function f(ok: boolean, s: string): string {',
      '  if (ok) /a > b/.test(s);',
      '  return s;',
      '}',
    ].join('\n');
    const plan = planMutations('src/s1.ts', source);
    // The `>` lives inside the regex body — never planned. Old
    // behavior: `)` from the if-header read as operand-end → regex
    // body treated as code → relax-boundary mutant inside `/a > b/`.
    expect(plan.filter((m) => m.kind === 'relax-boundary' && m.line === 2)).toEqual([]);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('treats a line-leading slash after an identifier as continued division', () => {
    const source = [
      'export function g(total: number): boolean {',
      '  const half =',
      '    total / 2;',
      '  return half > 1;',
      '}',
    ].join('\n');
    const plan = planMutations('src/s2.ts', source);
    // Old behavior: line-leading `/` saw no previous token on its own
    // line → classified as regex → ` 2;` masked (harmless) but the
    // division itself gone; the real loss shows in the NEXT line being
    // resynced from a phantom frame. The `>` on line 4 must be planned.
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 4)).toBe(true);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 4)).toBe(true);
  });

  it('still classifies same-line division after a call as division, nested parens intact', () => {
    const source = [
      'export function h(xs: number[], k: number): boolean {',
      '  const ok = xs.reduce((a, b) => a + b, 0) / k > 1;',
      '  return ok;',
      '}',
    ].join('\n');
    const plan = planMutations('src/s3.ts', source);
    // `)` of reduce(...) is an EXPRESSION paren — the `/ k` after it is
    // division (not a regex), so the `>` at line end is planned. The
    // arrow `=>` is not a boundary mutant by construction.
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 2)).toBe(true);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('still masks a regex after a control header spanning to a new line', () => {
    const source = [
      'export function j(ok: boolean, s: string): string {',
      '  if (',
      '    ok',
      '  ) /x > y/.test(s);',
      '  return s;',
      '}',
    ].join('\n');
    const plan = planMutations('src/s4.ts', source);
    // The control-header `)` sits on its own line; the regex starts
    // line 4. Cross-line token tracking must still see
    // control-paren-close → regex, so its body stays masked.
    expect(plan.filter((m) => m.kind === 'relax-boundary' && m.line === 4)).toEqual([]);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 5)).toBe(true);
  });
});

// ── Dogfood pinning tests (2026-08-20 run: 77% kill rate) ───────────
// A mutation pass executed against this suite's own engine surfaced
// behaviors no test pinned. Each group names the surviving mutant(s)
// it exists to kill; the survivors that remain after these are judged
// true/near equivalents (output-identical under the suite's oracle).

describe('planMutations — dogfood pinning: comment resume, regex classes, resync, JSON escapes', () => {
  it('resumes code scanning right after a multi-line comment closer with code on the closer line', () => {
    // Kills arith-plus-to-minus#269#19 (`i = close + 2` → `close - 2`):
    // resuming two chars early re-enters the comment tail; with an `=`
    // directly before the closer, the following `/` classifies as a
    // regex opener and masks the rest of the closer line — `4 > 3`
    // would stop being planned. (A word before the closer would read
    // as division and NOT kill — the operator is load-bearing.)
    const source = [
      'export function f(): number {',
      '  /* head',
      '   * end = */ const n = 4 > 3;',
      '  return n;',
      '}',
    ].join('\n');
    const plan = planMutations('src/p1.ts', source);
    // Code AFTER the closer on line 3 is live: the `>` is planned.
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 3)).toBe(true);
    // The line after the comment is untouched by any phantom frame.
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 4)).toBe(true);
    // Nothing from inside the comment body is planned.
    expect(plan.filter((m) => m.line === 2)).toEqual([]);
  });

  it('searches for the same-line comment closer from the opener, not before it', () => {
    // Kills arith-plus-to-minus#329#… (`line.indexOf('*/', i + 2)` → `i - 2`):
    // with an `/*/` opener, searching from two chars earlier finds the
    // `*/` formed by the opener's own `*/` pair at k+1 — the scan then
    // resumes inside the comment, the real closer's `/` reads as a regex
    // opener, and `4 > 3` stops being planned.
    const source = [
      'export function f2(): number {',
      '  const n = /*/ c */ 4 > 3;',
      '  return n;',
      '}',
    ].join('\n');
    const plan = planMutations('src/p6.ts', source);
    const relax = plan.filter((m) => m.kind === 'relax-boundary' && m.line === 2);
    expect(relax).toHaveLength(1); // the `4 > 3` after the real closer
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('keeps same-line code live after a regex containing a character class', () => {
    // Kills negate-boolean#445#33 (`inClass = false` on `]` flipped):
    // a class that never closes consumes the rest of the line as class
    // content, so `n > 2` would stop being planned.
    const source = [
      'export function g(s: string, n: number): boolean {',
      '  const ok = /[a-z]+/g.test(s) && n > 2;',
      '  return ok;',
      '}',
    ].join('\n');
    const plan = planMutations('src/p2.ts', source);
    const relax = plan.filter((m) => m.kind === 'relax-boundary' && m.line === 2);
    expect(relax).toHaveLength(1); // exactly the `n > 2` boundary
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('does not let a slash inside a character class close the regex early', () => {
    // Kills negate-boolean#450#17 (`inClass = true` on `[` flipped):
    // when the class never opens, the FIRST `/` inside it closes the
    // literal early — everything after it (`b>c]`) is then scanned as
    // code and the `>` leaks into the plan as a second relax-boundary.
    // Correct behavior masks the whole class: exactly one boundary
    // (`n > 2`) is planned. (The mask-all direction of #445 is caught
    // here too: the count would become 0.)
    const source = [
      'export function h(s: string, n: number): boolean {',
      '  const ok = /[a/b>c]/.test(s) && n > 2;',
      '  return ok;',
      '}',
    ].join('\n');
    const plan = planMutations('src/p3.ts', source);
    const relax = plan.filter((m) => m.kind === 'relax-boundary' && m.line === 2);
    expect(relax).toHaveLength(1); // only `n > 2` — `b>c` stays class content
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('masks an unterminated regex only to end of line — the next line stays live', () => {
    // Pins skipRegexLiteral's unterminated-literal behavior: the
    // remainder of the line is masked, but the scan resyncs cleanly —
    // no phantom frame bleeds into following lines.
    const source = [
      'export function k(n: number): boolean {',
      '  const re = /unterminated > oops',
      '  return n > 1;',
      '}',
    ].join('\n');
    const plan = planMutations('src/p4.ts', source);
    expect(plan.filter((m) => m.line === 2)).toEqual([]); // masked tail
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 3)).toBe(true);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('masks an unterminated regex tail under CRLF too — the \\r must not resync into code', () => {
    // Lines are split on '\n', so a lone '\n' can never appear inside a
    // line — the EOL guard in skipRegexLiteral is reachable ONLY via
    // the '\r' that CRLF leaves at line end. Under the old `start + 1`
    // resync, the '\r' re-exposed the regex tail as code and the `>`
    // leaked into the plan. Mask-to-EOL must hold for CRLF sources.
    const source = [
      'export function k2(n: number): boolean {',
      '  const re = /unterminated > oops',
      '  return n > 1;',
      '}',
    ].join('\r\n');
    const plan = planMutations('src/p5.ts', source);
    expect(plan.filter((m) => m.line === 2)).toEqual([]); // masked tail incl. '\r'
    expect(plan.some((m) => m.kind === 'relax-boundary' && m.line === 3)).toBe(true);
    expect(plan.some((m) => m.kind === 'return-null' && m.line === 3)).toBe(true);
  });

  it('parseMutationReport survives escaped quotes inside bare JSON in prose', () => {
    // Kills negate-boolean#518#17 / #522#17 (the `escaped` state flips
    // in extractBalancedObject). The UNBALANCED `{` inside the quoted
    // evidence text is load-bearing: with the escape flag broken, the
    // `\"` toggles the string tracker prematurely and the `{` then
    // corrupts the depth count — the balanced-object extraction never
    // closes and the report is unparseable. (With only balanced
    // structural content the corruption cancels — the first version of
    // this test survived #522 exactly that way.) Bare JSON, no fence —
    // the fenced candidate bypasses this code path entirely.
    const report = [
      'Mutation report (prose):',
      '{"summary":"ok","mutants":[{"id":"m#1#1","file":"a.ts","line":1,"kind":"relax-boundary","status":"killed","evidence":"assert \\"obj { ok"}]}',
      'trailing prose',
    ].join('\n');
    const parsed = parseMutationReport(report);
    expect(parsed?.mutants).toHaveLength(1);
    expect(parsed?.mutants[0]?.id).toBe('m#1#1');
    expect(parsed?.mutants[0]?.evidence).toBe('assert "obj { ok');
    expect(parsed?.summary).toBe('ok');
  });
});
