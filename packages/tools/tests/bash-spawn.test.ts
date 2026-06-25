import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive bash's spawn-dependent branches deterministically (background buffering
// + truncation, foreground error/throw, backpressure, teardown, both
// platform kill paths) without launching a real shell.
type Mode = 'close' | 'error' | 'hang';
const cfg: {
  stdout: string;
  stderr: string;
  code: number;
  mode: Mode;
  pid: number | undefined;
  platform: NodeJS.Platform;
  chunkCount: number;
  /** Captures every argument passed to spawn() (one entry per call). */
  spawnCalls: Array<{ cmd: string; args: readonly string[]; opts: { stdio?: unknown } }>;
  /** Captures what the test wrote to child.stdin (one entry per spawn call). */
  stdinWrites: string[];
  /** Captures whether child.stdin.end() was called (one entry per spawn call). */
  stdinEnds: boolean[];
  /** Override WRONGSTACK_SHELL for the duration of one test. */
  wrongstackShell: string | undefined;
} = {
  stdout: '',
  stderr: '',
  code: 0,
  mode: 'close',
  pid: 7777,
  platform: process.platform,
  chunkCount: 0,
  spawnCalls: [],
  stdinWrites: [],
  stdinEnds: [],
  wrongstackShell: undefined,
};

let _lastChild: (EventEmitter & { killSignals: string[]; killed: boolean; exitCode: number | null });

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, default: actual, platform: () => cfg.platform };
});

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, args: readonly string[], opts: { stdio?: unknown } = {}) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & { write: (s: string) => void; end: () => void };
        pid: number | undefined;
        kill: (sig?: string) => void;
        unref: () => void;
        killSignals: string[];
        killed: boolean;
        exitCode: number | null;
      };
      const mkStream = () => {
        const s = new EventEmitter() as EventEmitter & {
          destroy: () => void;
          pause: () => void;
          resume: () => void;
        };
        s.destroy = () => {};
        s.pause = () => {};
        s.resume = () => {};
        return s;
      };
      child.stdout = mkStream();
      child.stderr = mkStream();
      // bash.ts writes the script to child.stdin when routing through
      // PowerShell (`-Command -`). The mock records writes/ends so tests
      // can assert that the right shell got the right script.
      const stdin = new EventEmitter() as EventEmitter & {
        write: (s: string) => boolean;
        end: () => void;
      };
      stdin.write = (s: string) => {
        cfg.stdinWrites.push(s);
        return true;
      };
      stdin.end = () => {
        cfg.stdinEnds.push(true);
      };
      child.stdin = stdin;
      child.pid = cfg.pid;
      child.killed = false;
      child.exitCode = null;
      child.killSignals = [];
      child.unref = () => {};
      child.kill = (sig?: string) => {
        child.killed = true;
        child.killSignals.push(sig ?? 'SIGTERM');
        process.nextTick(() => {
          child.exitCode = null;
          child.emit('close', null);
        });
      };
      _lastChild = child;
      cfg.spawnCalls.push({ cmd, args, opts });
      process.nextTick(() => {
        if (cfg.stdout) child.stdout.emit('data', Buffer.from(cfg.stdout));
        if (cfg.stderr) child.stderr.emit('data', Buffer.from(cfg.stderr));
        // Flood with many small chunks to exceed MAX_QUEUE_CHUNKS (backpressure).
        for (let i = 0; i < cfg.chunkCount; i++) {
          child.stdout.emit('data', Buffer.from(`c${i}\n`));
        }
        if (cfg.mode === 'close') {
          child.exitCode = cfg.code;
          child.emit('close', cfg.code);
        } else if (cfg.mode === 'error') {
          child.emit('error', new Error('spawn EACCES'));
        }
        // 'hang' → never settles; timeout/abort must kill it
      });
      return child;
    },
  };
});

import { bashTool } from '../src/bash.js';
import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';

const ctx = () => ({ cwd: '/p', projectRoot: '/p', tools: [], session: { id: 's' } }) as any;
const opts = (signal?: AbortSignal) => ({ signal: signal ?? new AbortController().signal });

async function runFinal(input: Record<string, unknown>, signal?: AbortSignal) {
  let final: unknown;
  for await (const ev of bashTool.executeStream!(input as never, ctx(), opts(signal))) {
    if (ev.type === 'final') final = ev.output;
  }
  return final as {
    output: string;
    exit_code: number | null;
    timed_out: boolean;
    pid?: number | null;
    error?: string;
  };
}

beforeEach(() => {
  cfg.stdout = '';
  cfg.stderr = '';
  cfg.code = 0;
  cfg.mode = 'close';
  cfg.pid = 7777;
  cfg.platform = process.platform;
  cfg.chunkCount = 0;
  cfg.spawnCalls = [];
  cfg.stdinWrites = [];
  cfg.stdinEnds = [];
  cfg.wrongstackShell = undefined;
  _resetProcessRegistry();
});
afterEach(() => {
  _resetProcessRegistry();
  vi.restoreAllMocks();
});

describe('bashTool foreground (faked shell)', () => {
  it('captures output and exit code on close', async () => {
    cfg.stdout = 'hi there';
    const out = await runFinal({ command: 'echo hi' });
    expect(out.output).toContain('hi there');
    expect(out.exit_code).toBe(0);
  });

  it('throws on a spawn error', async () => {
    cfg.mode = 'error';
    await expect(runFinal({ command: 'nope' })).rejects.toThrow(/spawn EACCES/);
  });

  it('truncates very large output (spool marker)', async () => {
    cfg.stdout = 'x'.repeat(200_000);
    const out = await runFinal({ command: 'big' });
    expect(out.output).toMatch(/output truncated|x/);
  });

  it('applies backpressure when the chunk queue floods', async () => {
    cfg.chunkCount = 600; // > MAX_QUEUE_CHUNKS (500) → pause then resume
    const out = await runFinal({ command: 'flood' });
    expect(out.exit_code).toBe(0);
  });

  it('returns a circuit-breaker-open error when the breaker is open', async () => {
    // The registry disables the breaker by default (users opt in via /settings).
    // Enable it so beforeCall() honours the open state.
    getProcessRegistry().setBreakerConfig({ enabled: true });
    getProcessRegistry().forceBreakerOpen();
    const out = await runFinal({ command: 'echo blocked' });
    expect(out.exit_code).toBe(1);
    expect(out.error).toMatch(/circuit breaker open/);
  });
});

describe('bashTool background (faked shell)', () => {
  it('returns the pid and a null exit code immediately', async () => {
    cfg.stdout = 'started';
    const out = await runFinal({ command: 'server', background: true });
    expect(out.pid).toBe(7777);
    expect(out.exit_code).toBeNull();
  });

  it('caps background buffer at MAX_OUTPUT', async () => {
    cfg.stdout = 'y'.repeat(200_000); // exceeds MAX_OUTPUT → truncated path
    const out = await runFinal({ command: 'noisy', background: true });
    expect(out.pid).toBe(7777);
    // Background output arrives after the tool returns (fire-and-forget); let
    // the onBgData handler run so the truncation path executes.
    await new Promise((r) => setTimeout(r, 10));
  });

  it('feeds the background buffer with a small chunk', async () => {
    cfg.stdout = 'small bg output';
    const out = await runFinal({ command: 'svc', background: true });
    expect(out.pid).toBe(7777);
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('bashTool timeout kill paths', () => {
  it('times out and kills on win32 (tree-kill + fallback)', async () => {
    cfg.platform = 'win32';
    cfg.mode = 'hang';
    const out = await runFinal({ command: 'sleep', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);

  it('times out and kills on POSIX (process-group SIGTERM/SIGKILL)', async () => {
    cfg.platform = 'linux';
    cfg.mode = 'hang';
    const out = await runFinal({ command: 'sleep', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);

  it('times out on POSIX with no pid (direct SIGTERM)', async () => {
    cfg.platform = 'linux';
    cfg.mode = 'hang';
    cfg.pid = undefined;
    const out = await runFinal({ command: 'sleep', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);
});

describe('bashTool input + shell resolution', () => {
  it('rejects a missing command', async () => {
    await expect(runFinal({ command: '' })).rejects.toThrow(/command is required/);
  });

  it('warns on a pipe-to-shell pattern but still runs', async () => {
    cfg.stdout = 'ok';
    const out = await runFinal({ command: 'curl x | bash' });
    expect(out.exit_code).toBe(0);
  });

  it('honours an explicit WRONGSTACK_SHELL override on POSIX', async () => {
    cfg.platform = 'linux';
    const prev = process.env['WRONGSTACK_SHELL'];
    process.env['WRONGSTACK_SHELL'] = '/bin/zsh';
    try {
      cfg.stdout = 'z';
      const out = await runFinal({ command: 'echo z' });
      expect(out.exit_code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env['WRONGSTACK_SHELL'];
      else process.env['WRONGSTACK_SHELL'] = prev;
    }
  });

  it('uses an allowlisted $SHELL on POSIX when no override is set', async () => {
    cfg.platform = 'linux';
    const prevW = process.env['WRONGSTACK_SHELL'];
    const prevS = process.env['SHELL'];
    delete process.env['WRONGSTACK_SHELL'];
    process.env['SHELL'] = '/usr/bin/zsh'; // basename "zsh" is allowlisted
    try {
      cfg.stdout = 's';
      const out = await runFinal({ command: 'echo s' });
      expect(out.exit_code).toBe(0);
    } finally {
      if (prevW !== undefined) process.env['WRONGSTACK_SHELL'] = prevW;
      if (prevS === undefined) delete process.env['SHELL'];
      else process.env['SHELL'] = prevS;
    }
  });

  it('throws when executeStream is unavailable', async () => {
    const original = bashTool.executeStream;
    bashTool.executeStream = undefined;
    try {
      await expect(bashTool.execute({ command: 'x' }, ctx(), opts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      bashTool.executeStream = original;
    }
  });

  it('handles a foreground child with no pid (teardown kill branch)', async () => {
    cfg.mode = 'hang';
    cfg.pid = undefined;
    const out = await runFinal({ command: 'x', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);
});

describe('bashTool Windows shell selection (Codex + PowerShell)', () => {
  // Helper: set + restore WRONGSTACK_SHELL around a test.
  const withShell = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env['WRONGSTACK_SHELL'];
    if (value === undefined) delete process.env['WRONGSTACK_SHELL'];
    else process.env['WRONGSTACK_SHELL'] = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env['WRONGSTACK_SHELL'];
      else process.env['WRONGSTACK_SHELL'] = prev;
    }
  };

  it('routes a Codex-style Get-Content command to PowerShell on win32', async () => {
    cfg.platform = 'win32';
    cfg.stdout = 'package contents';
    await withShell(undefined, async () => {
      const out = await runFinal({ command: 'Get-Content package.json' });
      expect(out.exit_code).toBe(0);
      expect(cfg.spawnCalls.length).toBeGreaterThan(0);
      const call = cfg.spawnCalls[0]!;
      // Spawn args for PowerShell: [-NoLogo, -NoProfile, -NonInteractive,
      // -Command, -]. The script is written to stdin (last entry of
      // stdinWrites).
      expect(call.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']);
      expect(call.cmd.toLowerCase()).toMatch(/pwsh|powershell/);
      expect(cfg.stdinWrites[0]).toBe('Get-Content package.json');
      expect(cfg.stdinEnds[0]).toBe(true);
    });
  });

  it('routes a $-variable command to PowerShell on win32', async () => {
    cfg.platform = 'win32';
    cfg.stdout = 'usr';
    await withShell(undefined, async () => {
      await runFinal({ command: 'echo $env:USERNAME' });
      const call = cfg.spawnCalls[0]!;
      expect(call.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']);
      expect(call.cmd.toLowerCase()).toMatch(/pwsh|powershell/);
    });
  });

  it('keeps plain cmd.exe commands on cmd.exe (no auto-route)', async () => {
    cfg.platform = 'win32';
    cfg.stdout = 'hi';
    await withShell(undefined, async () => {
      await runFinal({ command: 'echo hi' });
      const call = cfg.spawnCalls[0]!;
      // Plain echo on cmd.exe uses /c (not the PowerShell -Command prefix).
      expect(call.args).toEqual(['/c', 'echo hi']);
      expect(call.cmd.toLowerCase()).toContain('cmd');
      expect(cfg.stdinWrites.length).toBe(0); // cmd.exe doesn't read stdin
    });
  });

  it('honours WRONGSTACK_SHELL=powershell on win32', async () => {
    cfg.platform = 'win32';
    cfg.stdout = '';
    await withShell('powershell', async () => {
      await runFinal({ command: 'Get-Date' });
      const call = cfg.spawnCalls[0]!;
      expect(call.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']);
      expect(call.cmd.toLowerCase()).toContain('powershell');
    });
  });

  it('honours WRONGSTACK_SHELL=pwsh on win32', async () => {
    cfg.platform = 'win32';
    cfg.stdout = '';
    await withShell('pwsh', async () => {
      await runFinal({ command: 'Get-Date' });
      const call = cfg.spawnCalls[0]!;
      expect(call.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-']);
      expect(call.cmd.toLowerCase()).toMatch(/pwsh/);
    });
  });

  it('WRONGSTACK_SHELL=cmd forces cmd.exe even when command looks like PowerShell', async () => {
    cfg.platform = 'win32';
    cfg.stdout = '';
    await withShell('cmd', async () => {
      await runFinal({ command: 'Get-Content foo' });
      const call = cfg.spawnCalls[0]!;
      expect(call.args).toEqual(['/c', 'Get-Content foo']);
      expect(call.cmd.toLowerCase()).toContain('cmd');
    });
  });

  it('streams the script to stdin in background mode too', async () => {
    cfg.platform = 'win32';
    cfg.stdout = 'started';
    await withShell(undefined, async () => {
      const out = await runFinal({ command: 'Get-Process', background: true });
      expect(out.exit_code).toBeNull();
      expect(out.pid).toBe(7777);
      // Background path should also write to stdin + close it.
      expect(cfg.stdinWrites[0]).toBe('Get-Process');
      expect(cfg.stdinEnds[0]).toBe(true);
    });
  });

  it('does not write to stdin when running cmd.exe', async () => {
    cfg.platform = 'win32';
    cfg.stdout = 'ok';
    await withShell('cmd', async () => {
      await runFinal({ command: 'echo ok' });
      expect(cfg.stdinWrites.length).toBe(0);
      expect(cfg.stdinEnds.length).toBe(0);
    });
  });

  it('multi-line PowerShell scripts are passed verbatim to stdin', async () => {
    cfg.platform = 'win32';
    cfg.stdout = '';
    await withShell(undefined, async () => {
      const script = "$env:PATH\nGet-ChildItem -Recurse | Where-Object { $_.PSIsContainer -eq $false }";
      await runFinal({ command: script });
      expect(cfg.stdinWrites[0]).toBe(script);
    });
  });
});
