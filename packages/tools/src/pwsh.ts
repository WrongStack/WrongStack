import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import {
  emitProcessCompleted,
  emitProcessOutput,
  emitProcessStarted,
} from '@wrongstack/core/observability';
import type { Context } from '@wrongstack/core/agent';
import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { type DangerAssessment, detectDanger } from './_danger-detect.js';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { diagnoseBashism, shellArgs } from './_shell-pick.js';
import { normalizeCommandOutput, safeResolveReal } from './_util.js';
import { resolvePowerShell } from './_win32-resolve.js';
import { checkAndBlockKillCommand } from './bash-kill-guard.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';

export interface PwshInput {
  command: string;
  workdir?: string | undefined;
  timeout_ms?: number | undefined;
  run_in_background?: boolean | undefined;
  background?: boolean | undefined;
  sandbox_permissions?: string | undefined;
  justification?: string | undefined;
}

export interface PwshOutput {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  pid?: number | null | undefined;
  job_id?: string | undefined;
  error?: string | undefined;
}

const MAX_OUTPUT = 32_768;
const DEFAULT_TIMEOUT_MS = 300_000;
const STREAM_FLUSH_INTERVAL_MS = 200;
const STREAM_FLUSH_BYTES = 4 * 1024;
const MAX_QUEUE_CHUNKS = 500;

export const PWSH_TOOL_DESCRIPTION =
  'Execute a PowerShell command (`pwsh -Command`) in a fresh process on Windows and return its stdout/stderr. ' +
  'Stateless per call: pass `workdir` instead of using `cd`.';

const PWSH_TOOL_USAGE_HINT =
  'Best practices & sandbox protocol for pwsh:\n' +
  '- **Stateless**: No cwd, variables, or functions persist between calls. Use `workdir` to set the directory.\n' +
  '- **Paths & Environs**: Use native Windows paths (`C:\\...`) and read env vars via `$env:NAME` (and `$env:DSH_*`).\n' +
  '- **Exit Codes**: Non-zero exits are reported as `[exit code: N]`. On Windows, a force-killed command settles as exit code 1 (interruption).\n' +
  '- **Background**: Set `run_in_background: true` for long-running processes (returns job id; manage via job_output/job_kill).\n' +
  '- **Sandboxing**: Under read-only sandbox, pwsh runs in `ConstrainedLanguage` mode (prefer cmdlets, basic types; .NET reflection and COM fail). Workspace-write runs in `FullLanguage`.\n' +
  '- **Escalation**: If denied by policy (`[sandbox: file access denied]`), retry once with `sandbox_permissions` plus a one-sentence `justification`.';

/**
 * Bootstrap PowerShell script wrapper with robust progress suppression,
 * UTF-8 encoding, error action defaults, and exit-code propagation.
 */
function wrapPwshCommand(command: string): string {
  const bootstrap =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;' +
    "$ProgressPreference = 'SilentlyContinue';" +
    "$ConfirmPreference = 'None';" +
    '$WhatIfPreference = $false';
  return (
    `${bootstrap}\n` +
    `$ErrorActionPreference = 'Stop'\n` +
    `${command}\n` +
    `if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE }`
  );
}

/**
 * Split a PowerShell command line into argv-shaped tokens for danger
 * classification.
 *
 * `detectDanger` rules inspect individual argv tokens (`-Force` as its own
 * element), but the pwsh tool receives the whole command as one string.
 * Passing that string as a single-element argv made every split-argument
 * rule structurally unable to fire on this path (e.g. `chmod 777 x` or
 * `Remove-Item -Recurse -Force` classified safe); only rules that regex the
 * whole line (pipe-to-shell, execution-policy) were effective.
 *
 * PowerShell-aware: single-quoted strings are literal (`''` escapes a
 * quote), double-quoted strings allow `""` and backtick escapes, and a
 * backtick outside quotes escapes the next character (including the
 * line-continuation newline). Quotes are stripped — they are syntax, not
 * content. An unterminated quote takes the rest of the line as one token.
 */
function tokenizePwshCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';

  const push = () => {
    if (current !== '') {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (ch === '`') {
      // Backtick escape: the next character (including a line-continuation
      // newline) loses its special meaning and joins the current token.
      const next = command.charAt(i + 1);
      if (next !== '') {
        current += next;
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < command.length) {
        const qch = command.charAt(i);
        if (qch === quote) {
          // A doubled quote (`''` / `""`) is an escaped quote; a lone one
          // terminates the string.
          if (command.charAt(i + 1) === quote) {
            current += quote;
            i += 2;
            continue;
          }
          break;
        }
        if (quote === '"' && qch === '`') {
          const next = command.charAt(i + 1);
          if (next !== '') {
            current += next;
            i += 2;
            continue;
          }
        }
        current += qch;
        i++;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

const DANGER_LEVEL_RANK: Readonly<Record<DangerAssessment['level'], number>> = {
  safe: 0,
  caution: 1,
  destructive: 2,
};

/**
 * Combine the assessments of one command made over different argv shapes.
 * Token-based rules need split argv; cmd-gated binary rules need the first
 * token as the program (mirroring how the exec tool sees the same line);
 * phrase-scanning rules (e.g. the execution-policy scanner matching
 * `Set-ExecutionPolicy Bypass` across two tokens) need the raw line. Takes
 * the highest level, unions the reasons, and keeps the matched rule of the
 * highest-level assessment.
 */
function mergeDanger(...assessments: readonly DangerAssessment[]): DangerAssessment {
  const top = assessments.reduce((acc, cur) =>
    DANGER_LEVEL_RANK[cur.level] > DANGER_LEVEL_RANK[acc.level] ? cur : acc,
  );
  const reasons = [...new Set(assessments.flatMap((a) => a.reasons))];
  if (top.level === 'safe') return { level: 'safe', reasons: [] };
  const result: DangerAssessment = { level: top.level, reasons };
  if (top.matchedRule !== undefined) result.matchedRule = top.matchedRule;
  return result;
}

export const pwshTool: Tool<PwshInput, PwshOutput> = {
  name: 'pwsh',
  category: 'Shell',
  description: PWSH_TOOL_DESCRIPTION,
  usageHint: PWSH_TOOL_USAGE_HINT,
  selection: {
    doNotUseWhen:
      'the command is an allowlisted single binary (node, git, pnpm, tsc) needing no shell expansion or pipelines.',
    useInstead: ['exec'],
  },
  permission: 'confirm',
  mutating: true,
  riskTier: 'destructive',
  icon: 'terminal',
  subjectKey: 'command',
  capabilities: ['shell.arbitrary'],
  timeoutMs: 610_000,
  maxOutputBytes: MAX_OUTPUT,
  estimatedDurationMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact PowerShell command or script block to run.',
      },
      workdir: {
        type: 'string',
        description:
          'Absolute or project-relative path to the working directory for this command. Defaults to session working directory.',
      },
      timeout_ms: {
        type: 'integer',
        description:
          'Optional timeout for this specific command in milliseconds (default 300000, max 600000).',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'If true, launch the process in the background and return the job ID / PID immediately.',
      },
      background: {
        type: 'boolean',
        description: 'Alias for run_in_background.',
      },
      sandbox_permissions: {
        type: 'string',
        description:
          'Escalation mode if retrying a sandbox-denied command (e.g., workspace-write).',
      },
      justification: {
        type: 'string',
        description:
          'One-sentence justification when retrying a denied command with sandbox_permissions.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    let final: PwshOutput | undefined;
    const executeStream = pwshTool.executeStream;
    if (!executeStream) throw new Error('pwshTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('pwsh: stream ended without final event');
    return final;
  },
  async cleanup(_input: PwshInput, ctx: Context): Promise<void> {
    const registry = getProcessRegistry();
    const sessionId = ctx.session?.id;
    if (!sessionId) return;
    for (const entry of registry.bySession(sessionId)) {
      if (entry.name !== 'pwsh') continue;
      if (entry.child && entry.child.exitCode !== null) continue;
      if (entry.protected) continue;
      registry.kill(entry.pid, { force: true });
    }
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<PwshOutput>> {
    if (!input?.command || typeof input.command !== 'string' || !input.command.trim()) {
      throw new ToolValidationError({
        message: 'pwsh: command is required and cannot be empty',
        field: 'command',
      });
    }

    const callerSignal = opts?.signal ?? ctx?.signal ?? new AbortController().signal;
    if (callerSignal.aborted) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 124,
          timed_out: false,
          pid: null,
          error: 'Aborted',
        },
      };
      return;
    }

    const isBackground = !!(input.run_in_background || input.background);
    const registry = getProcessRegistry();

    if (!registry.beforeCall(isBackground)) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error:
            'pwsh: circuit breaker open — too many consecutive failures or slow calls. Use /kill to inspect or /kill reset to recover.',
        },
      };
      return;
    }

    const killCheck = await checkAndBlockKillCommand(input.command);
    if (killCheck.blocked) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error: `pwsh: ${killCheck.reason}`,
        },
      };
      return;
    }

    const isWin = os.platform() === 'win32';
    const bin = isWin ? resolvePowerShell('pwsh.exe') : 'pwsh';
    const encodedCommand = Buffer.from(wrapPwshCommand(input.command), 'utf16le').toString(
      'base64',
    );
    const args = [...shellArgs('pwsh'), encodedCommand];

    const env = buildChildEnv(ctx.session?.id);
    let targetCwd: string;
    try {
      targetCwd = await safeResolveReal(input.workdir ?? ctx.workingDir ?? ctx.projectRoot, ctx);
    } catch (err) {
      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error: `pwsh: ${(err as Error).message}`,
        },
      };
      return;
    }

    const startedAt = Date.now();
    const detached = !isWin;

    if (isBackground) {
      const child = spawn(bin, args, {
        cwd: targetCwd,
        env,
        detached,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });

      const pid = child.pid;
      if (typeof pid === 'number') {
        registry.register({
          pid,
          name: 'pwsh',
          command: redactCommand(input.command),
          startedAt: Date.now(),
          sessionId: ctx.session?.id,
          child,
          processGroupLeader: detached && child.pid === pid,
          background: true,
        });

        child.on('close', () => registry.unregister(pid));
        child.on('error', () => {
          registry.unregister(pid);
          registry.afterCall(Date.now() - startedAt, true, isBackground);
        });

        child.unref();

        const jobId = `job_${pid}`;
        ctx.recordSideEffect?.({
          toolUseId: `pwsh-bg-${Date.now()}`,
          toolName: 'pwsh',
          ts: new Date().toISOString(),
          input: { command: redactCommand(input.command), background: true },
          outcome: `started background job ${jobId} (PID: ${pid})`,
          risk: 'shell',
        });

        yield {
          type: 'final',
          output: {
            output: `Background job started: ${jobId} (PID: ${pid})\nWorking directory: ${targetCwd}`,
            exit_code: null,
            timed_out: false,
            pid,
            job_id: jobId,
          },
        };
        return;
      }

      yield {
        type: 'final',
        output: {
          output: '',
          exit_code: 1,
          timed_out: false,
          pid: null,
          error: 'pwsh: failed to obtain PID for background process',
        },
      };
      return;
    }

    // Foreground / Synchronous execution
    const spool = createOutputSpool({ tool: 'pwsh', thresholdBytes: MAX_OUTPUT });
    const child = spawn(bin, args, {
      cwd: targetCwd,
      env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const pid = child.pid;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let telemetryCompleted = false;

    emitProcessStarted({
      ...(pid !== undefined ? { pid } : {}),
      parentPid: process.pid,
      command: redactCommand(`${bin} ${args.join(' ')}`),
      args: redactCommand(args.join(' ')).split(' ').filter(Boolean),
      cwd: targetCwd,
      background: false,
      startedAt: new Date(startedAt).toISOString(),
    });

    const completeForeground = (exitCode: number, sig?: string | undefined) => {
      if (telemetryCompleted) return;
      telemetryCompleted = true;
      emitProcessCompleted({
        ...(pid !== undefined ? { pid } : {}),
        exitCode,
        ...(sig ? { signal: sig } : {}),
        durationMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        timedOut,
        endedAt: new Date().toISOString(),
      });
    };

    if (typeof pid === 'number') {
      registry.register({
        pid,
        name: 'pwsh',
        command: redactCommand(input.command),
        startedAt: Date.now(),
        sessionId: ctx.session?.id,
        child,
        processGroupLeader: detached && child.pid === pid,
      });
    }

    const rawTimeout =
      typeof input.timeout_ms === 'number' && !Number.isNaN(input.timeout_ms)
        ? input.timeout_ms
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(1_000, rawTimeout), 600_000);

    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];

    const killWithTimeout = (timeout: number) => {
      if (isWin) {
        if (typeof child.pid === 'number' && child.exitCode === null) {
          const attempted = registry.kill(child.pid, { force: true, graceMs: timeout });
          if (!attempted) {
            try {
              child.kill();
            } catch (err) {
              // Both the registry kill and the direct kill failed — the
              // timed-out child is leaked. Surface it instead of swallowing
              // silently so an operator can chase the process.
              console.log(
                JSON.stringify({
                  level: 'warn',
                  event: 'pwsh.kill_fallback_failed',
                  pid: child.pid,
                  platform: process.platform,
                  error: err instanceof Error ? err.message : String(err),
                  message:
                    'pwsh child.kill() raised after the registry kill failed; process may be leaked',
                }),
              );
            }
          }
        }
        return;
      }
      if (typeof child.pid === 'number') {
        registry.kill(child.pid, { graceMs: timeout });
      } else {
        try {
          child.kill('SIGTERM');
        } catch (err) {
          console.log(
            JSON.stringify({
              level: 'warn',
              event: 'pwsh.sigterm_failed',
              platform: process.platform,
              error: err instanceof Error ? err.message : String(err),
              message: 'pwsh child.kill("SIGTERM") raised on POSIX fallback; process may be leaked',
            }),
          );
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killWithTimeout(2000);
    }, timeoutMs);
    timers.push(timer);

    const onAbort = () => killWithTimeout(2000);
    if (callerSignal.aborted) onAbort();
    else callerSignal.addEventListener('abort', onAbort, { once: true });

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

    let buf = '';
    let pending = '';
    let lastFlush = Date.now();
    const flush = () => {
      if (pending.length === 0) return null;
      const text = pending;
      pending = '';
      lastFlush = Date.now();
      return text;
    };

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

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const onData = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk);
      if (stream === 'stdout') stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      emitProcessOutput({ pid: pid ?? 0, stream, chunk });
      if (buf.length < MAX_OUTPUT) {
        buf += text.slice(0, MAX_OUTPUT - buf.length);
      }
      spool.write(text);
      pending += text;
      push({ kind: 'data', text });
      pauseIfFlooded();
    };

    child.stdout?.on('data', (chunk: Buffer) => onData(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => onData(chunk, 'stderr'));

    child.on('error', (err) => {
      for (const t of timers) clearTimeout(t);
      registry.afterCall(Date.now() - startedAt, true);
      completeForeground(1);
      push({ kind: 'error', err });
    });

    child.on('close', (code, signal) => {
      for (const t of timers) clearTimeout(t);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, code !== 0 && code !== null);
      completeForeground(timedOut ? 124 : (code ?? (signal ? 1 : 0)), signal ?? undefined);

      const tail = stdoutDecoder.end() + stderrDecoder.end();
      if (tail) {
        if (buf.length < MAX_OUTPUT) buf += tail.slice(0, MAX_OUTPUT - buf.length);
        spool.write(tail);
        pending += tail;
      }
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
          let formattedOutput = normalizeCommandOutput(buf);
          if (c.code !== null && c.code !== 0 && !timedOut) {
            if (!formattedOutput.includes(`[exit code: ${c.code}]`)) {
              formattedOutput = formattedOutput
                ? `${formattedOutput}\n[exit code: ${c.code}]`
                : `[exit code: ${c.code}]`;
            }
          }

          // Auto-diagnosis on non-zero exit for common shell confusion
          const hint =
            !timedOut && typeof c.code === 'number' && c.code !== 0
              ? diagnoseBashism(input.command, 'pwsh')
              : undefined;

          // Classify the command under the argv shapes each rule family
          // expects, so none goes dark on this path:
          //   - `pwsh` + all tokens → PowerShell cmdlet rules
          //     (`Remove-Item -recurse -force …`);
          //   - first token as the program → native-binary rules
          //     (`chmod 777 …`, `git push --force …`), mirroring how the
          //     exec tool would see the same line;
          //   - the raw line → phrase scanners
          //     (`Set-ExecutionPolicy Bypass …`).
          const tokens = tokenizePwshCommand(input.command);
          const danger = mergeDanger(
            detectDanger('pwsh', tokens),
            detectDanger(tokens[0] ?? 'pwsh', tokens.slice(1)),
            detectDanger('pwsh', [input.command]),
          );
          const cautionText =
            danger.level === 'caution' && danger.reasons.length > 0
              ? `\n[caution: ${danger.reasons.join('; ')}]`
              : '';

          const finalResultText =
            formattedOutput +
            (spooled ? spoolNote(spooled) : '') +
            (hint ? `\n\n${hint}` : '') +
            cautionText;

          ctx.recordSideEffect?.({
            toolUseId: `pwsh-${Date.now()}`,
            toolName: 'pwsh',
            ts: new Date().toISOString(),
            input: { command: redactCommand(input.command) },
            outcome: timedOut ? `timed out (exit ${c.code})` : `exit ${c.code}`,
            risk: 'shell',
          });

          const isAborted = callerSignal.aborted;
          yield {
            type: 'final',
            output: {
              output: finalResultText,
              exit_code: timedOut || isAborted ? 124 : c.code,
              timed_out: timedOut || isAborted,
              pid: pid ?? null,
              ...(isAborted ? { error: 'Command aborted by user or signal' } : {}),
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
      callerSignal.removeEventListener('abort', onAbort);
    }
  },
};
