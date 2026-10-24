/**
 * The rest gate, the per-feature judge, and the Brain's System One tier.
 *
 * What matters here is the fallback contract: a host that is busy or down
 * must be skipped without a network call until its rest ends, a feature
 * switched off must never get a client, and a judgment that is not sure
 * must hand the decision back unchanged.
 */

import { FetchError } from '@wrongstack/contracts/types/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrainDecisionRequest } from '../src/brain/brain.js';
import { createTieredBrainArbiter } from '../src/execution/autonomy-brain.js';
import { createSystemOneBrainTier } from '../src/execution/brain-system-one.js';
import {
  createTypeSafeRestGate,
  resetSharedTypeSafeRestGatesForTests,
  resetTypeSafeJudgesForTests,
  resetWarnOnceForTests,
  resolveTypeSafeJudge,
  type SystemOneResult,
  type TypeSafeJudge,
  TypeSafeRestingError,
  withTypeSafeRest,
} from '../src/typesafe/index.js';

function fetchError(status: number): FetchError {
  return new FetchError({ message: `boom ${status}`, status, context: { op: 'test' } });
}

afterEach(() => {
  resetSharedTypeSafeRestGatesForTests();
  resetTypeSafeJudgesForTests();
  resetWarnOnceForTests();
});

describe('TypeSafe rest gate', () => {
  it('rests after one 429 and skips the network until the cooldown ends', async () => {
    let now = 1_000;
    const gate = createTypeSafeRestGate({ baseCooldownMs: 30_000, now: () => now });
    const systemOne = vi.fn().mockRejectedValueOnce(fetchError(429));
    const client = withTypeSafeRest({ systemOne }, gate);

    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toThrow(FetchError);
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toBeInstanceOf(
      TypeSafeRestingError,
    );
    expect(systemOne).toHaveBeenCalledTimes(1);

    now += 30_001;
    systemOne.mockResolvedValueOnce({ answers: {}, usage: { inputTokens: 1, outputTokens: 0 } });
    await expect(client.systemOne({ state: {}, questions: {} })).resolves.toBeTruthy();
    expect(gate.isResting()).toBe(false);
  });

  it('needs two timeouts, and doubles the rest when the probe fails again', () => {
    let now = 0;
    const gate = createTypeSafeRestGate({ baseCooldownMs: 10, now: () => now });
    expect(gate.recordFailure(fetchError(0))).toBe(false);
    expect(gate.recordFailure(fetchError(503))).toBe(true);
    expect(gate.restingUntil()).toBe(10);
    now = 11;
    gate.recordFailure(fetchError(429));
    expect(gate.restingUntil()).toBe(31);
  });

  it('never rests on auth, validation or caller aborts', () => {
    const gate = createTypeSafeRestGate();
    for (const err of [
      fetchError(401),
      fetchError(403),
      fetchError(422),
      new DOMException('x', 'AbortError'),
    ]) {
      expect(gate.recordFailure(err)).toBe(false);
    }
    expect(gate.isResting()).toBe(false);
  });
});

describe('resolveTypeSafeJudge', () => {
  it('is silent and absent without an account', () => {
    const warn = vi.fn();
    expect(
      resolveTypeSafeJudge({
        config: { typesafe: { enabled: true } },
        feature: 'brain',
        env: {},
        logger: { warn },
      }),
    ).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('allows judgments after explicit master opt-in and honors feature switches', () => {
    const env = { TYPESAFE_API_KEY: 'k' };
    expect(
      resolveTypeSafeJudge({ config: { typesafe: { enabled: true } }, feature: 'brain', env }),
    ).toBeDefined();
    expect(
      resolveTypeSafeJudge({
        config: { typesafe: { enabled: true, judgments: { brain: false } } },
        feature: 'brain',
        env,
      }),
    ).toBeUndefined();
  });

  it('warns once when the account is unusable', () => {
    const warn = vi.fn();
    const config = { typesafe: { enabled: true, apiKey: 'k', endpoint: 'ftp://nope' } };
    resolveTypeSafeJudge({ config, feature: 'brain', env: {}, logger: { warn } });
    resolveTypeSafeJudge({ config, feature: 'topicShift', env: {}, logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('shares one client across features for the same account', () => {
    const config = { typesafe: { enabled: true, apiKey: 'shared-key' } };
    const a = resolveTypeSafeJudge({ config, feature: 'brain' });
    const b = resolveTypeSafeJudge({ config, feature: 'memoryTriage' });
    expect(a?.client).toBe(b?.client);
  });
});

function judgeReturning(result: Partial<SystemOneResult> | Error): TypeSafeJudge {
  return {
    feature: 'brain',
    model: 'jev-test',
    client: {
      systemOne: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return { answers: {}, usage: { inputTokens: 1, outputTokens: 0 }, ...result };
      }),
    },
  };
}

const request = (risk: BrainDecisionRequest['risk'] = 'low'): BrainDecisionRequest =>
  ({
    id: 'r1',
    source: 'test',
    question: 'Retry the flaky test once more?',
    risk,
    fallback: 'deny',
    options: [
      { id: 'retry', label: 'Retry once' },
      { id: 'skip', label: 'Skip it' },
    ],
  }) as unknown as BrainDecisionRequest;

const sure: Partial<SystemOneResult> = {
  answers: {
    which: {
      type: 'choice',
      choice: 'retry',
      probabilities: { retry: 0.92, skip: 0.08 },
      confidence: 0.9,
    },
    decidable: { type: 'noul', noul: 0.85 },
  },
};

describe('System One Brain tier', () => {
  it('settles a confident option-bearing decision', async () => {
    const tier = createSystemOneBrainTier({ getJudge: () => judgeReturning(sure) });
    const decision = await tier.decide(request());
    expect(decision).toMatchObject({ type: 'answer', optionId: 'retry' });
  });

  it('defers when the state is not enough to decide', async () => {
    const unsure = structuredClone(sure);
    (unsure.answers!['decidable'] as { noul: number }).noul = 0.3;
    const tier = createSystemOneBrainTier({ getJudge: () => judgeReturning(unsure) });
    expect(await tier.decide(request())).toBeNull();
  });

  it('defers on a resting host instead of throwing', async () => {
    const tier = createSystemOneBrainTier({
      getJudge: () => judgeReturning(new TypeSafeRestingError(0, 'resting')),
    });
    expect(await tier.decide(request())).toBeNull();
  });

  it('runs before the LLM tier and never below the council floor', async () => {
    const llm = { decide: vi.fn(async () => ({ type: 'answer', text: 'llm' }) as const) };
    const arbiter = createTieredBrainArbiter({
      policy: { decide: async () => ({ type: 'ask_human' }) as never },
      autonomous: llm as never,
      getMaxAutoRisk: () => 'high',
      systemOne: createSystemOneBrainTier({ getJudge: () => judgeReturning(sure) }),
    });
    expect(await arbiter.decide(request('low'))).toMatchObject({ optionId: 'retry' });
    expect(llm.decide).not.toHaveBeenCalled();

    // `high` is the default floor: a gut check does not settle it.
    await arbiter.decide(request('high'));
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });
});
