/**
 * LeaderAutoWakeController — debounce/coalesce, guards (incl. the Q1
 * undisplayed hold), rate limit, chain cap, wake eligibility, config switch,
 * and the prompt's resistance to Agent.run burst-dedupe.
 */

import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_WAKE_MARKER,
  buildAutoWakePrompt,
  type LeaderAutoWakeConfig,
  LeaderAutoWakeController,
  type LeaderWakePort,
} from '../../src/coordination/delegation/leader-auto-wake.js';
import {
  delegationDeliveryId,
  type LeaderDelivery,
  LeaderDeliveryHub,
} from '../../src/coordination/delegation/leader-delivery-hub.js';
import { isRuntimeContextInput } from '../../src/utils/context-evidence.js';

const SID = 'session-a';

function delivery(id: string, wake = true, sessionId = SID): LeaderDelivery {
  return {
    deliveryId: delegationDeliveryId(id),
    sessionId,
    kind: 'delegation_result',
    createdAt: Date.now(),
    wake,
    payload: {
      delegationId: id,
      target: 'helper',
      task: 't',
      ok: true,
      handoffs: 0,
      summary: 'done',
    },
  };
}

type PortState = {
  idle: boolean;
  queued: boolean;
  confirm: boolean;
  open: boolean;
  displayed: boolean;
};

function makePort(initial: Partial<PortState> = {}) {
  const s: PortState = {
    idle: true,
    queued: false,
    confirm: false,
    open: true,
    displayed: true,
    ...initial,
  };
  const startWakeTurn = vi.fn(async (_sessionId: string, _prompt: string) => {});
  const port: LeaderWakePort = {
    isIdle: () => s.idle,
    hasPendingUserInput: () => s.queued,
    isConfirmPending: () => s.confirm,
    isOpen: () => s.open,
    isDisplayed: () => s.displayed,
    startWakeTurn,
  };
  return { port, s, startWakeTurn };
}

let hub: LeaderDeliveryHub;
let events: EventBus;
let now: number;
let config: LeaderAutoWakeConfig;
const controllers: LeaderAutoWakeController[] = [];

function makeController() {
  const controller = new LeaderAutoWakeController({
    hub,
    events,
    now: () => now,
    config: () => config,
  });
  controllers.push(controller);
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
  hub = new LeaderDeliveryHub();
  events = new EventBus();
  now = 1_000_000;
  config = {};
});

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.useRealTimers();
});

describe('LeaderAutoWakeController', () => {
  it('debounces and coalesces several results into one wake naming every delegation', async () => {
    const controller = makeController();
    const { port, startWakeTurn } = makePort();
    controller.attachPort(port);
    const started: unknown[] = [];
    events.on('leader.auto_wake_started', (e) => started.push(e));

    hub.enqueue(delivery('d1'));
    await vi.advanceTimersByTimeAsync(1_000);
    hub.enqueue(delivery('d2'));
    expect(startWakeTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);

    expect(startWakeTurn).toHaveBeenCalledTimes(1);
    expect(startWakeTurn).toHaveBeenCalledWith(SID, buildAutoWakePrompt(['d1', 'd2']));
    expect(started).toEqual([
      {
        sessionId: SID,
        deliveryIds: [delegationDeliveryId('d1'), delegationDeliveryId('d2')],
        delegationIds: ['d1', 'd2'],
        chain: 1,
      },
    ]);
  });

  it('honours a configured debounce window', async () => {
    config = { autoWakeDebounceMs: 5_000 };
    const controller = makeController();
    const { port, startWakeTurn } = makePort();
    controller.attachPort(port);
    hub.enqueue(delivery('d1'));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(startWakeTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(startWakeTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['closed', { open: false }, 'closed'],
    ['busy', { idle: false }, 'busy'],
    ['queued user input', { queued: true }, 'busy'],
    ['confirm pending', { confirm: true }, 'busy'],
  ] as const)(
    'does not wake when %s, then wakes from the post-run check',
    async (_label, st, decision) => {
      const controller = makeController();
      const { port, s, startWakeTurn } = makePort(st);
      controller.attachPort(port);
      hub.enqueue(delivery('d1'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(startWakeTurn).not.toHaveBeenCalled();
      expect(controller.evaluate(SID)).toBe(decision);

      Object.assign(s, { idle: true, queued: false, confirm: false, open: true });
      expect(controller.onRunFinished(SID)).toBe('woken');
      expect(startWakeTurn).toHaveBeenCalledTimes(1);
    },
  );

  it('HOLDS results for an undisplayed session and wakes when it becomes displayed (Q1)', async () => {
    const controller = makeController();
    const { port, s, startWakeTurn } = makePort({ displayed: false });
    controller.attachPort(port);
    const suppressed: unknown[] = [];
    events.on('leader.auto_wake_suppressed', (e) => suppressed.push(e));

    hub.enqueue(delivery('d1'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startWakeTurn).not.toHaveBeenCalled();
    expect(controller.onRunFinished(SID)).toBe('undisplayed');
    // One notice per hold episode.
    expect(suppressed).toEqual([{ sessionId: SID, reason: 'undisplayed', pending: 1 }]);
    expect(hub.pending(SID)).toBe(1);

    s.displayed = true;
    expect(controller.onSessionDisplayed(SID)).toBe('woken');
    expect(startWakeTurn).toHaveBeenCalledWith(SID, buildAutoWakePrompt(['d1']));
  });

  it('rate-limits wakes per session to one per 30s and retries when the interval elapses', async () => {
    const controller = makeController();
    const { port, startWakeTurn } = makePort();
    controller.attachPort(port);

    hub.enqueue(delivery('d1'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(startWakeTurn).toHaveBeenCalledTimes(1);
    hub.take(SID); // the woken turn drained it

    now += 5_000;
    hub.enqueue(delivery('d2'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(startWakeTurn).toHaveBeenCalledTimes(1);
    expect(controller.onRunFinished(SID)).toBe('rate_limited');

    now += 25_000;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(startWakeTurn).toHaveBeenCalledTimes(2);
    expect(startWakeTurn).toHaveBeenLastCalledWith(SID, buildAutoWakePrompt(['d2']));
  });

  it('caps consecutive woken turns, emits a notice once, and resets on user input', async () => {
    config = { maxChainedWakes: 2 };
    const controller = makeController();
    const { port, startWakeTurn } = makePort();
    controller.attachPort(port);
    const suppressed: unknown[] = [];
    events.on('leader.auto_wake_suppressed', (e) => suppressed.push(e));

    for (const id of ['d1', 'd2']) {
      hub.enqueue(delivery(id));
      now += 31_000;
      expect(controller.onRunFinished(SID)).toBe('woken');
      hub.take(SID);
    }
    expect(controller.chainLength(SID)).toBe(2);

    hub.enqueue(delivery('d3'));
    now += 31_000;
    expect(controller.onRunFinished(SID)).toBe('chain_cap');
    expect(controller.onRunFinished(SID)).toBe('chain_cap');
    expect(startWakeTurn).toHaveBeenCalledTimes(2);
    expect(hub.pending(SID)).toBe(1);
    expect(suppressed).toEqual([{ sessionId: SID, reason: 'chain_cap', pending: 1 }]);

    controller.noteUserInput(SID);
    expect(controller.chainLength(SID)).toBe(0);
    expect(controller.onRunFinished(SID)).toBe('woken');
    expect(startWakeTurn).toHaveBeenCalledTimes(3);
  });

  it('never wakes for wake:false items — neither on enqueue nor via the post-run check', async () => {
    const controller = makeController();
    const { port, startWakeTurn } = makePort();
    controller.attachPort(port);
    hub.enqueue(delivery('user-stopped', false));
    hub.enqueue(delivery('rehydrated', false));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.onRunFinished(SID)).toBe('nothing_pending');
    expect(controller.onSessionDisplayed(SID)).toBe('nothing_pending');
    expect(startWakeTurn).not.toHaveBeenCalled();

    // A later eligible item wakes, and the prompt names only eligible ids.
    hub.enqueue(delivery('d-ok'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(startWakeTurn).toHaveBeenCalledWith(SID, buildAutoWakePrompt(['d-ok']));
  });

  it('autoWake:false disables the controller entirely (read live)', async () => {
    config = { autoWake: false };
    const controller = makeController();
    const { port, startWakeTurn } = makePort();
    controller.attachPort(port);
    hub.enqueue(delivery('d1'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.onRunFinished(SID)).toBe('disabled');
    expect(controller.onSessionDisplayed(SID)).toBe('disabled');
    expect(startWakeTurn).not.toHaveBeenCalled();

    config = {};
    expect(controller.onRunFinished(SID)).toBe('woken');
  });

  it('does not double-wake while a wake turn is in flight, and the post-run check clears it', async () => {
    const controller = makeController();
    let finish!: () => void;
    const { port, startWakeTurn } = makePort();
    startWakeTurn.mockImplementation(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    controller.attachPort(port);
    hub.enqueue(delivery('d1'));
    expect(controller.onRunFinished(SID)).toBe('woken');
    now += 60_000;
    expect(controller.evaluate(SID)).toBe('busy');
    // The woken turn finished (host post-run check) with the item still pending.
    expect(controller.onRunFinished(SID)).toBe('woken');
    finish();
  });

  it('logs and survives a failing startWakeTurn', async () => {
    const warn = vi.fn();
    const controller = new LeaderAutoWakeController({ hub, now: () => now, logger: { warn } });
    controllers.push(controller);
    const { port, startWakeTurn } = makePort();
    startWakeTurn.mockRejectedValue(new Error('boom'));
    controller.attachPort(port);
    hub.enqueue(delivery('d1'));
    expect(controller.evaluate(SID)).toBe('woken');
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('without a port nothing happens; detach and dispose stop further wakes', async () => {
    const controller = makeController();
    hub.enqueue(delivery('d1'));
    expect(controller.evaluate(SID)).toBe('no_port');
    const { port, startWakeTurn } = makePort();
    const detach = controller.attachPort(port);
    detach();
    expect(controller.evaluate(SID)).toBe('no_port');
    controller.attachPort(port);
    controller.dispose();
    hub.enqueue(delivery('d2'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.evaluate(SID)).toBe('disabled');
    expect(startWakeTurn).not.toHaveBeenCalled();
  });

  it('ignores other sessions', async () => {
    const controller = makeController();
    const { port, startWakeTurn } = makePort();
    controller.attachPort({ ...port, isOpen: (id) => id === SID, isDisplayed: (id) => id === SID });
    hub.enqueue(delivery('d1', true, 'other-session'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(startWakeTurn).not.toHaveBeenCalled();
  });

  it('unrefs its timers so a pending wake never keeps the process alive', () => {
    vi.useRealTimers();
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const handle = realSetTimeout(fn, ms);
      const wrapped = Object.assign(handle, {});
      const originalUnref = wrapped.unref?.bind(wrapped);
      wrapped.unref = () => {
        unref();
        return originalUnref ? originalUnref() : wrapped;
      };
      return wrapped;
    }) as never);
    try {
      const controller = makeController();
      controller.attachPort(makePort().port);
      hub.enqueue(delivery('d1'));
      expect(unref).toHaveBeenCalledTimes(1);
      controller.dispose();
    } finally {
      spy.mockRestore();
    }
  });

  it('builds a unique, content-free prompt that is not a human turn and defeats burst-dedupe', () => {
    const a = buildAutoWakePrompt(['d1']);
    const b = buildAutoWakePrompt(['d2']);
    expect(a).toBe('[AUTO-WAKE] Background delegation result(s) arrived: d1. Review and continue.');
    expect(a.startsWith(AUTO_WAKE_MARKER)).toBe(true);
    expect(a).not.toBe(b);
    expect(isRuntimeContextInput(a)).toBe(true);
  });
});
