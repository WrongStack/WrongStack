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
