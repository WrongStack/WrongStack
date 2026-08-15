import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fake the child process so the stdout/stderr/close/error/abort/timeout paths
// in runCommand run deterministically — on Windows `echo` is a cmd builtin
// (spawn ENOENT), so real allowlisted commands only ever hit the error path.
const cfg: {
  stdout: string;
  stderr: string;
  code: number;
  mode: 'close' | 'error' | 'hang';
  pid: number | undefined;
} = { stdout: '', stderr: '', code: 0, mode: 'close', pid: 4242 };

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number | undefined;
        kill: (sig?: string) => void;
        killed: boolean;
        exitCode: number | null;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = cfg.pid;
      child.killed = false;
      child.exitCode = null;
      child.kill = () => {
        child.killed = true;
        // A killed child closes with a null code.
        process.nextTick(() => child.emit('close', null));
      };
      process.nextTick(() => {
        if (cfg.stdout) child.stdout.emit('data', Buffer.from(cfg.stdout));
        if (cfg.stderr) child.stderr.emit('data', Buffer.from(cfg.stderr));
        if (cfg.mode === 'close') child.emit('close', cfg.code);
        else if (cfg.mode === 'error') child.emit('error', new Error('spawn failed'));
        // 'hang' → wait for kill() (timeout/abort tests)
      });
      return child;
    },
  };
});

import { execTool } from '../src/exec.js';
import { _resetProcessRegistry } from '../src/process-registry.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-spawn-'));
  // The process registry (and its circuit breaker) is a process-wide singleton;
  // reset it so error/timeout tests don't trip the breaker for later tests.
  _resetProcessRegistry();
  cfg.stdout = '';
  cfg.stderr = '';
  cfg.code = 0;
  cfg.mode = 'close';
  cfg.pid = 4242;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ctx = () => ({ cwd: dir, projectRoot: dir, tools: [], session: { id: 's1' } }) as any;
const opts = (signal?: AbortSignal) => ({ signal: signal ?? new AbortController().signal });

describe('execTool runCommand (faked child)', () => {
  it('captures stdout/stderr and the exit code on close', async () => {
    cfg.stdout = 'hello out';
    cfg.stderr = 'some warn';
    cfg.code = 0;
    const result = await execTool.execute({ command: 'echo', args: [] }, ctx(), opts());
    expect(result.allowed).toBe(true);
    expect(result.stdout).toContain('hello out');
    expect(result.stderr).toContain('some warn');
    expect(result.exitCode).toBe(0);
  });

  it('allows a command with blocked-arg patterns when the args are safe', async () => {
    // `rm` has BLOCKED_ARG_PATTERNS; a safe relative target passes validateArgs
    // (the loop finds no match and returns null).
    cfg.stdout = '';
    const result = await execTool.execute(
      { command: 'rm', args: ['-rf', 'scratch'] },
      ctx(),
      opts(),
    );
    expect(result.allowed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('allows package-manager run args when they are not dangerous subcommands', async () => {
    const vitest = await execTool.execute(
      { command: 'pnpm', args: ['vitest', 'run', 'packages/providers/tests/anthropic.test.ts'] },
      ctx(),
      opts(),
    );
    expect(vitest.allowed).toBe(true);

    const script = await execTool.execute(
      { command: 'pnpm', args: ['run', 'test'] },
      ctx(),
      opts(),
    );
    expect(script.allowed).toBe(true);
  });

  it('allows normal code-executing development commands', async () => {
    for (const input of [
      { command: 'pnpm', args: ['dlx', 'tsx', 'scripts/check.ts'] },
      { command: 'npx', args: ['tsx', 'scripts/check.ts'] },
      { command: 'node', args: ['-e', 'console.log("ok")'] },
      { command: 'python', args: ['-m', 'pytest'] },
      { command: 'docker', args: ['build', '.'] },
    ]) {
      const result = await execTool.execute(input, ctx(), opts());
      expect(result.allowed, `${input.command} ${input.args.join(' ')}`).toBe(true);
    }
  });

  it('still blocks externally destructive subcommands only in subcommand position', async () => {
    const blocked = await execTool.execute({ command: 'pnpm', args: ['publish'] }, ctx(), opts());
    expect(blocked.allowed).toBe(false);
    expect(blocked.stderr).toContain('Blocked subcommand "publish"');

    const dockerPush = await execTool.execute(
      { command: 'docker', args: ['push', 'repo/image'] },
      ctx(),
      opts(),
    );
    expect(dockerPush.allowed).toBe(false);
    expect(dockerPush.stderr).toContain('Blocked subcommand "push"');

    const yarnInfo = await execTool.execute(
      { command: 'yarn', args: ['npm', 'info', 'typescript'] },
      ctx(),
      opts(),
    );
    expect(yarnInfo.allowed).toBe(true);

    const yarnPublish = await execTool.execute(
      { command: 'yarn', args: ['npm', 'publish'] },
      ctx(),
      opts(),
    );
    expect(yarnPublish.allowed).toBe(false);
    expect(yarnPublish.stderr).toContain('Blocked subcommand "npm publish"');

    const downstreamArg = await execTool.execute(
      { command: 'pnpm', args: ['test', '--', 'publish'] },
      ctx(),
      opts(),
    );
    expect(downstreamArg.allowed).toBe(true);
  });

  it('rejects cwd that escapes project root through a symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-outside-'));
    const link = path.join(dir, 'outside-link');
    try {
      try {
        fs.symlinkSync(outside, link, 'dir');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
        throw err;
      }

      const result = await execTool.execute(
        { command: 'echo', cwd: 'outside-link' },
        ctx(),
        opts(),
      );
      expect(result.allowed).toBe(false);
      expect(result.stderr).toContain('outside project root');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('surfaces a non-zero exit code', async () => {
    cfg.code = 2;
    const result = await execTool.execute({ command: 'echo' }, ctx(), opts());
    expect(result.exitCode).toBe(2);
  });

  it('handles a spawn error', async () => {
    cfg.mode = 'error';
    const result = await execTool.execute({ command: 'echo' }, ctx(), opts());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('spawn failed');
  });

  it('returns exit code 124 when the timeout fires', async () => {
    cfg.mode = 'hang';
    cfg.pid = undefined; // force the child.kill() branch (no registry pid)
    const result = await execTool.execute({ command: 'echo', timeout: 1 }, ctx(), opts());
    expect(result.exitCode).toBe(124);
  }, 10_000);

  it('routes the timeout kill through the registry when a pid is present', async () => {
    cfg.mode = 'hang';
    cfg.pid = 4242; // registered → timeout kills via registry.kill(pid)
    const result = await execTool.execute({ command: 'echo', timeout: 1 }, ctx(), opts());
    expect(result.exitCode).toBe(124);
  }, 10_000);

  // onAbort only attaches on win32 (POSIX passes the signal to spawn instead,
  // which the fake child can't simulate) — so this path is win32-specific.
  (process.platform === 'win32' ? it : it.skip)(
    'kills on an already-aborted signal (win32)',
    async () => {
      cfg.mode = 'hang';
      cfg.pid = undefined;
      const ac = new AbortController();
      ac.abort();
      const result = await execTool.execute({ command: 'echo' }, ctx(), opts(ac.signal));
      expect(result.exitCode).toBe(124);
    },
    10_000,
  );

  (process.platform === 'win32' ? it : it.skip)(
    'aborts via the registry when a pid is present (win32)',
    async () => {
      cfg.mode = 'hang';
      cfg.pid = 4242; // registered → onAbort kills via registry.kill(pid, {force})
      const ac = new AbortController();
      ac.abort();
      const result = await execTool.execute({ command: 'echo' }, ctx(), opts(ac.signal));
      // The abort routes through registry.kill(pid, {force}); the run resolves
      // (no hang/throw) with the registry-driven child close.
      expect(typeof result.exitCode).toBe('number');
    },
    10_000,
  );
});
