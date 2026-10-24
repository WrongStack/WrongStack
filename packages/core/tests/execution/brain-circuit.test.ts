import type { Provider } from '@wrongstack/contracts/types/provider';
import { describe, expect, it, vi } from 'vitest';
import type { BrainDecisionRequest } from '../../src/brain/brain.js';
import { createAutonomyBrain } from '../../src/execution/autonomy-brain.js';
import { BrainCircuitBreaker } from '../../src/execution/brain-circuit.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'r1',
  source: 'goal',
  question: 'Is the goal complete?',
  risk: 'low',
  fallback: 'deny',
  ...over,
});

function throwingProvider(): Provider {
  return {
    id: 'p',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => {
      throw new Error('LLM down');
    }),
  } as never as Provider;
}

describe('BrainCircuitBreaker', () => {
  it('opens after the configured consecutive failures', () => {
    const breaker = new BrainCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    expect(breaker.shouldAttempt()).toBe(true);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    expect(breaker.shouldAttempt()).toBe(true);

    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.shouldAttempt()).toBe(false);
  });

  it('a success resets the streak before the breaker opens', () => {
    const breaker = new BrainCircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
  });

  it('allows exactly ONE probe once the cooldown expires', () => {
    let now = 0;
    const breaker = new BrainCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => now,
    });
    breaker.recordFailure();
    expect(breaker.shouldAttempt()).toBe(false);

    now = 1_000;
    expect(breaker.state()).toBe('half_open');
    // First caller becomes the probe...
    expect(breaker.shouldAttempt()).toBe(true);
    // ...concurrent callers must not ALSO pay the timeout.
    expect(breaker.shouldAttempt()).toBe(false);
  });

  it('a failed probe buys a fresh cooldown rather than resuming the expired one', () => {
    let now = 0;
    const breaker = new BrainCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => now,
    });
    breaker.recordFailure();

    now = 1_000;
    expect(breaker.shouldAttempt()).toBe(true);
    breaker.recordFailure();

    // Still open: the clock restarted at the probe's failure.
    expect(breaker.state()).toBe('open');
    now = 1_500;
    expect(breaker.state()).toBe('open');
    now = 2_000;
    expect(breaker.state()).toBe('half_open');
  });

  it('a successful probe closes the breaker', () => {
    let now = 0;
    const breaker = new BrainCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      now: () => now,
    });
    breaker.recordFailure();
    now = 1_000;
    breaker.shouldAttempt();
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.shouldAttempt()).toBe(true);
  });

  it('never opens when disabled', () => {
    const breaker = new BrainCircuitBreaker({ failureThreshold: 0 });
    for (let i = 0; i < 20; i++) breaker.recordFailure();
    expect(breaker.enabled).toBe(false);
    expect(breaker.shouldAttempt()).toBe(true);
  });

  it('deprioritises unhealthy targets without dropping them', () => {
    const breaker = new BrainCircuitBreaker();
    breaker.recordFailure('bad');
    breaker.recordFailure('bad');
    breaker.recordFailure('meh');

    const ordered = breaker.orderTargets(['bad', 'good', 'meh'], (t) => t);
    expect(ordered).toEqual(['good', 'meh', 'bad']);
    // Deprioritised, never removed — a recovered model must still be reached.
    expect(ordered).toHaveLength(3);
  });

  it('clears a target from the unhealthy list on success', () => {
    const breaker = new BrainCircuitBreaker();
    breaker.recordFailure('m');
    expect(breaker.snapshot().unhealthyTargets).toHaveLength(1);
    breaker.recordSuccess('m');
    expect(breaker.snapshot().unhealthyTargets).toHaveLength(0);
  });
});

describe('circuit breaker inside the LLM tier', () => {
  it('stops paying the pool sweep once the breaker opens', async () => {
    const a = throwingProvider();
    const b = throwingProvider();
    const circuit = new BrainCircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
    const brain = createAutonomyBrain({
      targets: [
        { provider: a, model: 'a', label: 'p/a' },
        { provider: b, model: 'b', label: 'p/b' },
      ],
      maxAutoRisk: 'all',
      circuit,
    });

    // First decision sweeps the whole pool: 2 calls, 2 recorded failures.
    await brain.decide(req());
    expect(a.complete).toHaveBeenCalledTimes(1);
    expect(b.complete).toHaveBeenCalledTimes(1);
    expect(circuit.state()).toBe('open');

    // Second decision must not touch a provider at all.
    const decision = await brain.decide(req({ id: 'r2' }));
    expect(a.complete).toHaveBeenCalledTimes(1);
    expect(b.complete).toHaveBeenCalledTimes(1);
    expect(decision.type).toBe('deny');
    expect(decision.type === 'deny' && decision.reason).toContain('circuit-broken');
  });

  it('leaves behaviour unchanged when no breaker is wired', async () => {
    const p = throwingProvider();
    const brain = createAutonomyBrain({ provider: p, model: 'm', maxAutoRisk: 'all' });
    await brain.decide(req());
    await brain.decide(req({ id: 'r2' }));
    expect(p.complete).toHaveBeenCalledTimes(2);
  });
});
