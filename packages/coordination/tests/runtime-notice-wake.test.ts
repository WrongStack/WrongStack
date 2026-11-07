/**
 * Runtime notices (timers, watches, background process exits) ride the
 * leader delivery hub: rendered as `[RUNTIME NOTICE]`, drained without the
 * delegation bookkeeping, and woken on their own wider budget.
 */

import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAutoWakePrompt,
  DEFAULT_MAX_CHAINED_RUNTIME_WAKES,
  DEFAULT_MAX_CHAINED_WAKES,
  LeaderAutoWakeController,
  type LeaderWakePort,
} from '../src/delegation/leader-auto-wake.js';
import {
  delegationDeliveryId,
  type LeaderDelivery,
  LeaderDeliveryHub,
  leaderDeliveryHub,
  leaderDeliveryRef,
  RUNTIME_NOTICE_BODY_MAX_CHARS,
  RUNTIME_NOTICE_MARKER,
  renderLeaderDeliveryBlock,
  runtimeNoticeDeliveryId,
} from '../src/delegation/leader-delivery-hub.js';
import { drainLeaderDeliveries } from '../src/leader-delivery-attach.js';
import { enqueueRuntimeNotice, resolveRuntimeNoticeTarget } from '../src/runtime-notice.js';

const SID = 'session-notices';

function notice(handle: string, seq: number, body?: string): LeaderDelivery {
  return {
    deliveryId: runtimeNoticeDeliveryId('timer', handle, seq),
    sessionId: SID,
    kind: 'runtime_notice',
    createdAt: Date.now(),
    wake: true,
    payload: { source: 'timer', handle, title: `session_wakeup ${handle} fired`, body },
  };
}

function delegation(id: string): LeaderDelivery {
  return {
    deliveryId: delegationDeliveryId(id),
    sessionId: SID,
    kind: 'delegation_result',
    createdAt: Date.now(),
    wake: true,
    payload: {
      delegationId: id,
      target: 'helper',
      task: 't',
      ok: true,
      handoffs: 0,
      summary: 'ok',
    },
  };
}

describe('runtime notice rendering', () => {
  it('renders a marked block with title and body and names it by source:handle#seq', () => {
    const item = notice('wk-1', 2, 'prompt: check CI');
    const text = renderLeaderDeliveryBlock(item);
    expect(text.startsWith(`${RUNTIME_NOTICE_MARKER} source=timer handle=wk-1`)).toBe(true);
    expect(text).toContain('session_wakeup wk-1 fired');
    expect(text).toContain('prompt: check CI');
    expect(leaderDeliveryRef(item)).toBe('timer:wk-1#2');
  });

  it('bounds an oversized body', () => {
    const text = renderLeaderDeliveryBlock(
      notice('wk-2', 1, 'x'.repeat(RUNTIME_NOTICE_BODY_MAX_CHARS * 2)),
    );
    expect(text.length).toBeLessThan(RUNTIME_NOTICE_BODY_MAX_CHARS + 500);
    expect(text).toContain('…');
  });

  it('names notices and delegations apart in the wake prompt', () => {
    expect(buildAutoWakePrompt([], ['timer:wk-1#1'])).toBe(
      '[AUTO-WAKE] Runtime notice(s) arrived: timer:wk-1#1. Review and continue.',
    );
    expect(buildAutoWakePrompt(['d1'], ['watch:pw-1#3'])).toBe(
      '[AUTO-WAKE] Background delegation result(s) arrived: d1; runtime notice(s) arrived: watch:pw-1#3. Review and continue.',
    );
    // Delegation-only prompts are unchanged.
    expect(buildAutoWakePrompt(['d1', 'd2'])).toBe(
      '[AUTO-WAKE] Background delegation result(s) arrived: d1, d2. Review and continue.',
    );
  });
});

describe('runtime notice target', () => {
  it('resolves the session only for a leader', () => {
    expect(resolveRuntimeNoticeTarget({ agentId: 'leader', session: { id: 's1' } })).toBe('s1');
    expect(
      resolveRuntimeNoticeTarget({
        agentId: 'leader',
        activeRunSessionId: 'pinned',
        session: { id: 's1' },
      }),
    ).toBe('pinned');
    expect(
      resolveRuntimeNoticeTarget({ agentId: 'worker-1', session: { id: 's1' } }),
    ).toBeUndefined();
    expect(resolveRuntimeNoticeTarget({ session: { id: 's1' } })).toBeUndefined();
    expect(resolveRuntimeNoticeTarget(undefined)).toBeUndefined();
  });

  it('enqueues once per source/handle/seq', () => {
    const sid = `${SID}-enqueue`;
    const input = { source: 'process' as const, handle: '4242', seq: 'exit@1', title: 'exited' };
    expect(enqueueRuntimeNotice(sid, input)).toBe(true);
    expect(enqueueRuntimeNotice(sid, input)).toBe(false);
    const [item] = leaderDeliveryHub.take(sid);
    expect(item?.kind).toBe('runtime_notice');
    expect(item?.wake).toBe(true);
  });
});

describe('runtime notice drain', () => {
  it('folds a notice for the leader without journaling a delegation delivery', async () => {
    const sid = `${SID}-drain`;
    enqueueRuntimeNotice(sid, {
      source: 'watch',
      handle: 'pw-1',
      seq: 1,
      title: 'pw-1: 2 new lines',
      body: 'READY',
    });
    const append = vi.fn(async () => undefined);
    const folded: string[] = [];
    const delivered = await drainLeaderDeliveries(
      {
        ctx: { agentId: 'leader', session: { id: sid, append } } as never,
        logger: { warn: () => undefined, debug: () => undefined } as never,
      },
      [sid],
      (block) => folded.push(block.text),
    );
    expect(delivered).toBe(1);
    expect(folded[0]).toContain(`${RUNTIME_NOTICE_MARKER} source=watch handle=pw-1`);
    expect(folded[0]).toContain('READY');
    expect(append).not.toHaveBeenCalled();
  });

  it('never lets a worker drain the leader notices', async () => {
    const sid = `${SID}-worker`;
    enqueueRuntimeNotice(sid, { source: 'timer', handle: 'wk-9', seq: 1, title: 'fired' });
    const delivered = await drainLeaderDeliveries(
      { ctx: { agentId: 'worker-1', session: { id: sid } } as never, logger: {} as never },
      [sid],
      () => undefined,
    );
    expect(delivered).toBe(0);
    expect(leaderDeliveryHub.pending(sid)).toBe(1);
    leaderDeliveryHub.take(sid);
  });
});

describe('notice-only auto-wake budget', () => {
  let hub: LeaderDeliveryHub;
  let events: EventBus;
  let now: number;
  const controllers: LeaderAutoWakeController[] = [];

  function setup() {
    const controller = new LeaderAutoWakeController({
      hub,
      events,
      now: () => now,
      config: () => ({}),
    });
    controllers.push(controller);
    const startWakeTurn = vi.fn(async (_sid: string, _prompt: string) => {});
    const port: LeaderWakePort = {
      isIdle: () => true,
      hasPendingUserInput: () => false,
      isConfirmPending: () => false,
      isOpen: () => true,
      isDisplayed: () => true,
      startWakeTurn,
    };
    controller.attachPort(port);
    return { controller, startWakeTurn };
  }

  /** Simulate the woken turn draining everything, then ending. */
  function drainAndFinish(controller: LeaderAutoWakeController) {
    hub.take(SID, { maxItems: 100, maxChars: 1_000_000 });
    controller.onRunFinished(SID);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    hub = new LeaderDeliveryHub();
    events = new EventBus();
    now = 5_000_000;
  });

  afterEach(() => {
    for (const c of controllers.splice(0)) c.dispose();
    vi.useRealTimers();
  });

  it('wakes for a notice with a notice prompt and reports the notices', async () => {
    const { startWakeTurn } = setup();
    const started: Array<{ notices?: string[] | undefined; delegationIds: string[] }> = [];
    events.on('leader.auto_wake_started', (e) => started.push(e));
    hub.enqueue(notice('wk-1', 1));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(startWakeTurn).toHaveBeenCalledWith(SID, buildAutoWakePrompt([], ['timer:wk-1#1']));
    expect(started).toEqual([
      expect.objectContaining({ delegationIds: [], notices: ['timer:wk-1#1'], chain: 1 }),
    ]);
  });

  it('rate-limits notice-only wakes at 5s instead of 30s', async () => {
    const { controller, startWakeTurn } = setup();
    hub.enqueue(notice('wk-1', 1));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(startWakeTurn).toHaveBeenCalledTimes(1);
    drainAndFinish(controller);

    hub.enqueue(notice('wk-1', 2));
    now += 2_000;
    await vi.advanceTimersByTimeAsync(1_600);
    expect(controller.evaluate(SID)).toBe('rate_limited');
    now += 5_000;
    expect(controller.evaluate(SID)).toBe('woken');
    expect(startWakeTurn).toHaveBeenCalledTimes(2);
  });

  it('allows a longer notice chain than the delegation cap, then holds until user input', () => {
    const { controller, startWakeTurn } = setup();
    expect(DEFAULT_MAX_CHAINED_RUNTIME_WAKES).toBeGreaterThan(DEFAULT_MAX_CHAINED_WAKES);
    const suppressed: unknown[] = [];
    events.on('leader.auto_wake_suppressed', (e) => suppressed.push(e));
    for (let i = 1; i <= DEFAULT_MAX_CHAINED_RUNTIME_WAKES; i++) {
      hub.enqueue(notice('wk-1', i));
      now += 6_000;
      expect(controller.evaluate(SID)).toBe('woken');
      drainAndFinish(controller);
    }
    hub.enqueue(notice('wk-1', 999));
    now += 6_000;
    expect(controller.evaluate(SID)).toBe('chain_cap');
    expect(suppressed).toHaveLength(1);
    expect(startWakeTurn).toHaveBeenCalledTimes(DEFAULT_MAX_CHAINED_RUNTIME_WAKES);

    controller.noteUserInput(SID);
    expect(controller.evaluate(SID)).toBe('woken');
  });

  it('a wake that carries a delegation result follows the delegation budget', () => {
    const { controller } = setup();
    hub.enqueue(notice('wk-1', 1));
    now += 6_000;
    expect(controller.evaluate(SID)).toBe('woken');
    drainAndFinish(controller);
    hub.enqueue(delegation('d1'));
    hub.enqueue(notice('wk-1', 2));
    now += 6_000;
    // 6s after the last wake: fine for notices, too soon for a delegation wake.
    expect(controller.evaluate(SID)).toBe('rate_limited');
    now += 30_000;
    expect(controller.evaluate(SID)).toBe('woken');
  });
});
