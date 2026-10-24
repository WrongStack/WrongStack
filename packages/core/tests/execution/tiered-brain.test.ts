import { describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from '../../src/brain/brain.js';
import {
  type BrainAutoRisk,
  createTieredBrainArbiter,
} from '../../src/execution/autonomy-brain.js';

function request(overrides: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest {
  return {
    id: 'tiered-1',
    source: 'system',
    question: 'Should the agent change approach?',
    risk: 'medium',
    fallback: 'continue',
    ...overrides,
  };
}

function arbiter(decision: BrainDecision): BrainArbiter & { decide: ReturnType<typeof vi.fn> } {
  return { decide: vi.fn(async () => decision) };
}

const ASK_HUMAN: BrainDecision = { type: 'ask_human', prompt: 'Need a human.' };
// A concrete policy decision carries the chosen option id. An optionId-less
// `continue` on a `fallback: 'continue'` request is only PROVISIONAL and the
// autonomous layer is still consulted (see the provisional-continue tests in
// brain-pool-and-routing.test.ts).
const POLICY_ANSWER: BrainDecision = {
  type: 'answer',
  optionId: 'continue',
  text: 'Policy says continue.',
};
const LLM_ANSWER: BrainDecision = { type: 'answer', text: 'LLM says steer left.' };

describe('createTieredBrainArbiter', () => {
  it('returns concrete policy answers without consulting the autonomous layer', async () => {
    const policy = arbiter(POLICY_ANSWER);
    const autonomous = arbiter(LLM_ANSWER);
    const brain = createTieredBrainArbiter({ policy, autonomous });

    const decision = await brain.decide(request());

    expect(decision).toEqual(POLICY_ANSWER);
    expect(autonomous.decide).not.toHaveBeenCalled();
  });

  it('lets the autonomous layer answer when the policy would escalate', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous = arbiter(LLM_ANSWER);
    const brain = createTieredBrainArbiter({ policy, autonomous });

    const decision = await brain.decide(request({ risk: 'medium' }));

    expect(decision).toEqual(LLM_ANSWER);
    expect(autonomous.decide).toHaveBeenCalledOnce();
  });

  it('escalates to the human when there is no autonomous layer', async () => {
    const policy = arbiter(ASK_HUMAN);
    const brain = createTieredBrainArbiter({ policy });

    const decision = await brain.decide(request());

    expect(decision).toEqual(ASK_HUMAN);
  });

  it('skips the autonomous layer entirely when the ceiling is off', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous = arbiter(LLM_ANSWER);
    const brain = createTieredBrainArbiter({
      policy,
      autonomous,
      getMaxAutoRisk: () => 'off',
    });

    const decision = await brain.decide(request({ risk: 'low' }));

    expect(decision).toEqual(ASK_HUMAN);
    expect(autonomous.decide).not.toHaveBeenCalled();
  });

  it('escalates requests whose risk exceeds the live ceiling', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous = arbiter(LLM_ANSWER);
    const brain = createTieredBrainArbiter({
      policy,
      autonomous,
      getMaxAutoRisk: () => 'low',
    });

    const decision = await brain.decide(request({ risk: 'high' }));

    expect(decision).toEqual(ASK_HUMAN);
    expect(autonomous.decide).not.toHaveBeenCalled();
  });

  it('lets "all" auto-decide even critical-risk requests', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous = arbiter(LLM_ANSWER);
    const brain = createTieredBrainArbiter({
      policy,
      autonomous,
      getMaxAutoRisk: () => 'all',
    });

    const decision = await brain.decide(request({ risk: 'critical' }));

    expect(decision).toEqual(LLM_ANSWER);
  });

  it('reads the ceiling on every decision so runtime changes apply immediately', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous = arbiter(LLM_ANSWER);
    let ceiling: BrainAutoRisk = 'off';
    const brain = createTieredBrainArbiter({
      policy,
      autonomous,
      getMaxAutoRisk: () => ceiling,
    });

    expect(await brain.decide(request({ risk: 'low' }))).toEqual(ASK_HUMAN);
    ceiling = 'high';
    expect(await brain.decide(request({ risk: 'high' }))).toEqual(LLM_ANSWER);
  });

  it('falls through to the human when the autonomous layer denies', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous = arbiter({ type: 'deny', reason: 'too risky' });
    const brain = createTieredBrainArbiter({ policy, autonomous });

    const decision = await brain.decide(request());

    expect(decision).toEqual(ASK_HUMAN);
  });

  it('falls through to the human when the autonomous layer throws', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous: BrainArbiter = {
      decide: async () => {
        throw new Error('LLM unavailable');
      },
    };
    const brain = createTieredBrainArbiter({ policy, autonomous });

    const decision = await brain.decide(request());

    expect(decision).toEqual(ASK_HUMAN);
  });

  it('defaults the ceiling to medium when no getter is provided', async () => {
    const policy = arbiter(ASK_HUMAN);
    const autonomous = arbiter(LLM_ANSWER);
    const brain = createTieredBrainArbiter({ policy, autonomous });

    expect(await brain.decide(request({ risk: 'medium' }))).toEqual(LLM_ANSWER);
    expect(await brain.decide(request({ risk: 'high' }))).toEqual(ASK_HUMAN);
  });
});
