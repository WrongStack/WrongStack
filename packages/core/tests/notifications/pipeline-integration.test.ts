/**
 * End-to-end pipeline integration test for the notification system.
 *
 * This test wires together the three core abstractions — EventBus, Notifier,
 * and NotificationChannel — and verifies that a real event flow reaches
 * multiple registered channels through the Notifier.
 *
 * The pipeline under test:
 *
 *   EventBus.emit('session.ended', { usage: {...}, id: 'sess_abc' })
 *       │
 *       ▼  (event handler subscribed via api.events.on)
 *   buildNotificationMessage()
 *       │
 *       ▼
 *   Notifier.notify(['telegram', 'webhook'], msg)
 *       │               │
 *       ├── TelegramNotificationChannel.deliver(msg)
 *       └── WebhookNotificationChannel.deliver(msg)
 *
 * All channels use mock implementations so no real I/O or network
 * infrastructure is needed. The EventBus is the real implementation
 * from @wrongstack/core.
 *
 * @module notifications
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NotificationChannel,
  NotificationMessage,
  NotificationResult,
} from '../../src/notifications/types.js';
import { NotifierImpl } from '../../src/notifications/notifier-impl.js';
import { EventBus } from '../../src/kernel/events.js';

// ---------------------------------------------------------------------------
// Mock channel factory
// ---------------------------------------------------------------------------

function createMockChannel(
  name: string,
  type: string,
): NotificationChannel & { delivered: NotificationMessage[] } {
  const delivered: NotificationMessage[] = [];
  return {
    name,
    type,
    delivered,
    async deliver(msg: NotificationMessage): Promise<NotificationResult> {
      delivered.push(msg);
      return { ok: true, channel: name, deliveredAt: new Date().toISOString() };
    },
    async ping() {
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// The event payload shapes the notification handlers receive
// ---------------------------------------------------------------------------

interface SessionEndedEvent {
  id: string;
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

interface ToolExecutedEvent {
  name: string;
  ok: boolean;
  durationMs: number;
  output?: string;
}

interface DelegateCompletedEvent {
  target: string;
  task: string;
  ok: boolean;
  status?: string;
  summary: string;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  costUsd?: number;
  subagentId?: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Notification pipeline integration', () => {
  let notifier: NotifierImpl;
  let bus: EventBus;
  let telegram: ReturnType<typeof createMockChannel>;
  let webhook: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    notifier = new NotifierImpl();
    bus = new EventBus();

    telegram = createMockChannel('telegram', 'telegram');
    webhook = createMockChannel('webhook', 'webhook');

    notifier.registerChannel(telegram);
    notifier.registerChannel(webhook);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // session.ended → Notifier → telegram + webhook
  // -----------------------------------------------------------------------

  it('routes a session.ended notification to both telegram and webhook channels', async () => {
    // Subscribe to session.ended as the Telegram plugin would.
    const handler = vi.fn((event: SessionEndedEvent) => {
      void notifier.notify(['telegram', 'webhook'], {
        title: 'Session ended',
        body: `Session ${event.id.slice(0, 8)} ended — ${event.usage.input} in, ${event.usage.output} out`,
        level: 'info',
        source: 'session.end',
      });
    });
    const unsub = bus.on('session.ended' as never, handler as never);

    // Fire the event as the core would.
    const event: SessionEndedEvent = {
      id: 'sess_abc12345',
      usage: { input: 8234, output: 3456 },
    };
    bus.emit('session.ended', event as never);

    // Allow microtasks to settle.
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    // Both channels should have received the message.
    expect(telegram.delivered).toHaveLength(1);
    expect(webhook.delivered).toHaveLength(1);

    const tgMsg = telegram.delivered[0]!;
    expect(tgMsg.title).toBe('Session ended');
    expect(tgMsg.source).toBe('session.end');
    expect(tgMsg.body).toContain('8234 in');
    expect(tgMsg.body).toContain('3456 out');

    const whMsg = webhook.delivered[0]!;
    expect(whMsg).toEqual(tgMsg); // same message shape to both

    unsub();
  });

  // -----------------------------------------------------------------------
  // session.ended → Notifier → telegram only (selective routing)
  // -----------------------------------------------------------------------

  it('routes to a single channel when the other is not requested', async () => {
    const handler = vi.fn((event: SessionEndedEvent) => {
      void notifier.notify('telegram', {
        title: 'Session ended',
        body: `Session ${event.id.slice(0, 8)} ended`,
        level: 'info',
        source: 'session.end',
      });
    });
    const unsub = bus.on('session.ended' as never, handler as never);

    bus.emit('session.ended', {
      id: 'sess_xyz',
      usage: { input: 100, output: 50 },
    } as never);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    // Only telegram should have received the message.
    expect(telegram.delivered).toHaveLength(1);
    expect(webhook.delivered).toHaveLength(0);

    unsub();
  });

  // -----------------------------------------------------------------------
  // tool.executed → Notifier → webhook only
  // -----------------------------------------------------------------------

  it('routes a long-running tool notification to webhook only', async () => {
    const handler = vi.fn((event: ToolExecutedEvent) => {
      // Only notify if the tool took longer than 30s (mimicking the
      // Telegram plugin's longToolThresholdMs guard).
      if (event.durationMs < 30_000) return;

      void notifier.notify('webhook', {
        title: event.ok ? 'Tool completed' : 'Tool failed',
        body: `${event.name} ran for ${(event.durationMs / 1000).toFixed(1)}s`,
        level: event.ok ? 'info' : 'warning',
        source: 'tool.exec',
      });
    });
    const unsub = bus.on('tool.executed', handler as never);

    // Short tool — should NOT trigger a notification.
    bus.emit('tool.executed', {
      name: 'bash',
      ok: true,
      durationMs: 500,
    } as never);

    // Long tool — SHOULD trigger.
    bus.emit('tool.executed', {
      name: 'bash',
      ok: true,
      durationMs: 45_000,
      output: 'All tests passed.',
    } as never);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });

    expect(telegram.delivered).toHaveLength(0);
    expect(webhook.delivered).toHaveLength(1);
    expect(webhook.delivered[0]!.title).toBe('Tool completed');
    expect(webhook.delivered[0]!.body).toContain('45.0s');

    unsub();
  });

  // -----------------------------------------------------------------------
  // delegate.completed → Notifier → both channels
  // -----------------------------------------------------------------------

  it('routes a delegate.completed notification with level based on ok status', async () => {
    const handler = vi.fn((event: DelegateCompletedEvent) => {
      void notifier.notify(['telegram', 'webhook'], {
        title: `Delegate: ${event.target}`,
        body: `${event.target} — ${event.ok ? 'success' : 'failed'} in ${(event.durationMs / 1000).toFixed(0)}s`,
        level: event.ok ? 'info' : 'warning',
        source: 'delegate.completed',
      });
    });
    const unsub = bus.on('delegate.completed', handler as never);

    // Failed delegate
    bus.emit('delegate.completed', {
      target: 'bug-hunter',
      task: 'Scan auth.ts for null dereferences',
      ok: false,
      status: 'failed',
      summary: 'Found 3 null-deref risks, patched 2, 1 remains',
      durationMs: 180_000,
      iterations: 4,
      toolCalls: 37,
    } as never);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    expect(telegram.delivered).toHaveLength(1);
    expect(webhook.delivered).toHaveLength(1);

    const tgMsg = telegram.delivered[0]!;
    expect(tgMsg.title).toBe('Delegate: bug-hunter');
    expect(tgMsg.level).toBe('warning');
    expect(tgMsg.source).toBe('delegate.completed');

    const whMsg = webhook.delivered[0]!;
    expect(whMsg.level).toBe('warning');

    unsub();
  });

  // -----------------------------------------------------------------------
  // Unknown channel names are silently skipped
  // -----------------------------------------------------------------------

  it('silently skips unknown channel names in the routing array', async () => {
    const handler = vi.fn(() => {
      void notifier.notify(['telegram', 'nonexistent-channel'], {
        title: 'Test',
        body: 'Only telegram should get this',
        level: 'info',
        source: 'test',
      });
    });
    const unsub = bus.on('session.ended', handler as never);

    bus.emit('session.ended', {
      id: 'sess_skip',
      usage: { input: 1, output: 1 },
    } as never);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    expect(telegram.delivered).toHaveLength(1);
    expect(webhook.delivered).toHaveLength(0); // not requested
    // 'nonexistent-channel' silently skipped — no error thrown

    unsub();
  });

  // -----------------------------------------------------------------------
  // Channel delivery failure does not break other channels
  // -----------------------------------------------------------------------

  it('isolates channel failures — a broken channel does not block others', async () => {
    // Create a failing telegram channel
    const failingTg: NotificationChannel = {
      name: 'telegram',
      type: 'telegram',
      async deliver() {
        return { ok: false, channel: 'telegram', error: 'API unreachable', deliveredAt: '' };
      },
      async ping() {
        return { ok: true };
      },
    };
    notifier.registerChannel(failingTg); // replaces the healthy one (last-write-wins)

    const handler = vi.fn(() => {
      void notifier.notify(['telegram', 'webhook'], {
        title: 'Test',
        body: 'Webhook should still receive this',
        level: 'info',
        source: 'test',
      });
    });
    const unsub = bus.on('session.ended', handler as never);

    bus.emit('session.ended', {
      id: 'sess_fail',
      usage: { input: 1, output: 1 },
    } as never);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    // Webhook should still succeed despite telegram failure
    expect(webhook.delivered).toHaveLength(1);
    expect(webhook.delivered[0]!.body).toBe('Webhook should still receive this');

    const counters = notifier.counters();
    expect(counters.failed).toBe(1);
    expect(counters.delivered).toBe(1);

    unsub();
  });
});
