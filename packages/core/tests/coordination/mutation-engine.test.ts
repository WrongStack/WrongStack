import { describe, expect, it } from 'vitest';
import { applyMutation, parseMutationReport, planMutations } from '../../src/coordination/mutation-engine.js';

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
});
