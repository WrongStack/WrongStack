/**
 * P4.14: idle-time WAL maintenance for the detached project-server daemon.
 *
 * `wal_autocheckpoint=1000` is PASSIVE and only attempts a checkpoint after a
 * COMMIT. A daemon whose clients keep issuing searches (long-running WAL
 * readers) can hold WAL snapshots indefinitely: the autocheckpointer sees
 * busy=1 every time and the WAL grows without bound until a reader gap or
 * shutdown. Nothing re-fires once writes stop — a COMMIT is what arms it.
 *
 * This scheduler gives the daemon its own maintenance heartbeat:
 *  - every completed write run arms a sliding idle timer;
 *  - when it fires (no further writes slid it), it checkpoints the WAL
 *    (probe-first; never blocks on readers) and periodically runs
 *    `PRAGMA optimize` so the query planner's statistics stay current.
 *
 * All timers are unref'd — they must never keep the daemon alive past its
 * idle-exit, and firing is harmless at any point because checkpointWal is
 * best-effort.
 */

interface WalMaintenanceOptions {
  /** Idle window after a write completion before maintenance fires. */
  idleMs?: number | undefined;
  /** Run `optimize()` once every N maintenance fires. Default: 8. */
  optimizeEvery?: number | undefined;
  /** Clock for tests. */
  setTimeoutFn?: typeof setTimeout | undefined;
  /** Clear for tests. */
  clearTimeoutFn?: typeof clearTimeout | undefined;
}

interface WalMaintenanceHooks {
  /** Returns true when a checkpoint completed (WAL reset). */
  checkpoint: () => boolean;
  /** Recompute statistics. */
  optimize: () => void;
}

const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_OPTIMIZE_EVERY = 8;

function envIdleMs(): number | undefined {
  const raw = process.env['WRONGSTACK_INDEX_WAL_IDLE_MS'];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export class WalMaintenance {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fireCount = 0;
  private disposed = false;
  private readonly idleMs: number;
  private readonly optimizeEvery: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(
    private readonly hooks: WalMaintenanceHooks,
    options: WalMaintenanceOptions = {},
  ) {
    this.idleMs = options.idleMs ?? envIdleMs() ?? DEFAULT_IDLE_MS;
    this.optimizeEvery = options.optimizeEvery ?? DEFAULT_OPTIMIZE_EVERY;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  /**
   * Arm (or re-arm) the idle timer. Call after every completed write run —
   * bursty incremental writes keep sliding the window so maintenance runs
   * once after the burst settles, not per write.
   */
  notifyWriteCompleted(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      this.fire();
    }, this.idleMs);
    // Maintenance must never keep the daemon alive past its idle-exit.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private fire(): void {
    if (this.disposed) return;
    this.fireCount++;
    // Checkpoint first (reclaims WAL bytes), then refresh planner stats on
    // the configured cadence. Each hook is best-effort on its own.
    try {
      this.hooks.checkpoint();
    } catch {
      /* maintenance must never crash the daemon */
    }
    if (this.fireCount % this.optimizeEvery === 0) {
      try {
        this.hooks.optimize();
      } catch {
        /* optional */
      }
    }
  }

  /** True when an idle fire is pending (test visibility). */
  get armed(): boolean {
    return this.timer !== undefined;
  }

  /** Stop all maintenance. Idempotent; safe to call on every shutdown path. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
  }
}
