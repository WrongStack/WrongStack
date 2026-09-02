import { describe, expect, it, vi } from 'vitest';
import type {
  BrainArbiter,
  BrainDecision,
  BrainDecisionRequest,
} from '../../src/coordination/brain.js';
import {
  BRAIN_RULE_PATTERN_MAX,
  type BrainRule,
  compileBrainRules,
  createRuleBrainArbiter,
  evaluateBrainRules,
  ruleMatches,
} from '../../src/coordination/brain-rules.js';
import { readDecisionTier } from '../../src/coordination/brain-telemetry.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'r1',
  source: 'goal',
  question: 'Should we continue?',
  risk: 'low',
  fallback: 'continue',
  ...over,
});

const compileOne = (rule: BrainRule) => {
  const { rules, errors } = compileBrainRules([rule]);
  expect(errors).toEqual([]);
  const compiled = rules[0];
  if (!compiled) throw new Error('rule failed to compile');
  return compiled;
};

const answerRule = (when: BrainRule['when'], id = 'r'): BrainRule => ({
  id,
  when,
  then: { action: 'answer', text: 'ok' },
});

describe('compileBrainRules', () => {
  it('drops an invalid rule but keeps the rest', () => {
    const { rules, errors } = compileBrainRules([
      answerRule({ question: '(' }, 'bad'),
      answerRule({ question: 'ok' }, 'good'),
    ]);
    expect(rules.map((r) => r.id)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bad');
  });

  it('skips disabled rules without reporting an error', () => {
    const { rules, errors } = compileBrainRules([{ ...answerRule({}, 'off'), enabled: false }]);
    expect(rules).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('rejects duplicate ids', () => {
    const { rules, errors } = compileBrainRules([answerRule({}, 'x'), answerRule({}, 'x')]);
    expect(rules).toHaveLength(1);
    expect(errors[0]).toContain('duplicate');
  });

  it('rejects an over-long pattern instead of compiling it', () => {
    const { errors } = compileBrainRules([
      answerRule({ question: 'a'.repeat(BRAIN_RULE_PATTERN_MAX + 1) }),
    ]);
    expect(errors[0]).toContain('max');
  });

  it('rejects an answer rule with neither optionId nor text', () => {
    const { errors } = compileBrainRules([{ id: 'empty', when: {}, then: { action: 'answer' } }]);
    expect(errors[0]).toContain('optionId or text');
  });

  it('rejects an unknown action', () => {
    const { errors } = compileBrainRules([
      { id: 'weird', when: {}, then: { action: 'launch' } as never },
    ]);
    expect(errors[0]).toContain('unknown action');
  });

  it('rejects an unknown risk bound', () => {
    const { errors } = compileBrainRules([answerRule({ minRisk: 'catastrophic' as never })]);
    expect(errors[0]).toContain('unknown minRisk');
  });
});

describe('ruleMatches', () => {
  it('matches on source, risk band and fallback together', () => {
    const rule = compileOne(
      answerRule({ source: 'system', minRisk: 'medium', maxRisk: 'high', fallback: 'ask_human' }),
    );
    expect(ruleMatches(rule, req({ source: 'system', risk: 'high', fallback: 'ask_human' }))).toBe(
      true,
    );
    expect(ruleMatches(rule, req({ source: 'goal', risk: 'high', fallback: 'ask_human' }))).toBe(
      false,
    );
    expect(
      ruleMatches(rule, req({ source: 'system', risk: 'critical', fallback: 'ask_human' })),
    ).toBe(false);
    expect(ruleMatches(rule, req({ source: 'system', risk: 'low', fallback: 'ask_human' }))).toBe(
      false,
    );
    expect(ruleMatches(rule, req({ source: 'system', risk: 'high', fallback: 'continue' }))).toBe(
      false,
    );
  });

  it('accepts arrays for source/risk/fallback', () => {
    const rule = compileOne(answerRule({ source: ['goal', 'director'], risk: ['low', 'high'] }));
    expect(ruleMatches(rule, req({ source: 'director', risk: 'high' }))).toBe(true);
    expect(ruleMatches(rule, req({ source: 'tool', risk: 'high' }))).toBe(false);
    expect(ruleMatches(rule, req({ source: 'goal', risk: 'medium' }))).toBe(false);
  });

  it('discriminates on option presence and on a specific offered option', () => {
    const needsOptions = compileOne(answerRule({ hasOptions: true }, 'a'));
    const needsNone = compileOne(answerRule({ hasOptions: false }, 'b'));
    const needsSteer = compileOne(answerRule({ offersOption: 'steer' }, 'c'));
    const withSteer = req({ options: [{ id: 'steer', label: 'Steer' }] });

    expect(ruleMatches(needsOptions, withSteer)).toBe(true);
    expect(ruleMatches(needsOptions, req())).toBe(false);
    expect(ruleMatches(needsNone, req())).toBe(true);
    expect(ruleMatches(needsNone, withSteer)).toBe(false);
    expect(ruleMatches(needsSteer, withSteer)).toBe(true);
    expect(ruleMatches(needsSteer, req({ options: [{ id: 'other', label: 'Other' }] }))).toBe(
      false,
    );
  });

  it('matches patterns case-insensitively', () => {
    const rule = compileOne(answerRule({ question: 'deadlock' }));
    expect(ruleMatches(rule, req({ question: 'DEADLOCK detected' }))).toBe(true);
  });

  it('never satisfies a context pattern when there is no context to inspect', () => {
    const rule = compileOne(answerRule({ context: 'resolved' }));
    expect(ruleMatches(rule, req({ context: 'the blocker is resolved' }))).toBe(true);
    expect(ruleMatches(rule, req({ context: undefined }))).toBe(false);
  });

  it('treats an absent context as passing a notContext guard', () => {
    const rule = compileOne(answerRule({ notContext: 'danger' }));
    expect(ruleMatches(rule, req({ context: undefined }))).toBe(true);
    expect(ruleMatches(rule, req({ context: 'DANGER ahead' }))).toBe(false);
  });

  it('applies notQuestion as a negative guard', () => {
    const rule = compileOne(answerRule({ question: 'continue', notQuestion: '\\bor\\b' }));
    expect(ruleMatches(rule, req({ question: 'Should we continue?' }))).toBe(true);
    expect(ruleMatches(rule, req({ question: 'Should we continue or stop?' }))).toBe(false);
  });
});

describe('evaluateBrainRules', () => {
  it('returns the first matching rule that produces a decision', () => {
    const { rules } = compileBrainRules([
      { id: 'first', when: { question: 'continue' }, then: { action: 'deny', reason: 'nope' } },
      { id: 'second', when: {}, then: { action: 'answer', text: 'yes' } },
    ]);
    const hit = evaluateBrainRules(rules, req());
    expect(hit?.ruleId).toBe('first');
    expect(hit?.decision.type).toBe('deny');
  });

  it('stops evaluation at a deferring rule rather than trying later rules', () => {
    const { rules } = compileBrainRules([
      { id: 'skip', when: { source: 'goal' }, then: { action: 'defer' } },
      { id: 'catchall', when: {}, then: { action: 'answer', text: 'would have matched' } },
    ]);
    // `defer` means "this tier declines", not "try the next rule" — otherwise
    // it could not be used to carve exceptions out of a broad later rule.
    expect(evaluateBrainRules(rules, req())).toBeNull();
  });

  it('defers when an answer rule names an option the request does not offer', () => {
    const { rules } = compileBrainRules([
      { id: 'pick', when: {}, then: { action: 'answer', optionId: 'ghost' } },
    ]);
    expect(evaluateBrainRules(rules, req({ options: [{ id: 'real', label: 'Real' }] }))).toBeNull();
  });

  it('resolves an option-bearing answer to the offered option', () => {
    const { rules } = compileBrainRules([
      { id: 'pick', when: {}, then: { action: 'answer', optionId: 'steer' } },
    ]);
    const hit = evaluateBrainRules(rules, req({ options: [{ id: 'steer', label: 'Steer it' }] }));
    expect(hit?.decision).toMatchObject({ type: 'answer', optionId: 'steer', text: 'Steer it' });
  });

  it('turns an escalate rule into ask_human carrying the request options', () => {
    const { rules } = compileBrainRules([
      { id: 'up', when: {}, then: { action: 'escalate', prompt: 'Need a human here' } },
    ]);
    const options = [{ id: 'a', label: 'A' }];
    const hit = evaluateBrainRules(rules, req({ options }));
    expect(hit?.decision).toMatchObject({
      type: 'ask_human',
      prompt: 'Need a human here',
      options,
    });
  });

  it('attributes the deciding rule in the rationale/reason', () => {
    const { rules } = compileBrainRules([
      { id: 'my-rule', when: {}, then: { action: 'deny', reason: 'too risky' } },
    ]);
    const hit = evaluateBrainRules(rules, req());
    expect(hit?.decision.type === 'deny' && hit.decision.reason).toContain('my-rule');
  });
});

describe('createRuleBrainArbiter', () => {
  const inner: BrainArbiter = { decide: async () => ({ type: 'answer', text: 'from inner' }) };

  it('short-circuits the inner chain and marks the rule tier', async () => {
    const { rules } = compileBrainRules([
      { id: 'fast', when: {}, then: { action: 'answer', text: 'from rule' } },
    ]);
    const onRuleDecision = vi.fn();
    const arbiter = createRuleBrainArbiter({ inner, getRules: () => rules, onRuleDecision });
    const r = req();
    const decision = await arbiter.decide(r);

    expect(decision).toMatchObject({ type: 'answer', text: 'from rule' });
    expect(readDecisionTier(r)).toBe('rule');
    expect(onRuleDecision).toHaveBeenCalledWith('fast', r, decision);
  });

  it('falls through to the inner chain when nothing matches', async () => {
    const { rules } = compileBrainRules([
      { id: 'never', when: { source: 'tool' }, then: { action: 'answer', text: 'x' } },
    ]);
    const onRuleDecision = vi.fn();
    const arbiter = createRuleBrainArbiter({ inner, getRules: () => rules, onRuleDecision });
    const r = req();
    const decision: BrainDecision = await arbiter.decide(r);

    expect(decision).toMatchObject({ text: 'from inner' });
    expect(readDecisionTier(r)).toBeUndefined();
    expect(onRuleDecision).not.toHaveBeenCalled();
  });

  it('reads the table per decision so config edits apply immediately', async () => {
    let rules = compileBrainRules([]).rules;
    const arbiter = createRuleBrainArbiter({ inner, getRules: () => rules });
    expect(await arbiter.decide(req())).toMatchObject({ text: 'from inner' });

    rules = compileBrainRules([
      { id: 'late', when: {}, then: { action: 'answer', text: 'from rule' } },
    ]).rules;
    expect(await arbiter.decide(req())).toMatchObject({ text: 'from rule' });
  });
});
