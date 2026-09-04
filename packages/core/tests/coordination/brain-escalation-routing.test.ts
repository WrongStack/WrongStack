import { describe, expect, it, vi } from 'vitest';
import type {
  BrainArbiter,
  BrainDecision,
  BrainDecisionRequest,
} from '../../src/coordination/brain.js';
import {
  BrainDecisionQueue,
  EscalationRoutingBrainArbiter,
  terminalPolicyDecision,
} from '../../src/coordination/brain.js';
import { EventBus } from '../../src/kernel/events.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'e1',
  source: 'system',
  question: 'Steer the agent?',
  risk: 'medium',
  fallback: 'ask_human',
  ...over,
});

const askHuman: BrainDecision = { type: 'ask_human', prompt: 'p' };
const stub = (decision: BrainDecision): BrainArbiter => ({ decide: async () => decision });

describe('terminalPolicyDecision', () => {
  it('chooses the caller-recommended option at low/medium risk', () => {
    const d = terminalPolicyDecision(
      req({
        risk: 'medium',
        options: [
          { id: 'steer', label: 'Steer', recommended: true },
          { id: 'wait', label: 'Wait' },
        ],
      }),
    );
    expect(d).toMatchObject({ type: 'answer', optionId: 'steer' });
  });

  it('refuses the recommended option at high risk and denies instead', () => {
    const d = terminalPolicyDecision(
      req({
        risk: 'high',
        options: [{ id: 'merge', label: 'Merge', recommended: true }],
      }),
    );
    expect(d.type).toBe('deny');
  });

  it('continues when the request declares continue as its fallback', () => {
    const d = terminalPolicyDecision(req({ risk: 'high', fallback: 'continue' }));
    expect(d).toMatchObject({ type: 'answer' });
    if (d.type === 'answer') expect(d.text).toContain('Continue');
  });

  it('denies when there is no safe automatic option', () => {
    const d = terminalPolicyDecision(req({ risk: 'critical' }));
    expect(d.type).toBe('deny');
  });
});

describe('EscalationRoutingBrainArbiter', () => {
  it('passes non-escalation decisions through untouched', async () => {
    const router = new EscalationRoutingBrainArbiter(
      stub({ type: 'answer', text: 'done' }),
      undefined,
      () => 'interactive',
    );
    const d = await router.decide(req());
    expect(d).toMatchObject({ type: 'answer', text: 'done' });
  });

  it('resolves escalations via the terminal policy in headless mode', async () => {
    const queue = { requestHumanDecision: vi.fn() };
    const router = new EscalationRoutingBrainArbiter(
      stub(askHuman),
      queue as never as BrainDecisionQueue,
      () => 'headless',
    );
    const d = await router.decide(req({ fallback: 'continue' }));
    expect(queue.requestHumanDecision).not.toHaveBeenCalled();
    expect(d).toMatchObject({ type: 'answer' });
  });

  it('prompts the human via the queue in interactive mode', async () => {
    const human: BrainDecision = { type: 'answer', text: 'human said yes' };
    const queue = { requestHumanDecision: vi.fn(async () => human) };
    const router = new EscalationRoutingBrainArbiter(
      stub(askHuman),
      queue as never as BrainDecisionQueue,
      () => 'interactive',
    );
    const d = await router.decide(req());
    expect(queue.requestHumanDecision).toHaveBeenCalledTimes(1);
    expect(d).toBe(human);
  });

  it('uses the terminal policy when interactive mode has no queue', async () => {
    const router = new EscalationRoutingBrainArbiter(
      stub(askHuman),
      undefined,
      () => 'interactive',
    );
    const d = await router.decide(req({ risk: 'critical' }));
    expect(d.type).toBe('deny');
  });

  it('reads the mode per decision so live /brain mode switches apply', async () => {
    let mode: 'interactive' | 'headless' = 'interactive';
    const human: BrainDecision = { type: 'answer', text: 'human' };
    const queue = { requestHumanDecision: vi.fn(async () => human) };
    const router = new EscalationRoutingBrainArbiter(
      stub(askHuman),
      queue as never as BrainDecisionQueue,
      () => mode,
    );
    await router.decide(req());
    expect(queue.requestHumanDecision).toHaveBeenCalledTimes(1);
    mode = 'headless';
    const d = await router.decide(req({ fallback: 'continue' }));
    expect(queue.requestHumanDecision).toHaveBeenCalledTimes(1);
    expect(d).toMatchObject({ type: 'answer' });
  });
});

describe('BrainDecisionQueue — onTimeout', () => {
  const fakeEvents = (): EventBus =>
    ({
      on: vi.fn(() => () => {}),
      emit: vi.fn(),
    }) as never as EventBus;

  it('resolves through the provided onTimeout decision', async () => {
    const queue = new BrainDecisionQueue(fakeEvents(), {
      timeoutMs: 10,
      onTimeout: terminalPolicyDecision,
    });
    const d = await queue.requestHumanDecision(
      req({
        risk: 'low',
        options: [{ id: 'go', label: 'Go', recommended: true }],
      }),
    );
    expect(d).toMatchObject({ type: 'answer', optionId: 'go' });
    queue.dispose();
  });

  it('still denies by default without onTimeout', async () => {
    const queue = new BrainDecisionQueue(fakeEvents(), { timeoutMs: 10 });
    const d = await queue.requestHumanDecision(req());
    expect(d.type).toBe('deny');
    queue.dispose();
  });
});

describe('escalation ladder steps', () => {
  it('headless mode records a terminal step naming the policy', async () => {
    const events = new EventBus();
    const steps: Array<Record<string, unknown>> = [];
    events.on('brain.tier_transition', (e) => steps.push(e as Record<string, unknown>));
    const arbiter = new EscalationRoutingBrainArbiter(
      stub(askHuman),
      undefined,
      () => 'headless',
      () => 'conservative',
      events,
    );

    const decision = await arbiter.decide(req({ risk: 'critical' }));

    expect(decision.type).toBe('deny');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ tier: 'terminal', outcome: 'deny', terminal: true });
    expect(String(steps[0]?.reason)).toContain('conservative');
  });

  it('an answering human records a terminal human step, and the prompt is marked pending', async () => {
    const events = new EventBus();
    const steps: Array<Record<string, unknown>> = [];
    const prompts: Array<Record<string, unknown>> = [];
    events.on('brain.tier_transition', (e) => steps.push(e as Record<string, unknown>));
    events.on('brain.decision_ask_human', (e) => prompts.push(e as Record<string, unknown>));
    const queue = new BrainDecisionQueue(events);
    const arbiter = new EscalationRoutingBrainArbiter(
      stub(askHuman),
      queue,
      () => 'interactive',
      undefined,
      events,
    );

    const pending = arbiter.decide(req({ id: 'h1', options: [{ id: 'go', label: 'Go' }] }));
    // The prompt is emitted after the inner chain resolves — let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.pending).toBe(true);

    events.emit('brain.human_answered', { id: 'h1', optionId: 'go', at: Date.now() });
    await expect(pending).resolves.toMatchObject({ type: 'answer', optionId: 'go' });

    expect(steps).toEqual([
      expect.objectContaining({ tier: 'human', outcome: 'answer', terminal: true }),
    ]);
    queue.dispose();
  });

  it('an unanswered prompt records a terminal step, not a human one', async () => {
    vi.useFakeTimers();
    try {
      const events = new EventBus();
      const steps: Array<Record<string, unknown>> = [];
      events.on('brain.tier_transition', (e) => steps.push(e as Record<string, unknown>));
      const queue = new BrainDecisionQueue(events, {
        timeoutMs: 50,
        onTimeout: (request) => terminalPolicyDecision(request),
      });
      const arbiter = new EscalationRoutingBrainArbiter(
        stub(askHuman),
        queue,
        () => 'interactive',
        undefined,
        events,
      );

      const pending = arbiter.decide(req({ id: 'h2', risk: 'critical' }));
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({ type: 'deny' });

      expect(steps).toEqual([
        expect.objectContaining({ tier: 'terminal', outcome: 'deny', terminal: true }),
      ]);
      queue.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
