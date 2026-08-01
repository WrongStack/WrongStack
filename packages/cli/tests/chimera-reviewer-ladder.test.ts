/**
 * Pins the Chimera reviewer retry ladder: a review must never be abandoned
 * because one model blew up. The ladder walks the assigned chain, then the
 * active fallback profile, and always ends on the session model.
 */
import { describe, expect, it } from 'vitest';
import {
  buildReviewerAttemptLadder,
  MAX_REVIEWER_ATTEMPTS,
  REVIEWER_ATTEMPT_TIMEOUT_MS,
  REVIEWER_LADDER_BUDGET_MS,
  REVIEWER_MIN_ATTEMPT_MS,
  reviewerAttemptTimeoutMs,
  shouldAdvanceReviewerLadder,
} from '../src/chimera-reviewer-policy.js';

const refs = (ladder: ReturnType<typeof buildReviewerAttemptLadder>): string[] =>
  ladder.map((a) => `${a.provider}/${a.model}`);

describe('buildReviewerAttemptLadder', () => {
  it('keeps the assigned spawn as the first rung with its chain intact', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: { provider: 'anthropic', model: 'opus', fallbackModels: ['openai/gpt-x'] },
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(ladder[0]).toEqual({
      provider: 'anthropic',
      model: 'opus',
      fallbackModels: ['openai/gpt-x'],
      tier: 'primary',
    });
  });

  it('promotes each assigned fallback to its own rung carrying the remaining chain', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: {
        provider: 'anthropic',
        model: 'opus',
        fallbackModels: ['openai/gpt-x', 'google/gemini'],
      },
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(refs(ladder)).toEqual(['anthropic/opus', 'openai/gpt-x', 'google/gemini']);
    expect(ladder[1]!.fallbackModels).toEqual(['google/gemini']);
    expect(ladder[2]!.fallbackModels).toEqual([]);
    expect(ladder[1]!.tier).toBe('fallback');
  });

  it('appends the fallback profile chain after the assigned chain', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: { provider: 'anthropic', model: 'opus', fallbackModels: ['openai/gpt-x'] },
      profileChain: ['groq/llama'],
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(refs(ladder)).toEqual(['anthropic/opus', 'openai/gpt-x', 'groq/llama']);
  });

  it('always ends on the session model when it is not already in the chain', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: { provider: 'openai', model: 'gpt-x', fallbackModels: ['groq/llama'] },
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(refs(ladder)).toEqual(['openai/gpt-x', 'groq/llama', 'anthropic/opus']);
    expect(ladder.at(-1)!.tier).toBe('session');
    expect(ladder.at(-1)!.fallbackModels).toEqual([]);
  });

  it('keeps the session model reachable even when the cap trims the ladder', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: {
        provider: 'openai',
        model: 'gpt-x',
        fallbackModels: ['groq/llama', 'google/gemini', 'mistral/large', 'xai/grok'],
      },
      session: { provider: 'anthropic', model: 'opus' },
      maxAttempts: 3,
    });

    expect(ladder).toHaveLength(3);
    expect(refs(ladder)).toEqual(['openai/gpt-x', 'groq/llama', 'anthropic/opus']);
    expect(ladder.at(-1)!.tier).toBe('session');
  });

  it('degrades to the session model alone when nothing else is configured', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: { provider: '', model: '' },
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(refs(ladder)).toEqual(['anthropic/opus']);
    expect(ladder[0]!.tier).toBe('session');
  });

  it('never duplicates a model that appears in more than one chain', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: { provider: 'anthropic', model: 'opus', fallbackModels: ['openai/gpt-x'] },
      profileChain: ['openai/gpt-x', 'anthropic/opus', 'groq/llama'],
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(refs(ladder)).toEqual(['anthropic/opus', 'openai/gpt-x', 'groq/llama']);
  });

  it('drops refs with no provider — a bare model id 401s on multi-provider hosts', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: { provider: 'anthropic', model: 'opus', fallbackModels: ['bare-model', '  '] },
      session: { provider: 'anthropic', model: 'opus' },
    });

    expect(refs(ladder)).toEqual(['anthropic/opus']);
  });

  it('defaults the cap to MAX_REVIEWER_ATTEMPTS', () => {
    const ladder = buildReviewerAttemptLadder({
      assigned: {
        provider: 'p0',
        model: 'm0',
        fallbackModels: ['p1/m1', 'p2/m2', 'p3/m3', 'p4/m4', 'p5/m5'],
      },
      session: { provider: 'sess', model: 'sm' },
    });

    expect(ladder).toHaveLength(MAX_REVIEWER_ATTEMPTS);
    expect(ladder.at(-1)!.tier).toBe('session');
  });
});

describe('shouldAdvanceReviewerLadder', () => {
  it('stops on success', () => {
    expect(shouldAdvanceReviewerLadder('success')).toBe(false);
  });

  it('stops on deliberate termination and parent abort', () => {
    expect(shouldAdvanceReviewerLadder('stopped')).toBe(false);
    expect(shouldAdvanceReviewerLadder('failed', { kind: 'aborted_by_parent' })).toBe(false);
  });

  it.each([
    'provider_rate_limit',
    'provider_5xx',
    'provider_auth',
    'context_overflow',
    'empty_response',
    'budget_timeout',
    'unknown',
  ] as const)('advances on %s — another model is the remedy', (kind) => {
    expect(shouldAdvanceReviewerLadder('failed', { kind })).toBe(true);
  });

  it('advances on timeout and on a result-less outcome', () => {
    expect(shouldAdvanceReviewerLadder('timeout')).toBe(true);
    expect(shouldAdvanceReviewerLadder(undefined)).toBe(true);
  });
});

describe('reviewerAttemptTimeoutMs', () => {
  it('gives the first rung the full per-attempt budget', () => {
    expect(reviewerAttemptTimeoutMs(REVIEWER_LADDER_BUDGET_MS)).toBe(REVIEWER_ATTEMPT_TIMEOUT_MS);
  });

  it('clamps a later rung to what is left of the ladder budget', () => {
    expect(reviewerAttemptTimeoutMs(300_000)).toBe(300_000);
  });

  it('returns 0 once too little budget remains to learn anything', () => {
    expect(reviewerAttemptTimeoutMs(REVIEWER_MIN_ATTEMPT_MS - 1)).toBe(0);
    expect(reviewerAttemptTimeoutMs(0)).toBe(0);
    expect(reviewerAttemptTimeoutMs(-5_000)).toBe(0);
  });
});
