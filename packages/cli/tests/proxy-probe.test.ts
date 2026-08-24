/**
 * Unit tests for the WrongProxy / WrongTrace health probe's soft-signal
 * active-flag semantics (packages/cli/src/wiring/proxy-probe.ts).
 *
 * Regression guard for the "active-flag flap": a single transient /api/health
 * failure used to flip `active` to false immediately, silently disabling
 * rewrites for every subsequent request until the next tick recovered it.
 * The probe now treats failures as SOFT signals — `active` flips to false
 * only after `deactivateAfterFailures` consecutive failures, a success resets
 * the counter, and toggling the proxy off still deactivates immediately.
 *
 * Notes on the harness:
 *  - `startProxyProbe` auto-fires one probe on start (scheduleImmediateProbe),
 *    so every test's `fetchImpl` queue leads with the auto-poke response and
 *    the test's own `runner.poke()` calls consume the rest.
 *  - `startProxyProbe` is a module-level singleton — `stopProxyProbe()` in
 *    afterEach guarantees each test builds a fresh runner with its own fetch.
 *  - `applyProxyConfig`/`getProxyConfig` come from the REAL core module so
 *    the assertions observe the same singleton the probe writes to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProxyConfig,
  getProxyConfig,
  __resetProxyConfigForTests,
} from '@wrongstack/core/wiring/proxy-rewrite';
import {
  startProxyProbe,
  stopProxyProbe,
  type ProbeRunner,
} from '../src/wiring/proxy-probe.js';

/** Disable the periodic interval so no tick interferes with explicit pokes. */
const NO_INTERVAL = {
  setIntervalImpl: (() => 0) as unknown as typeof setInterval,
  clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
};

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

function failResponse(): Response {
  return { ok: false, status: 503 } as Response;
}

/**
 * A fetch that never resolves until its AbortSignal fires (like a real
 * network call against a hung daemon): rejects with AbortError on abort.
 */
function hangOnAbort(): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')),
      );
    });
  }) as typeof fetch;
}

describe('proxy-probe soft-signal active flag', () => {
  beforeEach(() => {
    __resetProxyConfigForTests();
  });

  afterEach(() => {
    stopProxyProbe();
    __resetProxyConfigForTests();
  });

  it('keeps active=true after a single transient non-2xx failure', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse()) // auto-poke on start
      .mockResolvedValueOnce(failResponse()); // explicit poke → soft failure
    const runner: ProbeRunner = startProxyProbe({ ...NO_INTERVAL, fetchImpl });

    const result = await runner.poke();
    expect(result).toBe(false); // the health check itself failed…
    expect(getProxyConfig().active).toBe(true); // …but active is NOT flipped
  });

  it('deactivates only after N consecutive failures', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse()) // auto-poke
      .mockResolvedValueOnce(failResponse()) // streak 1
      .mockResolvedValueOnce(failResponse()); // streak 2 → deactivate
    const runner: ProbeRunner = startProxyProbe({
      ...NO_INTERVAL,
      fetchImpl,
      deactivateAfterFailures: 2,
    });

    await runner.poke();
    expect(getProxyConfig().active).toBe(true);

    await runner.poke();
    expect(getProxyConfig().active).toBe(false);
  });

  it('recovers: a success resets the counter and re-activates immediately', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse()) // auto-poke
      .mockResolvedValueOnce(failResponse()) // streak 1
      .mockResolvedValueOnce(failResponse()) // streak 2 → deactivate
      .mockResolvedValueOnce(okResponse()) // daemon recovered → reset + active
      .mockResolvedValueOnce(failResponse()); // single failure after recovery → soft
    const runner: ProbeRunner = startProxyProbe({
      ...NO_INTERVAL,
      fetchImpl,
      deactivateAfterFailures: 2,
    });

    await runner.poke();
    await runner.poke();
    expect(getProxyConfig().active).toBe(false);

    await runner.poke();
    expect(getProxyConfig().active).toBe(true);

    // The success reset the streak, so one new failure is soft again —
    // exactly the flap we removed (daemon blips must not cascade).
    await runner.poke();
    expect(getProxyConfig().active).toBe(true);
  });

  it('deactivates immediately on toggle-off and does not fetch', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse()) // auto-poke while still enabled
      .mockResolvedValueOnce(okResponse()); // (safety) — should NOT be consumed
    const runner: ProbeRunner = startProxyProbe({ ...NO_INTERVAL, fetchImpl });

    applyProxyConfig({ enabled: false });
    const result = await runner.poke();
    expect(result).toBe(false);
    expect(getProxyConfig().active).toBe(false);
    // Toggle-off path returns before any fetch — only the auto-poke ran.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('counts a genuine timeout as a failure (timedOut is not an overlap abort)', async () => {
    vi.useFakeTimers();
    try {
      applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
      const fetchImpl = hangOnAbort();
      const runner: ProbeRunner = startProxyProbe({
        ...NO_INTERVAL,
        fetchImpl,
        timeoutMs: 25,
      });

      // Auto-poke hangs; advance past the 25ms deadline → genuine timeout.
      await vi.advanceTimersByTimeAsync(30);
      expect(getProxyConfig().active).toBe(true); // streak 1 — still soft

      // Second probe also times out → streak 2 → deactivate.
      const second = runner.poke();
      await vi.advanceTimersByTimeAsync(30);
      await second;
      expect(getProxyConfig().active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count an overlapping-poke abort as a failure', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const hang = hangOnAbort();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => hang('http://localhost:3444/api/health'))
      .mockResolvedValueOnce(okResponse()); // explicit poke succeeds
    const runner: ProbeRunner = startProxyProbe({ ...NO_INTERVAL, fetchImpl });

    // The explicit poke aborts the still-in-flight auto-poke — a superseded
    // probe, not a health failure — then succeeds.
    const result = await runner.poke();
    expect(result).toBe(true);
    expect(getProxyConfig().active).toBe(true);

    // The abort did NOT count toward the streak: a following single failure
    // is still soft (would have deactivated if the abort had accumulated).
    fetchImpl.mockResolvedValueOnce(failResponse());
    await runner.poke();
    expect(getProxyConfig().active).toBe(true);
  });

  it('clamps invalid deactivateAfterFailures values to a sane threshold', async () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    // NaN would make `streak >= NaN` always false (never deactivate);
    // 0/negative would deactivate on every single failure (the original flap).
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse()) // auto-poke
      .mockResolvedValueOnce(failResponse()) // single failure → must be soft
      .mockResolvedValueOnce(failResponse()); // second failure → deactivate
    const runner: ProbeRunner = startProxyProbe({
      ...NO_INTERVAL,
      fetchImpl,
      deactivateAfterFailures: Number.NaN,
    });

    await runner.poke();
    expect(getProxyConfig().active).toBe(true);

    await runner.poke();
    expect(getProxyConfig().active).toBe(false);
  });
});