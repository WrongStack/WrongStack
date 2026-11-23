/**
 * TerminalServer — answers `terminal/*` methods from an ACP agent.
 *
 * The spec lets agents spawn shell commands inside the client's
 * environment and observe their output. We honour the protocol, but
 * every command runs under a per-process timeout and a byte limit on
 * retained output, both to keep runaway agents from filling memory
 * and to give the runner a clean signal when something is stuck.
 *
 * Scoping: commands run with `cwd` set to the agent's requested cwd
 * if its canonical path is inside `projectRoot`, else `projectRoot`.
 * Agent env entries are overlaid on a credential-scrubbed base, except
 * for variables that enable preload injection or path hijacking.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { treeKill } from '@wrongstack/core/utils/tree-kill';
import { buildWin32CmdShimInvocation } from '../win32-cmd.js';

const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * The `.cmd`/`.bat` a Windows command resolves to, if any. `spawn` without a
 * shell cannot run one — a bare `npm` fails ENOENT (no PATHEXT lookup), an
 * absolute `npm.cmd` fails EINVAL (CVE-2024-27980) — so those go through the
 * canonical cmd.exe shim builder. Only batch files: routing a real `.exe`
 * through cmd.exe would make the builder refuse `"`/`%` arguments it never
 * needed to see. Mirrors the PATHEXT walk of tools' resolveWin32Command.
 */
function win32BatchTarget(command: string): string | undefined {
  if (/\.(?:cmd|bat)$/i.test(command)) return command;
  if (/[\\/]/.test(command) || path.extname(command)) return undefined;
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';');
  for (const rawDir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    // cmd.exe and libuv accept a quoted entry (`"C:\Program Files\nodejs"`);
    // joined verbatim it named no file and `npm` was spawned bare -> ENOENT.
    const dir = rawDir.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const ext of exts) {
      if (!ext) continue;
      const full = path.join(dir, `${command}${ext}`);
      try {
        accessSync(full);
      } catch {
        continue;
      }
      return ext === '.cmd' || ext === '.bat' ? full : undefined;
    }
  }
  return undefined;
}

// Read once at module load — captures `WRONGSTACK_DEBUG=1` style env toggles.
// Debug-only logging in dispose() is gated on this so production is silent.
// Matches the convention used elsewhere in the repo (CLI --debug / docs).
const DEBUG_DISPOSE =
  typeof process !== 'undefined' &&
  !!process.env?.WRONGSTACK_DEBUG &&
  process.env.WRONGSTACK_DEBUG !== '0' &&
  process.env.WRONGSTACK_DEBUG !== 'false';

export interface TerminalServerOptions {
  projectRoot: string;
  /** Hard cap on per-command wall-clock. Default 5 minutes. */
  commandTimeoutMs?: number;
  /** Bytes of output to retain per terminal. Default 1 MiB. */
  outputByteLimit?: number;
  /**
   * Hard maximum cap on the per-call `outputByteLimit`. The agent can request
   * a lower limit per terminal/create, but it can never raise it above this
   * host-configured ceiling. Protects against memory exhaustion from a
   * malicious agent requesting `outputByteLimit: Infinity`. Default 16 MiB.
   */
  maxOutputByteLimit?: number;
  /** Maximum terminal records retained concurrently. Default 32. */
  maxTerminals?: number;
  /** Optional abort signal that kills ALL active terminals. */
  signal?: AbortSignal;
}

interface TerminalState {
  proc: ReturnType<typeof spawn>;
  cwd: string;
  command: string;
  args: string[];
  /** Byte chunks retained as a bounded queue. Joined only when output is read. */
  outputChunks: Buffer[];
  /** Index of the first live chunk; avoids O(n) Array.shift calls. */
  outputHead: number;
  /** Bytes currently retained (post-truncation). */
  retainedBytes: number;
  /** True once we've dropped output to fit under the per-call byte limit. */
  truncated: boolean;
  exitStatus?: { exitCode: number | null; signal: string | null } | undefined;
  /** Resolves when the process exits. */
  exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
  /** Per-terminal timeout handle. */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  /** Named so release() can detach pipes even when the child never closes. */
  onData?: ((chunk: string) => void) | undefined;
}

export class TerminalServer {
  private readonly terminals = new Map<string, TerminalState>();
  /**
   * Stable per-instance identifier for debug logs. 8 hex chars is enough
   * to disambiguate concurrent TerminalServers in a trace; not meant to
   * be cryptographically unique.
   */
  private readonly instanceId: string;
  private readonly projectRoot: string;
  private readonly commandTimeoutMs: number;
  private readonly outputByteLimit: number;
  private readonly maxOutputByteLimit: number;
  private readonly maxTerminals: number;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly abortHandler = (): void => this.dispose();
  private disposed = false;
  private nextId = 1;

  constructor(opts: TerminalServerOptions) {
    this.projectRoot = path.resolve(opts.projectRoot);
    // Node turns a delay above 2^31-1 ms into 1 ms: a longer deadline would
    // kill every command at once, so cap it (as acp-session-callbacks does).
    this.commandTimeoutMs = Math.min(opts.commandTimeoutMs ?? 5 * 60_000, 2_147_483_647);
    this.outputByteLimit = this.clampFiniteInt(opts.outputByteLimit, 1024 * 1024);
    this.maxOutputByteLimit = this.clampFiniteInt(opts.maxOutputByteLimit, 16 * 1024 * 1024);
    // Short, grep-friendly, no PII. 8 hex chars ≈ 4B values — plenty to
    // disambiguate concurrent TerminalServers within a single process.
    this.instanceId = `term_srv_${randomBytes(4).toString('hex')}`;
    this.maxTerminals = this.clampFiniteInt(opts.maxTerminals, 32);
    this.abortSignal = opts.signal;
    if (opts.signal?.aborted) {
      this.dispose();
    } else if (opts.signal) {
      opts.signal.addEventListener('abort', this.abortHandler, { once: true });
    }
  }

  /** Spawn a new terminal. Returns the agent-facing id. */
  create(params: {
    sessionId: string;
    command: string;
    args?: string[];
    env?: { name: string; value: string }[];
    cwd?: string;
    outputByteLimit?: number;
  }): { terminalId: string } {
    // Guard against post-dispose reuse. Otherwise a caller that ignores
    // the dispose() signal (or holds a stale ref across an async boundary)
    // would silently spawn an orphan child process whose output we would
    // never deliver to anywhere — exactly the leak mode dispose() exists
    // to prevent. Throw loudly so the bug surfaces at the call site.
    if (this.disposed) {
      throw new Error(
        'TerminalServer is disposed — create a new TerminalServer instead of reusing this one',
      );
    }

    if (this.terminals.size >= this.maxTerminals) {
      throw new Error(
        `terminal limit reached (${this.maxTerminals}); release an existing terminal before creating another`,
      );
    }
    const id = `term_${this.nextId++}`;
    const cwd = this.resolveCwd(params.cwd);
    const perCallByteLimit = Math.min(
      Math.max(1, this.clampFiniteInt(params.outputByteLimit, this.outputByteLimit)),
      this.maxOutputByteLimit,
    );
    const batch = process.platform === 'win32' ? win32BatchTarget(params.command) : undefined;
    // Throws on cmd.exe metacharacters; the terminal/create handler reports it.
    const shim = batch ? buildWin32CmdShimInvocation(batch, params.args ?? []) : undefined;
    const proc = spawn(shim?.command ?? params.command, shim?.args ?? params.args ?? [], {
      cwd,
      env: this.buildEnv(params.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
      // shell: false on purpose. The terminal server is invoked with
      // the agent's explicit argv; turning on shell-mode would make
      // the command a single shell-parsed string, which breaks
      // Windows cmd quoting for the common case of running node with
      // `-e "<script>"`. If a future feature needs shell features
      // (pipes, redirects), it should be opt-in per-call, not the
      // default.
    });

    const state: TerminalState = {
      proc,
      cwd,
      command: params.command,
      args: params.args ?? [],
      outputChunks: [],
      outputHead: 0,
      retainedBytes: 0,
      truncated: false,
      exitStatus: undefined,
      timeoutHandle: null,
      exitPromise: new Promise((resolve) => {
        proc.on('close', (code, signalName) => {
          if (state.timeoutHandle) {
            clearTimeout(state.timeoutHandle);
            state.timeoutHandle = null;
          }
          const exitStatus =
            state.exitStatus ??
            ({
              exitCode: typeof code === 'number' ? code : null,
              signal: typeof signalName === 'string' ? signalName : null,
            } as const);
          state.exitStatus = exitStatus;
          resolve(exitStatus);
        });
        proc.on('error', (err) => {
          // Spawn-time errors (ENOENT etc.) — surface as a special
          // exit status with exitCode 127 (command not found).
          if (state.timeoutHandle) {
            clearTimeout(state.timeoutHandle);
            state.timeoutHandle = null;
          }
          const exitStatus = { exitCode: 127, signal: null };
          state.exitStatus = exitStatus;
          let errorOutput = Buffer.from(`[spawn error] ${err.message}\n`, 'utf8');
          if (errorOutput.length > perCallByteLimit) {
            let start = errorOutput.length - perCallByteLimit;
            while (start < errorOutput.length && (errorOutput[start]! & 0xc0) === 0x80) start++;
            errorOutput = errorOutput.subarray(start);
            state.truncated = true;
          }
          state.outputChunks.push(errorOutput);
          state.retainedBytes = errorOutput.length;
          resolve(exitStatus);
        });
      }),
    };

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    const onData = (chunk: string): void => {
      const outputChunk = Buffer.from(chunk, 'utf8');
      state.outputChunks.push(outputChunk);
      state.retainedBytes += outputChunk.length;
      if (state.retainedBytes > perCallByteLimit) state.truncated = true;

      // Evict from the head. Each chunk is visited at most twice, so frequent
      // tiny writes do not repeatedly copy the full retained output window.
      while (
        state.retainedBytes > perCallByteLimit &&
        state.outputHead < state.outputChunks.length
      ) {
        const first = state.outputChunks[state.outputHead]!;
        const overflow = state.retainedBytes - perCallByteLimit;
        if (first.length <= overflow) {
          state.outputChunks[state.outputHead] = EMPTY_BUFFER;
          state.outputHead++;
          state.retainedBytes -= first.length;
          continue;
        }

        let start = overflow;
        while (start < first.length && (first[start]! & 0xc0) === 0x80) start++;
        state.outputChunks[state.outputHead] = first.subarray(start);
        state.retainedBytes -= start;
      }

      if (state.outputHead >= 256 && state.outputHead * 2 >= state.outputChunks.length) {
        state.outputChunks = state.outputChunks.slice(state.outputHead);
        state.outputHead = 0;
      }
    };
    state.onData = onData;
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    state.timeoutHandle = setTimeout(() => {
      // Best-effort kill; we don't have an exact "TIMEOUT" stop reason
      // so we just exit with -1.
      // POSIX treeKill gracefully signals only the direct child because this
      // process is not spawned as a process group; descendants may outlive it.
      // Windows uses taskkill /T /F to tear down the full process tree.
      treeKill(proc);
    }, this.commandTimeoutMs);

    this.terminals.set(id, state);
    return { terminalId: id };
  }

  /** Return captured output and (if available) the exit status. */
  output(terminalId: string): {
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  } {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`unknown terminal: ${terminalId}`);
    return {
      output: Buffer.concat(
        state.outputChunks.slice(state.outputHead),
        state.retainedBytes,
      ).toString('utf8'),
      truncated: state.truncated,
      ...(state.exitStatus ? { exitStatus: state.exitStatus } : {}),
    };
  }

  /** Block until the process exits. Resolves with the exit status. */
  async waitForExit(
    terminalId: string,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`unknown terminal: ${terminalId}`);
    return state.exitPromise;
  }

  /**
   * Kill the process but keep the terminal record (agent can still read output).
   * On POSIX this signals only the direct child; descendants may survive because
   * terminal processes are not spawned as process-group leaders.
   */
  kill(terminalId: string): void {
    const state = this.terminals.get(terminalId);
    if (!state) throw new Error(`unknown terminal: ${terminalId}`);
    treeKill(state.proc);
  }

  /** Kill the process if alive and remove the record. */
  release(terminalId: string): void {
    const state = this.terminals.get(terminalId);
    if (!state) return;
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = null;
    }
    if (state.onData) {
      state.proc.stdout?.off('data', state.onData);
      state.proc.stderr?.off('data', state.onData);
      state.onData = undefined;
    }
    state.proc.stdout?.destroy?.();
    state.proc.stderr?.destroy?.();
    state.outputChunks.length = 0;
    state.outputHead = 0;
    state.retainedBytes = 0;
    treeKill(state.proc, { force: true });
    this.terminals.delete(terminalId);
  }

  /**
   * Release all resources held by this server: kill every active terminal
   * and detach the host `AbortSignal` listener.
   *
   * Idempotent — calling it multiple times is safe. Required because the
   * previously-coded `releaseAll()` was the only path that removed the
   * abort listener: if the host never called it (unhandled error path,
   * host crash, GC of the session without explicit close), the listener
   * pinned `this` (terminals Map, output buffers) for the lifetime of the
   * signal. With `dispose()` this is no longer leak-prone.
   *
   * Also exposed as `[Symbol.dispose]` for `using` blocks in Node ≥ 22.
   *
   * RAM-leak audit 2026-08-11, MEDIUM (Finding 2).
   */
  dispose(): void {
    if (this.disposed) return;
    // Capture pre-teardown child count so the log shows the snapshot at
    // the moment we entered dispose(), not after the release() loop has
    // emptied the map. Gate on `WRONGSTACK_DEBUG` so production is silent.
    if (DEBUG_DISPOSE) {
      const activeChildren = this.terminals.size;
      console.debug(
        JSON.stringify({
          event: 'terminal_server.disposed',
          instanceId: this.instanceId,
          activeChildren,
          hadSignal: this.abortSignal !== undefined,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    this.disposed = true;
    this.abortSignal?.removeEventListener('abort', this.abortHandler);
    for (const id of [...this.terminals.keys()]) {
      this.release(id);
    }
  }

  /** Alias for `dispose()` — enables `using new TerminalServer(...)`. */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Kill all active terminals. Used on session close.
   *
   * @deprecated Prefer `dispose()` (or `using { … }` via `Symbol.dispose`).
   * `releaseAll` is retained as a delegated wrapper for callers that still
   * reference it; new code should call `dispose()` directly so the
   * host-signal listener is removed unconditionally.
   */
  releaseAll(): void {
    this.dispose();
  }

  private resolveCwd(cwd: string | undefined): string {
    if (!cwd) return this.projectRoot;
    const resolved = path.resolve(cwd);
    if (!isInsideRoot(resolved, this.projectRoot)) {
      return this.projectRoot;
    }
    try {
      const realRoot = realpathSync(this.projectRoot);
      const realCwd = realpathSync(resolved);
      if (!isInsideRoot(realCwd, realRoot)) {
        return realRoot;
      }
      return realCwd;
    } catch {
      // A process cannot start in a missing/unresolvable cwd. Fall back to the
      // configured root rather than allowing spawn to fail or follow a bad link.
      return this.projectRoot;
    }
  }

  private buildEnv(agentEnv?: { name: string; value: string }[]): NodeJS.ProcessEnv {
    // Use the sanitized child env from @wrongstack/core instead of raw
    // process.env. This strips API keys, tokens, and other credentials from
    // the host environment so a compromised ACP agent cannot exfiltrate them
    // via `terminal/create`. buildChildEnv preserves system/tooling variables
    // (PATH, HOME, LANG, ...) and handles the Windows Path/PATH aliasing.
    const env: NodeJS.ProcessEnv = buildChildEnv();
    if (agentEnv) {
      for (const { name, value } of agentEnv) {
        // Deny agent overrides of environment variables that could re-introduce
        // code injection (NODE_OPTIONS --require/--import/--loader), shared-library
        // preloading (LD_PRELOAD, DYLD_*), or path hijacking (PATH). buildChildEnv
        // already stripped these from the host env; the agent must not be able to
        // add them back.
        const upper = name.toUpperCase();
        if (DENIED_AGENT_ENV_KEYS.has(upper)) continue;
        env[name] = value;
      }
    }
    return env;
  }

  /**
   * Clamp an agent-supplied numeric to a finite positive safe integer, falling
   * back to `defaultValue` for undefined/NaN/non-finite values. Prevents
   * negative, NaN, or Infinity values from disabling output caps or causing
   * unbounded memory growth.
   */
  private clampFiniteInt(value: number | undefined, defaultValue: number): number {
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      value < 1 ||
      !Number.isSafeInteger(Math.trunc(value))
    ) {
      return defaultValue;
    }
    return Math.trunc(value);
  }
}

/**
 * `child` is `root` or below it. Windows paths are case-insensitive: a client
 * sending `d:\…` for a `D:\…` root must not fail the check and have its
 * command silently run in the project root instead (FileServer does the same).
 */
function isInsideRoot(child: string, root: string): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const c = fold(child);
  const r = fold(root);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Environment variables an ACP agent must NOT be allowed to set, because they
 * can re-introduce code injection or path hijacking after `buildChildEnv`
 * already stripped them from the host env. Checked case-insensitively.
 */
const DENIED_AGENT_ENV_KEYS: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'PERLLIB',
  'RUBYOPT',
  'RUBYLIB',
]);
