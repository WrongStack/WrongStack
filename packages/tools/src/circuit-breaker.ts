/**
 * CircuitBreaker — prevents runaway bash/exec tool chains by:
 *
 *   - Tripping on consecutive failures (models that keep repeating the
 *     same failing command, e.g. `npm install` with wrong args in a loop)
 *   - Tripping on slow call ratio (too many long-running commands suggest
 *     a hung subprocess that the model doesn't know how to kill)
 *   - Rate-limiting bursts (rapid succession of commands without reading
 *     output suggests the model isn't processing results)
 *   - Auto-recovering after a cooldown period so a fixed model can resume
 *
 * The breaker is owned by the ProcessRegistry so any tool that registers
 * a process participates in the same circuit. "Per-tool" isolation is
 * intentionally NOT implemented — the model treats bash/exec as one
 * resource pool; isolating them would let the model route around the
 * breaker by alternating which tool it uses.
 */

export interface CircuitBreakerConfig {
  /**
   * Consecutive failures before trip. Default: 5.
   * A single success resets this counter to 0.
   */
  maxConsecutiveFailures?: number | undefined;
  /**
   * Slow-call threshold in ms. A call that runs longer than this is
   * counted as "slow". Default: 60_000 (1 minute).
   */
  slowCallThresholdMs?: number | undefined;
  /**
   * Max slow calls before trip (within the sliding window). Default: 3.
   */
  maxSlowCalls?: number | undefined;
  /**
   * Sliding window for rate-limit and slow-call counting, in ms.
   * Default: 60_000 (1 minute).
   */
  windowMs?: number | undefined;
  /**
   * Max calls within the sliding window. Default: 30.
   * Burst exceeding this trips the breaker immediately.
   */
  maxCallsPerWindow?: number | undefined;
  /**
   * Cooldown before auto-recovery attempt, in ms. Default: 30_000 (30s).
   * After this the breaker enters "half-open" state and allows one call
   * through to test whether the problem is resolved.
   */
  cooldownMs?: number | undefined;
}

interface CallRecord {
  at: number;
  /** True if the call threw or returned an is_error result. */
  failed: boolean;
  /** True if elapsed time exceeded slowCallThresholdMs. */
  slow: boolean;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_SLOW_CALL_THRESHOLD_MS = 180_000;
// 3 minutes — balanced against the 5-minute bash timeout. Commands
// running <3min are normal; 3-5min are "slow" and count toward the
// breaker. 3 consecutive slow calls trip the circuit.
const DEFAULT_MAX_SLOW_CALLS = 3;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_CALLS_PER_WINDOW = 30;
const DEFAULT_COOLDOWN_MS = 30_000;

export interface CircuitBreakerSnapshot {
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  slowCallsInWindow: number;
  callsInWindow: number;
  windowMs: number;
  cooldownRemainingMs: number | null;
  lastFailureAt: number | null;
  lastSlowAt: number | null;
}

export class CircuitBreaker {
  private readonly maxConsecutiveFailures: number;
  private readonly slowCallThresholdMs: number;
  private readonly maxSlowCalls: number;
  private readonly windowMs: number;
  private readonly maxCallsPerWindow: number;
  private readonly cooldownMs: number;

  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private window: CallRecord[] = [];
  private lastFailureAt: number | null = null;
  private lastSlowAt: number | null = null;
  /** Timestamp when the breaker was opened (for cooldown calculation). */
  private openedAt: number | null = null;

  /**
   * Master enable flag. When false the breaker is bypassed: `beforeCall`
   * always returns true and `afterCall` records nothing. The class itself
   * defaults to enabled (so the standalone unit tests exercise tripping); the
   * ProcessRegistry flips this off until the user opts in via `/settings`.
   */
  private enabled = true;

  /**
   * Fired (best-effort) when the breaker transitions into the `open` state.
   * The registry uses this to arm its auto kill/reset countdown.
   */
  onTrip?: (() => void) | undefined;
  /**
   * Fired (best-effort) when the breaker returns to `closed` after having been
   * open/half-open. The registry uses this to cancel a pending kill/reset.
   */
  onReset?: (() => void) | undefined;

  constructor(config: CircuitBreakerConfig = {}) {
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.slowCallThresholdMs = config.slowCallThresholdMs ?? DEFAULT_SLOW_CALL_THRESHOLD_MS;
    this.maxSlowCalls = config.maxSlowCalls ?? DEFAULT_MAX_SLOW_CALLS;
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxCallsPerWindow = config.maxCallsPerWindow ?? DEFAULT_MAX_CALLS_PER_WINDOW;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /** Toggle the master enable. Disabling resets to a clean `closed` state. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this._reset();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Returns true if the circuit allows a new call to proceed.
   * When false, callers should abort the tool call and return a
   * circuit-breaker error instead of spawning a process.
   */
  get canProceed(): boolean {
    if (!this.enabled) return true;
    this._checkStateTransition();
    return this.state !== 'open';
  }

  /**
   * Snapshot of the current breaker state for observability (`/kill`).
   */
  snapshot(): CircuitBreakerSnapshot {
    this._checkStateTransition();
    const now = Date.now();
    let cooldownRemaining: number | null = null;
    if (this.openedAt !== null && this.state === 'open') {
      const elapsed = now - this.openedAt;
      cooldownRemaining = Math.max(0, this.cooldownMs - elapsed);
    }
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      slowCallsInWindow: this.window.filter((c) => c.slow).length,
      callsInWindow: this.window.length,
      windowMs: this.windowMs,
      cooldownRemainingMs: cooldownRemaining,
      lastFailureAt: this.lastFailureAt,
      lastSlowAt: this.lastSlowAt,
    };
  }

  /**
   * Call this BEFORE spawning a bash/exec process.
   * Returns true if the call is allowed; false if the breaker is open.
   * When false, callers MUST NOT spawn a process.
   *
   * @param bypass - If true, skip the circuit breaker check entirely.
   *                  Use for background/fire-and-forget processes that should
   *                  not affect breaker state.
   */
  beforeCall(bypass = false): boolean {
    if (bypass || !this.enabled) return true;
    this._checkStateTransition();
    if (this.state === 'open') return false;
    return true;
  }

  /**
   * Call this AFTER a bash/exec process finishes (success or failure).
   * `durationMs` is the wall-clock time the process ran.
   * `failed` is true when the process returned a non-zero exit code or
   * threw an exception before spawning.
   *
   * @param bypass - If true, do not update breaker state.
   *                  Use for background/fire-and-forget processes.
   */
  afterCall(durationMs: number, failed: boolean, bypass = false): void {
    if (bypass || !this.enabled) return;

    const now = Date.now();

    if (this.state === 'half-open') {
      // First call through after cooldown — if it failed, go back to open.
      if (failed) {
        this._trip();
        return;
      }
      // Success in half-open → reset to closed.
      this._reset();
      return;
    }

    // Prune old records outside the sliding window.
    this._pruneWindow(now);

    const slow = durationMs >= this.slowCallThresholdMs;
    this.window.push({ at: now, failed, slow });

    if (failed) {
      this.consecutiveFailures++;
      this.lastFailureAt = now;
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this._trip();
      }
      return;
    }

    // Success: reset consecutive failure counter.
    this.consecutiveFailures = 0;

    if (slow) {
      this.lastSlowAt = now;
      const slowCount = this.window.filter((c) => c.slow).length;
      if (slowCount >= this.maxSlowCalls) {
        this._trip();
      }
    }

    const callCount = this.window.length;
    if (callCount >= this.maxCallsPerWindow) {
      // Rate limit exceeded. This is a soft trip — we reset the window
      // and let the next call try immediately (the caller will still see
      // canProceed=false until the window drains naturally).
      this._trip();
    }
  }

  /** Force the breaker open. Used by /kill force and Ctrl+C. */
  forceOpen(): void {
    this._trip();
  }

  /** Force a reset to closed. Used by tests and /kill reset. */
  forceReset(): void {
    this._reset();
  }

  private _trip(): void {
    if (this.state === 'open') return; // already open
    this.state = 'open';
    this.openedAt = Date.now();
    // P3 #23 (before-release.md): clear the window on trip. Old records are
    // irrelevant once tripped — the breaker starts fresh after cooldown
    // (half-open → closed resets the counters). Without this the window array
    // holds onto CallRecord entries for its lifetime if no new afterCall()
    // arrives (which is the case when the breaker stays open and no new calls
    // are attempted).
    this.window = [];
    // Best-effort: never let a listener failure corrupt breaker state.
    try {
      this.onTrip?.();
    } catch {
      /* ignored — observability hook only */
    }
  }

  private _reset(): void {
    const wasRecovering = this.state !== 'closed';
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.window = [];
    this.openedAt = null;
    // Only notify on a real recovery (open/half-open → closed), not on the
    // initial closed state or an idempotent re-reset.
    if (wasRecovering) {
      try {
        this.onReset?.();
      } catch {
        /* ignored — observability hook only */
      }
    }
  }

  /** Transition from open → half-open when cooldown elapses. */
  private _checkStateTransition(): void {
    if (this.state !== 'open' || this.openedAt === null) return;
    const elapsed = Date.now() - this.openedAt;
    if (elapsed >= this.cooldownMs) {
      this.state = 'half-open';
      this.openedAt = null;
    }
  }

  private _pruneWindow(now: number): void {
    const cutoff = now - this.windowMs;
    this.window = this.window.filter((c) => c.at >= cutoff);
  }
}
