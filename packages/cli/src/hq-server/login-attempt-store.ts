/**
 * Persistent login attempt tracker with debounced disk write-through.
 *
 * Replaces the in-memory `Map<string, { count, blockedUntil, lastAttempt }>`
 * that reset on every server restart. Now an attacker who crashes or waits
 * out the server cannot reset their lockout counter — the state survives
 * across restarts.
 *
 * Storage: `~/.wrongstack/hq/login-attempts.json` (owner-only, 0o600 + icacls).
 * The file is pruned on load (entries older than the retention window are
 * dropped) and written back with a 500ms debounce so a burst of failed
 * logins doesn't hammer the disk.
 *
 * @module hq-server/login-attempt-store
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import { restrictFilePermissions } from '@wrongstack/core/security';

export interface LoginAttemptEntry {
  count: number;
  blockedUntil: number;
  lastAttempt: number;
}

export class LoginAttemptStore {
  private store = new Map<string, LoginAttemptEntry>();
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private readonly filePath: string;
  private readonly debounceMs: number;
  private readonly retentionMs: number;

  constructor(dataDir: string, opts?: { debounceMs?: number; retentionMs?: number }) {
    this.filePath = path.join(dataDir, 'login-attempts.json');
    this.debounceMs = opts?.debounceMs ?? 500;
    this.retentionMs = opts?.retentionMs ?? 15 * 60_000;
  }

  /**
   * Load persisted state from disk and prune stale entries.
   * Safe to call once at startup; subsequent calls reload from disk.
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, LoginAttemptEntry>;
      const cutoff = Date.now() - this.retentionMs;
      for (const [key, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.lastAttempt === 'number' && entry.lastAttempt > cutoff) {
          this.store.set(key, entry);
        }
      }
    } catch {
      // ENOENT or parse error — start fresh.
    }
  }

  get(key: string): LoginAttemptEntry | undefined {
    return this.store.get(key);
  }

  set(key: string, entry: LoginAttemptEntry): void {
    this.store.set(key, entry);
    this.scheduleWrite();
  }

  delete(key: string): void {
    if (this.store.delete(key)) {
      this.scheduleWrite();
    }
  }

  /**
   * Compound rate-limit key for public-relay mode: IP + SHA-256(password).
   * Limits how often the SAME password can be tried from different IPs,
   * so a rotating-IP attacker can't bypass per-IP backoff.
   */
  static credentialKey(ip: string, password: string): string {
    const hash = createHash('sha256').update(password, 'utf8').digest('hex').slice(0, 16);
    return `cred:${ip}:${hash}`;
  }

  /**
   * Check both IP and credential keys; return the stricter (later blockedUntil).
   */
  checkBlocked(ip: string, password: string): { blocked: boolean; retryAfter: number } {
    const ipEntry = this.store.get(ip);
    const credKey = LoginAttemptStore.credentialKey(ip, password);
    const credEntry = this.store.get(credKey);
    const now = Date.now();

    const ipBlocked = ipEntry && ipEntry.blockedUntil > now ? ipEntry.blockedUntil : 0;
    const credBlocked = credEntry && credEntry.blockedUntil > now ? credEntry.blockedUntil : 0;
    const blockedUntil = Math.max(ipBlocked, credBlocked);

    if (blockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((blockedUntil - now) / 1000) };
    }
    return { blocked: false, retryAfter: 0 };
  }

  /**
   * Record a failed attempt on both IP and credential keys.
   * Returns the updated IP entry (for the response Retry-After header).
   */
  recordFailure(
    ip: string,
    password: string,
    maxBackoffMs = 16_000,
  ): LoginAttemptEntry {
    const backoff = (prev: LoginAttemptEntry | undefined): LoginAttemptEntry => {
      const count = (prev?.count ?? 0) + 1;
      return {
        count,
        blockedUntil: Date.now() + Math.min(2 ** count * 1000, maxBackoffMs),
        lastAttempt: Date.now(),
      };
    };

    this.set(ip, backoff(this.store.get(ip)));
    const credKey = LoginAttemptStore.credentialKey(ip, password);
    this.set(credKey, backoff(this.store.get(credKey)));

    return this.store.get(ip)!;
  }

  /**
   * Clear both IP and credential entries on successful login.
   */
  clearOnSuccess(ip: string, password: string): void {
    this.delete(ip);
    this.delete(LoginAttemptStore.credentialKey(ip, password));
  }

  /** Number of tracked entries (for diagnostics). */
  get size(): number {
    return this.store.size;
  }

  /**
   * Flush pending writes immediately. Called on server shutdown.
   */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (this.dirty) {
      await this.writeToDisk();
    }
  }

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.writeToDisk();
    }, this.debounceMs);
    this.writeTimer.unref?.();
  }

  private async writeToDisk(): Promise<void> {
    this.dirty = false;
    const now = Date.now();
    // Prune stale entries before writing.
    const cutoff = now - this.retentionMs;
    const obj: Record<string, LoginAttemptEntry> = {};
    for (const [key, entry] of this.store) {
      if (entry.lastAttempt > cutoff) {
        obj[key] = entry;
      } else {
        this.store.delete(key);
      }
    }
    try {
      await atomicWrite(this.filePath, JSON.stringify(obj, null, 2), { mode: 0o600 });
      await restrictFilePermissions(this.filePath, { label: 'hq-login-attempts' });
    } catch {
      // Best-effort — the in-memory state is still correct.
    }
  }

  /** Iterate entries (for cleanup timers). */
  entries(): IterableIterator<[string, LoginAttemptEntry]> {
    return this.store.entries();
  }
}
