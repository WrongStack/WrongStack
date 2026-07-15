import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CouncilLLMCaller, CouncilQuestion } from '../../src/types/council.js';
import type { OneShotLLMInput, OneShotLLMResult } from '../../src/types/one-shot-llm.js';
import {
  CouncilOrchestrator,
  DEFAULT_COUNCIL_MAX_CONCURRENCY,
  MAX_COUNCIL_CONCURRENCY,
} from '../../src/execution/council-orchestrator.js';
import { DEFAULT_COUNCIL_PROFILE_REGISTRY } from '../../src/execution/council-profiles.js';
import { COUNCIL_REFUSE_OPTION_ID } from '../../src/execution/council-brain.js';

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
    expect(result.usage).toMatchObject({ calls: 3, inputTokens: 30, outputTokens: 15, totalTokens: 45 });
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.votes.filter((vote) => vote.status === 'valid')).toHaveLength(3);
    expect(log.judgeCalls).toEqual([]);
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
        options: [
          ...QUESTION.options!,
          { id: COUNCIL_REFUSE_OPTION_ID, label: 'Refuse' },
        ],
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

  it('returns the first valid stance when optionless and judge is disabled', async () => {
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

    expect(result).toMatchObject({
      status: 'decided',
      resolution: 'first_stance',
      answer: 'continue, evidence is solid.',
      judgeUsed: false,
    });
    expect(result.votes.filter((vote) => vote.status === 'valid')).toHaveLength(2);
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
    const orchestrator = new CouncilOrchestrator({ caller, maxConcurrency: 2, refusalOptionId: 'custom_refuse' });
    const result = await orchestrator.ask({
      ...QUESTION,
      profile,
    });

    expect(result.status).toBe('denied');
    expect(result.optionId).toBe('custom_refuse');
    expect(result.resolution).toBe('refusal');
    expect(log.judgeCalls).toEqual([]);
  });
});

function noopCaller(): CouncilLLMCaller {
  return {
    async call(): Promise<OneShotLLMResult> {
      return ok('{"stance":"go"}', {} as OneShotLLMInput);
    },
  };
}
