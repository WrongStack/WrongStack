import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '@wrongstack/core/types';
import { isPidAlive, wstackGlobalRoot } from '@wrongstack/core/utils';

/**
 * Cross-process single-poller lock for a Telegram bot token.
 *
 * Telegram allows exactly one `getUpdates` consumer per token; two wstack
 * instances (TUI + WebUI, or two projects) polling the same token fight each
 * other and every cycle returns HTTP 409. This lock elects one poller: the
 * holder writes a heartbeat to a lock file under `~/.wrongstack/telegram/`,
 * other instances stand by and take over when the heartbeat goes stale or
 * the file disappears.
 */

interface LockFilePayload {
  /** Unique per PollLock instance — `pid` alone can't distinguish two locks in one process. */
  id: string;
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

export interface PollLockOptions {
  log?: Logger | undefined;
  /** How often the holder refreshes its heartbeat. Default: 15s. */
  heartbeatMs?: number | undefined;
  /** A lock whose heartbeat is older than this is considered stale. Default: 45s. */
  staleMs?: number | undefined;
}

/** Lock file path for a bot token. The token itself never appears in the path. */
export function lockPathForToken(token: string, globalRoot = wstackGlobalRoot()): string {
  const hash = createHash('sha256').update(token).digest('hex').slice(0, 12);
  return join(globalRoot, 'telegram', `poll-${hash}.lock`);
}

export class PollLock {
  private readonly id = `${process.pid}:${randomUUID()}`;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly log?: Logger | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _held = false;

  /** Invoked when the lock is stolen by another instance while held. */
  onLost?: (() => void) | undefined;

  constructor(
    readonly lockPath: string,
    opts?: PollLockOptions,
  ) {
    this.heartbeatMs = opts?.heartbeatMs ?? 15_000;
    this.staleMs = opts?.staleMs ?? 45_000;
    this.log = opts?.log;
  }

  get held(): boolean {
    return this._held;
  }

  /**
   * Try to acquire the lock. Returns true when this instance is now (or was
   * already) the holder. Safe to call repeatedly from a standby retry loop.
   */
  tryAcquire(): boolean {
    if (this._held) return true;

    const existing = this.readLock();
    if (existing && !this.isStale(existing)) return false;

    const now = Date.now();
    const payload: LockFilePayload = {
      id: this.id,
      pid: process.pid,
      acquiredAt: now,
      heartbeatAt: now,
    };

    mkdirSync(dirname(this.lockPath), { recursive: true });

    // Fast path: exclusive creation when no file exists.
    try {
      writeFileSync(this.lockPath, JSON.stringify(payload), { flag: 'wx' });
      this._held = true;
      this.startHeartbeat();
      return true;
    } catch (err) {
      // Exclusive create of an existing file is EEXIST on POSIX. Windows
      // reports EPERM/EACCES/EBUSY for the same contention (sharing/AV),
      // matching withFileLock — treat those as "file exists" so a leftover
      // lock from a killed holder can still enter the stale-takeover path.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
        return false;
      }
    }

    // Slow path: file exists but may be stale. Check again before attempting takeover.
    const fresh = this.readLock();
    if (fresh && !this.isStale(fresh)) return false;

    // Take over stale lock atomically via temp file + rename (never blind unlink).
    const tmp = `${this.lockPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.lockPath);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // Temp cleanup is best-effort.
      }
      return false;
    }

    // Verify this instance actually won the rename race.
    if (this.readLock()?.id !== this.id) {
      return false;
    }

    this._held = true;
    this.startHeartbeat();
    return true;
  }

  /** Release the lock and stop the heartbeat. Idempotent. */
  release(): void {
    this.stopHeartbeat();
    if (!this._held) return;
    this._held = false;
    try {
      if (this.readLock()?.id === this.id) unlinkSync(this.lockPath);
    } catch {
      // Best effort — a stale file is reclaimed via the staleness check anyway.
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private heartbeatTick(): void {
    const current = this.readLock();
    if (!current || current.id !== this.id) {
      // Another instance stole the lock (e.g. this process was suspended past
      // the staleness window). Stop claiming it and notify the owner.
      this._held = false;
      this.stopHeartbeat();
      this.log?.warn('Telegram: poll lock was taken over by another instance.');
      this.onLost?.();
      return;
    }
    const tmp = `${this.lockPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      const payload: LockFilePayload = { ...current, heartbeatAt: Date.now() };
      // Write via temp + rename so a reader never sees a half-written file.
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.lockPath);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // Temp cleanup is best-effort.
      }
      this.log?.debug(`Telegram: poll lock heartbeat write failed: ${err}`);
    }
  }

  private readLock(): LockFilePayload | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as LockFilePayload;
      if (typeof parsed.id !== 'string' || typeof parsed.pid !== 'number') return null;
      // A non-finite heartbeatAt makes `Date.now() - heartbeatAt` NaN, and
      // `NaN > staleMs` is false, so the staleness check would silently never
      // fire and the lock could wedge every standby instance forever. Reject
      // it as corrupt so the file is reclaimed.
      if (!Number.isFinite(parsed.heartbeatAt)) return null;
      return parsed;
    } catch {
      return null; // Missing or corrupt — treated as stale/absent.
    }
  }

  private isStale(payload: LockFilePayload): boolean {
    if (Date.now() - payload.heartbeatAt > this.staleMs) return true;
    return !isPidAlive(payload.pid);
  }
}
