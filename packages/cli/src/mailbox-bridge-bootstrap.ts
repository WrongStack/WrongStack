/**
 * Mailbox-bridge auto-bootstrap.
 *
 * Called by REPL/TUI/WebUI/eternal-autonomy at startup. If a mailbox
 * bridge is already running for the current project, we discover it
 * via the lock file + /healthz probe and return its URL + token.
 * Otherwise we spawn `wstack mailbox serve` as a detached child
 * process and wait up to BOOTSTRAP_TIMEOUT_MS for the new bridge to
 * come up. The result is a `MailboxBridgeHandle` that callers can
 * use without re-doing the discovery.
 *
 * This is a CLIENT of the single-instance-mailbox contract — it
 * never touches the lock itself except to read. The spawned
 * `wstack mailbox serve` instance is the sole writer; we just
 * wait for it.
 *
 * Failure modes (all graceful — REPL starts anyway):
 *  - bridge already up but unreachable → return its URL/token
 *    anyway, hoping the caller's request timeout will catch a real
 *    outage. Don't crash REPL because /healthz is flaky.
 *  - spawn fails or bridge doesn't come up in time → return null,
 *    log a warning, REPL runs without mailbox-bridge. The user
 *    can run `wstack mailbox serve` manually later.
 */

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { readLiveLock, type MailboxBridgeLock } from '@wrongstack/core/coordination';
import { buildWin32CmdShimInvocation } from './utils/win32-cmd.js';

export const MAILBOX_BRIDGE_BOOTSTRAP_TIMEOUT_MS = 5_000;
export const MAILBOX_BRIDGE_HEALTHZ_PROBE_MS = 500;

export interface MailboxBridgeHandle {
  /** Bound URL — empty string if we couldn't bring the bridge up. */
  url: string;
  /** Bearer token. Empty string on failure. */
  token: string;
  /** Lock file path on disk. Always set, even on failure. */
  lockPath: string;
  /** Where the spawned process is, if we spawned one. */
  childPid: number | null;
  /**
   * How the handle was acquired:
   *  - 'joined'    — found an existing instance via lock + /healthz
   *  - 'spawned'   — we spawned a fresh `wstack mailbox serve`
   *  - 'unhealthy' — found a live lock but /healthz failed; returned
   *                   the recorded URL/token anyway so the caller's
   *                   fetch layer can retry.
   *  - 'failed'    — could not bring up a bridge; caller should run
   *                   `wstack mailbox serve` manually.
   */
  source: 'joined' | 'spawned' | 'unhealthy' | 'failed';
}

export interface BootstrapOptions {
  projectDir: string;
  /**
   * Function used to spawn `wstack mailbox serve` if no live
   * instance is found. Defaults to a real `child_process.spawn`
   * call; tests pass a stub.
   *
   * The function must return a child-like object with at least
   * `pid` and `unref()`. We do not stream stdout/stderr — the
   * bridge writes its own status to stdout, and the caller (or
   * the user's terminal) handles display.
   */
  spawnFn?: SpawnFn;
  /**
   * Function used to probe /healthz on a given URL. Defaults to
   * the global `fetch` with a 500 ms AbortSignal; tests pass a stub.
   */
  probeFn?: ProbeFn;
  /** Maximum time to wait for a freshly-spawned bridge. */
  timeoutMs?: number;
}

export type SpawnFn = (args: string[], cwd: string) => SpawnedChild;

export interface SpawnedChild {
  pid: number | undefined;
  unref(): void;
}

export type ProbeFn = (url: string, timeoutMs: number) => Promise<boolean>;

/**
 * Try to ensure a mailbox bridge is up for `projectDir`. Returns a
 * handle describing how it was obtained (or that the attempt
 * failed). Never throws — callers are usually startup code paths
 * that prefer to log a warning over crashing the host process.
 */
export async function tryAcquireMailboxBridge(
  opts: BootstrapOptions,
): Promise<MailboxBridgeHandle> {
  const lockPath = path.join(opts.projectDir, '.mailbox-bridge.lock');
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  // Phase 1 — check for a live instance via lock + probe.
  const existing = await readLiveLock(opts.projectDir);
  if (existing.kind === 'live') {
    return {
      url: existing.lock.url,
      token: existing.lock.token,
      lockPath,
      childPid: null,
      source: 'joined',
    };
  }
  if (existing.kind === 'probe-failed' && existing.pidAlive) {
    // Lock exists, the recorded PID is ALIVE, but /healthz didn't
    // respond — the bridge may be booting, wedged, or the PID was
    // reused. Return the recorded URL/token anyway; the caller's
    // request layer surfaces a real error if the bridge is truly
    // dead. We must NOT spawn a second bridge here: a live PID still
    // owns the lock, and racing it risks a port conflict.
    return {
      url: existing.lock.url,
      token: existing.lock.token,
      lockPath,
      childPid: null,
      source: 'unhealthy',
    };
  }
  // `existing.kind === 'probe-failed' && !existing.pidAlive` is a
  // STALE lock: the owning process is gone but the lock file was
  // never cleaned up (e.g. the bridge crashed or the machine was
  // hard-rebooted). Treat it exactly like `absent` and fall through
  // to Phase 2 — spawning `wstack mailbox serve` runs `acquireOrJoin`,
  // which unlinks the stale lock and reacquires the slot. Without
  // this, a stale lock would wedge every boot into `unhealthy`
  // forever and no bridge would ever come up.

  // Phase 2 — no live owner (absent or stale); spawn a fresh bridge.
  let child: SpawnedChild;
  try {
    // SpawnFn is declared async — must await, otherwise `child` is a
    // Promise and `child.pid`/`child.unref()` blow up at runtime.
    child = await spawnFn(['mailbox', 'serve'], opts.projectDir);
  } catch {
    return {
      url: '',
      token: '',
      lockPath,
      childPid: null,
      source: 'failed',
    };
  }
  // Detach the child from our event loop. Optional — test stubs
  // (and any future production callers that manage their own
  // lifecycle) may pass an object without unref().
  if (typeof child.unref === 'function') {
    child.unref();
  }

  // Wait for /healthz via the new lock.
  const timeoutMs = opts.timeoutMs ?? MAILBOX_BRIDGE_BOOTSTRAP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const lock = await readLiveLock(opts.projectDir);
    if (lock.kind === 'live') {
      return {
        url: lock.lock.url,
        token: lock.lock.token,
        lockPath,
        childPid: child.pid ?? null,
        source: 'spawned',
      };
    }
  }

  // Timed out. The child may still come up; we return 'failed' but
  // leave the child alive (its lifetime is independent of ours).
  return {
    url: '',
    token: '',
    lockPath,
    childPid: child.pid ?? null,
    source: 'failed',
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// (no defaultProbe — probing is internal to readLiveLock / single-instance-mailbox)

function defaultSpawn(args: string[], cwd: string): SpawnedChild {
  const cliEntry = process.argv[1];
  const isWin = process.platform === 'win32';
  // When we can see our own JS entry, re-launch it under the SAME node
  // binary. `spawn(scriptPath)` cannot execute a `.js` directly on
  // Windows and relies on a shebang on POSIX, so always go through
  // `process.execPath`. Otherwise fall back to `wstack` on PATH; on Windows
  // the cmd shim helper resolves `.cmd` wrappers without Node's shell+args
  // deprecation path.
  let cmd: string;
  let spawnArgs: string[];
  let shim: ReturnType<typeof buildWin32CmdShimInvocation> | null = null;
  if (cliEntry && /wstack|wrongstack|index\.(js|ts|mjs|cjs)$/.test(cliEntry)) {
    cmd = process.execPath;
    spawnArgs = [cliEntry, ...args];
  } else {
    cmd = 'wstack';
    spawnArgs = args;
    if (isWin) shim = buildWin32CmdShimInvocation(cmd, spawnArgs);
  }
  const child = spawn(shim?.command ?? cmd, shim?.args ?? spawnArgs, {
    cwd,
    // `detached` gives the bridge its own process group on POSIX so it
    // outlives the REPL. On win32 it forces a visible console window
    // (CREATE_NEW_CONSOLE) — the project convention is to never set it
    // there; the child already survives parent exit on Windows.
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
    env: process.env,
  });
  return {
    pid: child.pid,
    unref: () => child.unref(),
  };
}

// Re-export for tests
export { readLiveLock, type MailboxBridgeLock };

// Helper to keep the fs import alive for future token-file fallback
// reads (currently unused but exported for callers that want to
// re-read the token without going through the lock).
export async function readTokenFromFile(tokenPath: string): Promise<string | null> {
  try {
    return (await fsp.readFile(tokenPath, 'utf-8')).trim();
  } catch {
    return null;
  }
}
