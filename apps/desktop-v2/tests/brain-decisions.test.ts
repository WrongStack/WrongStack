import { expect, it } from 'vitest';
import { brainAnswerText, brainStatus } from '../src/BrainDecisions';

it('reads the ceiling and the decision log newest first', () => {
  const status = brainStatus({
    maxAutoRisk: 'medium',
    mode: 'council',
    log: [
      { at: 1, kind: 'permission', question: 'rm -rf dist?', outcome: 'deny' },
      {
        at: 5,
        kind: 'permission',
        question: 'git push?',
        outcome: 'ask_human',
        tier: 'deterministic',
      },
    ],
  });
  expect(status.maxAutoRisk).toBe('medium');
  expect(status.log.map((entry) => entry.question)).toEqual(['git push?', 'rm -rf dist?']);
  expect(status.log[0]!.tier).toBe('deterministic');
  expect(brainStatus({}).log).toEqual([]);
});

it('describes each decision type without inventing one', () => {
  expect(
    brainAnswerText({ decision: { type: 'answer', text: 'Yes', rationale: 'low risk' } }),
  ).toBe('Answer: Yes (low risk)');
  expect(brainAnswerText({ decision: { type: 'ask_human', prompt: 'Allow it?' } })).toBe(
    'The Brain would ask you: Allow it?',
  );
  expect(brainAnswerText({ decision: { type: 'deny', reason: 'unsafe' } })).toBe('Refused: unsafe');
  expect(brainAnswerText({})).toBe('The Brain returned no decision.');
});
