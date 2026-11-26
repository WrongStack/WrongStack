/**
 * Circuit breaker for the codebase indexer.
 *
 * The indexer can wedge: a hung filesystem, a parser pathology, or another
 * wstack process holding the SQLite write lock (several surfaces — TUI, WebUI,
 * parallel terminals — share one per-project `index.db`). Without protection,
 * every queued reindex piles up behind the process-wide mutex, `isIndexing()`
 * stays true forever, and anything that awaits an index run (the startup scan,
 * `/codebase-reindex`) locks its terminal.
 *
 * Standard three-state breaker:
 *
 *   closed    — normal operation; consecutive failures are counted.
 *   open      — after `failureThreshold` consecutive failures, every request
 *               is rejected fast ({@link CircuitOpenError}) for `cooldownMs`.
 *   half-open — after the cooldown exactly one probe run is admitted;
 *               success closes the circuit, failure re-opens it.
 *
 * Watchdog timeouts ({@link IndexTimeoutError}) count as failures;
 * caller-initiated aborts (session teardown) do not — the background indexer
 * makes that distinction before recording.
 *
 * Lock conflicts ({@link LockError}) do NOT count as failures — they are expected
 * transient conditions when multiple wstack surfaces share the same `index.db`.
 * The index store retries automatically; a LockError only reaches the circuit
 * breaker when all retries are exhausted.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailure: string | null;
  /** ms until an open circuit admits a half-open probe (0 unless open). */
  cooldownRemainingMs: number;
}

/** Thrown when a run is rejected because the circuit is open. */
export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
}

/** Thrown by the background indexer's watchdog when a run exceeds its timeout. */
export class IndexTimeoutError extends Error {
  override readonly name = 'IndexTimeoutError';
}

/**
 * Thrown when an SQLite operation fails with a lock conflict (SQLITE_BUSY or
 * SQLITE_LOCKED) even after all retry attempts are exhausted.
 *
 * The circuit breaker does **not** count `LockError` as a failure — a lock
 * conflict means another writer is active, not that this indexer is broken.
 * The caller should treat it as a transient failure and retry later.
 */
export class LockError extends Error {
  override readonly name = 'LockError';
}

/**
 * One admitted run. Pass it back to recordSuccess/recordFailure/abandonProbe:
 * only the half-open probe's own admission may free the probe slot. A run
 * admitted earlier, while the circuit was closed, can settle during the probe
 * (it was queued behind the index mutex) and must not admit a second probe.
 */
export interface CircuitAdmission {
  /** Set only for the half-open probe; identifies which probe it was. */
  readonly probeId: number | null;
}

interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. Default: 3. */
  failureThreshold?: number | undefined;
  /** How long an open circuit rejects requests before allowing a probe. Default: 60s. */
  cooldownMs?: number | undefined;
  /** Injectable clock for tests. Default: Date.now. */
  now?: (() => number) | undefined;
}

export class IndexCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private lastFailure: string | null = null;
  /** The half-open probe in flight, or null. */
  private probeId: number | null = null;
  private nextProbeId = 1;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold =
      typeof opts.failureThreshold === 'number' &&
      Number.isFinite(opts.failureThreshold) &&
      opts.failureThreshold >= 1
        ? Math.trunc(opts.failureThreshold)
        : 3;
    this.cooldownMs =
      typeof opts.cooldownMs === 'number' &&
      Number.isFinite(opts.cooldownMs) &&
      opts.cooldownMs >= 0
        ? opts.cooldownMs
        : 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * True when a run may proceed. An open circuit transitions to half-open once
   * the cooldown has elapsed, admitting exactly one probe; further requests
   * are rejected until that probe settles via recordSuccess/recordFailure.
   */
  allowRequest(): boolean {
    return this.admit() !== null;
  }

  /** Like {@link allowRequest}, returning the admission to settle with. */
  admit(): CircuitAdmission | null {
    if (this.state === 'closed') return { probeId: null };
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) return null;
      this.state = 'half-open';
    }
    // half-open: admit only one probe at a time.
    if (this.probeId !== null) return null;
    this.probeId = this.nextProbeId++;
    return { probeId: this.probeId };
  }

  /** No admission (older callers) settles as the probe, as before. */
  private ownsProbe(admission: CircuitAdmission | undefined): boolean {
    return admission === undefined || admission.probeId === this.probeId;
  }

  recordSuccess(_admission?: CircuitAdmission): void {
    // Any success is evidence the indexer works, so it closes the circuit.
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailure = null;
    this.probeId = null;
  }

  recordFailure(err: unknown, admission?: CircuitAdmission): void {
    // LockError means "another process is writing — try again later", not a
    // broken indexer. Do not count it against the failure threshold.
    if (err instanceof LockError) {
      this.lastFailure = `[transient/lock] ${err.message}`;
      if (this.ownsProbe(admission)) this.probeId = null;
      return;
    }
    this.lastFailure = err instanceof Error ? err.message : String(err);
    this.consecutiveFailures++;
    // Another run's failure while the probe is in flight: the probe decides.
    if (!this.ownsProbe(admission) && this.probeId !== null) return;
    this.probeId = null;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /**
   * Release a probe that ended without a verdict (the caller aborted it).
   * Neither success nor failure is recorded, but a half-open circuit must be
   * able to admit the next probe — otherwise it refuses every request until a
   * manual reset.
   */
  abandonProbe(admission?: CircuitAdmission): void {
    if (this.ownsProbe(admission)) this.probeId = null;
  }

  /** Force-close the circuit (manual recovery: `/codebase-reindex`). */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailure = null;
    this.probeId = null;
    this.openedAt = 0;
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailure: this.lastFailure,
      cooldownRemainingMs:
        this.state === 'open' ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt)) : 0,
    };
  }
}

/**
 * Process-wide breaker shared by every index path (startup scan, per-edit
 * incremental, external watcher, the `codebase-index` tool). Module-level for
 * the same reason the mutex is: there is one `index.db` per project and one
 * indexing pipeline per process.
 */
export const indexCircuitBreaker = new IndexCircuitBreaker();

/** Reset the shared breaker — used by `/codebase-reindex` and tests. */
export function resetIndexCircuitBreaker(): void {
  indexCircuitBreaker.reset();
}
