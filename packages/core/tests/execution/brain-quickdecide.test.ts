import { describe, expect, it } from 'vitest';
import { quickDecide } from '../../src/execution/autonomy-brain.js';
import type { BrainDecisionRequest } from '../../src/coordination/brain.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'r1',
  source: 'goal',
  question: 'Should we continue?',
  risk: 'low',
  fallback: 'continue',
  ...over,
});

describe('quickDecide — deadlock heuristic', () => {
  it('auto-answers when question mentions deadlock and context has failed tasks', () => {
    const d = quickDecide(
      req({
        question: 'We hit a deadlock in the pipeline',
        context: 'The build is stuck. 3 failed tasks are blocking progress.',
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.type).toBe('answer');
    expect(d!.text).toContain('Skip deadlocked tasks');
  });

  it('matches plural work-unit nouns (failed tests, failed steps)', () => {
    const d = quickDecide(
      req({
        question: 'deadlock detected',
        context: '2 failed tests blocking the suite',
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.type).toBe('answer');
  });

  it('matches all supported work-unit nouns', () => {
    const nouns = ['task', 'step', 'job', 'build', 'test', 'phase', 'stage', 'item', 'unit'];
    for (const noun of nouns) {
      const d = quickDecide(
        req({
          question: 'deadlock',
          context: `failed ${noun} blocking progress`,
        }),
      );
      expect(d, `expected match for "failed ${noun}"`).not.toBeNull();
    }
  });

  it('does NOT fire on incidental "failed" without a work-unit noun', () => {
    const d = quickDecide(
      req({
        question: 'deadlock detected',
        context: 'login failed for user admin',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire on "failed" with a non-work-unit noun', () => {
    const d = quickDecide(
      req({
        question: 'deadlock',
        context: 'the deployment failed miserably',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire without "deadlock" in the question', () => {
    const d = quickDecide(
      req({
        question: 'Should we retry the build?',
        context: '3 failed tasks blocking',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire on reversed order "task failed" (conservative)', () => {
    const d = quickDecide(
      req({
        question: 'deadlock',
        context: 'task failed 3 times',
      }),
    );
    expect(d).toBeNull();
  });
});

describe('quickDecide — retry exhaustion heuristic', () => {
  it('auto-answers when retries are explicitly exhausted', () => {
    const d = quickDecide(
      req({
        question: 'The API call failed again',
        context: 'Retries exhausted after 5 attempts.',
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.type).toBe('answer');
    expect(d!.text).toContain('Mark as failed');
  });

  it('matches "N consecutive attempts" pattern', () => {
    const d = quickDecide(
      req({
        question: 'retry the deployment',
        context: '4 consecutive attempts have all timed out',
      }),
    );
    expect(d).not.toBeNull();
  });

  it('matches "attempt N" pattern', () => {
    const d = quickDecide(
      req({
        question: 'failed to connect',
        context: 'attempt 5 returned ECONNREFUSED',
      }),
    );
    expect(d).not.toBeNull();
  });

  it('does NOT fire on low attempt counts (< 3)', () => {
    const d = quickDecide(
      req({
        question: 'failed to connect',
        context: 'attempt 2 returned ECONNREFUSED',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire without failed/retry in the question', () => {
    const d = quickDecide(
      req({
        question: 'What should we do next?',
        context: 'retries exhausted after 5 attempts',
        fallback: 'deny',
      }),
    );
    expect(d).toBeNull();
  });
});

describe('quickDecide — blocked-resolved heuristic', () => {
  it('auto-continues when question mentions blocked and context has resolution marker', () => {
    const d = quickDecide(
      req({
        question: 'Task is blocked by the auth dependency',
        context: 'auth-service has been resolved and deployed',
        fallback: 'continue',
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.type).toBe('answer');
    expect(d!.text).toContain('Blocker resolved');
  });

  it('matches all resolution markers', () => {
    for (const marker of [
      'resolved',
      'fixed',
      'completed',
      'unblocked',
      'available',
      'done',
      'merged',
      'landed',
      'shipped',
    ]) {
      const d = quickDecide(
        req({
          question: 'Work is blocked by upstream',
          context: `the dependency is ${marker}`,
          fallback: 'continue',
        }),
      );
      expect(d).not.toBeNull();
      expect(d!.type).toBe('answer');
    }
  });

  it('does NOT fire without a resolution marker in context', () => {
    const d = quickDecide(
      req({
        question: 'Task is blocked by the auth dependency',
        context: 'auth-service is still being worked on',
        fallback: 'continue',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire without blocked in the question', () => {
    const d = quickDecide(
      req({
        question: 'What should we do about the dependency?',
        context: 'dependency resolved',
        fallback: 'continue',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire when fallback is not continue', () => {
    const d = quickDecide(
      req({
        question: 'Task is blocked by dependency',
        context: 'dependency resolved',
        fallback: 'ask_human',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire when question contains "or" (alternative)', () => {
    const d = quickDecide(
      req({
        question: 'Blocked task — continue or escalate?',
        context: 'dependency resolved',
        fallback: 'continue',
      }),
    );
    expect(d).toBeNull();
  });
});

describe('quickDecide — goal complete passthrough', () => {
  it('returns null for goal-complete questions (defers to LLM)', () => {
    const d = quickDecide(req({ question: 'Is the goal complete?' }));
    expect(d).toBeNull();
  });

  it('returns null for mission-complete questions', () => {
    const d = quickDecide(req({ question: 'mission complete — verify all acceptance criteria' }));
    expect(d).toBeNull();
  });
});

describe('quickDecide — continue/proceed heuristic', () => {
  it('auto-continues when fallback is continue and question says proceed', () => {
    const d = quickDecide(
      req({
        question: 'Should we proceed with the next phase?',
        fallback: 'continue',
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.type).toBe('answer');
    expect(d!.text).toContain('Continue execution');
  });

  it('auto-continues on "continue" keyword', () => {
    const d = quickDecide(
      req({
        question: 'continue with the remaining work',
        fallback: 'continue',
      }),
    );
    expect(d).not.toBeNull();
  });

  it('does NOT fire when fallback is not continue', () => {
    const d = quickDecide(
      req({
        question: 'continue with the remaining work',
        fallback: 'deny',
      }),
    );
    expect(d).toBeNull();
  });

  it('does NOT fire when question contains stop/abort/halt keywords', () => {
    for (const word of ['stop', 'abort', 'halt', 'cancel', 'pause', 'rollback']) {
      const d = quickDecide(
        req({
          question: `Should we continue or ${word}?`,
          fallback: 'continue',
        }),
      );
      expect(d, `expected null for "${word}"`).toBeNull();
    }
  });

  it('does NOT fire when question contains "or" (alternative present)', () => {
    const d = quickDecide(
      req({
        question: 'Should we continue or try a different approach?',
        fallback: 'continue',
      }),
    );
    expect(d).toBeNull();
  });
});

describe('quickDecide — option-bearing requests', () => {
  it('always returns null when options are present', () => {
    const d = quickDecide(
      req({
        question: 'deadlock with failed tasks',
        context: 'failed task blocking',
        options: [
          { id: 'skip', label: 'Skip' },
          { id: 'retry', label: 'Retry' },
        ],
      }),
    );
    expect(d).toBeNull();
  });
});

describe('quickDecide — no match', () => {
  it('returns null for unrecognized questions', () => {
    const d = quickDecide(
      req({
        question: 'What is the meaning of life?',
        context: 'philosophical inquiry',
      }),
    );
    expect(d).toBeNull();
  });
});
