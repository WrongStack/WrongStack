import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionStore } from '../types/session.js';
import { ensureDir } from '../utils/atomic-write.js';
import { isPidAlive } from '../utils/pid.js';
import { sessionContentPreview, userInputTitle } from './session-helpers.js';

/**
 * Per-project lockfile used for crash detection. The CLI writes one of
 * these alongside the session JSONLs (`<projectSessions>/active.json`)
 * when an interactive run starts, and deletes it on clean exit. If we
 * find one on the next launch whose owning PID is dead (or whose host
 * doesn't match), we know the previous run was killed mid-flight and
 * the session it was writing to is a recovery candidate.
 *
 * The lockfile is intentionally per-project (already isolated by
 * `wpaths.projectSessions`), so two TUIs in two different repos do not
 * fight each other.
 */
export interface RecoveryLockOptions {
  /** Directory the lockfile lives in. Usually `wpaths.projectSessions`. */
  dir: string;
  /** This process's PID. Default: `process.pid`. */
  pid?: number | undefined;
  /** Hostname recorded for the lock. Default: `os.hostname()`. */
  hostname?: string | undefined;
  /** Locks older than this are considered orphaned (disk wiped, etc.). Default 24h. */
  maxAgeMs?: number | undefined;
  /** Used to check whether the abandoned session was actually closed cleanly. */
  sessionStore?: SessionStore | undefined;
  /**
   * Override the PID-liveness probe. Default: `process.kill(pid, 0)` —
   * succeeds (or throws EPERM) when the PID is alive, throws ESRCH when
   * it is gone. Tests inject a deterministic stub.
   */
  isPidAlive?: ((pid: number) => boolean) | undefined;
}

export interface AbandonedSession {
  sessionId: string;
  pid: number;
  startedAt: string;
  /** Lockfile age in ms at the time of the check. */
  ageMs: number;
  /** Number of messages already on disk for this session. */
  messageCount: number;
  /** Auto-derived session title from the first persisted user request. */
  title?: string | undefined;
  /** Latest persisted user request, compacted for the recovery prompt. */
  lastUserMessage?: string | undefined;
}

interface LockFile {
  v: 1;
  sessionId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

const LOCK_FILE = 'active.json';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @deprecated Production TUI/WebUI/SimpleUI hosts use per-session
 * {@link SessionRegistry} ownership. Retained only for API compatibility with
 * older embedders; it must not be used as a project-wide runtime lock.
 */
export class RecoveryLock {
  private readonly file: string;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly maxAgeMs: number;
  private readonly sessionStore?: SessionStore | undefined;
  private readonly probe: (pid: number) => boolean;

  constructor(opts: RecoveryLockOptions) {
    this.file = path.join(opts.dir, LOCK_FILE);
    this.pid = opts.pid ?? process.pid;
    this.hostname = opts.hostname ?? os.hostname();
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.sessionStore = opts.sessionStore;
    this.probe = opts.isPidAlive ?? defaultIsPidAlive;
  }

  /**
   * Examine the lockfile and decide whether it represents an abandoned
   * session. Returns `null` if the file is missing, points to a live
   * instance, references a clean-closed session, is too old, or is
   * malformed. Otherwise returns enough detail to prompt the user.
   *
   * Important: this is a read-only check. We never delete an active
   * lock from here — if another wstack instance is alive, the caller
   * should bail or run with a fresh session instead.
   */
  async checkAbandoned(): Promise<AbandonedSession | null> {
    const lock = await this.readLock();
    if (!lock) return null;

    const ageMs = Date.now() - new Date(lock.startedAt).getTime();
    if (Number.isNaN(ageMs) || ageMs < 0) {
      // Clock skew or corrupted timestamp — treat as orphan. Clean up the
      // stale lockfile so a subsequent write() with O_EXCL doesn't fail.
      await this.clear().catch(() => undefined);
      return null;
    }
    if (ageMs > this.maxAgeMs) {
      // Lock is older than the max-age window — the owning process is
      // guaranteed dead (disk wipe, OS reinstall, 24h+ uptime since crash).
      // Clean up the stale file so a subsequent write() doesn't hit EEXIST.
      await this.clear().catch(() => undefined);
      return null;
    }

    // PID liveness only meaningful on the same host. Different host
    // means we can't probe — assume abandoned (the other machine's
    // wstack can't be holding *our* sessions dir unless it was
    // shared via network mount, in which case the user is on their
    // own).
    if (lock.hostname === this.hostname && this.probe(lock.pid)) {
      // Another wstack on this box is actively writing here.
      return null;
    }

    let messageCount = 0;
    let title: string | undefined;
    let lastUserMessage: string | undefined;
    if (this.sessionStore) {
      try {
        const data = await this.sessionStore.load(lock.sessionId);
        // Closed means the LAST session_end is not followed by further
        // conversation activity. Legacy /save wrote mid-stream session_end
        // markers — `some()` would treat a session that crashed AFTER such a
        // marker as cleanly closed and silently skip recovery.
        const events = Array.isArray(data?.events) ? data.events : [];
        const lastEnd = events.findLastIndex
          ? events.findLastIndex((e) => e.type === 'session_end')
          : -1;
        const closed =
          lastEnd >= 0 &&
          !events
            .slice(lastEnd + 1)
            .some(
              (e) =>
                e.type === 'user_input' ||
                e.type === 'llm_response' ||
                e.type === 'in_flight_start',
            );
        if (closed) return null;
        messageCount = Array.isArray(data?.messages) ? data.messages.length : 0;
        for (const event of events) {
          if (event.type !== 'user_input') continue;
          if (title === undefined) title = userInputTitle(event.content);
          lastUserMessage = sessionContentPreview(event.content);
        }
      } catch {
        // Lock points to a session that doesn't exist on disk (deleted
        // out from under us). Nothing to recover.
        return null;
      }
    }

    return {
      sessionId: lock.sessionId,
      pid: lock.pid,
      startedAt: lock.startedAt,
      ageMs,
      messageCount,
      ...(title !== undefined ? { title } : {}),
      ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
    };
  }

  /**
   * Claim the lock for the given session. Uses exclusive-create (`O_EXCL`)
   * to detect whether another process acquired the lock between our
   * `checkAbandoned()` call and now. If the file already exists, it means
   * another process won the race and we throw instead of silently
   * overwriting their recovery record.
   *
   * The caller MUST have already called `checkAbandoned()` and handled its
   * null return before calling this.
   */
  async write(sessionId: string): Promise<void> {
    await ensureDir(path.dirname(this.file));
    const lock: LockFile = {
      v: 1,
      sessionId,
      pid: this.pid,
      hostname: this.hostname,
      startedAt: new Date().toISOString(),
    };
    // O_EXCL: atomic create — fails with EEXIST if another process wrote
    // the file between our checkAbandoned() and this write. This prevents
    // two processes that scanned the same stale lock from both believing
    // they hold it. The atomicWrite approach (temp+rename) would silently
    // replace on POSIX, hiding the race.
    try {
      await fsp.writeFile(this.file, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new Error(`Recovery lock already held by another process`);
      }
      /* v8 ignore next -- defensive: an unexpected (non-EEXIST) write failure is rethrown */
      throw err;
    }
  }

  /**
   * Release the lock. Idempotent — silently succeeds if the file is
   * already gone (e.g. someone else cleared it, or the directory was
   * wiped).
   */
  async clear(): Promise<void> {
    try {
      await fsp.unlink(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      /* v8 ignore next -- defensive: an unexpected (non-ENOENT) unlink failure is rethrown */
      throw err;
    }
  }

  private async readLock(): Promise<LockFile | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isLockFile(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

function isLockFile(v: unknown): v is LockFile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o['v'] === 1 &&
    typeof o['sessionId'] === 'string' &&
    typeof o['pid'] === 'number' &&
    typeof o['hostname'] === 'string' &&
    typeof o['startedAt'] === 'string'
  );
}

/** Default probe — the shared helper. Tests inject a deterministic stub. */
const defaultIsPidAlive = isPidAlive;
