/**
 * ProcessRegistry — global singleton that tracks all spawned child processes
 * from `bash` and `exec` tools. Enables:
 *
 *   - Listing active processes (for TUI status bar)
 *   - Killing individual processes or all processes (for Ctrl+C and /kill)
 *   - Detecting runaway processes (hung, looping)
 *   - Circuit breaker integration to prevent recursive/repeated failures
 *
 * Thread-safety: Node.js is single-threaded, but async callbacks can fire
 * in any order. All mutations go through synchronized Map methods.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import { CircuitBreaker, type CircuitBreakerSnapshot, type CircuitBreakerConfig } from './circuit-breaker.js';
export type { CircuitBreakerSnapshot, CircuitBreakerConfig } from './circuit-breaker.js';

export interface TrackedProcess {
  pid: number;
  name: string;
  /** Display-safe redacted command string — safe for logs, /ps, crash dumps.
   *  Contains [REDACTED] in place of sensitive flag values. */
  command: string;
  startedAt: number;
  sessionId?: string | undefined;
  /** The raw ChildProcess handle. Never call .kill() directly on this —
   *  use `kill()` below which handles process groups correctly on POSIX
   *  and degrades gracefully on Windows.
   *
   *  `null` for entries mirrored from the persistent registry
   *  (process-registry-persistent.ts): those track processes owned by OTHER
   *  host instances, so there is no live handle in this process. All
   *  registry paths must tolerate a null child (kill by PID, liveness by
   *  `process.kill(pid, 0)` probe). */
  child: ChildProcess | null;
  /** True only when this child was spawned as a POSIX process-group/session
   *  leader (for example `spawn(..., { detached: true })`) and `pid` is the
   *  actual `child.pid`. Negative-PID signaling is host-wide dangerous for
   *  values like -1, so tests and manually registered entries must not opt in. */
  processGroupLeader?: boolean | undefined;
  /** True once the process has been kill()ed but not yet exited.
   *  We keep it in the registry until 'close' fires so callers can
   *  distinguish "still running" from "just exited". */
  killed: boolean;
  /** If true, kill() and killAll() will refuse to kill this process.
   *  Used for infrastructure processes (browser, dev servers, …) that
   *  must outlive the agent session. */
  protected: boolean;
  /** True for an explicitly detached/background tool launch. */
  background: boolean;
}

// redactCommand (and its sensitive-flag patterns) lives in _redact-command.ts
// so registry-only consumers (e.g. ps-slash) don't carry its dependencies.
// Re-exported here to keep this module's historical public API intact.
export { redactCommand } from './_redact-command.js';

interface KillOpts {
  /** SIGKILL instead of SIGTERM. Default: false (SIGTERM first). */
  force?: boolean | undefined;
  /** MS to wait between SIGTERM and SIGKILL on POSIX. Default: 2000. */
  graceMs?: number | undefined;
  /** Leave explicitly backgrounded jobs alive. Default false. */
  preserveBackground?: boolean | undefined;
  /**
   * Also kill processes marked `protected` (browser open, etc.).
   * Default false. Host-process shutdown should pass true so protected
   * children cannot strand the parent event loop (issue #322).
   */
  includeProtected?: boolean | undefined;
}

/**
 * Snapshot of the armed auto kill/reset countdown, or null when nothing is
 * armed. `remainingMs` ticks down in real time; the TUI statusline renders it.
 */
export interface BreakerCountdown {
  remainingMs: number;
  totalMs: number;
}

type BreakerCountdownListener = (snapshot: BreakerCountdown | null) => void;

export interface RegistryStats {
  activeCount: number;
  backgroundCount: number;
  totalCount: number;
  breaker: CircuitBreakerSnapshot;
}

const DEFAULT_GRACE_MS = 2000;
const WIN32_TASKKILL_TIMEOUT_MS = 5000;

interface Win32TreeKillOptions {
  /**
   * Upper bound for taskkill itself before the caller's fallback may run.
   * This is deliberately separate from POSIX SIGTERM grace: on Windows the
   * direct-child fallback must not fire while taskkill is still walking the
   * child tree, or it can orphan grandchildren that keep stdio open.
   */
  timeoutMs?: number | undefined;
  onSettled?: (() => void) | undefined;
}

/**
 * Kill an entire process tree on Windows via `taskkill /T /F`.
 *
 * TerminateProcess (what `child.kill()` maps to) has no process-group
 * semantics, so killing a shell wrapper (`cmd.exe /c …`) orphans its
 * grandchildren (node, vitest forks, dev servers). The orphans inherit the
 * parent's stdio pipe handles and can keep streaming into this process for
 * the rest of the session — which both prevents the child's 'close' event
 * from ever firing and grows in-memory output buffers without bound.
 *
 * Returns true if taskkill was spawned, false if spawning it failed (caller
 * should fall back to a direct `child.kill()`). Callers that need a direct
 * fallback should pass `onSettled`; it runs after taskkill exits, errors, or
 * exceeds `timeoutMs`, avoiding the race where killing cmd.exe first prevents
 * taskkill from enumerating and killing grandchildren.
 */
export function killWin32Tree(pid: number, opts: Win32TreeKillOptions = {}): boolean {
  try {
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        opts.onSettled?.();
      } catch {
        /* fallback callbacks are best-effort */
      }
    };
    // spawn() reports a failure to launch (e.g. taskkill not on PATH, blocked by
    // security software) via an ASYNC 'error' event — the surrounding try/catch
    // only traps synchronous throws. Without a listener that event is unhandled
    // and crashes the whole process. Swallow it: this is best-effort tree-kill
    // and the registry still has the direct child.kill() fallback.
    child.on('error', settle);
    child.on('close', settle);
    timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      settle();
    }, Math.max(1, opts.timeoutMs ?? WIN32_TASKKILL_TIMEOUT_MS));
    timeout.unref?.();
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export class ProcessRegistryImpl {
  private readonly processes = new Map<number, TrackedProcess>();
  private readonly breaker: CircuitBreaker;

  /**
   * Auto kill/reset config. When the breaker trips and `autoKillResetMs > 0`,
   * a countdown is armed; on expiry all tracked processes are killed and the
   * breaker is reset to closed (forced recovery). Zero means manual recovery
   * only (`/kill reset`).
   */
  private autoKillResetMs = 0;
  private autoKillTimer: ReturnType<typeof setTimeout> | null = null;
  private autoKillArmedAt: number | null = null;
  private breakerCountdownListeners: BreakerCountdownListener[] = [];

  constructor(breakerConfig?: CircuitBreakerConfig) {
    this.breaker = new CircuitBreaker(breakerConfig);
    // Arm on trip, cancel on recovery. Listeners are best-effort.
    this.breaker.onTrip = () => this._armAutoKillReset();
    this.breaker.onReset = () => this._cancelAutoKillReset();
    // Protection is OFF by default — the user opts in via `/settings breaker on`.
    this.breaker.setEnabled(false);
  }

  register(
    info: Omit<TrackedProcess, 'killed' | 'protected' | 'background'> & {
      protected?: boolean | undefined;
      background?: boolean | undefined;
    },
  ): void {
    this.processes.set(info.pid, {
      ...info,
      killed: false,
      protected: info.protected ?? false,
      background: info.background ?? false,
    });
  }

  private _isSafeSignalPid(pid: number): boolean {
    return Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
  }

  private _canSignalProcessGroup(p: TrackedProcess): boolean {
    return (
      os.platform() !== 'win32' &&
      p.processGroupLeader === true &&
      this._isSafeSignalPid(p.pid) &&
      p.child !== null &&
      typeof p.child.pid === 'number' &&
      p.child.pid === p.pid
    );
  }

  private _killChildDirect(p: TrackedProcess, signal: NodeJS.Signals): void {
    try {
      if (p.child) {
        p.child.kill(signal);
        return;
      }
      // Persistent-registry mirror entry: no live handle — signal by PID
      // (guarded so a bogus persisted PID can never target pid 0/1/self).
      if (this._isSafeSignalPid(p.pid)) process.kill(p.pid, signal);
    } catch {
      // Process may have already exited.
    }
  }

  private _killPosix(p: TrackedProcess, signal: NodeJS.Signals): void {
    if (this._canSignalProcessGroup(p)) {
      try {
        process.kill(-p.pid, signal);
        return;
      } catch {
        // Process group may already be gone; fall back to the direct child.
      }
    }
    this._killChildDirect(p, signal);
  }

  /** Unregister a process by PID. Called on 'close' / 'exit' events. */
  unregister(pid: number): void {
    this.processes.delete(pid);
  }

  /** Get a single process by PID. */
  get(pid: number): TrackedProcess | undefined {
    this._pruneStale(pid);
    return this.processes.get(pid);
  }

  /** Get all tracked processes. */
  list(): TrackedProcess[] {
    this._pruneAllStale();
    return Array.from(this.processes.values());
  }

  /** Get processes filtered by name (e.g. 'bash', 'exec'). */
  byName(name: string): TrackedProcess[] {
    return this.list().filter((p) => p.name === name);
  }

  /** Get processes filtered by session. */
  bySession(sessionId: string): TrackedProcess[] {
    return this.list().filter((p) => p.sessionId === sessionId);
  }

  /** Count of active (non-killed) processes. */
  get activeCount(): number {
    let n = 0;
    for (const p of this.processes.values()) {
      if (!p.killed) n++;
    }
    return n;
  }

  /** Count of active jobs explicitly launched in background mode. */
  get activeBackgroundCount(): number {
    let n = 0;
    for (const p of this.processes.values()) {
      if (p.background && !p.killed) n++;
    }
    return n;
  }

  /**
   * Combined stats for observability — used by /ps and the TUI status bar.
   */
  stats(): RegistryStats {
    this._pruneAllStale();
    return {
      activeCount: this.activeCount,
      backgroundCount: this.activeBackgroundCount,
      totalCount: this.processes.size,
      breaker: this.breaker.snapshot(),
    };
  }

  /**
   * Returns true if the circuit allows a new bash/exec call to proceed.
   * When false, callers MUST NOT spawn a process.
   */
  get canProceed(): boolean {
    return this.breaker.canProceed;
  }

  /**
   * Called before spawning a process. Returns true if allowed; false if
   * the circuit breaker is open.
   *
   * @param bypass - If true, skip circuit breaker check (for background processes).
   */
  beforeCall(bypass = false): boolean {
    return this.breaker.beforeCall(bypass);
  }

  /**
   * Called after a process finishes. `durationMs` is wall-clock time;
   * `failed` is true for non-zero exit codes.
   *
   * @param bypass - If true, do not update circuit breaker state (for background processes).
   */
  afterCall(durationMs: number, failed: boolean, bypass = false): void {
    this.breaker.afterCall(durationMs, failed, bypass);
  }

  /** Force-open the circuit breaker (Ctrl+C, /kill force). */
  forceBreakerOpen(): void {
    this.breaker.forceOpen();
  }

  /** Force-reset the circuit breaker to closed (/kill reset). */
  forceBreakerReset(): void {
    this.breaker.forceReset();
  }

  /**
   * Configure circuit-breaker protection at runtime. Called from `/settings`
   * (instant, all modes) and on TUI mount (applies persisted config).
   *
   * - `enabled` toggles whether the breaker gates `bash`/`exec`.
   * - `autoKillResetMs` arms the auto kill/reset countdown when the breaker
   *   trips (0 = manual recovery only).
   *
   * Re-applies cleanly on every call: cancels a pending countdown when the
   * timeout is cleared or protection disabled, and re-arms if the breaker is
   * currently open under the new settings.
   */
  setBreakerConfig(cfg: { enabled?: boolean | undefined; autoKillResetMs?: number | undefined }): void {
    if (cfg.enabled !== undefined) this.breaker.setEnabled(cfg.enabled);
    if (cfg.autoKillResetMs !== undefined) this.autoKillResetMs = Math.max(0, cfg.autoKillResetMs);

    if (this.autoKillResetMs <= 0) {
      this._cancelAutoKillReset();
      return;
    }
    // If protection is active and the breaker is currently tripped, ensure a
    // countdown is armed for the new window (covers a live config change while
    // the breaker is already open).
    if (this.breaker.isEnabled && this.breaker.snapshot().state === 'open') {
      this._armAutoKillReset();
    }
  }

  /**
   * Live countdown to the next auto kill/reset, or null when nothing is armed.
   * The TUI polls this on a 1s tick while armed so the statusline decrements.
   */
  getBreakerCountdown(): BreakerCountdown | null {
    if (this.autoKillArmedAt === null || this.autoKillResetMs <= 0) return null;
    const elapsed = Date.now() - this.autoKillArmedAt;
    return { remainingMs: Math.max(0, this.autoKillResetMs - elapsed), totalMs: this.autoKillResetMs };
  }

  /**
   * Subscribe to countdown arm/cancel events. Returns an unsubscribe function.
   * Use {@link getBreakerCountdown} for the live ticking value between events.
   */
  onBreakerCountdownChange(listener: BreakerCountdownListener): () => void {
    this.breakerCountdownListeners.push(listener);
    return () => {
      this.breakerCountdownListeners = this.breakerCountdownListeners.filter((l) => l !== listener);
    };
  }

  private _emitBreakerCountdown(): void {
    const snap = this.getBreakerCountdown();
    for (const l of this.breakerCountdownListeners) {
      try {
        l(snap);
      } catch {
        /* listener failure must never affect breaker behavior */
      }
    }
  }

  /**
   * Arm the auto kill/reset countdown. Idempotent: re-arming resets the window
   * (a fresh trip after a failed half-open probe restarts the clock). No-op
   * when protection is off or no timeout is configured.
   */
  private _armAutoKillReset(): void {
    if (this.autoKillResetMs <= 0 || !this.breaker.isEnabled) return;
    this._clearAutoKillTimer();
    this.autoKillArmedAt = Date.now();
    this.autoKillTimer = setTimeout(() => {
      this.autoKillTimer = null;
      this.autoKillArmedAt = null;
      // Forced recovery: nuke runaway processes and reopen the circuit.
      this.killAll({ force: false, preserveBackground: true });
      this.breaker.forceReset();
      this._emitBreakerCountdown();
    }, this.autoKillResetMs);
    // Don't keep the event loop alive purely for auto-recovery.
    this.autoKillTimer.unref?.();
    this._emitBreakerCountdown();
  }

  private _cancelAutoKillReset(): void {
    const wasArmed = this.autoKillArmedAt !== null;
    this._clearAutoKillTimer();
    if (wasArmed) {
      this.autoKillArmedAt = null;
      this._emitBreakerCountdown();
    }
  }

  private _clearAutoKillTimer(): void {
    if (this.autoKillTimer !== null) {
      clearTimeout(this.autoKillTimer);
      this.autoKillTimer = null;
    }
  }

  /** Kill a single process by PID.
   *
   *  On POSIX: sends SIGTERM to the *process group* (-pid) so that
   *  runaway grandchild processes (`sleep 9999 & disown`) are also killed.
   *  After `graceMs` a SIGKILL is sent if the process hasn't exited.
   *
   *  On Windows: `child.kill()` maps to TerminateProcess — process groups
   *  are not meaningfully supported. A second `force=true` call sends
   *  SIGKILL (which maps to TerminateProcess again — the distinction is
   *  in the exit code, not the signal).
   *
   *  Returns true if the process was found and kill was attempted.
   */
  kill(pid: number, opts: KillOpts = {}): boolean {
    this._pruneStale(pid);
    const p = this.processes.get(pid);
    if (!p) return false;
    // Already kill()ed: a plain repeat is a no-op (don't re-send SIGTERM and
    // re-arm grace timers), but a `force: true` repeat is allowed through so
    // a process that ignored/survived the first kill can be ESCALATED to
    // SIGKILL. The old unconditional latch made `kill(pid, {force: true})`
    // after a timed-out soft kill silently do nothing.
    if (p.killed && opts.force !== true) return true;
    // Protected processes refuse kill unless the caller opts in (host shutdown).
    if (p.protected && opts.includeProtected !== true) return false;
    if (opts.preserveBackground && p.background) return false;

    const { force = false, graceMs = DEFAULT_GRACE_MS } = opts;
    const isWin = os.platform() === 'win32';

    if (isWin) {
      // Windows: no process group semantics. A direct kill terminates only
      // the immediate child — shell-wrapped commands (cmd.exe /c …) leave
      // grandchildren running that hold the inherited stdio pipes open and
      // keep feeding output into this process indefinitely. Kill the whole
      // tree via taskkill instead, but only for a real, still-running child
      // (exitCode === null); test fakes and already-exited processes take
      // the plain-kill path. The direct kill is deliberately NOT sent
      // immediately alongside taskkill: killing the root first would break
      // taskkill's parent-pid tree enumeration and orphan the grandchildren
      // again — it runs as a delayed fallback instead.
      // Persistent-registry mirror entries have no live handle — tree-kill by
      // PID is the only option (and also the correct one).
      const liveRealChild =
        p.child === null || (p.child.exitCode === null && typeof p.child.pid === 'number');
      const directFallback = () => {
        if (p.child && p.child.exitCode === null) {
          try {
            p.child.kill('SIGKILL');
          } catch {
            // Process may have already exited.
          }
        }
      };
      if (
        liveRealChild &&
        killWin32Tree(pid, {
          timeoutMs: Math.max(graceMs, WIN32_TASKKILL_TIMEOUT_MS),
          onSettled: directFallback,
        })
      ) {
        // The direct fallback is intentionally chained from taskkill's
        // completion. Killing cmd.exe before taskkill has walked the tree can
        // orphan the real command and leave stdio pipes open forever.
      } else {
        this._killChildDirect(p, force ? 'SIGKILL' : 'SIGTERM');
      }
      p.killed = true;
      return true;
    }

    // POSIX: kill the process group only when the tracked child is proven to
    // be the group leader. Otherwise use child.kill(); negative PID signaling
    // with untrusted/fake PIDs can target unrelated host processes.
    try {
      if (force) {
        this._killPosix(p, 'SIGKILL');
      } else {
        this._killPosix(p, 'SIGTERM');
        // Schedule SIGKILL as backup.
        const timer = setTimeout(() => {
          // Re-check: process may have exited on its own. Null-child
          // (persistent mirror) entries have no `.killed` latch — escalate.
          if (this.processes.has(pid) && !p.child?.killed) {
            this._killPosix(p, 'SIGKILL');
          }
        }, graceMs);
        timer.unref?.(); // Don't keep event loop alive.
      }
    } catch {
      // Process may have already exited.
    }
    p.killed = true;
    return true;
  }

  /**
   * Kill all tracked processes.
   * Returns the PIDs that were kill()ed.
   */
  killAll(opts: KillOpts = {}): number[] {
    const pids = Array.from(this.processes.keys());
    const killed: number[] = [];
    const includeProtected = opts.includeProtected === true;
    for (const pid of pids) {
      const p = this.processes.get(pid);
      if (!p) continue;
      if (p.protected && !includeProtected) continue;
      if (opts.preserveBackground && p.background) continue;
      if (this.kill(pid, opts)) killed.push(pid);
    }
    return killed;
  }

  /**
   * Kill all processes for a specific session.
   * Returns the PIDs that were kill()ed.
   */
  killSession(sessionId: string, opts: KillOpts = {}): number[] {
    const pids = this.bySession(sessionId).map((p) => p.pid);
    const killed: number[] = [];
    for (const pid of pids) {
      if (this.kill(pid, opts)) killed.push(pid);
    }
    return killed;
  }

  /**
   * Check whether a tracked process entry is stale — the child has exited
   * (exitCode !== null) AND it's been in the registry long enough that the
   * OS may have reused the PID for a new, unrelated process.
   *
   * P3 #24 (before-release.md): on POSIX, PIDs are reused after process
   * exit. If a tracked process exits but its 'close' event hasn't fired yet
   * (or was missed), the registry still holds the entry. A new process
   * gets the same PID, and PID-based lookups (get, kill, shouldBlockKill)
   * may incorrectly protect or target the wrong process.
   *
   * The 60s threshold is conservative — the OS typically waits much longer
   * before reusing a PID, but we want to clean up before that becomes a risk.
   */
  private _isStaleEntry(entry: TrackedProcess): boolean {
    if (entry.child === null) {
      // Persistent-registry mirror entry — no live handle to consult.
      // (The old code dereferenced `entry.child.exitCode` here and threw a
      // TypeError from get()/list()/stats()/kill() for every such entry.)
      if (Date.now() - entry.startedAt <= 60_000) return false;
      // win32: signal-0 probes are unreliable (no ESRCH semantics worth
      // trusting through Node) — keep the entry; the persistent registry's
      // own heartbeat/reaper owns cross-instance cleanup there.
      if (os.platform() === 'win32') return false;
      // POSIX: PID liveness probe. Signal 0 performs no kill; ESRCH means the
      // process is gone (stale), EPERM means it exists but isn't ours (live).
      try {
        process.kill(entry.pid, 0);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== 'EPERM';
      }
    }
    return entry.child.exitCode !== null && Date.now() - entry.startedAt > 60_000;
  }

  /**
   * Remove a stale entry for a specific PID before any PID-based lookup.
   * This prevents PID reuse from causing the registry to act on a dead
   * process that has been replaced by a new one with the same PID.
   */
  private _pruneStale(pid: number): void {
    const entry = this.processes.get(pid);
    if (entry && this._isStaleEntry(entry)) {
      this.processes.delete(pid);
    }
  }

  /**
   * Remove every stale entry, not just one PID. `list()`/`stats()` — the
   * surfaces the TUI status bar and `/ps` poll — must prune too: a child
   * whose 'close' event never fires (e.g. Windows grandchildren holding stdio
   * open) would otherwise linger in the registry until someone looks up its
   * exact PID, and PID reuse meanwhile makes `get()`/`kill()` target the
   * wrong process. RAM-leak audit 2026-07-31, MEDIUM.
   */
  private _pruneAllStale(): void {
    for (const [pid, entry] of this.processes) {
      if (this._isStaleEntry(entry)) this.processes.delete(pid);
    }
  }
}

/** Module-level singleton. Initialized on first access. */
let _registry: ProcessRegistryImpl | undefined;

export function getProcessRegistry(): ProcessRegistryImpl {
  if (!_registry) {
    _registry = new ProcessRegistryImpl();
  }
  return _registry;
}

/** Reset for tests. */
export function _resetProcessRegistry(): void {
  _registry = undefined;
}

// ── Convenience re-exports ────────────────────────────────────────────────────

export type { KillOpts };
