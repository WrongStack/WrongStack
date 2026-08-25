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
 *     `localhost:3444` cannot stall the loop.
 *
 * The probe is intentionally minimal: the daemon's `/api/health` response
 * shape is small and stable, so we don't try to parse it — a 2xx is
 * enough to mark the proxy active. Failures (timeout, non-2xx, ECONNREFUSED)
 * are treated as SOFT signals: a single transient failure (daemon mid-
 * restart, one dropped 2xx) must not flip `active` to false and silently
 * disable rewrites for every subsequent request. `active` flips to false
 * only after `deactivateAfterFailures` consecutive failures; the periodic
 * loop keeps retrying, so a recovered daemon re-activates on the next
 * successful probe. Toggle-off (`enabled: false` / no URL) still deactivates
 * immediately.
 */

import { applyProxyConfig, getProxyConfig } from '@wrongstack/core/wiring/proxy-rewrite';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const HEALTH_PATH = '/api/health';
/** Consecutive failures before `active` flips to false (soft-signal threshold). */
const DEFAULT_DEACTIVATE_AFTER_FAILURES = 2;

/**
 * Minimal structural logger for probe transitions. Deliberately not core's
 * full `Logger` so any host (CLI logger, diag subcommand, test stub) can
 * pass a plain object — observability must not hard-require a dependency.
 */
export interface ProbeLogger {
  info(message: string): void;
  warn(message: string): void;
}

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
  /**
   * Number of CONSECUTIVE failed probes required before `active` flips to
   * false. A single transient failure is a soft signal and leaves `active`
   * untouched. Defaults to 2. Useful for tests wanting to exercise the
   * threshold without waiting two ticks.
   */
  deactivateAfterFailures?: number;
}

export interface ProbeRunner {
  /** Stop the periodic probe and abort any in-flight request. */
  stop(): void;
  /** Force an immediate probe (next tick). Resolves with whether the health check succeeded. */
  poke(): Promise<boolean>;
}

let activeRunner: ProbeRunner | undefined;

/**
 * Module-level transition logger so the SINGLETON probe runner can gain a
 * logger after it was booted: `startProxyProbe()` is first called from
 * `applyWrongProxyPrefs` (no logger in scope there), while the CLI logger
 * only becomes available later in boot. `setProxyProbeLogger` updates the
 * LIVE runner too — the closure reads this variable at flip time.
 */
let probeLogger: ProbeLogger | undefined;

/**
 * Install (or replace) the probe's transition logger. Affects the running
 * probe immediately; subsequent `startProxyProbe()` calls inherit it.
 * Passing undefined silences transition logging again.
 */
export function setProxyProbeLogger(logger: ProbeLogger | undefined): void {
  probeLogger = logger;
}

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
  const logger = () => probeLogger;
  // Fires ONLY on an actual active-flag transition. Every flip is a routing
  // change for every subsequent provider build — exactly what an operator
  // grepping wrongstack.log for "is traffic proxied?" needs to see.
  // Fully isolated: a throwing logger must never alter probe control flow
  // (activation logging sits INSIDE runOnce's try block, and toggle-off
  // logging runs inside fire-and-forget poke() chains).
  const logTransition = (next: boolean, reason: string): void => {
    const log = logger();
    if (!log) return;
    // Redact query/fragment: a user-entered proxy URL may embed credentials
    // there, and a log line must never become a secret leak. The reason
    // string deliberately carries NO URL — the sanitized proxy= field does.
    const url = sanitizeUrlForLog(getProxyConfig().url) || '<unset>';
    const line = next
      ? `WrongProxy active=true (${reason}) — base-URL rewrites ON, proxy=${url}`
      : `WrongProxy active=false (${reason}) — base-URL rewrites OFF, proxy=${url}`;
    try {
      if (next) log.info(line);
      else log.warn(line);
    } catch {
      // Observability failure must not corrupt probe state or verdicts.
    }
  };
  // Clamp to a sane threshold: NaN / 0 / negative would break the
  // `consecutiveFailures >= threshold` comparison (never deactivating, or
  // deactivating on every single failure — the exact flap we removed).
  const deactivateAfterFailures =
    typeof opts.deactivateAfterFailures === 'number' &&
    Number.isFinite(opts.deactivateAfterFailures)
      ? Math.max(1, Math.trunc(opts.deactivateAfterFailures))
      : DEFAULT_DEACTIVATE_AFTER_FAILURES;

  const state = {
    currentAbort: undefined as AbortController | undefined,
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    // Consecutive failed probes. Reset on every success; `active` flips to
    // false only once this reaches `deactivateAfterFailures`. A single
    // transient failure is a soft signal and must not disable rewrites.
    consecutiveFailures: 0,
  };

  const runOnce = async (): Promise<boolean> => {
    const cfg = getProxyConfig();
    if (!cfg.enabled || !cfg.url) {
      // Toggle off → ensure we don't claim the proxy is active. Also reset
      // the failure streak so a later re-enable starts from a clean slate
      // instead of immediately deactivating on one stale failure. Abort any
      // in-flight probe so its late result cannot resurrect the flag.
      state.consecutiveFailures = 0;
      if (state.currentAbort) state.currentAbort.abort();
      state.currentAbort = undefined;
      const prev = applyProxyConfig({ active: false });
      if (prev.active) logTransition(false, 'toggle off or URL unset');
      return false;
    }
    // Abort any previous run that's still in flight; this guarantees we
    // never accumulate a queue when toggles flip rapidly.
    if (state.currentAbort) state.currentAbort.abort();
    const abort = new AbortController();
    state.currentAbort = abort;
    // Distinguish a genuine timeout (the 2s deadline fired — a real health
    // failure that accumulates toward deactivation) from an overlapping-poke
    // abort (a newer probe superseded this run — its result is moot).
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
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
      // Discard the verdict if the config this probe started with is no
      // longer live: a toggle-off or URL change mid-flight makes a 2xx from
      // the OLD target irrelevant, and resurrecting `active` from a stale
      // probe would undo the toggle-off above.
      const live = getProxyConfig();
      const stillRelevant = live.enabled && live.url === cfg.url;
      if (stillRelevant) {
        if (ok) {
          // Healthy probe: reset the streak and mark the proxy active. A
          // recovered daemon re-activates on the very next tick, no wait.
          state.consecutiveFailures = 0;
          const prev = applyProxyConfig({ active: true });
          if (!prev.active) logTransition(true, 'health check ok');
        } else {
          // Soft signal: a single non-2xx (daemon mid-restart, one dropped
          // 2xx) must not flip `active` false and silently disable rewrites
          // for every subsequent request. Only N consecutive failures count.
          state.consecutiveFailures += 1;
          if (state.consecutiveFailures >= deactivateAfterFailures) {
            const prev = applyProxyConfig({ active: false });
            if (prev.active) {
              logTransition(
                false,
                `${state.consecutiveFailures} consecutive failed health checks (last: HTTP ${res.status})`,
              );
            }
          }
        }
      }
      return ok;
    } catch {
      // Timeout / ECONNREFUSED / DNS — soft-signal treatment identical to a
      // non-2xx: they accumulate toward the threshold. An OVERLAPPING-POKE
      // abort (the next run superseded this one, or the toggle changed
      // mid-flight) is NOT a health failure and must not accumulate. Same
      // relevancy guard as the success path: a stale probe never counts.
      const live = getProxyConfig();
      const stillRelevant = live.enabled && live.url === cfg.url;
      if (stillRelevant && (timedOut || !abort.signal.aborted)) {
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= deactivateAfterFailures) {
          const prev = applyProxyConfig({ active: false });
          if (prev.active) {
            logTransition(
              false,
              `${state.consecutiveFailures} consecutive failed health checks (last: ${timedOut ? `timeout after ${timeoutMs}ms` : 'network error'})`,
            );
          }
        }
      }
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
 * Redact a URL for logging: keep scheme://host[:port]/path, drop query and
 * fragment. Provider/proxy URLs may embed credentials there (`?key=...`);
 * a wrongstack.log line must never persist them.
 */
export function sanitizeUrlForLog(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Not parseable — log only the pre-query portion, if any.
    const cut = raw.indexOf('?');
    return cut >= 0 ? raw.slice(0, cut) : raw;
  }
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
  probeLogger = undefined;
}