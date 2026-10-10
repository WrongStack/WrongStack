import { describe, expect, it } from 'vitest';
import {
  classifyCase,
  type LabeledRequest,
  parseEvalJsonl,
  scoreSuggestions,
  sweepThresholds,
  unknownGoldLabels,
} from '../../src/skills/suggest/evaluate.js';
import { redecide, type SkillSuggestionTrace } from '../../src/skills/suggest/skill-suggester.js';

function trace(partial: Partial<SkillSuggestionTrace>): SkillSuggestionTrace {
  return {
    gate: 0,
    gateValues: {},
    ranked: [],
    shortlist: [],
    fits: {},
    winner: undefined,
    suggestion: undefined,
    stop: 'gate',
    requests: 2,
    // `models` and `inputTokens` are required on the trace; a synthetic fixture
    // reports no model and no billed tokens.
    models: [],
    inputTokens: 0,
    ...partial,
  };
}

describe('classifyCase', () => {
  it('separates a wrong suggestion from silence on a covered request', () => {
    // These are not equally bad: silence leaves the agent where it started,
    // a wrong name actively pushes it somewhere.
    const covered: LabeledRequest = { text: 't', gold: 'git-flow' };
    expect(classifyCase(covered, 'git-flow')).toBe('correct');
    expect(classifyCase(covered, 'design-craft')).toBe('wrong');
    expect(classifyCase(covered, undefined)).toBe('missed');
  });

  it('treats null and absent gold identically as uncovered', () => {
    expect(classifyCase({ text: 't', gold: null }, 'git-flow')).toBe('needless');
    expect(classifyCase({ text: 't' }, undefined)).toBe('correctly-silent');
  });
});

describe('scoreSuggestions', () => {
  const requests: LabeledRequest[] = [
    { text: 'a', gold: 'git-flow' },
    { text: 'b', gold: 'git-flow' },
    { text: 'c', gold: 'design-craft' },
    { text: 'd', gold: null },
    { text: 'e', gold: null },
  ];

  it('computes the three rates over their own denominators', () => {
    const { score } = scoreSuggestions(requests, (r) => {
      if (r.text === 'a') return 'git-flow'; // correct
      if (r.text === 'b') return 'design-craft'; // wrong
      if (r.text === 'c') return undefined; // missed
      if (r.text === 'd') return 'git-flow'; // needless
      return undefined; // correctly silent
    });
    expect(score.covered).toBe(3);
    expect(score.uncovered).toBe(2);
    expect(score.correct).toBeCloseTo(1 / 3);
    expect(score.wrongSuggestion).toBeCloseTo(1 / 3);
    expect(score.missed).toBeCloseTo(1 / 3);
    expect(score.needless).toBe(0.5);
  });

  it('reports 0 rather than NaN when a denominator is empty', () => {
    const { score } = scoreSuggestions([{ text: 'a', gold: 'x' }], () => 'x');
    expect(score.uncovered).toBe(0);
    expect(score.needless).toBe(0);
    expect(Number.isNaN(score.needless)).toBe(false);
  });

  it('counts an empty-string gold as uncovered, matching classifyCase', () => {
    // parseEvalJsonl accepts `"gold": ""`, and classifyCase treats it as
    // uncovered. The covered denominator must use the same convention, or the
    // case lands in the uncovered bucket while `covered` counts it.
    expect(classifyCase({ text: 'c', gold: '' }, 'git-flow')).toBe('needless');
    const { score } = scoreSuggestions([{ text: 'c', gold: '' }], () => 'git-flow');
    expect(score.covered).toBe(0);
    expect(score.uncovered).toBe(1);
    expect(score.needless).toBe(1);
  });
});

describe('redecide', () => {
  const t = trace({ gate: 0.5, winner: 'git-flow', fits: { 'git-flow': 0.45, other: 0.1 } });

  it('reproduces the verdict at the collecting thresholds', () => {
    expect(redecide(t, 0.3, 0.3)).toBe('git-flow');
  });

  it('drops the suggestion when either threshold rises past its number', () => {
    expect(redecide(t, 0.6, 0.3)).toBeUndefined();
    expect(redecide(t, 0.3, 0.5)).toBeUndefined();
  });

  it('returns nothing for a trace that never reached pass 2', () => {
    // A gate-stopped trace has no pass-2 answers to re-decide with. Guessing
    // here would silently make a whole sweep row plausible and wrong.
    expect(redecide(trace({ gate: 0.9 }), 0.1, 0.1)).toBeUndefined();
  });
});

describe('sweepThresholds', () => {
  it('re-scores the same traces at every threshold pair without new answers', () => {
    const rows = [
      {
        request: { text: 'covered', gold: 'git-flow' } as LabeledRequest,
        trace: trace({ gate: 0.5, winner: 'git-flow', fits: { 'git-flow': 0.5 } }),
      },
      {
        request: { text: 'uncovered', gold: null } as LabeledRequest,
        trace: trace({ gate: 0.4, winner: 'git-flow', fits: { 'git-flow': 0.4 } }),
      },
    ];

    const sweep = sweepThresholds(rows, [0.3, 0.45], [0.3]);

    // At gate 0.3 both pass: the covered one is correct, the uncovered one is
    // a needless suggestion.
    const low = sweep.find((r) => r.gateThreshold === 0.3)!;
    expect(low.score.correct).toBe(1);
    expect(low.score.needless).toBe(1);

    // Raising the gate to 0.45 silences the uncovered case (0.4) while the
    // covered one (0.5) survives — the exact trade the table exists to show.
    const high = sweep.find((r) => r.gateThreshold === 0.45)!;
    expect(high.score.correct).toBe(1);
    expect(high.score.needless).toBe(0);
  });
});

describe('parseEvalJsonl', () => {
  it('parses cases, skips blanks and comments, and normalizes absent gold to null', () => {
    const { requests, errors } = parseEvalJsonl(
      [
        '// a comment',
        '',
        '{"text": "cut a release", "gold": "git-flow"}',
        '{"text": "explain a monad"}',
        '{"text": "  padded  ", "gold": null}',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(requests).toEqual([
      { text: 'cut a release', gold: 'git-flow' },
      { text: 'explain a monad', gold: null },
      { text: 'padded', gold: null },
    ]);
  });

  it('reports malformed lines with their line numbers instead of dropping them', () => {
    // A silently dropped line changes the denominator every rate is computed
    // over, which is worse than a loud one.
    const { requests, errors } = parseEvalJsonl(
      ['{not json}', '["array"]', '{"text": ""}', '{"text": "ok", "gold": 7}'].join('\n'),
    );
    expect(requests).toEqual([]);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(errors[3]?.reason).toContain('gold');
  });
});

describe('unknownGoldLabels', () => {
  it('names gold labels the roster no longer contains', () => {
    // These can never be scored correct, which drags the rate down for a
    // reason that has nothing to do with the suggester.
    const unknown = unknownGoldLabels(
      [
        { text: 'a', gold: 'git-flow' },
        { text: 'b', gold: 'renamed-away' },
        { text: 'c', gold: null },
      ],
      ['git-flow', 'design-craft'],
    );
    expect(unknown).toEqual(['renamed-away']);
  });
});
