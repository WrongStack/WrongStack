/**
 * Tests for MailboxHealthWatchdog.
 *
 * Two surfaces are pinned by these tests:
 *
 *   1. **Alert body snapshot** — `buildDownAlert` and `buildRecoveryAlert`
 *      produce the exact subject + body an external dashboard or alert
 *      consumer parses. Changing these strings is a breaking change for
 *      downstream tooling; the snapshot here is the contract.
 *
 *   2. **Config validation** — `validateWatchdogOptions` rejects
 *      nonsensical configurations (negative interval, timeout ≥
 *      interval, etc.) at startup, not silently after the first probe.
 *
 * The live probing path (`probe()`, `recordFailure()`, `recordSuccess()`)
 * is intentionally NOT exercised here — it depends on `fetch` + real
 * timing, and the existing `mailbox-bridge.test.ts` integration test
 * already covers it end-to-end with a spawned `wstack mailbox serve`
 * child process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAILBOX_HEALTH_DEFAULT_FROM,
  MAILBOX_HEALTH_DEFAULT_INTERVAL_MS,
  MailboxHealthWatchdog,
  buildDownAlert,
  buildRecoveryAlert,
  validateWatchdogOptions,
  type DownAlertInput,
  type MailboxHealthEvent,
  type RecoveryAlertInput,
  type WatchdogConfig,
} from '../../src/coordination/mailbox-health.js';
import type { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';

const downFixture: DownAlertInput = {
  from: 'mailbox-bridge-watchdog',
  url: 'http://127.0.0.1:7788',
  consecutiveFailures: 2,
};

const recoveryFixture: RecoveryAlertInput = {
  from: 'mailbox-bridge-watchdog',
  url: 'http://127.0.0.1:7788',
  downtimeMs: 17_321,
  consecutiveFailures: 2,
};

const validConfig: WatchdogConfig = {
  probeIntervalMs: 15_000,
  probeTimeoutMs: 3_000,
  failureThreshold: 2,
};

describe('buildDownAlert', () => {
  it('produces the exact down-alert subject', () => {
    expect(buildDownAlert(downFixture).subject).toBe(
      'mailbox-bridge-down: HTTP /healthz not responding',
    );
  });

  it('broadcasts to * with type=status and high priority', () => {
    const a = buildDownAlert(downFixture);
    expect(a.from).toBe('mailbox-bridge-watchdog');
    expect(a.to).toBe('*');
    expect(a.type).toBe('status');
    expect(a.priority).toBe('high');
  });

  it('includes the bridge URL and failure count in the body', () => {
    const body = buildDownAlert(downFixture).body;
    expect(body).toContain('http://127.0.0.1:7788');
    expect(body).toContain('2 consecutive /healthz probes');
  });

  it('lists external-agent consequences and remediation', () => {
    const body = buildDownAlert(downFixture).body;
    expect(body).toContain('External agents (Claude Code, Aider, scripts)');
    expect(body).toContain('Fix: re-run');
    expect(body).toContain('wstack mailbox serve');
    expect(body).toContain('/mailbox-serve');
  });

  it('substitutes different failure counts verbatim', () => {
    const body = buildDownAlert({ ...downFixture, consecutiveFailures: 7 }).body;
    expect(body).toContain('7 consecutive');
    expect(body).not.toContain('2 consecutive');
  });
});

describe('buildRecoveryAlert', () => {
  it('includes downtime in the subject as a rounded-second count', () => {
    expect(buildRecoveryAlert(recoveryFixture).subject).toBe(
      'mailbox-bridge-up: recovered after 17s',
    );
  });

  it('broadcasts to * with type=status and normal priority', () => {
    const a = buildRecoveryAlert(recoveryFixture);
    expect(a.from).toBe('mailbox-bridge-watchdog');
    expect(a.to).toBe('*');
    expect(a.type).toBe('status');
    expect(a.priority).toBe('normal');
  });

  it('includes the bridge URL, downtime, and failure count in the body', () => {
    const body = buildRecoveryAlert(recoveryFixture).body;
    expect(body).toContain('http://127.0.0.1:7788');
    expect(body).toContain('Downtime: 17s');
    expect(body).toContain('Consecutive failures before recovery: 2.');
  });

  it('rounds downtime to the nearest second', () => {
    // 999 ms rounds down to 1 s
    expect(buildRecoveryAlert({ ...recoveryFixture, downtimeMs: 999 }).subject).toBe(
      'mailbox-bridge-up: recovered after 1s',
    );
    // 1500 ms rounds to 2 s (banker's rounding aside — Math.round is round-half-up)
    expect(buildRecoveryAlert({ ...recoveryFixture, downtimeMs: 1500 }).subject).toBe(
      'mailbox-bridge-up: recovered after 2s',
    );
  });
});

describe('validateWatchdogOptions', () => {
  it('accepts the default config', () => {
    expect(() => validateWatchdogOptions(validConfig)).not.toThrow();
  });

  it('accepts custom configs within sane bounds', () => {
    expect(() =>
      validateWatchdogOptions({
        probeIntervalMs: 60_000,
        probeTimeoutMs: 5_000,
        failureThreshold: 3,
      }),
    ).not.toThrow();
  });

  it('rejects zero or negative probeIntervalMs', () => {
    expect(() => validateWatchdogOptions({ ...validConfig, probeIntervalMs: 0 })).toThrow(
      /probeIntervalMs must be a positive finite number/,
    );
    expect(() => validateWatchdogOptions({ ...validConfig, probeIntervalMs: -1 })).toThrow(
      /probeIntervalMs must be a positive finite number/,
    );
    expect(() => validateWatchdogOptions({ ...validConfig, probeIntervalMs: Number.NaN })).toThrow(
      /probeIntervalMs must be a positive finite number/,
    );
    expect(() =>
      validateWatchdogOptions({ ...validConfig, probeIntervalMs: Number.POSITIVE_INFINITY }),
    ).toThrow(/probeIntervalMs must be a positive finite number/);
  });

  it('rejects zero or negative probeTimeoutMs', () => {
    expect(() => validateWatchdogOptions({ ...validConfig, probeTimeoutMs: 0 })).toThrow(
      /probeTimeoutMs must be a positive finite number/,
    );
    expect(() => validateWatchdogOptions({ ...validConfig, probeTimeoutMs: -100 })).toThrow(
      /probeTimeoutMs must be a positive finite number/,
    );
  });

  it('rejects probeTimeoutMs >= probeIntervalMs (race condition)', () => {
    expect(() => validateWatchdogOptions({ ...validConfig, probeTimeoutMs: 15_000 })).toThrow(
      /probeTimeoutMs .* must be less than probeIntervalMs/,
    );
    expect(() =>
      validateWatchdogOptions({
        probeIntervalMs: 1_000,
        probeTimeoutMs: 1_000,
        failureThreshold: 2,
      }),
    ).toThrow(/must be less than probeIntervalMs/);
    // 1 ms vs 1 ms — the strict `<` means equality also rejects.
    expect(() =>
      validateWatchdogOptions({
        probeIntervalMs: 1,
        probeTimeoutMs: 1,
        failureThreshold: 2,
      }),
    ).toThrow(/must be less than probeIntervalMs/);
  });

  it('rejects non-positive failureThreshold', () => {
    expect(() => validateWatchdogOptions({ ...validConfig, failureThreshold: 0 })).toThrow(
      /failureThreshold must be a positive integer/,
    );
    expect(() => validateWatchdogOptions({ ...validConfig, failureThreshold: -3 })).toThrow(
      /failureThreshold must be a positive integer/,
    );
    expect(() => validateWatchdogOptions({ ...validConfig, failureThreshold: 1.5 })).toThrow(
      /failureThreshold must be a positive integer/,
    );
  });
});

// ── Live probing path ─────────────────────────────────────────────────────
// The original tests above pin the pure builders + validation. These exercise
// the Watchdog's timer-driven probe/record lifecycle with fake timers + a
// stubbed fetch + a fake mailbox.

function makeMailbox(send?: (m: unknown) => Promise<void>): SqliteMailbox {
  return { send: send ?? (vi.fn(async () => undefined) as never) } as unknown as SqliteMailbox;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('MailboxHealthWatchdog lifecycle', () => {
  it('starts, probes immediately, emits started/stopped, strips trailing slash', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);
    const events: MailboxHealthEvent[] = [];
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(),
      url: 'http://127.0.0.1:7788/',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
      failureThreshold: 2,
      onAlert: (e) => events.push(e),
    });
    await wd.start();
    await flush();
    expect(events[0]).toMatchObject({ kind: 'started', intervalMs: 1000 });
    expect(wd.isRunning()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7788/healthz', expect.anything());
    await wd.stop();
    expect(events.at(-1)).toMatchObject({ kind: 'stopped' });
    expect(wd.isRunning()).toBe(false);
  });

  it('applies documented defaults', () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);
    const wd = new MailboxHealthWatchdog({ mailbox: makeMailbox(), url: 'http://x' });
    expect((wd as unknown as { intervalMs: number }).intervalMs).toBe(
      MAILBOX_HEALTH_DEFAULT_INTERVAL_MS,
    );
    expect((wd as unknown as { from: string }).from).toBe(MAILBOX_HEALTH_DEFAULT_FROM);
  });

  it('start is idempotent and stays stopped after stop (aborted guard)', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
    });
    await wd.start();
    const timerBefore = (wd as unknown as { timer: NodeJS.Timeout }).timer;
    await wd.start(); // no-op (timer already set)
    expect((wd as unknown as { timer: NodeJS.Timeout }).timer).toBe(timerBefore);
    await wd.stop();
    await wd.start(); // aborted -> no-op
    expect(wd.isRunning()).toBe(false);
  });

  it('stop is a no-op when not running', async () => {
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
    });
    await wd.stop();
    expect(wd.isRunning()).toBe(false);
  });
});

describe('MailboxHealthWatchdog probing', () => {
  it('posts a down alert after the failure threshold, then a recovery', async () => {
    const send = vi.fn(async () => undefined);
    fetchMock.mockResolvedValue({ ok: false } as Response); // unhealthy
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(send),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
      failureThreshold: 2,
    });
    await wd.start();
    await flush(); // first probe: cf=1 (below threshold)
    expect(wd.currentFailureStreak).toBe(1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); // second probe: cf=2 -> alert
    expect(wd.isBridgeDown()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1); // postDown
    await vi.advanceTimersByTimeAsync(1000); // third failure while alerting -> no re-post
    expect(send).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValue({ ok: true } as Response);
    await vi.advanceTimersByTimeAsync(1000); // success -> recovery
    expect(wd.isBridgeDown()).toBe(false);
    expect(send).toHaveBeenCalledTimes(2); // postRecovery
    await wd.stop();
  });

  it('treats a thrown fetch as a probe failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const events: MailboxHealthEvent[] = [];
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
      failureThreshold: 5,
      onAlert: (e) => events.push(e),
    });
    await wd.start();
    await flush();
    expect(
      events.some(
        (e) => e.kind === 'probe-failed' && (e as { error?: string }).error === 'network down',
      ),
    ).toBe(true);
    expect(wd.currentFailureStreak).toBe(1);
    await wd.stop();
  });

  it('fires the per-probe abort timeout when fetch hangs', async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((r) => {
        resolveFetch = r;
      }),
    );
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
      failureThreshold: 5,
    });
    await wd.start();
    await flush(); // tick waiting on the hung fetch
    await vi.advanceTimersByTimeAsync(100); // past the per-probe timeout -> abort backstop fires
    resolveFetch?.({ ok: true } as Response); // unstick the probe
    await flush();
    await wd.stop();
  });

  it('skips a probe when the previous one is still in flight', async () => {
    let resolveFetch: ((v: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((r) => {
        resolveFetch = r;
      }),
    );
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
    });
    const tick = (wd as unknown as { tick: () => Promise<void> }).tick.bind(wd);
    const p1 = tick(); // inFlight = true
    const p2 = tick(); // inFlight -> returns immediately
    expect(await p2).toBeUndefined();
    resolveFetch?.({ ok: true } as Response);
    await p1;
  });

  it('swallows a rejecting mailbox.send (best-effort post + recovery)', async () => {
    const send = vi.fn(async () => {
      throw new Error('mailbox down');
    });
    fetchMock.mockResolvedValue({ ok: false } as Response);
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(send),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
      failureThreshold: 1,
    });
    await wd.start();
    await flush(); // first failure -> alert -> postDown rejects -> .catch swallows
    expect(wd.isBridgeDown()).toBe(true);
    fetchMock.mockResolvedValue({ ok: true } as Response);
    await vi.advanceTimersByTimeAsync(1000); // recovery -> postRecovery rejects -> .catch
    expect(wd.isBridgeDown()).toBe(false);
    await wd.stop();
  });

  it('swallows a throwing onAlert observer', async () => {
    fetchMock.mockResolvedValue({ ok: false } as Response);
    const wd = new MailboxHealthWatchdog({
      mailbox: makeMailbox(),
      url: 'http://x',
      probeIntervalMs: 1000,
      probeTimeoutMs: 100,
      failureThreshold: 5,
      onAlert: () => {
        throw new Error('observer boom');
      },
    });
    await wd.start();
    await flush(); // emit() catches the throwing observer
    expect(wd.currentFailureStreak).toBe(1);
    await wd.stop();
  });
});
