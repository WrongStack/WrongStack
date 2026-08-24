/**
 * Periodic health probe for the local WrongProxy / WrongTrace daemon.
 *
 * The daemon exposes `GET <base>/api/health` returning JSON like:
 *   { "repo": "WrongTrace", "status": "ok", "timestamp": "...", ... }
 *
 * The probe:
 *  1. Runs once on boot so the first request doesn't hit a dead proxy.
 *  2. Re-runs every `intervalMs` (default 30s) while the toggle is on.
 *  3. Aborts in-flight probes on every state change so we never accumulate
 *     a backlog when the user toggles the proxy on/off rapidly.
 *  4. Uses a small per-call AbortController + timeout (2s) so a hung
 *     `localhost:8000` cannot stall the loop.
 *
 * The probe is intentionally minimal: the daemon's `/api/health` response
 * shape is small and stable, so we don't try to parse it — a 2xx is
 * enough to mark the proxy active. Failures (timeout, non-2xx, ECONNREFUSED)
 * flip `active` to false and the rewriter leaves base URLs alone.
 */

import { applyProxyConfig, getProxyConfig } from '@wrongstack/core/wiring/proxy-rewrite';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const HEALTH_PATH = '/api/health';

interface ProbeRunnerOptions {
  /** Override the default interval (30s). Useful for tests. */
  intervalMs?: number;
  /** Override the default per-request timeout (2s). Useful for tests. */
  timeoutMs?: number;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Override `setInterval` / `clearInterval` for tests. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface ProbeRunner {
  /** Stop the periodic probe and abort any in-flight request. */
  stop(): void;
  /** Force an immediate probe (next tick). Returns the new active state. */
  poke(): Promise<boolean>;
}

let activeRunner: ProbeRunner | undefined;

/**
 * Start the probe loop. Idempotent — repeated calls reuse the existing
 * runner unless `stop()` was called in between.
 */
export function startProxyProbe(opts: ProbeRunnerOptions = {}): ProbeRunner {
  if (activeRunner) {
    // Re-apply current prefs so a config change between boots still wins.
    scheduleImmediateProbe(activeRunner);
    return activeRunner;
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const setIntervalImpl = opts.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval;

  const state = {
    currentAbort: undefined as AbortController | undefined,
    timer: undefined as ReturnType<typeof setInterval> | undefined,
  };

  const runOnce = async (): Promise<boolean> => {
    const cfg = getProxyConfig();
    if (!cfg.enabled || !cfg.url) {
      // Toggle off → ensure we don't claim the proxy is active.
      applyProxyConfig({ active: false });
      return false;
    }
    // Abort any previous run that's still in flight; this guarantees we
    // never accumulate a queue when toggles flip rapidly.
    if (state.currentAbort) state.currentAbort.abort();
    const abort = new AbortController();
    state.currentAbort = abort;
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    if (typeof (timeout as { unref?: () => void }).unref === 'function') {
      (timeout as { unref: () => void }).unref();
    }
    try {
      const healthUrl = buildHealthUrl(cfg.url);
      const res = await fetchImpl(healthUrl, {
        method: 'GET',
        signal: abort.signal,
        headers: { accept: 'application/json' },
      });
      const ok = res.ok && res.status >= 200 && res.status < 300;
      applyProxyConfig({ active: ok });
      return ok;
    } catch {
      // Timeout / ECONNREFUSED / DNS — anything other than a clean 2xx
      // counts as inactive. AbortError is the common case here.
      applyProxyConfig({ active: false });
      return false;
    } finally {
      clearTimeout(timeout);
      if (state.currentAbort === abort) state.currentAbort = undefined;
    }
  };

  const runner: ProbeRunner = {
    stop(): void {
      if (state.timer !== undefined) {
        clearIntervalImpl(state.timer);
        state.timer = undefined;
      }
      if (state.currentAbort) {
        state.currentAbort.abort();
        state.currentAbort = undefined;
      }
      activeRunner = undefined;
    },
    poke: runOnce,
  };

  // First run: schedule, don't block the caller.
  scheduleImmediateProbe(runner);
  state.timer = setIntervalImpl(() => {
    void runOnce();
  }, intervalMs);
  if (state.timer && typeof (state.timer as { unref?: () => void }).unref === 'function') {
    (state.timer as { unref: () => void }).unref();
  }

  activeRunner = runner;
  return runner;
}

function scheduleImmediateProbe(runner: ProbeRunner): void {
  // Fire-and-forget; the runner doesn't block the caller.
  void runner.poke();
}

function buildHealthUrl(rawBase: string): string {
  // Normalize trailing slash + append /api/health if the user gave us
  // a bare origin. If they gave us a deeper base, respect it but still
  // append the canonical health path segment.
  const trimmed = rawBase.trim().replace(/\/+$/, '');
  return `${trimmed}${HEALTH_PATH}`;
}

/**
 * Stop any running probe. Safe to call when nothing is running.
 */
export function stopProxyProbe(): void {
  if (activeRunner) activeRunner.stop();
}

/** Test-only: clear module state without touching timers. */
export function __resetProxyProbeForTests(): void {
  activeRunner = undefined;
}