import { expectDefined } from '@wrongstack/core';
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
   *  and degrades gracefully on Windows. */
  child: ChildProcess;
  /** True once the process has been kill()ed but not yet exited.
   *  We keep it in the registry until 'close' fires so callers can
   *  distinguish "still running" from "just exited". */
  killed: boolean;
  /** If true, kill() and killAll() will refuse to kill this process.
   *  Used for infrastructure processes (browser, dev servers, …) that
   *  must outlive the agent session. */
  protected: boolean;
}

// Sensitive CLI flag patterns that may appear in process command lines.
// Redacted to [REDACTED] so crash dumps /ps output cannot leak secrets.
const SENSITIVE_FLAG_PATTERNS: RegExp[] = [
  // --flag=value  or  --flag "value"  (value captured up to next space or comma)
  /--(?:token|password|passwd|pwd|secret|api[-_]?key|api[-_]?secret|auth|credential|private[-_]?key|access[-_]?key|github[-_]?token|gh[-_]?token|bearer|jwt|oauth|pin|pincode|passphrase|access[-_]?token)(?:[=\s,][^\s]*)?/gi,
  // -f "value" style short flags
  /(?<!\w)-t(?:\s+|\s*=\s*)[^\s,]+/,
  /(?<!\w)-p(?:ssword)?(?:\s+|\s*=\s*)[^\s,]+/gi,
  // env var–style secrets: TOKEN=x, API_KEY=y, etc.
  /(?:TOKEN|API_KEY|API_SECRET|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|BEARER|JWT|OAUTH|CREDENTIAL|SECRET|PRIVATE_KEY|PASSWORD|PASSWD)\s*[=:]\s*[^\s,]+/gi,
  // Generic high-entropy look: base64 strings >32 chars or hex strings >32 digits — but only
  // when preceded by a flag name (e.g. --github-token=EyJ...).
  /--\w*(?:token|key|secret|password|passwd|auth|credential)\w*[=\s,][A-Za-z0-9+/=]{32,}/,
];

/**
 * Returns a display-safe copy of `cmd` with sensitive flag values replaced by [REDACTED].
 * The original string is unchanged; this is pure and has no side effects.
 */
export function redactCommand(cmd: string): string {
  let result = cmd;
  for (const pattern of SENSITIVE_FLAG_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Preserve the flag name portion; redact only the value part.
      // e.g. "--token=sekrit_abc"  →  "--token=[REDACTED]"
      const eq = match.indexOf('=');
      const sp = match.search(/\s/);
      const delim = eq !== -1 ? '=' : sp !== -1 ? match[sp] : null;
      if (delim !== null) {
        const flag = match.slice(0, match.indexOf(expectDefined(delim)) + 1);
        return `${flag}[REDACTED]`;
      }
      // Nothing delimitable found; replace the whole token silently.
      // Short flags like -tVALUE are replaced entirely to avoid edge cases.
      const flagEnd = match.match(/^--?[a-zA-Z][a-zA-Z0-9_-]*/)?.[0] ?? match;
      return `${flagEnd}=**redacted**`;
    });
  }
  return result;
}

interface KillOpts {
  /** SIGKILL instead of SIGTERM. Default: false (SIGTERM first). */
  force?: boolean | undefined;
  /** MS to wait between SIGTERM and SIGKILL on POSIX. Default: 2000. */
  graceMs?: number | undefined;
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
  totalCount: number;
  breaker: CircuitBreakerSnapshot;
}

const DEFAULT_GRACE_MS = 2000;

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
 * Fire-and-forget: returns true if taskkill was spawned, false if spawning
 * it failed (caller should fall back to a direct `child.kill()`).
 */
export function killWin32Tree(pid: number): boolean {
  try {
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    // spawn() reports a failure to launch (e.g. taskkill not on PATH, blocked by
    // security software) via an ASYNC 'error' event — the surrounding try/catch
    // only traps synchronous throws. Without a listener that event is unhandled
    // and crashes the whole process. Swallow it: this is best-effort tree-kill
    // and the registry still has the direct child.kill() fallback.
    child.on('error', () => {});
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

  register(info: Omit<TrackedProcess, 'killed' | 'protected'> & { protected?: boolean | undefined }): void {
    this.processes.set(info.pid, { ...info, killed: false, protected: info.protected ?? false });
  }

  /** Unregister a process by PID. Called on 'close' / 'exit' events. */
  unregister(pid: number): void {
    this.processes.delete(pid);
  }

  /** Get a single process by PID. */
  get(pid: number): TrackedProcess | undefined {
    return this.processes.get(pid);
  }

  /** Get all tracked processes. */
  list(): TrackedProcess[] {
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

  /**
   * Combined stats for observability — used by /ps and the TUI status bar.
   */
  stats(): RegistryStats {
    return {
      activeCount: this.activeCount,
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
      this.killAll({ force: false });
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
    const p = this.processes.get(pid);
    if (!p) return false;
    if (p.killed) return true; // already kill()ed, don't double-send
    if (p.protected) return false; // protected processes are never kill()ed

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
      const liveRealChild = p.child.exitCode === null && typeof p.child.pid === 'number';
      if (liveRealChild && killWin32Tree(pid)) {
        const fallback = setTimeout(() => {
          if (p.child.exitCode === null) {
            try {
              p.child.kill('SIGKILL');
            } catch {
              // Process may have already exited.
            }
          }
        }, graceMs);
        fallback.unref?.();
      } else {
        try {
          p.child.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // Process may have already exited.
        }
      }
      p.killed = true;
      return true;
    }

    // POSIX: kill the process group so grandchildren are cleaned up too.
    try {
      if (force) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          p.child.kill('SIGKILL');
        }
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          p.child.kill('SIGTERM');
        }
        // Schedule SIGKILL as backup.
        const timer = setTimeout(() => {
          // Re-check: process may have exited on its own.
          if (this.processes.has(pid) && !p.child.killed) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              try {
                p.child.kill('SIGKILL');
              } catch {
                /* already gone */
              }
            }
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
    for (const pid of pids) {
      const p = this.processes.get(pid);
      if (p && !p.protected && this.kill(pid, opts)) killed.push(pid);
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