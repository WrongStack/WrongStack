/**
 * Unit tests for WebhookNotificationChannel.
 *
 * Tests use a mock `fetch` to simulate HTTP responses without network I/O.
 * The class is instantiated directly (no plugin setup needed) so each test
 * has full control over the configuration and circuit breaker state.
 *
 * @module notify-hub
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationMessage } from '@wrongstack/core/notifications';
import { WebhookNotificationChannel } from '../src/notify-hub/webhook-channel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_MSG: NotificationMessage = {
  title: 'Test',
  body: 'Hello from the webhook test suite',
  level: 'info',
  source: 'test:webhook-channel',
};

const WEBHOOK_URL = 'https://hooks.example.com/hook';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constructor / identity
// ---------------------------------------------------------------------------

describe('WebhookNotificationChannel identity', () => {
  it('has name "webhook" and type "webhook"', () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    expect(ch.name).toBe('webhook');
    expect(ch.type).toBe('webhook');
  });
});

// ---------------------------------------------------------------------------
// Delivery (deliver)
// ---------------------------------------------------------------------------

describe('deliver', () => {
  it('POSTs JSON to the configured webhook URL', async () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    const result = await ch.deliver(SAMPLE_MSG);

    expect(result.ok).toBe(true);
    expect(result.channel).toBe('webhook');
    expect(result.deliveredAt).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(WEBHOOK_URL);
    expect((init as RequestInit).method).toBe('POST');

    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['source']).toBe('wrongstack/notify-hub');
    expect(body['event']).toBe('test:webhook-channel');
    expect(body['title']).toBe('Test');
    expect(body['message']).toBe('Hello from the webhook test suite');
    expect(body['level']).toBe('info');
  });

  it('sends extra headers', async () => {
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      headers: { authorization: 'Bearer tok', 'x-custom': 'val' },
    });
    await ch.deliver(SAMPLE_MSG);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-custom']).toBe('val');
    expect(headers['content-type']).toBe('application/json');
  });

  it('includes metadata in the JSON body', async () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    const msg: NotificationMessage = {
      ...SAMPLE_MSG,
      metadata: { durationMs: 1234, ok: true },
    };
    await ch.deliver(msg);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['durationMs']).toBe(1234);
    expect(body['ok']).toBe(true);
  });

  it('returns ok:false when the webhook responds with a non-2xx status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    const result = await ch.deliver(SAMPLE_MSG);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns ok:false and a descriptive error on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    const result = await ch.deliver(SAMPLE_MSG);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('survives a timeout and returns ok:false', async () => {
    // Simulate a timeout by having the mock listen to the abort signal
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          }
        }),
    );
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      timeoutMs: 50,
    });
    const result = await ch.deliver(SAMPLE_MSG);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
  });

  it('uses the configured timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          }
        }),
    );

    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      timeoutMs: 100,
    });
    const result = await ch.deliver(SAMPLE_MSG);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
  });

  it('never throws — all errors are returned as results', async () => {
    fetchMock.mockRejectedValue(new Error('any error'));
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    // Should not reject — should return a result with ok: false
    const result = await ch.deliver(SAMPLE_MSG);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe('circuit breaker', () => {
  it('starts closed', () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    const cs = ch.circuitStatus();
    expect(cs.open).toBe(false);
    expect(cs.consecutiveFailures).toBe(0);
  });

  it('opens after maxConsecutiveFailures', async () => {
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      maxConsecutiveFailures: 2,
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    // First failure — circuit still closed
    const r1 = await ch.deliver(SAMPLE_MSG);
    expect(r1.ok).toBe(false);
    expect(ch.circuitStatus().open).toBe(false);
    expect(ch.circuitStatus().consecutiveFailures).toBe(1);

    // Second failure — circuit opens
    const r2 = await ch.deliver(SAMPLE_MSG);
    expect(r2.ok).toBe(false);
    expect(ch.circuitStatus().open).toBe(true);
    expect(ch.circuitStatus().consecutiveFailures).toBe(2);

    // Third attempt — suppressed by circuit breaker, no HTTP call
    const r3 = await ch.deliver(SAMPLE_MSG);
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('circuit open');
    expect(fetchMock).toHaveBeenCalledTimes(2); // no third call
  });

  it('resets on successful delivery', async () => {
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      maxConsecutiveFailures: 2,
    });

    // Fail once
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await ch.deliver(SAMPLE_MSG);
    expect(ch.circuitStatus().consecutiveFailures).toBe(1);

    // Succeed — resets the counter
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const r = await ch.deliver(SAMPLE_MSG);
    expect(r.ok).toBe(true);
    expect(ch.circuitStatus().open).toBe(false);
    expect(ch.circuitStatus().consecutiveFailures).toBe(0);
  });

  it('can be manually reset with resetCircuit()', async () => {
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      maxConsecutiveFailures: 1,
    });

    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await ch.deliver(SAMPLE_MSG);
    expect(ch.circuitStatus().open).toBe(true);

    ch.resetCircuit();
    expect(ch.circuitStatus().open).toBe(false);
    expect(ch.circuitStatus().consecutiveFailures).toBe(0);

    // After reset, delivery succeeds again
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const r = await ch.deliver(SAMPLE_MSG);
    expect(r.ok).toBe(true);
  });

  it('does not suppress when maxConsecutiveFailures is 0 (disabled)', async () => {
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      maxConsecutiveFailures: 0,
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    // 10 failures — circuit breaker should never open
    for (let i = 0; i < 10; i++) {
      await ch.deliver(SAMPLE_MSG);
    }
    expect(ch.circuitStatus().open).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('auto-recovers after the cooldown and retries a recovered endpoint', async () => {
    vi.useFakeTimers();
    try {
      const ch = new WebhookNotificationChannel({
        webhookUrl: WEBHOOK_URL,
        maxConsecutiveFailures: 2,
        circuitResetMs: 1000,
      });

      // Fail twice — circuit opens.
      fetchMock.mockResolvedValue({ ok: false, status: 503 });
      await ch.deliver(SAMPLE_MSG);
      await ch.deliver(SAMPLE_MSG);
      expect(ch.circuitStatus().open).toBe(true);

      // Still inside the cooldown — suppressed, no HTTP call.
      const suppressed = await ch.deliver(SAMPLE_MSG);
      expect(suppressed.ok).toBe(false);
      expect(suppressed.error).toContain('circuit open');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Advance past the cooldown; the endpoint is now healthy.
      vi.advanceTimersByTime(1001);
      fetchMock.mockResolvedValue({ ok: true, status: 200 });

      // Delivery falls through to a real probe and succeeds (breaker resets).
      const recovered = await ch.deliver(SAMPLE_MSG);
      expect(recovered.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(ch.circuitStatus().open).toBe(false);
      expect(ch.circuitStatus().consecutiveFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

describe('counters', () => {
  it('starts at zero', () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    const c = ch.counters();
    expect(c).toEqual({ attempted: 0, delivered: 0, failed: 0, suppressed: 0 });
  });

  it('increments on success', async () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    await ch.deliver(SAMPLE_MSG);
    const c = ch.counters();
    expect(c.attempted).toBe(1);
    expect(c.delivered).toBe(1);
    expect(c.failed).toBe(0);
  });

  it('increments on failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    await ch.deliver(SAMPLE_MSG);
    const c = ch.counters();
    expect(c.attempted).toBe(1);
    expect(c.delivered).toBe(0);
    expect(c.failed).toBe(1);
  });

  it('increments suppressed when circuit is open', async () => {
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      maxConsecutiveFailures: 1,
    });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await ch.deliver(SAMPLE_MSG); // fail #1 → circuit opens
    await ch.deliver(SAMPLE_MSG); // suppressed
    await ch.deliver(SAMPLE_MSG); // suppressed

    const c = ch.counters();
    expect(c.attempted).toBe(1); // only 1 actual HTTP attempt
    expect(c.delivered).toBe(0);
    expect(c.failed).toBe(1);
    expect(c.suppressed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

describe('ping', () => {
  it('returns ok:true when the circuit is closed and URL is set', async () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: WEBHOOK_URL });
    const result = await ch.ping();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with circuit-open message when circuit is open', async () => {
    const ch = new WebhookNotificationChannel({
      webhookUrl: WEBHOOK_URL,
      maxConsecutiveFailures: 1,
    });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await ch.deliver(SAMPLE_MSG); // opens the circuit

    const result = await ch.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('circuit open');
  });

  it('returns ok:false when no webhookUrl is configured', async () => {
    const ch = new WebhookNotificationChannel({ webhookUrl: '' });
    const result = await ch.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no webhookUrl');
  });
});
