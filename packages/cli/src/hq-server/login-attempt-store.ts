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
import { restrictFilePermissions } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';

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
   *
   * SEC-001: legacy `cred:` entries (per-password hashes persisted by the
   * pre-fix version) are skipped here, not just on write — re-seeding them
   * would keep the hashes in memory and on disk. When any are found, a
   * debounced rewrite scrubs them from the file.
   */
  async load(): Promise<void> {
    let legacyCredEntries = 0;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, LoginAttemptEntry>;
      const cutoff = Date.now() - this.retentionMs;
      for (const [key, entry] of Object.entries(parsed)) {
        // SEC-001: cred: (per-password) entries are memory-only. Skip any
        // legacy persisted copy and schedule a scrub write below.
        if (key.startsWith('cred:')) {
          legacyCredEntries++;
          continue;
        }
        if (entry && typeof entry.lastAttempt === 'number' && entry.lastAttempt > cutoff) {
          this.store.set(key, entry);
        }
      }
    } catch {
      // ENOENT or parse error — start fresh.
      return;
    }
    if (legacyCredEntries > 0) this.scheduleWrite();
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
   * Rate-limit key for a *candidate password*, independent of source IP.
   *
   * WS-104: this used to be `cred:${ip}:${hash}`. Embedding the IP made the
   * documented purpose — "limit how often the SAME password can be tried from
   * different IPs" — structurally impossible, because a rotating-IP attacker
   * got a fresh counter with every hop, exactly the case the key exists for.
   * The IP-scoped counter is already kept separately under the bare `ip` key.
   *
   * Backoff caps at 16s (see {@link recordFailure}), so a global per-password
   * counter throttles guessing without becoming a lockout an attacker could
   * aim at the operator.
   */
  static credentialKey(password: string): string {
    const hash = createHash('sha256').update(password, 'utf8').digest('hex').slice(0, 16);
    return `cred:${hash}`;
  }

  /**
   * Check the IP key and — when a candidate password is supplied — the
   * credential key too, returning the stricter (later `blockedUntil`).
   *
   * WS-104: `handleApiLogin` called this with `''` before parsing the request
   * body ("we don't have the password yet") and never called it again, so the
   * credential entries {@link recordFailure} wrote were only ever *written*.
   * Callers now re-check once the password is known; passing no password (or
   * an empty one) means "IP scope only".
   */
  checkBlocked(ip: string, password?: string): { blocked: boolean; retryAfter: number } {
    const now = Date.now();
    const ipEntry = this.store.get(ip);
    const ipBlocked = ipEntry && ipEntry.blockedUntil > now ? ipEntry.blockedUntil : 0;

    let credBlocked = 0;
    if (password !== undefined && password.length > 0) {
      const credEntry = this.store.get(LoginAttemptStore.credentialKey(password));
      credBlocked = credEntry && credEntry.blockedUntil > now ? credEntry.blockedUntil : 0;
    }

    const blockedUntil = Math.max(ipBlocked, credBlocked);
    if (blockedUntil > now) {
      return { blocked: true, retryAfter: Math.ceil((blockedUntil - now) / 1000) };
    }
    return { blocked: false, retryAfter: 0 };
  }

  /**
   * Record a failed attempt on the IP key, and on the credential key when a
   * candidate password is supplied. Omit the password for flows that have no
   * one (2FA verification, TOTP disable) so they do not accumulate a
   * meaningless `cred:sha256("")` counter shared by every such flow.
   *
   * Returns the updated IP entry (for the response Retry-After header).
   */
  recordFailure(ip: string, password?: string, maxBackoffMs = 16_000): LoginAttemptEntry {
    const backoff = (prev: LoginAttemptEntry | undefined): LoginAttemptEntry => {
      const count = (prev?.count ?? 0) + 1;
      return {
        count,
        blockedUntil: Date.now() + Math.min(2 ** count * 1000, maxBackoffMs),
        lastAttempt: Date.now(),
      };
    };

    this.set(ip, backoff(this.store.get(ip)));
    if (password !== undefined && password.length > 0) {
      const credKey = LoginAttemptStore.credentialKey(password);
      this.set(credKey, backoff(this.store.get(credKey)));
    }

    return this.store.get(ip)!;
  }

  /**
   * Clear the IP entry — and the credential entry when a password is given —
   * on successful login.
   */
  clearOnSuccess(ip: string, password?: string): void {
    this.delete(ip);
    if (password !== undefined && password.length > 0) {
      this.delete(LoginAttemptStore.credentialKey(password));
    }
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
        // SEC-001: cred: (per-password) entries are kept in memory only so
        // candidate password hashes are never persisted to disk.
        if (!key.startsWith('cred:')) {
          obj[key] = entry;
        }
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
