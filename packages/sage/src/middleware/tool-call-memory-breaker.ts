/**
 * Circuit breaker for the tool-result memory injector.
 *
 * A SAGE store whose backing file is unreadable (`disk I/O error`, a corrupt or
 * vanished `sage.db`, a WAL/shm file that cannot be attached) fails the same way
 * on every query. Retrying on each tool call buys nothing and paints an
 * identical error row under every `read`. After a few consecutive store faults
 * the breaker opens: injection is skipped for a cooldown, then a single probe
 * call decides whether the store came back.
 *
 * Only genuine storage faults count. A retrieval timeout or an unrelated
 * exception is not evidence that the file is unreadable and must not pause
 * injection.
 */

const STORE_FAULT_PATTERN =
  /disk I\/O error|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_CANTOPEN|database disk image is malformed|unable to open database file|readonly database/i;

export const DEFAULT_STORE_FAULT_THRESHOLD = 3;
export const DEFAULT_STORE_FAULT_COOLDOWN_MS = 60_000;

export function isStoreFault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return STORE_FAULT_PATTERN.test(message);
}

export interface StoreFaultBreakerOptions {
  threshold?: number | undefined;
  cooldownMs?: number | undefined;
}

export interface StoreFaultOutcome {
  /** True when this failure opened (or re-opened) the breaker. */
  tripped: boolean;
  /** Message to surface when `tripped`; names the fault and the pause. */
  message?: string | undefined;
}

export class StoreFaultBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private consecutive = 0;
  private openUntil = 0;
  /** Set once the cooldown lapsed; the next failure re-opens without recounting. */
  private probing = false;

  constructor(options: StoreFaultBreakerOptions = {}) {
    this.threshold = Math.max(1, options.threshold ?? DEFAULT_STORE_FAULT_THRESHOLD);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_STORE_FAULT_COOLDOWN_MS);
  }

  /** True while injection should be skipped. Lapse of the cooldown arms a probe. */
  isOpen(now: number): boolean {
    if (this.openUntil === 0) return false;
    if (now < this.openUntil) return true;
    this.openUntil = 0;
    this.probing = true;
    return false;
  }

  recordSuccess(): void {
    this.consecutive = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  recordFailure(error: unknown, now: number): StoreFaultOutcome {
    if (!isStoreFault(error)) {
      // An unrelated failure says nothing about the store. Clear the probe
      // flag too: a timeout after the cooldown is not a failed storage probe,
      // and leaving it set made the next single I/O error skip the threshold.
      this.consecutive = 0;
      this.probing = false;
      return { tripped: false };
    }
    this.consecutive += 1;
    if (!this.probing && this.consecutive < this.threshold) return { tripped: false };
    this.probing = false;
    this.consecutive = 0;
    this.openUntil = now + this.cooldownMs;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      tripped: true,
      message:
        `SAGE store unreadable (${detail}); memory injection paused for ` +
        `${Math.round(this.cooldownMs / 1000)}s. Check the project's sage.db, its -wal/-shm files ` +
        'and the filesystem they sit on.',
    };
  }
}
