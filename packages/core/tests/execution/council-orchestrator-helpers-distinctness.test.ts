import type {
  CouncilVoteResult,
  ResolvedCouncilProfile,
} from '@wrongstack/contracts/types/council';
import { describe, expect, it } from 'vitest';
import {
  distinctnessWarnings,
  distinctTargetCount,
} from '../../src/execution/council-orchestrator-helpers.js';

function profile(distinctness: 'none' | 'model' | 'provider'): ResolvedCouncilProfile {
  return {
    id: 'p',
    name: 'P',
    description: '',
    seats: [],
    judge: false,
    quorumFraction: 0.5,
    approvalFraction: 0.5,
    distinctness,
    voterMaxTokens: undefined,
    judgeMaxTokens: undefined,
    perCallTimeoutMs: 30_000,
    overallTimeoutMs: 60_000,
    deliberationRounds: 1,
  } as ResolvedCouncilProfile;
}

function vote(seatId: string, provider: string, model: string): CouncilVoteResult {
  return {
    seatId,
    persona: seatId,
    status: 'valid',
    provider,
    model,
    durationMs: 1,
    optionId: 'go',
  } as CouncilVoteResult;
}

describe('council distinctness policy: model semantics', () => {
  it("flags one model served through two providers under the 'model' policy", () => {
    // The contract (brain-config.ts) for distinctness 'model' is "seats must
    // use distinct models". The same model reached through two provider ids is
    // one model; keying by provider/model pairs would silently bless it.
    const votes = [vote('a', 'openai', 'gpt-x'), vote('b', 'azure', 'gpt-x')];
    const warnings = distinctnessWarnings(votes, profile('model'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('distinctness policy "model"');
    expect(distinctTargetCount(votes, profile('model'))).toBe(1);
  });

  it("accepts distinct models under the 'model' policy", () => {
    const votes = [vote('a', 'openai', 'model-a'), vote('b', 'openai', 'model-b')];
    expect(distinctnessWarnings(votes, profile('model'))).toHaveLength(0);
    expect(distinctTargetCount(votes, profile('model'))).toBe(2);
  });

  it("keys votes without a model by provider under the 'model' policy", () => {
    const votes = [
      { seatId: 'a', persona: 'a', status: 'valid', provider: 'openai', durationMs: 1 },
      { seatId: 'b', persona: 'b', status: 'valid', provider: 'azure', durationMs: 1 },
    ] as unknown as CouncilVoteResult[];
    expect(distinctTargetCount(votes, profile('model'))).toBe(2);
  });

  it("keys by provider under the 'provider' policy regardless of model", () => {
    const distinct = [vote('a', 'openai', 'x'), vote('b', 'azure', 'y')];
    expect(distinctnessWarnings(distinct, profile('provider'))).toHaveLength(0);

    const sameProvider = [vote('a', 'openai', 'x'), vote('b', 'openai', 'y')];
    expect(distinctnessWarnings(sameProvider, profile('provider'))).toHaveLength(1);
    expect(distinctTargetCount(sameProvider, profile('provider'))).toBe(1);
  });

  it("reports provider/model pair counts under the default 'none' policy without warning", () => {
    const votes = [vote('a', 'openai', 'x'), vote('b', 'openai', 'x')];
    expect(distinctnessWarnings(votes, profile('none'))).toHaveLength(0);
    expect(distinctTargetCount(votes, profile('none'))).toBe(1);
  });

  it('ignores invalid and cancelled ballots', () => {
    const votes = [
      vote('a', 'openai', 'x'),
      { seatId: 'b', persona: 'b', status: 'cancelled', durationMs: 0 } as CouncilVoteResult,
    ];
    expect(distinctnessWarnings(votes, profile('model'))).toHaveLength(0);
    expect(distinctTargetCount(votes, profile('model'))).toBe(1);
  });
});
