import { describe, expect, it } from 'vitest';
import {
  DESIGN_EVAL_BRIEFS,
  DESIGN_JUDGE_AXES,
  DESIGN_JUDGE_GATES,
  DESIGN_JUDGE_RUBRIC,
  parseDesignJudgeVerdict,
  scoreDesignEvalCell,
} from '../../src/execution/design-eval.js';

describe('design-eval (canonical briefs, judge parser & composite scorer)', () => {
  it('exposes the 8 canonical evaluation briefs including zero-traction trap and same-kit divergence', () => {
    expect(DESIGN_EVAL_BRIEFS).toHaveLength(8);
    expect(DESIGN_EVAL_BRIEFS.map((b) => b.id)).toContain('b4-metric-temptation');
    expect(DESIGN_EVAL_BRIEFS.map((b) => b.id)).toContain('b5-component-signup');
    expect(DESIGN_EVAL_BRIEFS.map((b) => b.id)).toContain('b7-same-kit-divergence');
    expect(DESIGN_JUDGE_RUBRIC).toContain('1280x800');
    expect(DESIGN_JUDGE_AXES).toHaveLength(6);
    expect(DESIGN_JUDGE_GATES).toHaveLength(5);
  });

  it('parses raw or fenced JSON judge verdicts and clamps out-of-range scores', () => {
    const raw = [
      '```json',
      JSON.stringify({
        axes: {
          philosophy: 5,
          hierarchy: 4,
          execution: 6, // clamps to 5
          specificity: 4,
          restraint: 5,
          variety: 0, // clamps to 1
        },
        gates: {
          'centred-hero': 'pass',
          'flat-rhythm': 'pass',
          'stock-nav': 'fail',
          'link-farm-footer': 'pass',
          'empty-or-drawn-slot': 'UNKNOWN',
        },
        overall: 9,
        rationale: 'Strong editorial typography, though top bar falls back to a stock pill nav.',
      }),
      '```',
    ].join('\n');

    const verdict = parseDesignJudgeVerdict(raw);
    expect(verdict.axes.execution).toBe(5);
    expect(verdict.axes.variety).toBe(1);
    expect(verdict.gates['stock-nav']).toBe('fail');
    expect(verdict.gates['empty-or-drawn-slot']).toBe('unclear');
    expect(verdict.overall).toBe(9);

    expect(() => parseDesignJudgeVerdict('not json at all')).toThrow(/no JSON object/);
  });

  it('computes composite mechanical + visual scores and enforces floorClean on FAILs', () => {
    const cleanCell = scoreDesignEvalCell({
      briefId: 'b1-voice-studio',
      verifyReport: {
        filesScanned: 1,
        palette: [],
        tokenNames: [],
        score: 1,
        ok: true,
        filesWithNoSignal: 0,
        violations: [],
        waived: [],
      },
      inspectReport: {
        viewports: [1440, 375],
        fails: 0,
        warns: 0,
        checked: [],
        notCovered: [],
        findings: [],
      },
      judgeVerdict: {
        axes: {
          philosophy: 5,
          hierarchy: 5,
          execution: 5,
          specificity: 5,
          restraint: 5,
          variety: 5,
        },
        gates: {
          'centred-hero': 'pass',
          'flat-rhythm': 'pass',
          'stock-nav': 'pass',
          'link-farm-footer': 'pass',
          'empty-or-drawn-slot': 'pass',
        },
        overall: 10,
        rationale: 'Clean across every axis and gate.',
      },
    });
    expect(cleanCell.floorClean).toBe(true);
    expect(cleanCell.compositeScore).toBe(100);

    const failingCell = scoreDesignEvalCell({
      briefId: 'b4-metric-temptation',
      verifyReport: {
        filesScanned: 1,
        palette: [],
        tokenNames: [],
        score: 1,
        ok: false,
        filesWithNoSignal: 0,
        violations: [
          {
            id: 'a11y.icon-button-unlabeled',
            severity: 'FAIL',
            axis: 'a11y',
            file: 'index.html',
            line: 12,
            snippet: '<button><svg/></button>',
            reason: 'Unlabeled icon button',
          },
        ],
        waived: [],
      },
    });
    expect(failingCell.floorClean).toBe(false);
    expect(failingCell.staticFails).toBe(1);
    expect(failingCell.compositeScore).toBeLessThan(80);
  });
});
