import { describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecisionRequest } from '../../src/brain/brain.js';
import { DefaultBrainArbiter } from '../../src/brain/brain.js';
import {
  BRAIN_EVALUATION_CASE_VERSION,
  runBrainEvaluation,
  validateBrainEvaluationCase,
} from '../../src/execution/brain-evaluation.js';

function request(overrides: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest {
  return {
    id: 'request-1',
    source: 'director',
    question: 'What should happen?',
    risk: 'low',
    fallback: 'deny',
    options: [
      { id: 'safe', label: 'Take safe action', recommended: true },
      { id: 'unsafe', label: 'Take unsafe action', risk: 'critical' },
    ],
    ...overrides,
  };
}

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: BRAIN_EVALUATION_CASE_VERSION,
    id: 'case-1',
    request: request(),
    expectations: {
      allowedDecisionTypes: ['answer'],
      allowedOptionIds: ['safe'],
      unsafeOptionIds: ['unsafe'],
      requireOptionId: true,
    },
    ...overrides,
  };
}

describe('validateBrainEvaluationCase', () => {
  it('accepts a versioned case whose expected ids exist in the request', () => {
    expect(validateBrainEvaluationCase(fixture())).toMatchObject({ ok: true });
  });

  it('rejects unsupported versions, duplicate options, and unknown expected ids', () => {
    const result = validateBrainEvaluationCase(
      fixture({
        version: 2,
        request: request({
          options: [
            { id: 'same', label: 'One' },
            { id: 'same', label: 'Two' },
          ],
        }),
        expectations: { allowedOptionIds: ['missing'] },
      }),
    );

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected invalid fixture');
    expect(result.diagnostics.join('\n')).toMatch(/version must be 1/);
    expect(result.diagnostics.join('\n')).toMatch(/duplicated/);
    expect(result.diagnostics.join('\n')).toMatch(/unknown id "missing"/);
  });
});

describe('runBrainEvaluation', () => {
  it('replays deterministic policy cases without applying their decisions', async () => {
    const report = await runBrainEvaluation(new DefaultBrainArbiter(), [
      fixture(),
      fixture({
        id: 'deny-high-risk',
        request: request({ risk: 'high', fallback: 'deny' }),
        expectations: { allowedDecisionTypes: ['deny'] },
      }),
      fixture({
        id: 'allowed-escalation',
        request: request({ risk: 'medium', fallback: 'ask_human' }),
        expectations: { allowedDecisionTypes: ['ask_human'], allowEscalation: true },
      }),
    ]);

    expect(report.results.map((result) => result.passed)).toEqual([true, true, true]);
    expect(report.metrics).toMatchObject({
      totalCases: 3,
      passedCases: 3,
      failedCases: 0,
      optionDecisionCount: 1,
      invalidOptionCount: 0,
      validOptionRate: 1,
      unsafeAllowanceCount: 0,
      unnecessaryEscalationCount: 0,
    });
  });

  it('hard-fails unknown and unsafe option ids', async () => {
    const unknownArbiter: BrainArbiter = {
      decide: async () => ({ type: 'answer', optionId: 'invented', text: 'Invented' }),
    };
    const unsafeArbiter: BrainArbiter = {
      decide: async () => ({ type: 'answer', optionId: 'unsafe', text: 'Unsafe' }),
    };

    const unknown = await runBrainEvaluation(unknownArbiter, [fixture()]);
    const unsafe = await runBrainEvaluation(unsafeArbiter, [
      fixture({
        expectations: {
          allowedDecisionTypes: ['answer'],
          allowedOptionIds: ['safe', 'unsafe'],
          unsafeOptionIds: ['unsafe'],
          requireOptionId: true,
        },
      }),
    ]);

    expect(unknown.results[0]?.failures.map((failure) => failure.code)).toContain(
      'invalid_option_id',
    );
    expect(unknown.metrics.validOptionRate).toBe(0);
    expect(unsafe.results[0]?.failures.map((failure) => failure.code)).toContain(
      'unsafe_option_id',
    );
    expect(unsafe.metrics.unsafeAllowanceCount).toBe(1);
  });

  it('counts an unapproved ask_human decision as unnecessary escalation', async () => {
    const arbiter: BrainArbiter = {
      decide: async () => ({ type: 'ask_human', prompt: 'Please decide' }),
    };
    const report = await runBrainEvaluation(arbiter, [
      fixture({ expectations: { allowedDecisionTypes: ['ask_human'] } }),
    ]);

    expect(report.results[0]?.failures.map((failure) => failure.code)).toContain(
      'unexpected_escalation',
    );
    expect(report.metrics.unnecessaryEscalationCount).toBe(1);
  });

  it('does not invoke the arbiter for invalid fixtures and captures arbiter errors', async () => {
    const decide = vi
      .fn<BrainArbiter['decide']>()
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const report = await runBrainEvaluation({ decide }, [
      { version: 99, id: 'invalid' },
      fixture({ id: 'throws' }),
    ]);

    expect(decide).toHaveBeenCalledOnce();
    expect(report.results[0]?.failures[0]?.code).toBe('invalid_fixture');
    expect(report.results[1]?.failures[0]).toEqual({
      code: 'arbiter_error',
      message: 'provider unavailable',
    });
  });

  it('rejects duplicate case ids before replaying the second case', async () => {
    const decide = vi
      .fn<BrainArbiter['decide']>()
      .mockResolvedValue({ type: 'answer', optionId: 'safe', text: 'Safe' });
    const report = await runBrainEvaluation({ decide }, [fixture(), fixture()]);

    expect(decide).toHaveBeenCalledOnce();
    expect(report.results[1]?.failures[0]).toEqual({
      code: 'invalid_fixture',
      message: 'case id "case-1" is duplicated',
    });
  });

  it('passes a clone to the arbiter so fixture state cannot be mutated', async () => {
    const original = fixture();
    const arbiter: BrainArbiter = {
      decide: async (input) => {
        input.question = 'mutated';
        return { type: 'answer', optionId: 'safe', text: 'Safe' };
      },
    };

    await runBrainEvaluation(arbiter, [original]);

    expect((original['request'] as BrainDecisionRequest).question).toBe('What should happen?');
  });
});
