/**
 * Unit tests for NotifierImpl.
 *
 * These tests use mock NotificationChannel instances via vitest fake functions
 * so no real I/O, network, or Telegram infrastructure is needed. Each test
 * creates a NotifierImpl, registers zero or more mock channels, and asserts
 * the dispatch/counter/ping behaviour without side effects.
 *
 * @module notifications
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotifierImpl } from '../../src/notifications/notifier-impl.js';
import type {
  NotificationChannel,
  NotificationMessage,
  NotificationResult,
} from '../../src/notifications/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_MSG: NotificationMessage = {
  title: 'Test',
  body: 'Hello from the test suite',
  level: 'info',
  source: 'test:notifier-impl',
};

const ANOTHER_MSG: NotificationMessage = {
  title: 'Warning',
  body: 'Something noteworthy happened',
  level: 'warning',
  source: 'test:notifier-impl',
};

/** Create a mock channel that resolves `deliver` with the given result. */
function mockChannel(
  name: string,
  type: string,
  deliverResult: NotificationResult,
  pingResult?: { ok: boolean; error?: string | undefined },
): NotificationChannel {
  return {
    name,
    type,
    deliver: vi.fn().mockResolvedValue(deliverResult),
    ping: vi.fn().mockResolvedValue(pingResult ?? { ok: true }),
  };
}

/** Create a mock channel whose `deliver` rejects (simulates a crash). */
function crashingChannel(name: string, type: string): NotificationChannel {
  return {
    name,
    type,
    deliver: vi.fn().mockRejectedValue(new Error('network unreachable')),
    ping: vi.fn().mockRejectedValue(new Error('crash')),
  };
}

/** Create a mock channel whose `ping` resolves to an error. */
function unhealthyChannel(name: string, type: string): NotificationChannel {
  return {
    name,
    type,
    deliver: vi.fn().mockResolvedValue({
      ok: true,
      channel: name,
      deliveredAt: new Date().toISOString(),
    } satisfies NotificationResult),
    ping: vi.fn().mockResolvedValue({ ok: false, error: 'rate limited' }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotifierImpl', () => {
  let notifier: NotifierImpl;

  beforeEach(() => {
    notifier = new NotifierImpl();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  describe('registerChannel / unregisterChannel', () => {
    it('starts with no channels', async () => {
      const chs = await notifier.channels();
      expect(chs).toEqual([]);
    });

    it('registerChannel makes the channel discoverable', async () => {
      const ch = mockChannel('slack', 'webhook', {
        ok: true,
        channel: 'slack',
        deliveredAt: 'now',
      });
      notifier.registerChannel(ch);

      const chs = await notifier.channels();
      expect(chs).toHaveLength(1);
      expect(chs[0]).toMatchObject({ name: 'slack', type: 'webhook', ok: true });
    });

    it('registerChannel replaces an existing channel with the same name', async () => {
      const first = mockChannel('dup', 'webhook', {
        ok: true,
        channel: 'dup',
        deliveredAt: '1',
      });
      const second = mockChannel('dup', 'slack', {
        ok: true,
        channel: 'dup',
        deliveredAt: '2',
      });
      notifier.registerChannel(first);
      notifier.registerChannel(second);

      const chs = await notifier.channels();
      expect(chs).toHaveLength(1);
      expect(chs[0]!.type).toBe('slack'); // last-write-wins
    });

    it('unregisterChannel removes the channel but keeps counters', async () => {
      const ch = mockChannel('tmp', 'webhook', {
        ok: true,
        channel: 'tmp',
        deliveredAt: 'now',
      });
      notifier.registerChannel(ch);
      await notifier.notify('tmp', SAMPLE_MSG);
      notifier.unregisterChannel('tmp');

      const chs = await notifier.channels();
      expect(chs).toHaveLength(0); // gone from live registry

      const counters = notifier.perChannelCounters();
      expect(counters['tmp']).toBeDefined(); // counters survive unregister
      expect(counters['tmp']!.attempted).toBe(1);
    });

    it('unregisterChannel is idempotent for unknown names', () => {
      expect(() => notifier.unregisterChannel('nope')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Dispatch (notify)
  // -----------------------------------------------------------------------

  describe('notify', () => {
    it('delivers to a single channel by string name', async () => {
      const ch = mockChannel('slack', 'webhook', {
        ok: true,
        channel: 'slack',
        deliveredAt: 't1',
      });
      notifier.registerChannel(ch);

      const results = await notifier.notify('slack', SAMPLE_MSG);
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(true);
      expect(results[0]!.channel).toBe('slack');
      expect(ch.deliver).toHaveBeenCalledTimes(1);
      expect(ch.deliver).toHaveBeenCalledWith(SAMPLE_MSG);
    });

    it('delivers to multiple channels by array of names', async () => {
      const slack = mockChannel('slack', 'webhook', {
        ok: true,
        channel: 'slack',
        deliveredAt: 't1',
      });
      const tg = mockChannel('telegram', 'telegram', {
        ok: true,
        channel: 'telegram',
        deliveredAt: 't2',
      });
      notifier.registerChannel(slack);
      notifier.registerChannel(tg);

      const results = await notifier.notify(['slack', 'telegram'], SAMPLE_MSG);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.channel)).toEqual(['slack', 'telegram']);
      expect(slack.deliver).toHaveBeenCalledTimes(1);
      expect(tg.deliver).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when channels array is empty', async () => {
      const results = await notifier.notify([], SAMPLE_MSG);
      expect(results).toEqual([]);
    });

    it('silently skips unknown channel names', async () => {
      const ch = mockChannel('slack', 'webhook', {
        ok: true,
        channel: 'slack',
        deliveredAt: 't1',
      });
      notifier.registerChannel(ch);

      const results = await notifier.notify(['slack', 'unknown', 'also-unknown'], SAMPLE_MSG);
      expect(results).toHaveLength(1); // only 'slack' result returned
      expect(results[0]!.channel).toBe('slack');
      expect(ch.deliver).toHaveBeenCalledTimes(1);
    });

    it('propagates delivery failures from the channel', async () => {
      const ch = mockChannel('flaky', 'webhook', {
        ok: false,
        channel: 'flaky',
        error: 'HTTP 500',
        deliveredAt: 't1',
      });
      notifier.registerChannel(ch);

      const results = await notifier.notify('flaky', SAMPLE_MSG);
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(false);
      expect(results[0]!.error).toBe('HTTP 500');
    });

    it('catches a channel whose deliver() throws (unexpected crash)', async () => {
      const ch = crashingChannel('crashy', 'webhook');
      notifier.registerChannel(ch);

      // NotifierImpl catches deliver rejections and converts them to
      // { ok: false, error: "threw: <msg>" } so a single crashing channel
      // does not tear down every parallel delivery in the same notify() call.
      const results = await notifier.notify('crashy', SAMPLE_MSG);
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(false);
      expect(results[0]!.error).toMatch(/^threw: /);
      expect(results[0]!.channel).toBe('crashy');

      // Counter should reflect the failure.
      const counters = notifier.perChannelCounters();
      expect(counters['crashy']).toBeDefined();
      expect(counters['crashy']!.attempted).toBe(1);
      expect(counters['crashy']!.delivered).toBe(0);
      expect(counters['crashy']!.failed).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Counters
  // -----------------------------------------------------------------------

  describe('counters', () => {
    it('returns zeros when no notifications have been sent', () => {
      const c = notifier.counters();
      expect(c).toEqual({ attempted: 0, delivered: 0, failed: 0, suppressed: 0 });
    });

    it('counts a successful delivery', async () => {
      const ch = mockChannel('slack', 'webhook', {
        ok: true,
        channel: 'slack',
        deliveredAt: 't1',
      });
      notifier.registerChannel(ch);
      await notifier.notify('slack', SAMPLE_MSG);

      const c = notifier.counters();
      expect(c.attempted).toBe(1);
      expect(c.delivered).toBe(1);
      expect(c.failed).toBe(0);
    });

    it('counts a failed delivery', async () => {
      const ch = mockChannel('flaky', 'webhook', {
        ok: false,
        channel: 'flaky',
        error: 'err',
        deliveredAt: 't1',
      });
      notifier.registerChannel(ch);
      await notifier.notify('flaky', SAMPLE_MSG);

      const c = notifier.counters();
      expect(c.attempted).toBe(1);
      expect(c.delivered).toBe(0);
      expect(c.failed).toBe(1);
    });

    it('tallies across multiple channels', async () => {
      const ok = mockChannel('ok', 'webhook', {
        ok: true,
        channel: 'ok',
        deliveredAt: 't1',
      });
      const fail = mockChannel('fail', 'webhook', {
        ok: false,
        channel: 'fail',
        error: 'err',
        deliveredAt: 't2',
      });
      notifier.registerChannel(ok);
      notifier.registerChannel(fail);

      await notifier.notify(['ok', 'fail'], SAMPLE_MSG);
      await notifier.notify('ok', ANOTHER_MSG);

      const c = notifier.counters();
      expect(c.attempted).toBe(3); // 2 from first batch + 1 from second
      expect(c.delivered).toBe(2); // both 'ok' calls succeed
      expect(c.failed).toBe(1); // 'fail' call failed
    });

    it('unknown channel names do not increment counters', async () => {
      await notifier.notify('nobody', SAMPLE_MSG);
      const c = notifier.counters();
      expect(c).toEqual({ attempted: 0, delivered: 0, failed: 0, suppressed: 0 });
    });
  });

  // -----------------------------------------------------------------------
  // perChannelCounters
  // -----------------------------------------------------------------------

  describe('perChannelCounters', () => {
    it('returns per-channel breakdown', async () => {
      const a = mockChannel('chA', 'webhook', {
        ok: true,
        channel: 'chA',
        deliveredAt: 't1',
      });
      const b = mockChannel('chB', 'webhook', {
        ok: false,
        channel: 'chB',
        error: 'err',
        deliveredAt: 't2',
      });
      notifier.registerChannel(a);
      notifier.registerChannel(b);

      await notifier.notify(['chA', 'chB'], SAMPLE_MSG);
      await notifier.notify('chA', ANOTHER_MSG);

      const pc = notifier.perChannelCounters();
      expect(pc['chA']).toEqual({ attempted: 2, delivered: 2, failed: 0 });
      expect(pc['chB']).toEqual({ attempted: 1, delivered: 0, failed: 1 });
    });

    it('returns empty object when no channels registered or used', () => {
      expect(notifier.perChannelCounters()).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Channels / ping
  // -----------------------------------------------------------------------

  describe('channels (ping aggregation)', () => {
    it('returns healthy status for a channel with ok ping', async () => {
      const ch = mockChannel('slack', 'webhook', {
        ok: true,
        channel: 'slack',
        deliveredAt: 'now',
      });
      notifier.registerChannel(ch);

      const chs = await notifier.channels();
      expect(chs).toHaveLength(1);
      expect(chs[0]).toMatchObject({ name: 'slack', type: 'webhook', ok: true });
      expect(ch.ping).toHaveBeenCalledTimes(1);
    });

    it('reports unhealthy status when ping returns ok: false', async () => {
      const ch = unhealthyChannel('limited', 'webhook');
      notifier.registerChannel(ch);

      const chs = await notifier.channels();
      expect(chs).toHaveLength(1);
      expect(chs[0]).toMatchObject({ name: 'limited', ok: false, error: 'rate limited' });
    });

    it('handles channels whose ping() throws', async () => {
      const ch = crashingChannel('crashy', 'webhook');
      notifier.registerChannel(ch);

      const chs = await notifier.channels();
      expect(chs).toHaveLength(1);
      expect(chs[0]).toMatchObject({ name: 'crashy', ok: false, error: 'ping threw' });
    });

    it('aggregates multiple channels in parallel', async () => {
      const healthy = mockChannel('healthy', 'webhook', {
        ok: true,
        channel: 'healthy',
        deliveredAt: 'now',
      });
      const sick = unhealthyChannel('sick', 'webhook');
      const crash = crashingChannel('crash', 'webhook');
      notifier.registerChannel(healthy);
      notifier.registerChannel(sick);
      notifier.registerChannel(crash);

      const chs = await notifier.channels();
      expect(chs).toHaveLength(3);

      const healthyStatus = chs.find((c) => c.name === 'healthy');
      const sickStatus = chs.find((c) => c.name === 'sick');
      const crashStatus = chs.find((c) => c.name === 'crash');

      expect(healthyStatus).toMatchObject({ ok: true });
      expect(sickStatus).toMatchObject({ ok: false, error: 'rate limited' });
      expect(crashStatus).toMatchObject({ ok: false, error: 'ping threw' });
    });
  });
});
