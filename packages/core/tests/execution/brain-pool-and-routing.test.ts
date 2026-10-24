import type { Provider } from '@wrongstack/contracts/types/provider';
import { describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from '../../src/brain/brain.js';
import {
  createAutonomyBrain,
  createTieredBrainArbiter,
} from '../../src/execution/autonomy-brain.js';

// A question the quickDecide heuristics pass through to the LLM tier.
const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'p1',
  source: 'system',
  question: 'Is the goal complete?',
  risk: 'medium',
  fallback: 'ask_human',
  ...over,
});

function fakeProvider(text: string): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
  } as never as Provider;
}

function throwingProvider(): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => {
      throw new Error('LLM down');
    }),
  } as never as Provider;
}

describe('createAutonomyBrain — LLM pool', () => {
  it('falls back to the next target when the primary fails', async () => {
    const primary = throwingProvider();
    const backup = fakeProvider('Continue execution.');
    const brain = createAutonomyBrain({
      targets: [
        { provider: primary, model: 'a' },
        { provider: backup, model: 'b' },
      ],
    });
    const d = await brain.decide(req());
    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(backup.complete).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({ type: 'answer', text: 'Continue execution.' });
  });

  it('fallback strategy always starts from the first target', async () => {
    const first = fakeProvider('From first.');
    const second = fakeProvider('From second.');
    const brain = createAutonomyBrain({
      targets: [
        { provider: first, model: 'a' },
        { provider: second, model: 'b' },
      ],
      strategy: 'fallback',
    });
    await brain.decide(req());
    await brain.decide(req({ id: 'p2' }));
    expect(first.complete).toHaveBeenCalledTimes(2);
    expect(second.complete).not.toHaveBeenCalled();
  });

  it('round-robin rotates the starting target across decisions', async () => {
    const first = fakeProvider('From first.');
    const second = fakeProvider('From second.');
    const brain = createAutonomyBrain({
      targets: [
        { provider: first, model: 'a' },
        { provider: second, model: 'b' },
      ],
      strategy: 'round-robin',
    });
    const d1 = await brain.decide(req());
    const d2 = await brain.decide(req({ id: 'p2' }));
    expect(d1).toMatchObject({ type: 'answer', text: 'From first.' });
    expect(d2).toMatchObject({ type: 'answer', text: 'From second.' });
    expect(first.complete).toHaveBeenCalledTimes(1);
    expect(second.complete).toHaveBeenCalledTimes(1);
  });

  it('reports an entirely dead pool as unavailable', async () => {
    const brain = createAutonomyBrain({
      targets: [
        { provider: throwingProvider(), model: 'a' },
        { provider: throwingProvider(), model: 'b' },
      ],
    });
    const d = await brain.decide(req({ fallback: 'continue' }));
    // Every target was tried and none answered — that is an unavailable pool,
    // not a decision to continue. The tiered ladder converts it back into the
    // caller's continue fallback, attributed to the policy tier.
    expect(d).toMatchObject({ type: 'deny', reason: expect.stringContaining('unavailable') });
  });

  it('requires at least one LLM source', () => {
    expect(() => createAutonomyBrain({})).toThrow(/targets/);
  });
});

// ── Tiered routing: council placement + provisional-continue fix ─────────

const stub = (decision: BrainDecision): BrainArbiter & { decide: ReturnType<typeof vi.fn> } => ({
  decide: vi.fn(async () => decision),
});

const askHuman: BrainDecision = { type: 'ask_human', prompt: 'p' };

describe('createTieredBrainArbiter — council routing', () => {
  it('routes high-risk requests to the council instead of the single LLM', async () => {
    const policy = stub(askHuman);
    const llm = stub({ type: 'answer', text: 'llm says yes' });
    const council = stub({ type: 'answer', text: 'council says no', optionId: undefined });
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: llm,
      council,
      getMaxAutoRisk: () => 'all',
    });
    const d = await tiered.decide(req({ risk: 'high' }));
    expect(council.decide).toHaveBeenCalledTimes(1);
    expect(llm.decide).not.toHaveBeenCalled();
    expect(d).toMatchObject({ type: 'answer', text: 'council says no' });
  });

  it('council denials are terminal — they do not fall through to the LLM', async () => {
    const llm = stub({ type: 'answer', text: 'llm would approve' });
    const council = stub({ type: 'deny', reason: 'skeptic veto' });
    const tiered = createTieredBrainArbiter({
      policy: stub(askHuman),
      autonomous: llm,
      council,
      getMaxAutoRisk: () => 'all',
    });
    const d = await tiered.decide(req({ risk: 'critical' }));
    expect(d.type).toBe('deny');
    expect(llm.decide).not.toHaveBeenCalled();
  });

  it('keeps sub-floor risks on the single-LLM tier', async () => {
    const llm = stub({ type: 'answer', text: 'llm decision' });
    const council = stub({ type: 'answer', text: 'council decision' });
    const tiered = createTieredBrainArbiter({
      policy: stub(askHuman),
      autonomous: llm,
      council,
      getMaxAutoRisk: () => 'all',
      getCouncilMinRisk: () => 'high',
    });
    await tiered.decide(req({ risk: 'medium' }));
    expect(council.decide).not.toHaveBeenCalled();
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });

  it('degrades to the single LLM when the council abstains', async () => {
    const llm = stub({ type: 'answer', text: 'llm decision' });
    const council = stub(askHuman);
    const tiered = createTieredBrainArbiter({
      policy: stub(askHuman),
      autonomous: llm,
      council,
      getMaxAutoRisk: () => 'all',
    });
    const d = await tiered.decide(req({ risk: 'high' }));
    expect(council.decide).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({ type: 'answer', text: 'llm decision' });
  });
});

describe('createTieredBrainArbiter — provisional continue consults the LLM', () => {
  // The policy tier answers `continue` for `fallback: 'continue'` requests it
  // cannot really decide. Historically that bypassed the LLM entirely (e.g.
  // goal-completion checks never reached it).
  const policyContinue: BrainDecision = {
    type: 'answer',
    text: 'Continue with the caller default.',
    rationale: 'fallback',
  };

  it('consults the LLM behind a fallback-continue policy answer', async () => {
    const llm = stub({ type: 'answer', text: 'Goal is NOT complete: 2 deliverables open.' });
    const tiered = createTieredBrainArbiter({
      policy: stub(policyContinue),
      autonomous: llm,
      getMaxAutoRisk: () => 'all',
    });
    const d = await tiered.decide(req({ fallback: 'continue' }));
    expect(llm.decide).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({ type: 'answer', text: expect.stringContaining('NOT complete') });
  });

  it('keeps the policy continue when the LLM fails', async () => {
    const llm: BrainArbiter = {
      decide: vi.fn(async () => {
        throw new Error('down');
      }),
    };
    const tiered = createTieredBrainArbiter({
      policy: stub(policyContinue),
      autonomous: llm,
      getMaxAutoRisk: () => 'all',
    });
    const d = await tiered.decide(req({ fallback: 'continue' }));
    expect(d).toMatchObject({ type: 'answer', text: 'Continue with the caller default.' });
  });

  it('does not second-guess an option-backed policy answer', async () => {
    const llm = stub({ type: 'answer', text: 'llm' });
    const tiered = createTieredBrainArbiter({
      policy: stub({ type: 'answer', optionId: 'go', text: 'Go' }),
      autonomous: llm,
      getMaxAutoRisk: () => 'all',
    });
    const d = await tiered.decide(req({ fallback: 'continue' }));
    expect(llm.decide).not.toHaveBeenCalled();
    expect(d).toMatchObject({ optionId: 'go' });
  });

  it('respects the ceiling for provisional continues too', async () => {
    const llm = stub({ type: 'answer', text: 'llm' });
    const tiered = createTieredBrainArbiter({
      policy: stub(policyContinue),
      autonomous: llm,
      getMaxAutoRisk: () => 'low',
    });
    const d = await tiered.decide(req({ risk: 'high', fallback: 'continue' }));
    expect(llm.decide).not.toHaveBeenCalled();
    expect(d).toMatchObject({ type: 'answer', text: 'Continue with the caller default.' });
  });
});
