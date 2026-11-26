import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUTO_WAKE_DEBOUNCE_MS,
  DEFAULT_MAX_CHAINED_WAKES,
  LeaderAutoWakeController,
  type LeaderWakePort,
} from '../src/delegation/leader-auto-wake.js';
import { LeaderDeliveryHub } from '../src/delegation/leader-delivery-hub.js';

const SESSION = 'sess_config_types';

function port(): LeaderWakePort & { calls: number } {
  const state = {
    calls: 0,
    isIdle: () => true,
    hasPendingUserInput: () => false,
    isConfirmPending: () => false,
    isOpen: () => true,
    isDisplayed: () => true,
    startWakeTurn: async () => {
      state.calls += 1;
    },
  };
  return state;
}

function enqueue(hub: LeaderDeliveryHub): void {
  hub.enqueue({
    deliveryId: `delegation:${Math.random()}`,
    sessionId: SESSION,
    kind: 'delegation_result',
    createdAt: 0,
    wake: true,
    payload: {
      delegationId: 'd1',
      target: 'bug-hunter',
      task: 'audit',
      ok: true,
      status: 'success',
      handoffs: 0,
      summary: 'done',
    },
  });
}

/**
 * F2625: `fleet.delegate` is user-edited JSON with no runtime validation, and
 * `autoWake` was read as `=== false` (fail-open) while a non-numeric
 * `maxChainedWakes` became `NaN` and silently removed the chain cap. The switch
 * is a consent boundary — the in-project policy denies `fleet` precisely because
 * it can enable autonomous turns — so a malformed opt-out must fail closed.
 */
describe('leader auto-wake config typing (F2625)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['string "false"', 'false'],
    ['string "no"', 'no'],
    ['number 0', 0],
    ['null', null],
  ])('treats a non-boolean autoWake (%s) as disabled', (_label, autoWake) => {
    const hub = new LeaderDeliveryHub();
    const controller = new LeaderAutoWakeController({
      hub,
      config: () => ({ autoWake: autoWake as unknown as boolean }),
      now: () => 1_000_000,
    });
    controller.attachPort(port());
    enqueue(hub);

    expect(controller.evaluate(SESSION)).toBe('disabled');
    controller.dispose();
  });

  it.each([
    ['absent (default on)', undefined],
    ['explicit true', true],
  ])('keeps auto-wake enabled for %s', (_label, autoWake) => {
    const hub = new LeaderDeliveryHub();
    const controller = new LeaderAutoWakeController({
      hub,
      config: () => ({ autoWake: autoWake as boolean | undefined }),
      now: () => 1_000_000,
      minWakeIntervalMs: 0,
    });
    controller.attachPort(port());
    enqueue(hub);

    expect(controller.evaluate(SESSION)).toBe('woken');
    controller.dispose();
  });

  it('falls back to the default chain cap when maxChainedWakes is not a number', async () => {
    const hub = new LeaderDeliveryHub();
    let now = 1_000_000;
    const controller = new LeaderAutoWakeController({
      hub,
      config: () => ({ maxChainedWakes: 'abc' as unknown as number }),
      now: () => (now += 31_000),
    });
    controller.attachPort(port());
    enqueue(hub);

    const decisions: string[] = [];
    for (let i = 0; i <= DEFAULT_MAX_CHAINED_WAKES; i++) {
      decisions.push(controller.evaluate(SESSION));
      await Promise.resolve();
    }
    controller.dispose();

    expect(decisions.slice(0, DEFAULT_MAX_CHAINED_WAKES)).toEqual(
      Array.from({ length: DEFAULT_MAX_CHAINED_WAKES }, () => 'woken'),
    );
    expect(decisions[DEFAULT_MAX_CHAINED_WAKES]).toBe('chain_cap');
  });

  it('falls back to the default debounce when autoWakeDebounceMs is not a number', () => {
    vi.useFakeTimers();
    const hub = new LeaderDeliveryHub();
    const controller = new LeaderAutoWakeController({
      hub,
      config: () => ({
        autoDebounce: undefined,
        autoWakeDebounceMs: 'abc' as unknown as number,
      }),
      minWakeIntervalMs: 0,
    });
    const wakePort = port();
    controller.attachPort(wakePort);

    enqueue(hub);
    expect(wakePort.calls).toBe(0);
    vi.advanceTimersByTime(DEFAULT_AUTO_WAKE_DEBOUNCE_MS - 1);
    expect(wakePort.calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(wakePort.calls).toBe(1);
    controller.dispose();
  });
});
