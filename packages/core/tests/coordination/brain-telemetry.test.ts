import { describe, expect, it, vi } from 'vitest';
import {
  DefaultBrainArbiter,
  EscalationRoutingBrainArbiter,
  ObservableBrainArbiter,
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionRequest,
} from '../../src/coordination/brain.js';
import { createLedgerGuardBrainArbiter } from '../../src/coordination/brain-ledger.js';
import {
  BrainTierCounter,
  isDeterministicTier,
  markDecisionTier,
  readDecisionTier,
} from '../../src/coordination/brain-telemetry.js';
import { createTieredBrainArbiter } from '../../src/execution/autonomy-brain.js';
import { EventBus } from '../../src/kernel/events.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'r1',
  source: 'goal',
  question: 'Should we continue?',
  risk: 'low',
  fallback: 'continue',
  ...over,
});

const stub = (decision: BrainDecision): BrainArbiter => ({ decide: async () => decision });

describe('markDecisionTier / readDecisionTier', () => {
  it('records provenance against the request identity', () => {
    const r = req();
    expect(readDecisionTier(r)).toBeUndefined();
    markDecisionTier(r, 'council');
    expect(readDecisionTier(r)).toBe('council');
  });

  it('is last-writer-wins so a later tier overrides an earlier mark', () => {
    const r = req();
    markDecisionTier(r, 'policy');
    markDecisionTier(r, 'llm');
    expect(readDecisionTier(r)).toBe('llm');
  });

  it('does not leak between distinct request objects with the same id', () => {
    const a = req();
    const b = req();
    markDecisionTier(a, 'llm');
    expect(readDecisionTier(b)).toBeUndefined();
  });
});

describe('isDeterministicTier', () => {
  it('classifies the free tiers as deterministic', () => {
    for (const tier of [
      'rule',
      'policy',
      'heuristic',
      'cache',
      'ledger-guard',
      'terminal',
    ] as const) {
      expect(isDeterministicTier(tier)).toBe(true);
    }
  });

  it('classifies provider-backed tiers as non-deterministic', () => {
    expect(isDeterministicTier('llm')).toBe(false);
    expect(isDeterministicTier('council')).toBe(false);
    expect(isDeterministicTier(undefined)).toBe(false);
  });
});

describe('tier marking through the real chain', () => {
  it('marks a low-risk recommended fast path as heuristic', async () => {
    const policy = new DefaultBrainArbiter();
    const r = req({ risk: 'low', options: [{ id: 'go', label: 'Go', recommended: true }] });
    await policy.decide(r);
    expect(readDecisionTier(r)).toBe('heuristic');
  });

  it('marks a fallback deny as policy', async () => {
    const policy = new DefaultBrainArbiter();
    const r = req({ fallback: 'deny' });
    await policy.decide(r);
    expect(readDecisionTier(r)).toBe('policy');
  });

  it('marks a council decision as council', async () => {
    const tiered = createTieredBrainArbiter({
      policy: new DefaultBrainArbiter(),
      council: stub({ type: 'deny', reason: 'Council vetoes' }),
      getMaxAutoRisk: () => 'all',
      getCouncilMinRisk: () => 'medium',
    });
    const r = req({ risk: 'high', fallback: 'ask_human' });
    await tiered.decide(r);
    expect(readDecisionTier(r)).toBe('council');
  });

  it('restores policy provenance when the LLM tier produces a non-answer', async () => {
    const tiered = createTieredBrainArbiter({
      policy: new DefaultBrainArbiter(),
      autonomous: stub({ type: 'deny', reason: 'LLM denies' }),
      getMaxAutoRisk: () => 'all',
    });
    const r = req({ risk: 'medium', fallback: 'ask_human' });
    const decision = await tiered.decide(r);
    // The LLM's deny is discarded in favour of the policy escalation, so the
    // reported tier must follow the decision that was actually returned.
    expect(decision.type).toBe('ask_human');
    expect(readDecisionTier(r)).toBe('policy');
  });

  it('marks a headless escalation as terminal', async () => {
    const routed = new EscalationRoutingBrainArbiter(
      new DefaultBrainArbiter(),
      undefined,
      () => 'headless',
    );
    const r = req({ fallback: 'ask_human', risk: 'medium' });
    await routed.decide(r);
    expect(readDecisionTier(r)).toBe('terminal');
  });

  it('marks a ledger-guard denial as ledger-guard', async () => {
    const guarded = createLedgerGuardBrainArbiter({
      inner: stub({ type: 'answer', text: 'ok' }),
      failureStreakFor: () => 5,
      denyAfter: 3,
    });
    const r = req();
    const decision = await guarded.decide(r);
    expect(decision.type).toBe('deny');
    expect(readDecisionTier(r)).toBe('ledger-guard');
  });
});

describe('ObservableBrainArbiter tier propagation', () => {
  it('includes the tier on the emitted decision event', async () => {
    const events = new EventBus();
    const seen = vi.fn();
    events.on('brain.decision_answered', seen);
    const observable = new ObservableBrainArbiter(
      {
        decide: async (request) => {
          markDecisionTier(request, 'cache');
          return { type: 'answer', text: 'replayed' };
        },
      },
      events,
    );
    await observable.decide(req());
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ tier: 'cache' }));
  });

  it('omits the tier when no tier recorded itself', async () => {
    const events = new EventBus();
    const seen = vi.fn();
    events.on('brain.decision_answered', seen);
    const observable = new ObservableBrainArbiter(stub({ type: 'answer', text: 'x' }), events);
    await observable.decide(req());
    expect(seen).toHaveBeenCalledWith(expect.not.objectContaining({ tier: expect.anything() }));
  });
});

describe('BrainTierCounter', () => {
  it('splits deterministic from provider-backed decisions', () => {
    const counter = new BrainTierCounter();
    counter.record('policy');
    counter.record('heuristic');
    counter.record('llm');
    counter.record('council');
    counter.record(undefined);

    const stats = counter.snapshot();
    expect(stats.total).toBe(5);
    expect(stats.deterministic).toBe(2);
    expect(stats.llmBacked).toBe(2);
    expect(stats.unattributed).toBe(1);
    expect(stats.byTier).toEqual({ policy: 1, heuristic: 1, llm: 1, council: 1 });
  });

  it('resets cleanly', () => {
    const counter = new BrainTierCounter();
    counter.record('llm');
    counter.reset();
    expect(counter.snapshot()).toEqual({
      byTier: {},
      total: 0,
      deterministic: 0,
      llmBacked: 0,
      unattributed: 0,
    });
  });
});
