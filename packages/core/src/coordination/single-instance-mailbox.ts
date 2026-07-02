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

import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

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
  await fsp.writeFile(tokenPath, finalized.token, { mode: 0o600 });
  return finalized;
}

/**
 * Phase 3 — best-effort cleanup on shutdown. Removes the lock + token
 * files IF this process is still the recorded owner (generation match).
 *
 * If the generation doesn't match, another acquire() has already
 * superseded us — we must NOT delete their lock.
 */
export async function release(projectDir: string, generation: number): Promise<void> {
  const lockPath = path.join(projectDir, MAILBOX_BRIDGE_LOCK_FILENAME);
  const tokenPath = path.join(projectDir, MAILBOX_BRIDGE_TOKEN_FILENAME);
  try {
    const raw = await fsp.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as MailboxBridgeLock;
    if (parsed.generation !== generation) return; // not ours
    if (parsed.pid !== process.pid) return; // not ours
    /* v8 ignore next -- best-effort cleanup: a vanished lock at shutdown is fine */
    await fsp.unlink(lockPath).catch(() => undefined);
    /* v8 ignore next -- best-effort cleanup: token may already be gone */
    await fsp.unlink(tokenPath).catch(() => undefined);
  } catch {
    // Lock already gone — fine.
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
    raw = await fsp.readFile(lockPath, 'utf-8');
  } catch {
    return { kind: 'absent' };
  }
  let parsed: MailboxBridgeLock;
  try {
    parsed = JSON.parse(raw) as MailboxBridgeLock;
  } catch {
    // Malformed JSON — no usable data to preserve, safe to unlink so
    // the next acquire starts fresh. We don't lose anything here.
    /* v8 ignore next -- best-effort: malformed lock already gone is fine */
    await fsp.unlink(lockPath).catch(() => undefined);
    return { kind: 'absent' };
  }
  if (!isProcessAlive(parsed.pid)) {
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
async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(value, null, 2) + '\n';
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  try {
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    // rename failed — clean up the tmpfile and rethrow.
    /* v8 ignore next -- best-effort: tmp already gone during cleanup is fine */
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// ── Cross-platform PID + healthz probe helpers ─────────────────────────

/**
 * True iff `pid` is alive. POSIX: process.kill(pid, 0) throws ESRCH
 * for dead processes. Windows: use tasklist to look the pid up.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  if (os.platform() === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // tasklist prints the header even with /NH; if the pid exists,
      // it includes a row with the pid somewhere.
      return /\b"?,?\d+,?"?/.test(out) || out.includes(String(pid));
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
