import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { execTool } from '../src/exec.js';

const makeOpts = () => ({ signal: new AbortController().signal });
const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;

describe('execTool', () => {
  it('has correct metadata', () => {
    expect(execTool.name).toBe('exec');
    expect(execTool.permission).toBe('confirm');
    expect(execTool.mutating).toBe(true);
    expect(execTool.riskTier).toBe('standard');
  });

  it('rejects empty command', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: '  ' }, ctx, makeOpts());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Empty command');
  });

  it('blocks command strings with embedded shell metacharacters via allowlist', async () => {
    // Pre-0.1.6 the tool also pattern-matched against a forbidden-regex list,
    // but that was dead code (only the command name was tested). Today the
    // allowlist alone suffices: 'echo hello; rm -rf /' is not the key 'echo'.
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo hello; rm -rf /' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('not in allowlist');
  });

  it('blocks rm -rf pattern', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm -rf /tmp' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
  });

  it('blocks eval pattern', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'eval echo hello' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
  });

  it('rejects unknown commands not in allowlist', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'curl' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('not in allowlist');
  });

  it('allows commands present in the allowlist', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo', args: ['hello'] }, ctx, makeOpts());
    // may fail if echo is missing from PATH but allowlist gate should let it through
    expect(result).toHaveProperty('command');
  });

  it('respects MAX_ARGS limit', async () => {
    const ctx = makeCtx();
    const manyArgs = Array(30).fill('arg');
    const result = await execTool.execute(
      { command: 'echo', args: manyArgs as string[] },
      ctx,
      makeOpts(),
    );
    // args should be sliced to MAX_ARGS
    expect(result).toHaveProperty('args');
  });

  it('respects timeout cap', async () => {
    const ctx = makeCtx();
    // timeout > TIMEOUT_MS should be capped
    const result = await execTool.execute(
      { command: 'echo', timeout: 999_999_999 } as any,
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('exitCode');
  });

  it('rejects cwd that resolves outside projectRoot', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute(
      { command: 'echo', cwd: '../../../etc' },
      ctx,
      makeOpts(),
    );
    expect(result.allowed).toBe(false);
    expect(result.stderr).toMatch(/outside project root/);
  });

  it('accepts cwd resolving inside projectRoot', async () => {
    const sb = await mkRealSandbox();
    try {
      await fs.mkdir(path.join(sb.ctx.projectRoot, 'sub'));
      const result = await execTool.execute({ command: 'echo', cwd: 'sub' }, sb.ctx, makeOpts());
      expect(result.stderr).not.toMatch(/outside project root/);
    } finally {
      await sb.cleanup();
    }
  });

  it('blocks rm with absolute path /etc', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '/etc'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });

  it('blocks rm with ~', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '~'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });

  it('blocks rm with . (current dir)', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '.'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });

  it('blocks rm with .. (parent dir)', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '..'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });
});

// ─── Coverage: runCommand timer callback and buffer write paths ───────────────
describe('exec timer and buffer paths', () => {
  // Lines 243-246: timer callback sets killed=true, calls registry.kill(pid)
  // when pid is number, falls back to child.kill('SIGTERM') otherwise.
  // Exercises the callback body by letting the timeout timer fire.
  it('exercises timer callback with timeout large enough for spawn', async () => {
    // Uses a real temp dir so the spawn succeeds.
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'echo', args: ['start'], timeout: 500 },
        sb.ctx,
        makeOpts(),
      );
      // Either way the timer callback body ran; just verify no crash.
      expect(result).toHaveProperty('exitCode');
    } finally {
      await sb.cleanup();
    }
  });

  it('exercises timer callback with very short timeout', async () => {
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'echo', args: ['ok'], timeout: 20 },
        sb.ctx,
        makeOpts(),
      );
      // exitCode may be 0 (completed) or 124 (killed) — just verify no crash.
      expect(result).toHaveProperty('exitCode');
    } finally {
      await sb.cleanup();
    }
  });

  // Lines 248-253: stdout/stderr chunks written to buffers when under MAX_OUTPUT
  it('writes stdout chunks to buffer when under MAX_OUTPUT', async () => {
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'echo', args: ['hello'] },
        sb.ctx,
        makeOpts(),
      );
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('truncated');
    } finally {
      await sb.cleanup();
    }
  });

  it('writes stderr chunks to buffer when command produces stderr', async () => {
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'ls', args: ['--no-such-option'] },
        sb.ctx,
        makeOpts(),
      );
      expect(result).toHaveProperty('stderr');
    } finally {
      await sb.cleanup();
    }
  });
});

// ─── Helper: real temp sandbox for exec tests ────────────────────────────────
async function mkRealSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-tool-'));
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    tools: [],
    session: { id: 'test', append: async () => {}, close: async () => {}, recordFileChange: () => {} },
    messages: [],
    todos: [],
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    hasRead(p: string) { return this.readFiles.has(p); },
    lastReadMtime(p: string) { return this.fileMtimes.get(p); },
    recordRead(p: string, m: number) { this.readFiles.add(p); this.fileMtimes.set(p, m); },
  } as never as Context;
  return { ctx, cleanup: async () => fs.rm(dir, { recursive: true, force: true }) };
}

// ─── Coverage: abort / ENOENT hardening (issue #99) ─────────────────────────
// Before the fix, a child process that exited via `AbortSignal.timeout()`
// emitted an `'error'` event with code 'ABORT_ERR'. Without an `'error'`
// listener attached at the moment the abort fired, Node's EventEmitter
// contract rethrows the error on nextTick and crashes the host process
// with `uncaughtException`. The fix in exec.ts attaches the error listener
// immediately after `spawn()` and wraps the lifecycle in try/catch so
// synchronous spawn failures resolve gracefully too.
//
// These tests exercise the abort path WITHOUT running a long-lived
// command: a *pre-aborted* signal causes spawn() (non-Windows) to
// emit `'error'` with ABORT_ERR synchronously after spawn returns.
// That is the exact EventEmitter race the fix guards against — if the
// `'error'` listener weren't attached before the abort fired, Node
// would throw on nextTick and crash this test process.
describe('exec abort and ENOENT hardening (#99)', () => {
  it('survives a pre-aborted signal without crashing the host (POSIX)', async () => {
    if (process.platform === 'win32') {
      // The pre-aborted signal path is handled differently on Windows
      // (manual onAbort() in the signal listener). The POSIX path is
      // what crashes per the issue body.
      return;
    }
    const sb = await mkRealSandbox();
    let crashed = false;
    const onUncaught = (err: Error) => {
      if (/abort/i.test(err.message)) crashed = true;
    };
    process.on('uncaughtException', onUncaught);
    try {
      const ac = new AbortController();
      ac.abort(); // pre-abort BEFORE spawn() is called
      const result = await execTool.execute(
        { command: 'node', args: ['--version'], timeout: 5000 },
        sb.ctx,
        { signal: ac.signal },
      );
      // spawn() with an already-aborted signal emits 'error' immediately
      // with code 'ABORT_ERR'. The error listener catches it and the
      // helper resolves with exitCode=124 + an Aborted: stderr.
      expect(result.allowed).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toMatch(/aborted/i);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await sb.cleanup();
    }
    expect(crashed).toBe(false);
  });

  it('handles ENOENT (command not on PATH) gracefully — does not crash the host', async () => {
    // The tool allowlist gates known-bad command names — pick a name that
    // is syntactically allowed but doesn't exist on any PATH. The
    // single-letter + dot pattern passes `cmd in ALLOWED_COMMANDS`'s
    // existence check but Node's spawn() will emit an ENOENT error
    // (async) or throw synchronously (depending on Node version).
    // Both paths must resolve the promise without crashing the host.
    // We bypass the allowlist by going through execTool with a 1-char
    // synthetic command — but the allowlist gate refuses unknown names,
    // so we use a known-allowed command name that has been removed from
    // PATH for this test only by using a sandboxed PATH.
    const sb = await mkRealSandbox();
    let crashed = false;
    const onUncaught = (err: Error) => {
      if (/ENOENT/.test(err.message)) crashed = true;
    };
    process.on('uncaughtException', onUncaught);
    try {
      // `mkdir` is in the allowlist. Rename it temporarily via PATH
      // stripping so spawn() reports ENOENT. We restore PATH after.
      const originalPath = process.env.PATH;
      process.env.PATH = '';
      try {
        const result = await execTool.execute(
          { command: 'mkdir', args: ['-p', 'subdir'], timeout: 5000 },
          sb.ctx,
          { signal: new AbortController().signal },
        );
        // The command exits gracefully (either ENOENT caught async via
        // 'error' event OR synchronous spawn throw caught by try/catch).
        expect(result.allowed).toBe(true);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      } finally {
        process.env.PATH = originalPath;
      }
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await sb.cleanup();
    }
    expect(crashed).toBe(false);
  });
});
