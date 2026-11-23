/**
 * Single-instance mailbox-bridge lock.
 *
 * Per-project isolation: each project (resolved via
 * `resolveProjectDir`) gets its own lock file under
 * `<projectDir>/.mailbox-bridge.lock`. Two projects on the same
 * machine never collide — different slugs, different lock files,
 * and (with default port 0) different OS-assigned ports.
 *
 * The lock holds:
 *  - pid          process id of the owning `wstack mailbox serve`
 *  - host, port   what the owner actually bound (port may be OS-assigned)
 *  - url          convenience copy for callers
 *  - token        the bearer token (so external agents don't have to
 *                 re-read it from .mailbox.token separately)
 *  - generation   monotonically increasing counter; bumped on every
 *                 acquire. Lets a release() call identify whether the
 *                 current lock file still belongs to *this* process
 *                 (e.g. after a stale cleanup raced with us).
 *  - spawnedAt    ISO timestamp — for observability, not load-bearing.
 *
 * Concurrency model:
 *  - `acquireOrJoin` is atomic via rename(2). Two concurrent spawns
 *    race to write a tmpfile then rename; one wins, the other reads
 *    the winner's lock and joins.
 *  - PID liveness is checked via `process.kill(pid, 0)` (POSIX) or
 *    `tasklist` (Windows). A live PID means another instance owns
 *    this project; a dead PID means the lock is stale and gets cleaned.
 *  - `release` is best-effort: a missing lock file at shutdown is
 *    fine (someone else already took over). A generation mismatch means
 *    we lost the race and another instance owns it now — also fine.
 *
 * Token persistence: the token in the lock always matches the token in
 * `.mailbox.token`, so an external agent that reads either file gets the
 * same value. While an instance stays alive, every joining caller
 * (`kind: 'joined'`) reuses that one token. A cold (re)start — no lock,
 * or a lock whose owner PID is dead/unhealthy — mints a FRESH token and
 * rewrites both files atomically. External agents must therefore re-read
 * `.mailbox.token` after a bridge restart (a stale token returns 401).
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPidAlive } from '@wrongstack/core/utils';
import { restrictFilePermissions } from '@wrongstack/persistence';

export const MAILBOX_BRIDGE_LOCK_FILENAME = '.mailbox-bridge.lock';
export const MAILBOX_BRIDGE_TOKEN_FILENAME = '.mailbox.token';

export interface MailboxBridgeLock {
  pid: number;
  host: string;
  port: number;
  url: string;
  token: string;
  generation: number;
  spawnedAt: string;
}

export type AcquireResult =
  | { kind: 'acquired'; lock: MailboxBridgeLock; tokenPath: string }
  | { kind: 'joined'; lock: MailboxBridgeLock; tokenPath: string }
  | { kind: 'port-conflict'; existing: MailboxBridgeLock };
// port-conflict carries only the existing owner's record — no
// `lock` or `tokenPath` because we never wrote our own tentative
// lock in this branch (acquireOrJoin bails before the tentative
// write when a live cross-port owner is detected). The caller does
// NOT need to release anything on this path.

export interface AcquireOptions {
  /** Project dir (already resolved by caller via resolveProjectDir). */
  projectDir: string;
  /** Bind host. Required when acquiring. */
  host: string;
  /** Explicit port. Pass null/undefined to mean "OS-assigned" (read it after listen). */
  requestedPort: number | null;
  /** When true, fail loud on EADDRINUSE. When false, fall back to OS-assigned. */
  strictPort: boolean;
}

/**
 * Try to acquire the mailbox-bridge lock for `projectDir`. If another
 * instance is already alive and healthy, join it. Otherwise claim
 * the slot for ourselves.
 *
 * Two-phase contract:
 *  1. Caller invokes `acquireOrJoin(...)` BEFORE calling
 *     `server.listen()`. The returned lock either:
 *       - `kind: 'joined'`     → another instance is alive, the caller
 *                                should NOT bind; just print the URL/token
 *                                and exit cleanly (return 0).
 *       - `kind: 'acquired'`   → caller is the owner, proceeds to bind.
 *       - `kind: 'port-conflict'` → caller asked for an explicit port
 *                                that's already taken by an unrelated
 *                                process; we return the existing owner
 *                                but the caller decides what to do
 *                                (loud-fail).
 *  2. After `server.listen()` resolves with a real port, the caller
 *     invokes `finalize(lock, boundPort)` to atomically write the
 *     final lock + token file with the OS-assigned port.
 *
 * The two-phase split keeps the listen() call out of the lock module —
 * the caller owns the HTTP server instance; the lock module owns
 * the on-disk contract.
 */
export async function acquireOrJoin(opts: AcquireOptions): Promise<AcquireResult> {
  const lockPath = path.join(opts.projectDir, MAILBOX_BRIDGE_LOCK_FILENAME);
  const tokenPath = path.join(opts.projectDir, MAILBOX_BRIDGE_TOKEN_FILENAME);

  // Phase 1 — inspect any pre-existing lock. We do a single
  // combined read: parse JSON + check liveness, all before any
  // cleanup. This way the generation counter survives across
  // acquire→release→reacquire cycles — only an owner restart bumps
  // it.
  //
  // acquireOrJoin is the ONLY caller that wants the stale lock
  // unlinked (the next acquire needs a clean slate). readLiveLock
  // also calls this classifier but MUST NOT unlink — it just reports
  // liveness for the caller. So we classify here and do the cleanup
  // explicitly below.
  const inspected = await readLockForInspection(lockPath);
  if (inspected.kind === 'live') {
    const existing = inspected.lock;
    if (opts.requestedPort !== null && opts.requestedPort !== existing.port) {
      return { kind: 'port-conflict', existing };
    }
    return { kind: 'joined', lock: existing, tokenPath };
  }
  // inspected.kind === 'absent' | 'stale' — either way, we may
  // acquire. `generation` is read off the live lock (stale → 1).
  // We're claiming the slot now, so unlink any stale lock first so
  // a concurrent reader doesn't race against our rename below.
  if (inspected.kind === 'stale') {
    /* v8 ignore next -- best-effort: a vanished stale lock is fine */
    await fsp.unlink(lockPath).catch(() => undefined);
  }
  const generation = inspected.kind === 'stale' ? inspected.lock.generation + 1 : 1;
  const token = randomBytes(32).toString('hex');

  // Pre-write a tentative lock with the requested port (or 0 if
  // OS-assigned). The caller will rewrite with the bound port after
  // listen() resolves. Using pid is safe — even if our pid dies
  // between write and finalize, the next acquire will detect a stale
  // lock via the PID check.
  const tentative: MailboxBridgeLock = {
    pid: process.pid,
    host: opts.host,
    port: opts.requestedPort ?? 0,
    url: opts.requestedPort !== null ? `http://${opts.host}:${opts.requestedPort}` : '', // finalized in finalize() once we know the OS-assigned port
    token,
    generation,
    spawnedAt: new Date().toISOString(),
  };
  await atomicWriteJson(lockPath, tentative);

  return { kind: 'acquired', lock: tentative, tokenPath };
}

/**
 * Phase 2 — after server.listen() resolves, write the final lock
 * with the actually-bound port and the same token. Also writes the
 * .mailbox.token file with mode 0600 so external agents can read it.
 *
 * Returns the finalized lock so the caller can use the resolved URL.
 */
export async function finalize(
  projectDir: string,
  tentative: MailboxBridgeLock,
  boundPort: number,
): Promise<MailboxBridgeLock> {
  const lockPath = path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME);
  const tokenPath = path.join(projectDir, MAILBOX_BRIDGE_TOKEN_FILENAME);
  let current: MailboxBridgeLock;
  try {
    current = JSON.parse(await readLockRaw(lockPath)) as MailboxBridgeLock;
  } catch (error) {
    throw new Error('Mailbox bridge lock was superseded before finalize', { cause: error });
  }
  if (
    current.pid !== tentative.pid ||
    current.generation !== tentative.generation ||
    current.token !== tentative.token
  ) {
    throw new Error('Mailbox bridge lock was superseded before finalize');
  }
  const finalized: MailboxBridgeLock = {
    ...tentative,
    port: boundPort,
    url: `http://${tentative.host}:${boundPort}`,
  };
  await atomicWriteJson(lockPath, finalized);
  // Token file: 0600 on POSIX, best-effort on Windows. Same content
  // as the lock's token field so an external agent that only reads
  // `.mailbox.token` (without knowing about the lock) still gets
  // a valid bearer.
  await atomicWriteString(tokenPath, finalized.token);
  return finalized;
}

/**
 * Phase 3 — best-effort cleanup on shutdown. Removes the lock + token
 * files IF this process is still the recorded owner (generation match).
 *
 * If the generation doesn't match, another acquire() has already
 * superseded us — we must NOT delete their lock. Even after the
 * generation check passes, the lock path is CLAIMED with an atomic
 * rename and ownership re-verified on the private copy before anything
 * is deleted, so a takeover that lands mid-cleanup keeps both of its
 * files (see release/claimedLockIsOurs/tokenStillOurs).
 */
export async function release(projectDir: string, generation: number): Promise<void> {
  const lockPath = path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME);
  const tokenPath = path.join(projectDir, MAILBOX_BRIDGE_TOKEN_FILENAME);
  try {
    const raw = (await fsp.readFile(lockPath, 'utf-8')).replace(/^\uFEFF/, '');
    const parsedRaw: unknown = JSON.parse(raw);
    if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) return;
    const parsed = parsedRaw as MailboxBridgeLock;
    if (parsed.generation !== generation) return; // not ours
    if (parsed.pid !== process.pid) return; // not ours
    // Claim the lock path atomically before deleting anything. rename(2) is
    // atomic on both platforms, so whatever sits at lockPath moves to a
    // private name; if it is (still) ours we delete our own copy, and if a
    // takeover completed in the meantime we restore theirs untouched. A
    // check-then-unlink by path cannot do this: the takeover of a wedged
    // bridge (pid alive, /healthz failing) can complete in the gap between
    // any in-process verification and the unlink syscall, and the loser
    // would delete the new owner's lock.
    const claimed = `${lockPath}.release.${process.pid}.${randomBytes(4).toString('hex')}`;
    await fsp.rename(lockPath, claimed);
    const owned = await claimedLockIsOurs(claimed, generation);
    if (owned) {
      /* v8 ignore next -- best-effort cleanup: a vanished lock at shutdown is fine */
      await fsp.unlink(claimed).catch(() => undefined);
      // Same claim-verify dance for the token: a takeover that lands
      // between any check and the unlink syscall must not lose the new
      // owner's bearer.
      const claimedToken = `${tokenPath}.release.${process.pid}.${randomBytes(4).toString('hex')}`;
      try {
        await fsp.rename(tokenPath, claimedToken);
        if (await claimedTokenIsOurs(claimedToken, parsed.token)) {
          await fsp.unlink(claimedToken).catch(() => undefined);
        } else {
          try {
            await fsp.rename(claimedToken, tokenPath);
          } catch {
            await fsp.unlink(claimedToken).catch(() => undefined);
          }
        }
      } catch {
        // Token already gone — fine.
      }
    } else {
      // Not ours — put the new owner's lock back. If the restore target
      // appeared underneath us, fail closed: leave the newer file alone and
      // drop our stale copy.
      try {
        await fsp.rename(claimed, lockPath);
      } catch {
        await fsp.unlink(claimed).catch(() => undefined);
      }
    }
  } catch {
    // Lock already gone — fine.
  }
}

/**
 * True iff the private claimed copy still carries the given generation
 * owned by this process. Any read/parse error fails closed ("not ours" —
 * restore, do not delete).
 */
async function claimedLockIsOurs(claimedPath: string, generation: number): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readLockRaw(claimedPath)) as MailboxBridgeLock;
    return parsed.generation === generation && parsed.pid === process.pid;
  } catch {
    return false;
  }
}

/**
 * True iff the token file on disk still contains exactly `token`. Any
 * read error fails closed ("not ours" — do not delete).
 */
async function claimedTokenIsOurs(claimedTokenPath: string, token: string): Promise<boolean> {
  try {
    return (await fsp.readFile(claimedTokenPath, 'utf-8')) === token;
  } catch {
    return false;
  }
}

// ── Internals ──────────────────────────────────────────────────────────

type LockInspection =
  | { kind: 'live'; lock: MailboxBridgeLock }
  /**
   * The lock is present and parseable but not usable. `pidAlive`
   * distinguishes the two reasons:
   *  - `pidAlive: false` — the recorded PID is dead. The lock is
   *    a leftover from a crashed/killed bridge; a fresh spawn is the
   *    right recovery (`acquireOrJoin` unlinks + reacquires).
   *  - `pidAlive: true`  — the PID is alive but /healthz didn't
   *    respond. The bridge may be booting, wedged, or a PID got
   *    reused. Callers may still surface the recorded URL/token so
   *    a real request can confirm/deny liveness.
   */
  | { kind: 'stale'; lock: MailboxBridgeLock; pidAlive: boolean }
  | { kind: 'absent' };

/**
 * Read the lock file once and classify it as live / stale / absent.
 *
 * **Side-effect free** — does NOT unlink the lock file on stale or
 * malformed JSON. Callers that want cleanup do it themselves after
 * they decide what to do (acquireOrJoin unlinks so its rename can
 * claim the slot atomically; readLiveLock never unlinks because it
 * only reports).
 *
 * The only filesystem writes this function performs are best-effort
 * unlinks of a MALFORMED lock (so the next acquire starts fresh) —
 * these can't lose data because there's no usable lock to preserve.
 * Stale-but-parseable locks are preserved so the caller can read the
 * generation counter off them.
 *
 * The healthz probe runs only for the 'live' branch (a reused PID
 * would otherwise fool us). Stale-PID detection doesn't bother
 * probing because the PID is already gone.
 */
async function readLockForInspection(lockPath: string): Promise<LockInspection> {
  let raw: string;
  try {
    raw = await readLockRaw(lockPath);
  } catch (error) {
    // Only a missing file is "no lock". An unreadable one (EBUSY from an
    // indexer/antivirus) read as absent, and the caller overwrote a live
    // bridge's lock and token.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  let parsed: MailboxBridgeLock;
  try {
    const parsedRaw: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
      throw new SyntaxError('Lock payload is not a JSON object');
    }
    parsed = parsedRaw as MailboxBridgeLock;
  } catch {
    // Malformed JSON — no usable data to preserve, safe to unlink so
    // the next acquire starts fresh. We don't lose anything here.
    /* v8 ignore next -- best-effort: malformed lock already gone is fine */
    await fsp.unlink(lockPath).catch(() => undefined);
    return { kind: 'absent' };
  }
  if (!(await isProcessAlive(parsed.pid))) {
    // Dead PID — keep the data so callers (acquireOrJoin) can bump
    // generation off it; the caller decides whether to unlink. The
    // owning bridge is gone, so recovery is a fresh spawn.
    return { kind: 'stale', lock: parsed, pidAlive: false };
  }
  // Sanity-check the URL too — if the lock is well-formed but the
  // recorded port doesn't have anything bound, the PID might be
  // a reused pid. Probe /healthz to be sure. (Best-effort — if the
  // probe fails we still trust the PID check.)
  if (!(await probeHealthz(parsed.url))) {
    // PID alive but /healthz unreachable. Keep the data so the
    // caller can surface the URL/token to the user; do NOT unlink.
    return { kind: 'stale', lock: parsed, pidAlive: true };
  }
  return { kind: 'live', lock: parsed };
}

const TRANSIENT_LOCK_READ_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Read the lock, retrying briefly through transient Windows sharing errors. */
async function readLockRaw(lockPath: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.readFile(lockPath, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || code === undefined || !TRANSIENT_LOCK_READ_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/**
 * Read the lock file and return it, with enough information for the
 * caller to distinguish:
 *  - 'live'        — PID alive, /healthz reachable; safe to use.
 *  - 'probe-failed' — PID alive (or recently was) but /healthz
 *                     unreachable. Caller can still return the URL
 *                     + token to the host so its request layer can
 *                     retry; the host's fetch timeout will surface
 *                     the real error if the bridge is truly dead.
 *  - 'absent'      — no lock file existed, or it was malformed
 *                     (cleaned up best-effort).
 *
 * Distinguishing 'probe-failed' from 'absent' matters for the
 * "joined vs spawned" decision in tryAcquireMailboxBridge — we
 * don't want to spawn a second bridge just because /healthz flaked.
 */
export type LiveLockResult =
  | { kind: 'live'; lock: MailboxBridgeLock }
  /**
   * The lock exists but isn't usable. `pidAlive` tells the caller
   * which recovery to pick:
   *  - `pidAlive: false` — the owning process is dead (stale lock).
   *    Callers should treat this like `absent` and spawn a fresh
   *    bridge rather than surfacing a dead URL.
   *  - `pidAlive: true`  — the process is alive but /healthz didn't
   *    respond (booting/wedged/PID-reuse). Callers may return the
   *    recorded URL/token and let a real request confirm liveness.
   */
  | { kind: 'probe-failed'; lock: MailboxBridgeLock; pidAlive: boolean }
  | { kind: 'absent' };

export async function readLiveLock(projectDir: string): Promise<LiveLockResult> {
  const lockPath = path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME);
  const result = await readLockForInspection(lockPath);
  if (result.kind === 'live') {
    return { kind: 'live', lock: result.lock };
  }
  if (result.kind === 'stale') {
    return { kind: 'probe-failed', lock: result.lock, pidAlive: result.pidAlive };
  }
  return { kind: 'absent' };
}

/**
 * Atomic JSON write: serialize to a tmpfile with a unique suffix
 * (so concurrent writers don't clobber each other's tmpfile), then
 * rename(2) into place. POSIX guarantees rename atomicity; on
 * Windows, Node's fs.rename is implemented via MoveFileEx which is
 * also atomic on the same volume.
 */
async function atomicWriteString(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await fsp.writeFile(tmp, content, { mode: 0o600 });
  try {
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    /* v8 ignore next -- best-effort: tmp already gone during cleanup is fine */
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
  // F43 (WS-045 class): the lock carries the bearer token and `mode: 0o600` is
  // a Windows no-op, so the lock/token files stayed readable by other local
  // accounts where inheritance was not owner-only. Every atomic replacement
  // re-applies owner-only permissions (best-effort, warned not thrown).
  await restrictFilePermissions(targetPath, { label: 'mailbox-bridge' });
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await atomicWriteString(targetPath, JSON.stringify(value, null, 2) + '\n');
}

// ── Cross-platform PID + healthz probe helpers ─────────────────────────

/**
 * True iff `pid` is alive. POSIX: process.kill(pid, 0) throws ESRCH
 * for dead processes. Windows: use tasklist to look the pid up.
 */
async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  // win32: tasklist is AUTHORITATIVE here and must run first. `process.kill`
  // can report a terminated-but-unreaped pid as alive, and this predicate
  // decides whether a lock may be broken — a false "alive" wedges every
  // subsequent boot into `unhealthy` with no bridge. Prefer the subprocess.
  if (os.platform() === 'win32') {
    return new Promise((resolve) => {
      execFile(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 256 * 1024,
        },
        (error, out) => {
          if (error) {
            // tasklist itself failed (timed out on a loaded machine, missing):
            // that says nothing about the pid. "Dead" would let the caller
            // break a live bridge's lock, so fall back to the signal probe.
            resolve(isPidAlive(pid));
            return;
          }
          // tasklist prints the header even with /NH; if the pid exists,
          // it includes a row with the pid somewhere.
          // Match the PID as the first quoted field in a CSV row:
          // "name","PID","session","mem"
          const match = /(?:^|\n)"[^"]*","(\d+)"/.exec(out);
          resolve(match !== null && match[1] === String(pid));
        },
      );
    });
  }
  // POSIX: the shared probe, which reports EPERM ("alive, not ours to
  // signal") as alive rather than dead.
  return isPidAlive(pid);
}

/**
 * Best-effort /healthz probe with a tight timeout. Used to detect
 * pid-reuse false positives: a pid could be alive but not actually
 * running our bridge. We return false on any error; the caller
 * treats that as "lock is stale".
 */
async function probeHealthz(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const ctrl = new AbortController();
    /* v8 ignore next -- 500ms abort backstop fires only on a hung probe */
    const t = setTimeout(() => ctrl.abort(), 500);
    if (typeof t.unref === 'function') t.unref();
    const res = await fetch(`${url}/healthz`, {
      signal: ctrl.signal,
      redirect: 'manual',
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
