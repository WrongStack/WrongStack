import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FallbackProfileManager } from '../../src/core/fallback-profile-manager.js';
import { COUNCIL_REFUSE_OPTION_ID } from '../../src/execution/council-brain.js';
import {
  CouncilOrchestrator,
  DEFAULT_COUNCIL_MAX_CONCURRENCY,
  MAX_COUNCIL_CONCURRENCY,
} from '../../src/execution/council-orchestrator.js';
import { DEFAULT_COUNCIL_PROFILE_REGISTRY } from '../../src/execution/council-profiles.js';
import type { Config } from '../../src/types/config.js';
import type {
  CouncilLLMCaller,
  CouncilProfileConfig,
  CouncilQuestion,
} from '../../src/types/council.js';
import type { OneShotLLMInput, OneShotLLMResult } from '../../src/types/one-shot-llm.js';

interface CallPlan {
  voterResponses: Map<string, string>;
  voterErrors?: Map<string, string>;
  judgeResponse?: string;
  judgeError?: string;
  delay?: number | undefined;
}

interface CallLog {
  voterCalls: OneShotLLMInput[];
  judgeCalls: OneShotLLMInput[];
}

function makeCaller(plan: CallPlan): { caller: CouncilLLMCaller; log: CallLog } {
  const log: CallLog = { voterCalls: [], judgeCalls: [] };
  const caller: CouncilLLMCaller = {
    async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
      const user = input.userPrompt ?? '';
      const isJudge = user.includes('<council-ballots>');
      if (isJudge) {
        log.judgeCalls.push(input);
        if (plan.judgeError) throw new Error(plan.judgeError);
        return ok(plan.judgeResponse ?? '{"optionId":"merge"}', input);
      }
      const seatMatch = /Seat id: ([a-z0-9-]+)/.exec(user);
      const seatId = seatMatch?.[1] ?? 'unknown';
      log.voterCalls.push(input);
      const error = plan.voterErrors?.get(seatId);
      if (error) return ok('', input, error);
      const text = plan.voterResponses.get(seatId) ?? '{"optionId":"merge"}';
      return ok(text, input);
    },
  };
  return { caller, log };
}

function ok(text: string, input: OneShotLLMInput, error?: string): OneShotLLMResult {
  return {
    text,
    model: input.model ?? 'test-model',
    provider: input.providerId ?? 'test',
    tokens: { input: 10, output: 5, total: 15 },
    durationMs: 1,
    fromFallback: false,
    ...(error ? { error } : {}),
  };
}

function makeOrchestrator(
  plan: CallPlan,
  opts: {
    profiles?: ReturnType<typeof DEFAULT_COUNCIL_PROFILE_REGISTRY.require>;
    refusalOptionId?: string | undefined;
  } = {},
): { orchestrator: CouncilOrchestrator; log: CallLog } {
  const { caller, log } = makeCaller(plan);
  const orchestrator = new CouncilOrchestrator({
    caller,
    refusalOptionId: opts.refusalOptionId,
    maxConcurrency: 2,
  });
  return { orchestrator, log };
}

const QUESTION: CouncilQuestion = {
  question: 'Should we merge the risky change?',
  options: [
    { id: 'merge', label: 'Merge it' },
    { id: 'hold', label: 'Hold for review' },
  ],
};

describe('CouncilOrchestrator', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it('returns a decided result when the weighted majority exceeds the approval threshold', async () => {
    const profile = DEFAULT_COUNCIL_PROFILE_REGISTRY.require('balanced');
    const { orchestrator, log } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"optionId":"merge","rationale":"safe to land"}'],
        ['skeptic', '{"optionId":"hold","rationale":"needs another pass"}'],
        ['auditor', '{"optionId":"merge","rationale":"low risk"}'],
      ]),
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result).toMatchObject({
      status: 'decided',
      optionId: 'merge',
      answer: 'Merge it',
      resolution: 'majority',
      configuredSeatCount: profile.seats.length,
      validVoteCount: 3,
      judgeUsed: false,
    });
    // Two deliberation rounds x three seats: deliberation is linear in cost.
    expect(result.rounds).toBe(2);
    expect(result.usage).toMatchObject({
      calls: 6,
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 90,
    });
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
    // `votes` is the TALLIED round; every round is retained on `roundVotes`.
    expect(result.votes.filter((vote) => vote.status === 'valid')).toHaveLength(3);
    expect(result.roundVotes).toHaveLength(2);
    expect(result.roundVotes[0]?.every((vote) => vote.round === 1)).toBe(true);
    expect(result.roundVotes[1]).toEqual(result.votes);
    expect(log.judgeCalls).toEqual([]);
  });

  it('re-resolves a reused ad-hoc profile after the caller mutates it', async () => {
    const profile: CouncilProfileConfig = {
      id: 'mutable-profile',
      seats: [{ id: 'executor', persona: 'executor' }],
      judge: false,
    };
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"optionId":"merge"}'],
        ['auditor', '{"optionId":"merge"}'],
      ]),
    });

    const first = await orchestrator.ask({ ...QUESTION, profile });
    expect(first.configuredSeatCount).toBe(1);

    (profile.seats as Array<CouncilProfileConfig['seats'][number]>).push({
      id: 'auditor',
      persona: 'auditor',
    });
    const second = await orchestrator.ask({ ...QUESTION, profile });
    expect(second.configuredSeatCount).toBe(2);
  });

  it('rejects when a veto seat refuses', async () => {
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"optionId":"merge"}'],
        ['skeptic', JSON.stringify({ optionId: COUNCIL_REFUSE_OPTION_ID, rationale: 'unsafe' })],
        ['auditor', '{"optionId":"merge"}'],
      ]),
    });
    const result = await orchestrator.ask(QUESTION);

    expect(result.status).toBe('denied');
    expect(result.optionId).toBe(COUNCIL_REFUSE_OPTION_ID);
    expect(result.resolution).toBe('veto');
    expect(result.reason).toMatch(/veto/i);
  });

  it('reports refusal when the refusal option wins without a veto', async () => {
    const profile = {
      id: 'no-veto-three',
      name: 'No Veto',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
        { id: 'maintainer', persona: 'maintainer' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', JSON.stringify({ optionId: COUNCIL_REFUSE_OPTION_ID, rationale: 'no' })],
        ['auditor', JSON.stringify({ optionId: COUNCIL_REFUSE_OPTION_ID, rationale: 'no' })],
        ['maintainer', '{"optionId":"merge"}'],
      ]),
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.status).toBe('denied');
    expect(result.optionId).toBe(COUNCIL_REFUSE_OPTION_ID);
    expect(result.resolution).toBe('refusal');
  });

  it('routes ties through the judge and respects the judge verdict', async () => {
    const profile = {
      id: 'judge-tie-four',
      name: 'Judge Tie',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
        { id: 'c', persona: 'maintainer' },
        { id: 'd', persona: 'user-advocate' },
      ],
      judge: { role: 'reviewer' },
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator, log } = makeOrchestrator({
      voterResponses: new Map([
        ['a', '{"optionId":"merge"}'],
        ['b', '{"optionId":"merge"}'],
        ['c', '{"optionId":"hold"}'],
        ['d', '{"optionId":"hold"}'],
      ]),
      judgeResponse: '{"optionId":"hold","rationale":"safer to wait"}',
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.status).toBe('decided');
    expect(result.optionId).toBe('hold');
    expect(result.resolution).toBe('judge');
    expect(result.judgeUsed).toBe(true);
    expect(log.judgeCalls).toHaveLength(1);
  });

  it('returns judge denial as a denied verdict', async () => {
    const profile = {
      id: 'judge-deny-three',
      name: 'Judge Deny',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
        { id: 'maintainer', persona: 'maintainer' },
      ],
      judge: { role: 'reviewer' },
      quorumFraction: 0.5,
      approvalFraction: 0.9,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"optionId":"merge"}'],
        ['auditor', '{"optionId":"hold"}'],
        ['maintainer', '{"optionId":"hold"}'],
      ]),
      judgeResponse: JSON.stringify({
        optionId: COUNCIL_REFUSE_OPTION_ID,
        rationale: 'none acceptable',
      }),
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.status).toBe('denied');
    expect(result.optionId).toBe(COUNCIL_REFUSE_OPTION_ID);
    expect(result.resolution).toBe('judge');
    expect(result.reason).toContain('none acceptable');
  });

  it('abstains when the judge is needed but unavailable, even with profile.judge enabled', async () => {
    const profile = {
      id: 'judge-unavailable-four',
      name: 'Judge Unavailable',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
        { id: 'c', persona: 'maintainer' },
        { id: 'd', persona: 'user-advocate' },
      ],
      judge: { role: 'reviewer' },
      quorumFraction: 0.5,
      approvalFraction: 0.9,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['a', '{"optionId":"merge"}'],
        ['b', '{"optionId":"merge"}'],
        ['c', '{"optionId":"hold"}'],
        ['d', '{"optionId":"hold"}'],
      ]),
      judgeError: 'judge unavailable',
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.status).toBe('abstained');
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('judge')]));
  });

  it('abstains when the judge is required but the profile has none', async () => {
    const profile = {
      id: 'no-judge-tie',
      name: 'No Judge Tie',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.9,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { caller, log } = makeCaller({
      voterResponses: new Map([
        ['executor', '{"optionId":"merge"}'],
        ['auditor', '{"optionId":"hold"}'],
      ]),
    });
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 2 });

    const result = await orchestrator.ask({ ...QUESTION, profile });
    expect(result.status).toBe('abstained');
    expect(result.resolution).toBe('none');
    expect(log.judgeCalls).toEqual([]);
  });

  it('treats a refusal id collision as an error before any seat runs', async () => {
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map(),
    });

    await expect(
      orchestrator.ask({
        ...QUESTION,
        options: [...QUESTION.options!, { id: COUNCIL_REFUSE_OPTION_ID, label: 'Refuse' }],
      }),
    ).rejects.toThrow(/reserved/);
  });

  it('cancels quickly when the call signal is already aborted', async () => {
    const profile = {
      id: 'cancel-fast',
      name: 'Cancel',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({});
    const controller = new AbortController();
    controller.abort();
    const result = await orchestrator.ask({ ...QUESTION, profile, signal: controller.signal });

    expect(result.status).toBe('cancelled');
    expect(result.votes.every((vote) => vote.status === 'cancelled')).toBe(true);
    expect(result.usage.calls).toBe(0);
  });

  it('emits a distinctness warning when seats converge on a single serving target', async () => {
    const profile = {
      id: 'distinctness-tight',
      name: 'Distinctness Tight',
      description: '',
      seats: [
        { id: 'a', persona: 'executor', target: { providerId: 'p' } },
        { id: 'b', persona: 'auditor', target: { providerId: 'q' } },
        { id: 'c', persona: 'maintainer', target: { providerId: 'p' } },
        { id: 'd', persona: 'user-advocate', target: { providerId: 'p' } },
      ],
      judge: { role: 'reviewer' },
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'provider' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['a', '{"optionId":"merge"}'],
        ['b', '{"optionId":"hold"}'],
        ['c', '{"optionId":"merge"}'],
        ['d', '{"optionId":"merge"}'],
      ]),
      judgeResponse: '{"optionId":"merge"}',
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/distinctness policy "provider" was not met/i),
      ]),
    );
  });

  it('still warns for a half-dead panel whose surviving votes share one target', async () => {
    const profile = {
      id: 'half-dead-correlated',
      name: 'Half Dead Correlated',
      description: '',
      seats: [
        { id: 'a', persona: 'executor', target: { providerId: 'p1' } },
        { id: 'b', persona: 'auditor', target: { providerId: 'p1' } },
        { id: 'c', persona: 'maintainer', target: { providerId: 'p1' } },
        { id: 'd', persona: 'user-advocate', target: { providerId: 'p1' } },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'provider' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterErrors: new Map([
        ['a', 'down'],
        ['b', 'down'],
      ]),
      voterResponses: new Map([
        ['c', '{"optionId":"merge"}'],
        ['d', '{"optionId":"merge"}'],
      ]),
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    // The failed seats must not shrink the comparison out of existence: the
    // two survivors were both served by p1, so the panel is flagged even
    // though half its seats died.
    expect(result.status).toBe('decided');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/distinctness policy "provider" was not met/i),
      ]),
    );
    expect(result.warnings?.join(' ')).toContain('1 distinct target(s) served 2 valid vote(s)');
  });

  it('does not judge distinctness from votes that lack a serving target', async () => {
    const noTargetCaller: CouncilLLMCaller = {
      async call(_input: OneShotLLMInput): Promise<OneShotLLMResult> {
        return {
          text: '{"optionId":"merge"}',
          model: '',
          provider: '',
          tokens: { input: 1, output: 1, total: 2 },
          durationMs: 1,
          fromFallback: false,
        };
      },
    };
    const profile = {
      id: 'no-attribution',
      name: 'No Attribution',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const orchestrator = new CouncilOrchestrator({ caller: noTargetCaller, maxConcurrency: 2 });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.status).toBe('decided');
    // Votes with no provider/model can neither demonstrate nor refute
    // diversity — the 'model'-mode template must not conjure a warning from
    // the '/' sentinel.
    expect(result.warnings).toBeUndefined();
    expect(result.distinctTargetCount).toBe(0);
  });

  it('drops model-only votes from the provider-mode distinctness count', async () => {
    // Regression for the provider-mode key bug: a valid vote reporting a
    // model but no provider must not produce an `undefined` key that a Set
    // counts as a distinct target (which would inflate distinctTargetCount
    // and suppress the correlation warning).
    const partialTargetCaller: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        const seatMatch = /Seat id: ([a-z0-9-]+)/.exec(input.userPrompt ?? '');
        const seatId = seatMatch?.[1] ?? 'unknown';
        return {
          text: '{"optionId":"merge"}',
          // Seat 'a' reports a provider; seat 'b' reports model-only.
          model: 'gpt-5',
          provider: seatId === 'a' ? 'openai' : '',
          tokens: { input: 1, output: 1, total: 2 },
          durationMs: 1,
          fromFallback: false,
        };
      },
    };
    const profile = {
      id: 'provider-mode-partial',
      name: 'Provider Mode Partial',
      description: '',
      seats: [
        { id: 'a', persona: 'executor', target: { providerId: 'openai' } },
        { id: 'b', persona: 'auditor', target: { providerId: 'openai' } },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'provider' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const orchestrator = new CouncilOrchestrator({
      caller: partialTargetCaller,
      maxConcurrency: 2,
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.status).toBe('decided');
    // Only the vote WITH a provider counts toward provider diversity.
    expect(result.distinctTargetCount).toBe(1);
    expect(result.warnings).toBeUndefined();
  });

  it('abstains when optionless stances diverge and no judge is configured', async () => {
    const profile = {
      id: 'open-no-judge',
      name: 'Open No Judge',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"stance":"continue, evidence is solid."}'],
        ['auditor', '{"stance":"hold, wait for benchmarks."}'],
      ]),
    });
    const result = await orchestrator.ask({
      question: 'Should we continue?',
      profile,
    });

    // Divergence is surfaced instead of first-stance-wins: with no judge to
    // reconcile free-text stances, the panel abstains rather than silently
    // letting the first seat's stance win.
    expect(result).toMatchObject({
      status: 'abstained',
      resolution: 'none',
      judgeUsed: false,
    });
    expect(result.reason).toMatch(/multiple distinct stances/i);
    expect(result.votes.filter((vote) => vote.status === 'valid')).toHaveLength(2);
  });

  it('decides on a single stance when optionless and judge is disabled', async () => {
    const profile = {
      id: 'open-single-stance',
      name: 'Open Single Stance',
      description: '',
      seats: [{ id: 'executor', persona: 'executor' }],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([['executor', '{"stance":"continue, evidence is solid."}']]),
    });
    const result = await orchestrator.ask({
      question: 'Should we continue?',
      profile,
    });

    expect(result).toMatchObject({
      status: 'decided',
      resolution: 'first_stance',
      answer: 'continue, evidence is solid.',
      judgeUsed: false,
    });
    expect(result.votes.filter((vote) => vote.status === 'valid')).toHaveLength(1);
  });

  it('decides when multiple optionless stances are identical and no judge is configured', async () => {
    const profile = {
      id: 'open-identical-stances',
      name: 'Open Identical Stances',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"stance":"proceed carefully"}'],
        ['auditor', '{"stance":"proceed carefully"}'],
      ]),
    });
    const result = await orchestrator.ask({
      question: 'Should we proceed?',
      profile,
    });

    // Identical free-text stances are unanimous, not divergent — a decision,
    // not an abstain.
    expect(result).toMatchObject({
      status: 'decided',
      resolution: 'first_stance',
      answer: 'proceed carefully',
      judgeUsed: false,
    });
    expect(result.votes.filter((vote) => vote.status === 'valid')).toHaveLength(2);
  });

  it('treats formatting-only stance differences as agreement when judge-less', async () => {
    const profile = {
      id: 'open-formatting-agreement',
      name: 'Open Formatting Agreement',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"stance":"Yes."}'],
        ['auditor', '{"stance":"yes"}'],
      ]),
    });
    const result = await orchestrator.ask({
      question: 'Proceed?',
      profile,
    });

    // Casing/punctuation differences normalize to agreement — the panel
    // decides (returning the raw first stance, per divergentStances'
    // "winning stance is still returned raw" contract) instead of escalating.
    expect(result).toMatchObject({
      status: 'decided',
      resolution: 'first_stance',
      answer: 'Yes.',
      judgeUsed: false,
    });
  });

  it('returns the synthesized judge answer for optionless tie questions', async () => {
    const profile = {
      id: 'open-tie-judge',
      name: 'Open Tie Judge',
      description: '',
      seats: [
        { id: 'executor', persona: 'executor' },
        { id: 'auditor', persona: 'auditor' },
        { id: 'maintainer', persona: 'maintainer' },
      ],
      judge: { role: 'reviewer' },
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { orchestrator } = makeOrchestrator({
      voterResponses: new Map([
        ['executor', '{"stance":"proceed"}'],
        ['auditor', '{"stance":"hold"}'],
        ['maintainer', '{"stance":"proceed"}'],
      ]),
      judgeResponse: '{"answer":"proceed cautiously","rationale":"weighted evidence"}',
    });
    const result = await orchestrator.ask({
      question: 'Should we proceed?',
      profile,
    });

    expect(result).toMatchObject({
      status: 'decided',
      resolution: 'judge',
      answer: 'proceed cautiously',
      judgeUsed: true,
    });
    expect(result.reason).toContain('weighted evidence');
  });

  it('caps total concurrent voter calls at the configured maxConcurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const profile = {
      id: 'concurrency-cap-four',
      name: 'Concurrency Cap',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
        { id: 'c', persona: 'maintainer' },
        { id: 'd', persona: 'user-advocate' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const caller: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        if (input.userPrompt?.includes('<council-ballots>')) return ok('{"answer":"go"}', input);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return ok('{"stance":"proceed"}', input);
      },
    };
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 2 });
    const before = Date.now();
    const result = await orchestrator.ask({ question: 'Go?', profile });
    expect(Date.now() - before).toBeGreaterThanOrEqual(20);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.usage.calls).toBeGreaterThan(0);
  });

  it('rejects invalid maxConcurrency at construction', () => {
    expect(() => new CouncilOrchestrator({ caller: noopCaller(), maxConcurrency: 0 })).toThrow(
      /maxConcurrency/,
    );
    expect(() => new CouncilOrchestrator({ caller: noopCaller(), maxConcurrency: 999 })).toThrow(
      /maxConcurrency/,
    );
    expect(DEFAULT_COUNCIL_MAX_CONCURRENCY).toBeLessThanOrEqual(MAX_COUNCIL_CONCURRENCY);
  });

  it('throws on collision between caller option and the synthetic refusal id', async () => {
    const { orchestrator } = makeOrchestrator({});
    await expect(
      orchestrator.ask({
        ...QUESTION,
        options: [...QUESTION.options!, { id: COUNCIL_REFUSE_OPTION_ID, label: 'Refuse' }],
      }),
    ).rejects.toThrow(/reserved/);
  });

  it('preserves the configured refusal id through resolution', async () => {
    const profile = {
      id: 'refusal-custom-three',
      name: 'Custom Refusal',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
        { id: 'c', persona: 'maintainer' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const { caller, log } = makeCaller({
      voterResponses: new Map([
        ['a', '{"optionId":"custom_refuse"}'],
        ['b', '{"optionId":"custom_refuse"}'],
        ['c', '{"optionId":"merge"}'],
      ]),
    });
    const orchestrator = new CouncilOrchestrator({
      caller,
      maxConcurrency: 2,
      refusalOptionId: 'custom_refuse',
    });
    const result = await orchestrator.ask({
      ...QUESTION,
      profile,
    });

    expect(result.status).toBe('denied');
    expect(result.optionId).toBe('custom_refuse');
    expect(result.resolution).toBe('refusal');
    expect(log.judgeCalls).toEqual([]);
  });

  it('pre-resolves fallbackProfile through the injected FallbackProfileManager', async () => {
    const cfg = {
      provider: 'primary',
      model: 'p-model',
      providers: {
        primary: { type: 'test', apiKey: 'sk-1', models: ['p-model', 'fb-model'] },
        fallback: { type: 'test', apiKey: 'sk-2', models: ['fb-model'] },
      },
      fallbackProfiles: {
        'safe-fb': ['fallback/fb-model'],
      },
    } as unknown as Config;
    const mgr = new FallbackProfileManager(cfg);
    let captured: OneShotLLMInput | undefined;
    const capturing: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        captured = input;
        return ok('{"optionId":"merge"}', input);
      },
    };
    const orch = new CouncilOrchestrator({
      caller: capturing,
      fallbackProfileManager: mgr,
      maxConcurrency: 1,
    });
    const profile = {
      id: 'fallback-profile-seat',
      name: 'Fallback Profile Seat',
      description: '',
      seats: [
        {
          id: 'a',
          persona: 'executor',
          target: { providerId: 'primary', model: 'p-model', fallbackProfile: 'safe-fb' },
        },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const result = await orch.ask({ ...QUESTION, profile });
    expect(result.status).toBe('decided');
    // The seat target's named profile was resolved to its chain and handed to
    // the caller as explicit fallbackModels — not left as a profile name.
    expect(captured?.fallbackModels).toEqual(['fallback/fb-model']);
  });
});

describe('CouncilOrchestrator — status + usage consistency', () => {
  const hangingCaller = (onCall: () => void): CouncilLLMCaller => ({
    async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
      onCall();
      // Hangs until the orchestrator's signal aborts, like a real provider
      // observing the abort signal.
      await new Promise<void>((_resolve, reject) => {
        if (input.signal?.aborted) return reject(new Error('aborted'));
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
      return ok('{"optionId":"merge"}', input);
    },
  });

  it('marks votes failed, not cancelled, when the overall budget expires', async () => {
    // Consistency regression: the overall timeout aborts the combined signal,
    // so in-flight seats must be reported as failed (timeout), not cancelled —
    // only the CALLER's own signal means "cancelled".
    const orchestrator = new CouncilOrchestrator({
      caller: hangingCaller(() => {}),
      maxConcurrency: 1,
    });
    const profile = {
      id: 'overall-timeout-status',
      name: 'Overall Timeout',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
        { id: 'c', persona: 'maintainer' },
        { id: 'd', persona: 'user-advocate' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 50,
      overallTimeoutMs: 100,
    } satisfies CouncilProfileConfig;
    const result = await orchestrator.ask({ ...QUESTION, profile });
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/overall timeout/i);
    expect(result.votes).toHaveLength(4);
    // In-flight seats aborted by the budget are failures, and they share the
    // canonical timeout error with seats that never started.
    expect(result.votes.every((vote) => vote.status === 'failed')).toBe(true);
    expect(result.votes.every((vote) => vote.error?.includes('overall timeout'))).toBe(true);
  }, 3_000);

  it('does not report a judge verdict produced after the overall budget expired', async () => {
    const profile = {
      id: 'post-expiry-judge',
      name: 'Post Expiry Judge',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
      ],
      judge: { role: 'reviewer' },
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 50,
      overallTimeoutMs: 100,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    // Voters tie (merge vs hold) so the judge is required; the judge is
    // signal-blind and returns a verdict AFTER the overall budget expired.
    const seatCaller: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        const seatMatch = /Seat id: ([a-z0-9-]+)/.exec(input.userPrompt ?? '');
        const seatId = seatMatch?.[1] ?? 'unknown';
        return ok(seatId === 'a' ? '{"optionId":"merge"}' : '{"optionId":"hold"}', input);
      },
    };
    const signalBlindJudge: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return ok('{"optionId":"merge"}', input);
      },
    };
    const orchestrator = new CouncilOrchestrator({
      caller: seatCaller,
      judgeCaller: signalBlindJudge,
      maxConcurrency: 2,
    });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    // A decision derived from a post-expiry judge call must be surfaced as a
    // timeout failure, not 'decided'.
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('Council overall timeout exceeded.');
    expect(result.judgeUsed).toBe(true);
  }, 3_000);

  it('appends the standalone timeout error when no seat error carries it', async () => {
    // A signal-blind caller resolves valid votes even after the overall
    // budget expired: every seat looks fine, so the timeout must surface
    // through the standalone errors entry (deduped — exactly once).
    const signalBlind: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return ok('{"optionId":"merge"}', input);
      },
    };
    const profile = {
      id: 'standalone-timeout',
      name: 'Standalone Timeout',
      description: '',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'auditor' },
      ],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      // Per-call budget < overall so the invariant holds; the signal-blind
      // caller ignores the per-call timeout and only the overall (100ms) can
      // fire while the calls are in flight.
      perCallTimeoutMs: 50,
      overallTimeoutMs: 100,
    } satisfies import('../../src/types/council.js').CouncilProfileConfig;
    const orchestrator = new CouncilOrchestrator({ caller: signalBlind, maxConcurrency: 2 });
    const result = await orchestrator.ask({ ...QUESTION, profile });

    expect(result.status).toBe('failed');
    // Both seats started before the budget expired and resolved valid after
    // it — no seat error carries the timeout text, so the standalone entry is
    // appended exactly once.
    expect(result.votes.every((vote) => vote.status === 'valid')).toBe(true);
    expect(result.errors).toEqual(['Council overall timeout exceeded.']);
  }, 3_000);

  it('marks votes cancelled when the caller signal aborts mid-run', async () => {
    const controller = new AbortController();
    let started = 0;
    const orchestrator = new CouncilOrchestrator({
      caller: hangingCaller(() => {
        started += 1;
      }),
      maxConcurrency: 2,
    });
    const pending = orchestrator.ask({ ...QUESTION, signal: controller.signal });
    await vi.waitFor(() => expect(started).toBeGreaterThan(0));
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.votes.length).toBeGreaterThan(0);
    expect(result.votes.every((vote) => vote.status === 'cancelled')).toBe(true);
  }, 3_000);

  it('attributes provider/model and real duration to a seat call that throws', async () => {
    const throwing: CouncilLLMCaller = {
      async call(): Promise<OneShotLLMResult> {
        await new Promise((resolve) => setTimeout(resolve, 15));
        throw new Error('boom');
      },
    };
    const orchestrator = new CouncilOrchestrator({ caller: throwing, maxConcurrency: 1 });
    const profile = {
      id: 'throw-attribution',
      name: 'Throw Attribution',
      description: '',
      seats: [{ id: 'a', persona: 'executor', target: { providerId: 'p1', model: 'm1' } }],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies CouncilProfileConfig;
    const result = await orchestrator.ask({ ...QUESTION, profile });
    const vote = result.votes[0]!;
    expect(vote.status).toBe('failed');
    expect(vote.error).toContain('boom');
    expect(vote.provider).toBe('p1');
    expect(vote.model).toBe('m1');
    expect(vote.durationMs).toBeGreaterThanOrEqual(10);
    // One seat, two deliberation rounds.
    expect(result.usage.calls).toBe(2);
  });

  it('counts reported fallback attempts in usage.calls', async () => {
    const multiAttempt: CouncilLLMCaller = {
      async call(): Promise<OneShotLLMResult> {
        return {
          text: '{"optionId":"merge"}',
          model: 'm',
          provider: 'p',
          tokens: { input: 1, output: 1, total: 2 },
          durationMs: 1,
          fromFallback: true,
          attempts: 3,
        };
      },
    };
    const profile = {
      id: 'attempts-count',
      name: 'Attempts',
      description: '',
      seats: [{ id: 'a', persona: 'executor' }],
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model' as const,
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      overallTimeoutMs: 90_000,
    } satisfies CouncilProfileConfig;
    const orchestrator = new CouncilOrchestrator({ caller: multiAttempt, maxConcurrency: 1 });
    const result = await orchestrator.ask({ ...QUESTION, profile });
    expect(result.status).toBe('decided');
    // 3 reported attempts per call, one seat, two deliberation rounds.
    expect(result.usage.calls).toBe(6);
  });
});

function noopCaller(): CouncilLLMCaller {
  return {
    async call(): Promise<OneShotLLMResult> {
      return ok('{"stance":"go"}', {} as OneShotLLMInput);
    },
  };
}

describe('CouncilOrchestrator — truncation attribution', () => {
  const truncated = (text: string): OneShotLLMResult => ({
    text,
    model: 'test-model',
    provider: 'test',
    tokens: { input: 10, output: 5, total: 15 },
    durationMs: 1,
    fromFallback: false,
    stopReason: 'max_tokens',
  });

  it('appends the voter budget to an invalid vote cut off at max_tokens', async () => {
    // A reasoning model that spends its whole output budget thinking returns
    // empty/mid-JSON text with stopReason max_tokens. The bare parse error
    // ("did not contain JSON") pointed operators away from the actual fix.
    const caller: CouncilLLMCaller = {
      async call(): Promise<OneShotLLMResult> {
        return truncated('{"optionId":');
      },
    };
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const profile = {
      id: 'trunc-voter',
      seats: [{ id: 'a', persona: 'executor' }],
      judge: false,
      voterMaxTokens: 123,
    } satisfies CouncilProfileConfig;
    const result = await orchestrator.ask({ ...QUESTION, profile });
    const vote = result.votes[0];
    expect(vote?.status).toBe('invalid');
    expect(vote?.error).toContain('truncated at maxTokens=123');
  });

  it('appends the judge budget when the judge response is cut off at max_tokens', async () => {
    const caller: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        const isJudge = (input.userPrompt ?? '').includes('<council-ballots>');
        if (isJudge) return truncated('{"optionId');
        // Split panel forces the judge to run.
        const seatId = /Seat id: ([a-z0-9-]+)/.exec(input.userPrompt ?? '')?.[1];
        return ok(seatId === 'a' ? '{"optionId":"merge"}' : '{"optionId":"hold"}', input);
      },
    };
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const profile = {
      id: 'trunc-judge',
      seats: [
        { id: 'a', persona: 'executor' },
        { id: 'b', persona: 'skeptic' },
      ],
      judge: { role: 'reviewer' },
      judgeMaxTokens: 77,
    } satisfies CouncilProfileConfig;
    const result = await orchestrator.ask({ ...QUESTION, profile });
    expect(result.judgeUsed).toBe(true);
    expect(result.errors?.some((e) => e.includes('truncated at maxTokens=77'))).toBe(true);
  });
});

describe('CouncilOrchestrator — deliberation rounds', () => {
  /** A caller that answers per (seatId, round) so a seat can change its mind. */
  function roundCaller(script: Record<string, string[]>) {
    const prompts: OneShotLLMInput[] = [];
    const seen = new Map<string, number>();
    const caller: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        const user = input.userPrompt ?? '';
        prompts.push(input);
        const seatId = /Seat id: ([a-z0-9-]+)/.exec(user)?.[1] ?? 'unknown';
        const round = seen.get(seatId) ?? 0;
        seen.set(seatId, round + 1);
        const answers = script[seatId] ?? ['{"optionId":"merge"}'];
        const text = answers[Math.min(round, answers.length - 1)] ?? answers[0]!;
        return {
          text,
          model: 'm',
          provider: 'p',
          tokens: { input: 1, output: 1, total: 2 },
          durationMs: 1,
          fromFallback: false,
        };
      },
    };
    return { caller, prompts };
  }

  const threeSeats = (over: Partial<CouncilProfileConfig> = {}): CouncilProfileConfig => ({
    id: 'delib',
    seats: [
      { id: 'a', persona: 'executor' },
      { id: 'b', persona: 'skeptic' },
      { id: 'c', persona: 'auditor' },
    ],
    judge: false,
    distinctness: 'none',
    ...over,
  });

  it('keeps round 1 independent and shows the other ballots from round 2', async () => {
    const { caller, prompts } = roundCaller({
      a: ['{"optionId":"merge","rationale":"ship it"}'],
      b: ['{"optionId":"merge","rationale":"fine"}'],
      c: ['{"optionId":"merge","rationale":"ok"}'],
    });
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const result = await orchestrator.ask({ ...QUESTION, profile: threeSeats() });

    expect(result.rounds).toBe(2);
    const round1 = prompts.slice(0, 3).map((p) => p.userPrompt ?? '');
    const round2 = prompts.slice(3).map((p) => p.userPrompt ?? '');
    // The panel's value is independence; round 1 must never leak a peer view.
    expect(round1.some((p) => p.includes('council-deliberation'))).toBe(false);
    expect(round2.every((p) => p.includes('<council-deliberation>'))).toBe(true);
    expect(round2[0]).toContain('"seatId":"b"');
    // A seat sees its OWN previous ballot marked, so it can hold a position
    // rather than re-deriving one from scratch.
    expect(round2[0]).toContain('"isYou":true');
  });

  it('tallies the final round and records the seats that moved', async () => {
    const { caller } = roundCaller({
      // The skeptic is persuaded in round 2; the panel flips to unanimous.
      a: ['{"optionId":"merge"}', '{"optionId":"merge"}'],
      b: ['{"optionId":"hold"}', '{"optionId":"merge"}'],
      c: ['{"optionId":"merge"}', '{"optionId":"merge"}'],
    });
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const result = await orchestrator.ask({ ...QUESTION, profile: threeSeats() });

    expect(result.optionId).toBe('merge');
    expect(result.roundVotes[0]?.find((v) => v.seatId === 'b')?.optionId).toBe('hold');
    expect(result.votes.find((v) => v.seatId === 'b')?.optionId).toBe('merge');
    expect(result.votes.find((v) => v.seatId === 'b')?.changed).toBe(true);
    expect(result.deliberationChanges).toBe(1);
  });

  it('reports nothing changed when the panel holds its positions', async () => {
    const { caller } = roundCaller({
      a: ['{"optionId":"merge"}'],
      b: ['{"optionId":"merge"}'],
      c: ['{"optionId":"merge"}'],
    });
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const result = await orchestrator.ask({ ...QUESTION, profile: threeSeats() });

    // 0 is the honest signal that the extra round bought cost and nothing else.
    expect(result.deliberationChanges).toBe(0);
    expect(result.warnings ?? []).toEqual([]);
  });

  it('warns when a majority of the panel converges in one round', async () => {
    const { caller } = roundCaller({
      a: ['{"optionId":"hold"}', '{"optionId":"merge"}'],
      b: ['{"optionId":"hold"}', '{"optionId":"merge"}'],
      c: ['{"optionId":"merge"}', '{"optionId":"merge"}'],
    });
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const result = await orchestrator.ask({ ...QUESTION, profile: threeSeats() });

    // A clean unanimous verdict that was manufactured by conformity looks
    // BETTER than the split it came from — the warning is the only signal.
    expect(result.warnings?.some((w) => w.includes('convergence'))).toBe(true);
  });

  it('warns when a veto seat folds after seeing the other ballots', async () => {
    const { caller } = roundCaller({
      a: ['{"optionId":"merge"}'],
      b: ['{"optionId":"hold"}', '{"optionId":"merge"}'],
      c: ['{"optionId":"merge"}'],
    });
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const result = await orchestrator.ask({
      ...QUESTION,
      profile: threeSeats({
        seats: [
          { id: 'a', persona: 'executor' },
          { id: 'b', persona: 'skeptic', veto: true },
          { id: 'c', persona: 'auditor' },
        ],
      }),
    });

    // The veto seat is the panel's safety property; a folded veto removes it.
    expect(result.warnings?.some((w) => w.includes('veto seat "b"'))).toBe(true);
  });

  it('runs exactly one round when deliberation is disabled', async () => {
    const { caller, prompts } = roundCaller({ a: ['{"optionId":"merge"}'] });
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const result = await orchestrator.ask({
      ...QUESTION,
      profile: threeSeats({ seats: [{ id: 'a', persona: 'executor' }], deliberationRounds: 1 }),
    });

    expect(result.rounds).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(result.roundVotes).toHaveLength(1);
    expect(result.deliberationChanges).toBe(0);
  });

  it('falls back to the last usable round when a later round fails wholesale', async () => {
    let round = 0;
    const caller: CouncilLLMCaller = {
      async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
        round += 1;
        const base = {
          model: 'm',
          provider: 'p',
          tokens: { input: 1, output: 1, total: 2 },
          durationMs: 1,
          fromFallback: false,
        };
        // Round 1 votes cleanly; round 2's transport dies.
        if ((input.userPrompt ?? '').includes('<council-deliberation>')) {
          return { ...base, text: '', error: 'upstream 503' };
        }
        void round;
        return { ...base, text: '{"optionId":"merge"}' };
      },
    };
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 1 });
    const result = await orchestrator.ask({
      ...QUESTION,
      profile: threeSeats({ seats: [{ id: 'a', persona: 'executor' }] }),
    });

    // A dead second round must not throw away a perfectly good first one.
    expect(result.status).toBe('decided');
    expect(result.optionId).toBe('merge');
    expect(result.roundVotes).toHaveLength(2);
  });
});
