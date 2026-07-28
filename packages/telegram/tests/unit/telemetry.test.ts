// ---------------------------------------------------------------------------
// P3.1 — Telemetry redaction tests
//
// Verifies that the TelegramTelemetry snapshot and its log output contain
// only bounded metrics (counters, gauges) and never embed message bodies,
// usernames, callback tokens, secrets, or other PII.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { TelegramTelemetry, bumpCounter, observeHistogram } from '../../src/telemetry.js';

describe('TelegramTelemetry redaction', () => {
  it('starts with zero-value counters and gauges', () => {
    const t = new TelegramTelemetry();
    const s = t.snapshot;

    // All counters start at 0
    expect(s.poll.success.count).toBe(0);
    expect(s.poll.failure.count).toBe(0);
    expect(s.updates.received.count).toBe(0);
    expect(s.updates.accepted.count).toBe(0);
    expect(s.updates.rejected.count).toBe(0);
    expect(s.updates.callbacks.count).toBe(0);
    expect(s.updates.deduplicated.count).toBe(0);
    expect(s.retry.attempts.count).toBe(0);
    expect(s.retry.rateLimited.count).toBe(0);
    expect(s.retry.terminalErrors.count).toBe(0);
    expect(s.queue.enqueued.count).toBe(0);
    expect(s.queue.sent.count).toBe(0);
    expect(s.queue.dropped.count).toBe(0);
    expect(s.queue.failures.count).toBe(0);
    expect(s.approvals.created.count).toBe(0);
    expect(s.approvals.timedOut.count).toBe(0);
    expect(s.approvals.cancelled.count).toBe(0);
    expect(s.approvals.settled.count).toBe(0);
    expect(s.locks.acquireAttempts.count).toBe(0);
    expect(s.locks.acquires.count).toBe(0);
    expect(s.locks.lost.count).toBe(0);
    expect(s.locks.releases.count).toBe(0);

    // All gauges start at 0
    expect(s.poll.conflictStreak.value).toBe(0);
    expect(s.queue.inflight.value).toBe(0);
    expect(s.queue.pending.value).toBe(0);
    expect(s.locks.held.value).toBe(0);

    // Histogram starts empty
    expect(s.poll.latencyMs.count).toBe(0);
  });

  it('bumpCounter increments count and updates lastAt', () => {
    const t = new TelegramTelemetry();
    bumpCounter(t.snapshot.poll.success);
    expect(t.snapshot.poll.success.count).toBe(1);
    expect(t.snapshot.poll.success.lastAt).toBeTruthy();
  });

  it('observeHistogram tracks min/max/sum/count', () => {
    const t = new TelegramTelemetry();
    observeHistogram(t.snapshot.poll.latencyMs, 100);
    observeHistogram(t.snapshot.poll.latencyMs, 200);
    expect(t.snapshot.poll.latencyMs.count).toBe(2);
    expect(t.snapshot.poll.latencyMs.min).toBe(100);
    expect(t.snapshot.poll.latencyMs.max).toBe(200);
    expect(t.snapshot.poll.latencyMs.sum).toBe(300);
  });

  it('snapshot contains no PII fields', () => {
    const t = new TelegramTelemetry();
    const json = JSON.stringify(t.snapshot);

    // No message text, usernames, tokens, callback data, or secrets
    expect(json).not.toContain('message');
    expect(json).not.toContain('username');
    expect(json).not.toContain('firstName');
    expect(json).not.toContain('callback_data');
    expect(json).not.toContain('bot_token');
    expect(json).not.toContain('secret');
    expect(json).not.toContain('password');
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('token');

    // Verify the snapshot shape — only safe numeric types
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.generatedAt).toBeTypeOf('string');
    expect(parsed.poll).toBeTypeOf('object');
    expect(parsed.updates).toBeTypeOf('object');
    expect(parsed.retry).toBeTypeOf('object');
    expect(parsed.queue).toBeTypeOf('object');
    expect(parsed.approvals).toBeTypeOf('object');
    expect(parsed.locks).toBeTypeOf('object');
  });

  it('logSnapshot output contains only counters, never raw values', () => {
    const t = new TelegramTelemetry();

    // Simulate some activity
    bumpCounter(t.snapshot.poll.success);
    bumpCounter(t.snapshot.poll.success);
    bumpCounter(t.snapshot.poll.failure);
    bumpCounter(t.snapshot.updates.accepted);
    bumpCounter(t.snapshot.updates.rejected);
    bumpCounter(t.snapshot.retry.attempts);
    bumpCounter(t.snapshot.queue.dropped);

    // The log output must be a string with key=value pairs, no PII
    const lines: string[] = [];
    const fakeLog = {
      level: 'debug' as const,
      info: (msg: string) => {
        lines.push(msg);
      },
      warn: (_msg: string) => {},
      error: (_msg: string) => {},
      debug: (_msg: string) => {},
      trace: (_msg: string) => {},
      child() {
        return this;
      },
    };

    t.logSnapshot(fakeLog);
    expect(lines.length).toBe(1);

    const logLine = lines[0]!;
    // Should start with the metrics marker
    expect(logLine).toMatch(/^\[telegram\.metrics\]/);
    // Every value should be a number
    const valueMatches = logLine.matchAll(/[a-z_]+=(\S+)/g);
    for (const match of valueMatches) {
      const value = match[1]!;
      // Values are either a number or a fraction like "2/3"
      expect(value).toMatch(/^\d+(\/\d+)?$/);
    }
    // Must NOT contain any string fields that could be PII
    expect(logLine).not.toMatch(/message|username|token|secret|password|apiKey|callback/);
  });
});
