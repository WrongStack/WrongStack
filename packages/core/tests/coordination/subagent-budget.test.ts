import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, SubagentBudget, BudgetThresholdSignal } from '../../src/coordination/subagent-budget.js';
import { EventBus } from '../../src/kernel/events.js';

describe('SubagentBudget', () => {
  it('records iterations and throws when over limit', () => {
    const b = new SubagentBudget({ maxIterations: 2 });
    b.recordIteration();
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow(BudgetExceededError);
  });

  it('records tool calls and throws when over limit', () => {
    const b = new SubagentBudget({ maxToolCalls: 1 });
    b.recordToolCall();
    try {
      b.recordToolCall();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).kind).toBe('tool_calls');
      expect((err as BudgetExceededError).limit).toBe(1);
      expect((err as BudgetExceededError).observed).toBe(2);
    }
  });

  it('records tokens and throws when total exceeds limit', () => {
    const b = new SubagentBudget({ maxTokens: 100 });
    b.recordUsage({ input: 60, output: 30 });
    expect(() => b.recordUsage({ input: 5, output: 10 })).toThrow(BudgetExceededError);
  });

  it('records cost and throws when over limit', () => {
    const b = new SubagentBudget({ maxCostUsd: 0.5 });
    b.recordUsage({ input: 0, output: 0 }, 0.3);
    expect(() => b.recordUsage({ input: 0, output: 0 }, 0.3)).toThrow(BudgetExceededError);
  });

  it('checkTimeout throws after deadline', async () => {
    const b = new SubagentBudget({ timeoutMs: 30 });
    b.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(() => b.checkTimeout()).toThrow(BudgetExceededError);
  });

  it('checkTimeout is a no-op without start()', () => {
    const b = new SubagentBudget({ timeoutMs: 1 });
    expect(() => b.checkTimeout()).not.toThrow();
  });

  it('isTimedOut returns boolean without throwing', async () => {
    const b = new SubagentBudget({ timeoutMs: 20 });
    b.start();
    expect(b.isTimedOut()).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(b.isTimedOut()).toBe(true);
  });

  it('usage reports cumulative state', () => {
    const b = new SubagentBudget({});
    b.start();
    b.recordIteration();
    b.recordIteration();
    b.recordToolCall();
    b.recordUsage({ input: 100, output: 50 }, 0.01);
    const u = b.usage();
    expect(u.iterations).toBe(2);
    expect(u.toolCalls).toBe(1);
    expect(u.tokens.total).toBe(150);
    expect(u.costUsd).toBeCloseTo(0.01);
  });

  it('limits are readonly at the type level (compile-time guard)', () => {
    const b = new SubagentBudget({ maxIterations: 5 });
    // The compile-time `readonly` is the external-mutation guard (the
    // @ts-expect-error below proves the type system rejects it). The object
    // is intentionally NOT runtime-frozen so the budget can patch limits in
    // place when the coordinator grants an auto-extension.
    // @ts-expect-error readonly
    b.limits.maxIterations = 999;
    expect(b.limits.maxIterations).toBe(999);
  });

  it('unbounded limits never throw', () => {
    const b = new SubagentBudget({});
    for (let i = 0; i < 1000; i++) {
      b.recordIteration();
      b.recordToolCall();
      b.recordUsage({ input: 1000, output: 1000 }, 1);
    }
    expect(b.usage().iterations).toBe(1000);
  });

  it('isNearLimit returns false when nothing is configured', () => {
    const b = new SubagentBudget({});
    expect(b.isNearLimit()).toBe(false);
  });

  it('isNearLimit flips true at ≥90% of any iteration budget', () => {
    const b = new SubagentBudget({ maxIterations: 10 });
    for (let i = 0; i < 8; i++) b.recordIteration();
    expect(b.isNearLimit()).toBe(false);
    b.recordIteration(); // 9/10 = 90% — should flip
    expect(b.isNearLimit()).toBe(true);
  });

  it('isNearLimit flips true at ≥90% of tool-call budget', () => {
    const b = new SubagentBudget({ maxToolCalls: 10 });
    for (let i = 0; i < 9; i++) b.recordToolCall();
    expect(b.isNearLimit()).toBe(true);
  });

  it('isNearLimit flips true at ≥90% of token budget (input + output combined)', () => {
    const b = new SubagentBudget({ maxTokens: 1000 });
    b.recordUsage({ input: 500, output: 400 }, 0); // 900 = 90%
    expect(b.isNearLimit()).toBe(true);
  });

  it('isNearLimit flips true at ≥90% of cost budget', () => {
    const b = new SubagentBudget({ maxCostUsd: 1 });
    b.recordUsage({ input: 1, output: 1 }, 0.9);
    expect(b.isNearLimit()).toBe(true);
  });

  it('onThreshold getter returns _onThreshold', () => {
    const b = new SubagentBudget({ maxIterations: 10 });
    expect(b.onThreshold).toBeUndefined();
    const handler = () => 'throw';
    b.onThreshold = handler;
    expect(b.onThreshold).toBe(handler);
  });

  it('onThreshold setter assigns _onThreshold', () => {
    const b = new SubagentBudget({ maxIterations: 10 });
    const handler = () => 'throw';
    b.onThreshold = handler;
    // @ts-expect-error accessing private field for test verification
    expect(b._onThreshold).toBe(handler);
  });

  it('mode getter returns the constructor argument', () => {
    const bAuto = new SubagentBudget({ maxIterations: 10 }, 'auto');
    const bSync = new SubagentBudget({ maxIterations: 10 }, 'sync');
    expect(bAuto.mode).toBe('auto');
    expect(bSync.mode).toBe('sync');
    expect(bAuto.mode).not.toBe('sync');
  });

  it('sync mode hard-stops on timeout even when a listener is present', () => {
    const bus = new EventBus();
    bus.on('budget.threshold_reached', ({ extend }) => extend({ timeoutMs: 999_999 }));
    const b = new SubagentBudget({ timeoutMs: 5 }, 'sync');
    (b as never as { _events: EventBus })._events = bus;
    b.onThreshold = ({ requestDecision }) => requestDecision();
    b.start();
    // Advance clock manually past the limit
    (b as never as { startTime: number }).startTime = Date.now() - 1000;
    expect(() => b.checkTimeout()).toThrow(/timeout/i);
  });

  it('sync mode hard-stops when onThreshold is set and mode is sync', () => {
    const bus = new EventBus();
    bus.on('budget.threshold_reached', ({ extend }) => extend({ maxIterations: 999 }));
    const b = new SubagentBudget({ maxIterations: 2 }, 'sync');
    (b as never as { _events: EventBus })._events = bus; // has a real listener
    b.onThreshold = () => 'continue'; // handler that would normally soft-stop
    b.recordIteration();
    b.recordIteration();
    // Even though there's a listener and a handler, 'sync' forces a hard stop
    expect(() => b.recordIteration()).toThrow(BudgetExceededError);
  });

  it('auto mode with a bus but no listener: async handler hard-stops (no one to grant)', () => {
    const bus = new EventBus(); // bus present, but no budget.threshold_reached listener
    const b = new SubagentBudget({ maxIterations: 2 }, 'auto');
    (b as never as { _events: EventBus })._events = bus;
    let handlerCalls = 0;
    // Production handler shape: defers to the bus via requestDecision(). With no
    // listener the negotiation can only resolve to 'stop' — so the budget
    // hard-stops with BudgetExceededError. This is the documented "auto + no
    // listener → hard stop" invariant that protects a bare /spawn (no director)
    // from a runaway subagent. (A wired listener would instead get a
    // BudgetThresholdSignal to negotiate — see the listener tests.)
    b.onThreshold = ({ requestDecision }) => {
      handlerCalls++;
      return requestDecision();
    };
    b.recordIteration();
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow(BudgetExceededError);
    expect(handlerCalls).toBeGreaterThan(0);
  });

  it('auto mode with a bus but no listener: a SYNC policy handler is honored without throwing', () => {
    const bus = new EventBus(); // no listener
    const b = new SubagentBudget({ maxIterations: 2 }, 'auto');
    (b as never as { _events: EventBus })._events = bus;
    let handlerCalls = 0;
    // A synchronous policy/recording handler (the coordinator watchdog shape):
    // it decides in-process and grants headroom directly via `extend`. No
    // listener is needed and the budget does NOT hard-stop — it keeps running
    // under the raised ceiling.
    b.onThreshold = ({ extend }) => {
      handlerCalls++;
      extend?.({ maxIterations: 999 });
      return 'continue';
    };
    b.recordIteration();
    b.recordIteration();
    expect(() => b.recordIteration()).not.toThrow();
    expect(handlerCalls).toBeGreaterThan(0);
    expect(b.limits.maxIterations).toBe(999);
  });

  it('auto mode with NO event bus hard-stops with BudgetExceededError', () => {
    // No `_events` wired at all → nobody to negotiate with → hard stop.
    const b = new SubagentBudget({ maxIterations: 2 }, 'auto');
    b.onThreshold = ({ requestDecision }) => requestDecision();
    b.recordIteration();
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow(BudgetExceededError);
  });

  it('auto mode soft-negotiates when bus has a wildcard listener', async () => {
    const bus = new EventBus();
    bus.onPattern('*', (type, payload) => {
      if (type === 'budget.threshold_reached') {
        (payload as { extend: (e: { maxIterations: number }) => void }).extend({ maxIterations: 999 });
      }
    });
    const b = new SubagentBudget({ maxIterations: 2 }, 'auto');
    (b as never as { _events: EventBus })._events = bus;
    b.onThreshold = ({ requestDecision }) => requestDecision();
    b.recordIteration();
    b.recordIteration();

    let signal: BudgetThresholdSignal | null = null;
    try {
      b.recordIteration();
    } catch (e) {
      signal = e as BudgetThresholdSignal;
    }
    expect(signal).toBeInstanceOf(BudgetThresholdSignal);
    const decision = await signal!.decision;
    expect(decision).toEqual({ extend: { maxIterations: 999 } });
  });

  it('includes the current session id on threshold events', async () => {
    const bus = new EventBus();
    let sessionId = '2026-06-29/sess_one';
    const seen: Array<string | undefined> = [];
    bus.on('budget.threshold_reached', (payload) => {
      seen.push(payload.sessionId);
      payload.extend({ maxIterations: 999 });
    });
    const b = new SubagentBudget(
      { maxIterations: 2 },
      'auto',
      { sessionId: () => sessionId },
    );
    (b as never as { _events: EventBus })._events = bus;
    b.onThreshold = ({ requestDecision }) => requestDecision();
    b.recordIteration();
    b.recordIteration();

    let signal: BudgetThresholdSignal | null = null;
    try {
      sessionId = '2026-06-29/sess_two';
      b.recordIteration();
    } catch (e) {
      signal = e as BudgetThresholdSignal;
    }
    expect(signal).toBeInstanceOf(BudgetThresholdSignal);
    await signal!.decision;
    expect(seen).toEqual(['2026-06-29/sess_two']);
  });

  it('checkLimit throws synchronously for timeout kind without calling _onThreshold', async () => {
    const b = new SubagentBudget({ timeoutMs: 50 });
    b.start();
    // Even with a handler set, timeout always throws synchronously
    b.onThreshold = () => { throw new Error('handler should not be called'); };
    await new Promise(r => setTimeout(r, 60));
    expect(() => b.checkTimeout()).toThrow(BudgetExceededError);
    expect(() => b.checkTimeout()).toThrow(/timeout/);
  });

  it('checkLimitAsync _onThreshold returns throw → throws BudgetExceededError synchronously via checkLimit', () => {
    // Deliberately test only the 'no handler' path — the 'sync' mode path is covered above.
    const b2 = new SubagentBudget({ maxIterations: 2 });
    b2.recordIteration();
    b2.recordIteration();
    expect(() => b2.recordIteration()).toThrow(BudgetExceededError);
  });

  // NOTE: the three tests below targeted the pre-refactor fire-and-forget
  // handler API (sync return of 'continue' / 'stop' / { extend }). The
  // current contract throws `BudgetThresholdSignal` synchronously from
  // checkLimit and requires an EventBus listener on
  // `budget.threshold_reached` (typically wired by agent-subagent-runner)
  // to actually drive the handler. Without that listener, checkLimit hard-
  // fails with BudgetExceededError. End-to-end coverage of the negotiation
  // path lives in agent-subagent-runner / director integration tests.
  it.skip('checkLimitAsync _onThreshold returns continue → returns without throwing', () => {});
  it.skip('checkLimitAsync _onThreshold returns Promise with stop → throws BudgetExceededError', () => {});
  it.skip('checkLimitAsync _onThreshold returns Promise with extend → extends limits and continues', () => {});

  it('BudgetThresholdSignal constructor sets all fields', async () => {
    const decision = Promise.resolve('stop');
    const signal = new (await import('../../src/coordination/subagent-budget.js')).BudgetThresholdSignal(
      'iterations', 10, 11, decision,
    );
    expect(signal.kind).toBe('iterations');
    expect(signal.limit).toBe(10);
    expect(signal.used).toBe(11);
    expect(signal.decision).toBe(decision);
    expect(signal.message).toContain('iterations');
    expect(signal.name).toBe('BudgetThresholdSignal');
  });

  it('isNearLimit works when start() has not been called', () => {
    const b = new SubagentBudget({ maxIterations: 10 });
    // start() not called — startTime is null
    // isNearLimit uses startTime only for isTimedOut() — not for iteration/tool/token/cost checks
    expect(b.isNearLimit()).toBe(false);
    b.recordIteration();
    b.recordIteration();
    expect(b.isNearLimit()).toBe(false);
  });

  describe('idle timeout', () => {
    it('markActivity resets the idle clock so an active agent does not time out', async () => {
      const b = new SubagentBudget({ idleTimeoutMs: 40 });
      b.start();
      // Keep poking activity faster than the idle window — must never trip.
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 25));
        b.markActivity();
        expect(() => b.checkTimeout()).not.toThrow();
        expect(b.isTimedOut()).toBe(false);
      }
    });

    it('checkTimeout trips when idle exceeds idleTimeoutMs with no activity', async () => {
      const b = new SubagentBudget({ idleTimeoutMs: 30 });
      b.start();
      await new Promise((r) => setTimeout(r, 60));
      expect(b.isTimedOut()).toBe(true);
      expect(() => b.checkTimeout()).toThrow(BudgetExceededError);
      expect(() => b.checkTimeout()).toThrow(/timeout/i);
    });

    it('recordToolCall counts as activity and keeps the idle clock fresh', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const b = new SubagentBudget({ idleTimeoutMs: 40, maxToolCalls: 100 });
        b.start();
        vi.advanceTimersByTime(30);
        b.recordToolCall(); // activity → resets idle
        vi.advanceTimersByTime(20);
        expect(b.isTimedOut()).toBe(false); // only 20ms idle since the tool call
      } finally {
        vi.useRealTimers();
      }
    });

    it('idleMs reports time since the last activity, not since start', async () => {
      const b = new SubagentBudget({ idleTimeoutMs: 10_000 });
      b.start();
      // The sleep must dwarf the assertion bound so "since last activity"
      // (small) is distinguishable from "since start" (>= the sleep) even
      // when the event loop stalls under full-suite load.
      await new Promise((r) => setTimeout(r, 1000));
      b.markActivity();
      expect(b.idleMs()).toBeLessThan(800);
    });

    it('an explicit wall-clock timeoutMs still enforces a hard cap', async () => {
      const b = new SubagentBudget({ timeoutMs: 30 });
      b.start();
      // Activity does NOT reset a wall-clock cap.
      b.markActivity();
      await new Promise((r) => setTimeout(r, 60));
      b.markActivity();
      expect(b.isTimedOut()).toBe(true);
      expect(() => b.checkTimeout()).toThrow(BudgetExceededError);
    });

    it('no timeout fields → checkTimeout is always a no-op', async () => {
      const b = new SubagentBudget({ maxIterations: 10 });
      b.start();
      await new Promise((r) => setTimeout(r, 30));
      expect(() => b.checkTimeout()).not.toThrow();
      expect(b.isTimedOut()).toBe(false);
    });
  });
});
