import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureDangerBypass,
  configureExecPolicy,
  execTool,
  getDangerBypass,
  getExecAllowlist,
  isExecCommandAllowed,
  resetDangerBypass,
  resetExecPolicy,
} from '../src/exec.js';
import { getProcessRegistry } from '../src/process-registry.js';
import { processCleanupDeadline } from './fixtures.js';

const makeOpts = () => ({ signal: new AbortController().signal });
const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;

// Refusals THROW (a returned `allowed: false` payload was recorded by the
// executor as a successful call). A command that passes the gate may still
// fail to launch on this machine (e.g. `echo` is a cmd builtin on Windows), so
// gate-passes tests assert the failure — if any — is not a policy refusal.
const REFUSAL = /not in allowlist|Blocked (option|argument|subcommand)|outside project root/;
// The danger-banner tests need a real `rm` to spawn: a launch failure now
// throws, so no result carries the assessment. Windows has `rm` only when Git's
// usr/bin is on PATH (Git Bash yes, a plain PowerShell `pnpm` run no).
const HAS_RM =
  process.platform !== 'win32' || spawnSync('where.exe', ['rm'], { stdio: 'ignore' }).status === 0;
async function settle<T>(p: Promise<T>): Promise<{ result?: T; error?: Error }> {
  try {
    return { result: await p };
  } catch (error) {
    return { error: error as Error };
  }
}
function expectNotRefused(outcome: { error?: Error }): void {
  expect(outcome.error?.message ?? '').not.toMatch(REFUSAL);
}

describe('execTool', () => {
  it('has correct metadata', () => {
    expect(execTool.name).toBe('exec');
    expect(execTool.permission).toBe('confirm');
    expect(execTool.mutating).toBe(true);
    expect(execTool.riskTier).toBe('standard');
  });

  it('rejects empty command', async () => {
    const ctx = makeCtx();
    await expect(execTool.execute({ command: '  ' }, ctx, makeOpts())).rejects.toThrow(
      /empty command/,
    );
  });

  it('blocks command strings with embedded shell metacharacters via allowlist', async () => {
    // Pre-0.1.6 the tool also pattern-matched against a forbidden-regex list,
    // but that was dead code (only the command name was tested). Today the
    // allowlist alone suffices: 'echo hello; rm -rf /' is not the key 'echo'.
    const ctx = makeCtx();
    await expect(
      execTool.execute({ command: 'echo hello; rm -rf /' }, ctx, makeOpts()),
    ).rejects.toThrow(/not in allowlist/);
  });

  it('blocks rm -rf pattern', async () => {
    const ctx = makeCtx();
    await expect(execTool.execute({ command: 'rm -rf /tmp' }, ctx, makeOpts())).rejects.toThrow(
      /not in allowlist/,
    );
  });

  it('blocks eval pattern', async () => {
    const ctx = makeCtx();
    await expect(execTool.execute({ command: 'eval echo hello' }, ctx, makeOpts())).rejects.toThrow(
      /not in allowlist/,
    );
  });

  it('rejects unknown commands not in allowlist', async () => {
    const ctx = makeCtx();
    const { error } = await settle(
      execTool.execute({ command: 'definitely-not-wstack' }, ctx, makeOpts()),
    );
    expect(error?.message).toContain('not in allowlist');
    expect(error?.message).toContain('~/.wrongstack/profiles/<name>/config.json');
    expect(error?.message).not.toContain('your ~/.wrongstack/config.json');
  });

  it('allows commands present in the allowlist', async () => {
    const ctx = makeCtx();
    // may fail to launch if echo is missing from PATH, but the gate lets it through
    expectNotRefused(
      await settle(execTool.execute({ command: 'echo', args: ['hello'] }, ctx, makeOpts())),
    );
  });

  it('preserves arguments beyond the former 20-argument limit', async () => {
    const ctx = makeCtx();
    const manyArgs = Array(30).fill('arg');
    const outcome = await settle(
      execTool.execute({ command: 'echo', args: manyArgs as string[] }, ctx, makeOpts()),
    );
    expectNotRefused(outcome);
    if (outcome.result) expect(outcome.result.args).toEqual(manyArgs);
  });

  it('caps per-call timeout at MAX_TIMEOUT_MS (600s), not the 30s default', async () => {
    // Regression: the old clamp used DEFAULT_TIMEOUT_MS as the ceiling too,
    // silently capping EVERY call at 30s regardless of input.timeout. The
    // ceiling is now 600_000, and the declared executor-facing timeoutMs must
    // sit above it so the executor abort can't fire before the tool's own
    // timer (which returns a structured exit-124 result).
    expect(execTool.timeoutMs).toBeGreaterThanOrEqual(600_000);
    const schema = execTool.inputSchema as {
      properties: { timeout: { description: string } };
    };
    expect(schema.properties.timeout.description).toContain('max 600000');
    expect(schema.properties.timeout.description).toContain('default 30000');
    const ctx = makeCtx();
    // A huge requested timeout is clamped (to 600s) but the call still runs.
    expectNotRefused(
      await settle(
        execTool.execute({ command: 'echo', timeout: 999_999_999 } as any, ctx, makeOpts()),
      ),
    );
  });

  it('rejects cwd that resolves outside projectRoot', async () => {
    const ctx = makeCtx();
    await expect(
      execTool.execute({ command: 'echo', cwd: '../../../etc' }, ctx, makeOpts()),
    ).rejects.toThrow(/outside project root/);
  });

  it('accepts cwd resolving inside projectRoot', async () => {
    const sb = await mkRealSandbox();
    try {
      await fs.mkdir(path.join(sb.ctx.projectRoot, 'sub'));
      expectNotRefused(
        await settle(execTool.execute({ command: 'echo', cwd: 'sub' }, sb.ctx, makeOpts())),
      );
    } finally {
      await sb.cleanup();
    }
  });

  it('defaults cwd to ctx.workingDir when set (set_working_dir integration)', async () => {
    const sb = await mkRealSandbox();
    try {
      const sub = path.join(sb.ctx.projectRoot, 'wd-sub');
      await fs.mkdir(sub);
      (sb.ctx as { workingDir?: string }).workingDir = sub;
      const result = await execTool.execute(
        { command: 'node', args: ['-e', 'console.log(process.cwd())'] },
        sb.ctx,
        makeOpts(),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('wd-sub');
    } finally {
      await sb.cleanup();
    }
  });

  it('blocks rm with absolute path /etc', async () => {
    const ctx = makeCtx();
    await expect(
      execTool.execute({ command: 'rm', args: ['-rf', '/etc'] }, ctx, makeOpts()),
    ).rejects.toThrow(/Blocked argument/);
  });

  it('blocks rm with ~', async () => {
    const ctx = makeCtx();
    await expect(
      execTool.execute({ command: 'rm', args: ['-rf', '~'] }, ctx, makeOpts()),
    ).rejects.toThrow(/Blocked argument/);
  });

  it('blocks rm with . (current dir)', async () => {
    const ctx = makeCtx();
    await expect(
      execTool.execute({ command: 'rm', args: ['-rf', '.'] }, ctx, makeOpts()),
    ).rejects.toThrow(/Blocked argument/);
  });

  it('blocks rm with .. (parent dir)', async () => {
    const ctx = makeCtx();
    await expect(
      execTool.execute({ command: 'rm', args: ['-rf', '..'] }, ctx, makeOpts()),
    ).rejects.toThrow(/Blocked argument/);
  });

  // After `--`, rm treats EVERY argument as a path, so `rm -rf -- /` is the same
  // catastrophic delete as `rm -rf /`. The path block stopped scanning at the
  // `--` terminator (correct for git/find, whose tables name OPTIONS), which made
  // the terminator a one-token bypass of every rm path pattern.
  describe('rm path block applies to operands after the `--` terminator', () => {
    const blocked: readonly (readonly string[])[] = [
      ['-rf', '--', '/'],
      ['-rf', '--', '/etc'],
      ['-rf', '--', '~'],
      ['-rf', '--', '~/'],
      ['-rf', '--', '.'],
      ['-rf', '--', '..'],
      ['-rf', '--', './*'],
      ['-rf', '--', 'C:\\'],
      ['-rf', '--', '..\\..'],
      ['-rf', '--', 'build', '/'],
      ['--', '/'],
    ];
    for (const args of blocked) {
      it(`blocks rm ${args.join(' ')}`, async () => {
        await expect(
          execTool.execute({ command: 'rm', args: [...args] }, makeCtx(), makeOpts()),
        ).rejects.toThrow(/Blocked argument/);
      });
    }

    it('still allows an ordinary operand after `--`', async () => {
      for (const args of [
        ['-rf', '--', 'build'],
        ['--', '-rf'],
        ['-f', '--', 'a.txt', 'b.txt'],
      ]) {
        const outcome = await settle(
          execTool.execute({ command: 'rm', args }, makeCtx(), makeOpts()),
        );
        expect(outcome.error?.message ?? '').not.toMatch(/Blocked argument/);
      }
    });

    it('keeps git/find option-name scanning stopped at `--` (pathspecs, not options)', async () => {
      for (const [command, args] of [
        ['git', ['log', '--', '-c']],
        ['git', ['log', '--', '--exec']],
        ['find', ['.', '--', '-exec']],
      ] as const) {
        const outcome = await settle(
          execTool.execute({ command, args: [...args] }, makeCtx(), makeOpts()),
        );
        expect(outcome.error?.message ?? '').not.toMatch(/Blocked (option|argument)/);
      }
    });
  });

  // Security scan 2026-08-04, finding M3. The git table was prefix-anchored on
  // `--opt=`, but git's parse-options accepts `--opt value` just as happily, so
  // the space-separated spelling of every blocked option walked through. The
  // advisory layer (`_danger-detect.ts`, rule `git-exec`) already listed the
  // bare forms — only the *blocking* layer had drifted.
  describe('git option blocking covers both spellings (M3)', () => {
    const blocked: readonly (readonly string[])[] = [
      // space-separated forms — previously unblocked
      ['push', '--exec', './evil.sh'],
      ['fetch', '--upload-pack', './evil.sh'],
      ['push', '--receive-pack', './evil.sh'],
      ['--exec-path', '/tmp/evil', 'status'],
      ['--git-dir', '/tmp/elsewhere/.git', 'log'],
      ['--work-tree', '/tmp/elsewhere', 'checkout'],
      // `=` forms — must keep working
      ['push', '--exec=./evil.sh'],
      ['fetch', '--upload-pack=./evil.sh'],
      ['--exec-path=/tmp/evil', 'status'],
      ['--git-dir=/tmp/elsewhere/.git', 'log'],
      ['--work-tree=/tmp/elsewhere', 'checkout'],
      ['-c', 'core.pager=./evil.sh', 'log'],
      ['--config-env=core.pager=EVIL', 'log'],
      ['-C', '/tmp/elsewhere', 'status'],
    ];

    for (const args of blocked) {
      it(`blocks git ${args.join(' ')}`, async () => {
        const ctx = makeCtx();
        await expect(
          execTool.execute({ command: 'git', args: [...args] }, ctx, makeOpts()),
        ).rejects.toThrow(/Blocked (option|argument)/);
      });
    }

    it('does not block ordinary git invocations', async () => {
      const ctx = makeCtx();
      for (const args of [['status'], ['log', '--oneline', '-n', '5'], ['diff', '--stat']]) {
        const outcome = await settle(execTool.execute({ command: 'git', args }, ctx, makeOpts()));
        expect(outcome.error?.message ?? '').not.toMatch(/Blocked (option|argument)/);
      }
    });

    it('does not block a positional operand that merely looks like an option', async () => {
      // After `--`, git treats everything as a pathspec. A file literally named
      // `--exec` is not an option, and blocking it would be a false positive.
      const ctx = makeCtx();
      const outcome = await settle(
        execTool.execute({ command: 'git', args: ['log', '--', '--exec'] }, ctx, makeOpts()),
      );
      expect(outcome.error?.message ?? '').not.toMatch(/Blocked option/);
    });
  });
});

// ─── Coverage: runCommand timer callback and buffer write paths ───────────────
describe('exec timer and buffer paths', () => {
  // Lines 243-246: timer callback sets killed=true, calls registry.kill(pid)
  // when pid is number, falls back to child.kill('SIGTERM') otherwise.
  // Exercises the callback body by letting the timeout timer fire.
  it('exercises timer callback with timeout large enough for spawn', async () => {
    // Uses a real temp dir so the spawn succeeds. A command that finishes well
    // inside its timeout keeps its real exit code — the timer must not fire.
    const sb = await mkRealSandbox();
    try {
      const result = (await execTool.execute(
        { command: 'node', args: ['-e', "process.stdout.write('start')"], timeout: 15_000 },
        sb.ctx,
        makeOpts(),
      )) as { stdout: string; exitCode: number };
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('start');
    } finally {
      await sb.cleanup();
    }
  });

  it('exercises timer callback with very short timeout', async () => {
    // A process that outlives its timeout is killed and reported as exit 124 —
    // never as success, and without waiting for the process to end on its own.
    const sb = await mkRealSandbox();
    try {
      const startedAt = Date.now();
      const result = (await execTool.execute(
        { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], timeout: 300 },
        sb.ctx,
        makeOpts(),
      )) as { exitCode: number };
      expect(result.exitCode).toBe(124);
      expect(Date.now() - startedAt).toBeLessThan(processCleanupDeadline(8_000));
    } finally {
      await sb.cleanup();
    }
  });

  // Lines 248-253: stdout/stderr chunks written to buffers when under MAX_OUTPUT
  // `node` instead of `echo`/`ls`: those are not executables on Windows, so the
  // old tests only ever took their "spawn failed" branch there and asserted
  // nothing about captured output.
  it('writes stdout chunks to buffer when under MAX_OUTPUT', async () => {
    const sb = await mkRealSandbox();
    try {
      const result = (await execTool.execute(
        { command: 'node', args: ['-e', "process.stdout.write('hello-stdout')"] },
        sb.ctx,
        makeOpts(),
      )) as { stdout: string; stderr: string; exitCode: number; truncated: boolean };
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello-stdout');
      expect(result.stderr).not.toContain('hello-stdout');
      expect(result.truncated).toBe(false);
    } finally {
      await sb.cleanup();
    }
  });

  it('writes stderr chunks to buffer when command produces stderr', async () => {
    const sb = await mkRealSandbox();
    try {
      // A non-zero exit is a RESULT (the process ran), not a thrown failure.
      const result = (await execTool.execute(
        { command: 'node', args: ['-e', "process.stderr.write('oops-stderr'); process.exit(3)"] },
        sb.ctx,
        makeOpts(),
      )) as { stdout: string; stderr: string; exitCode: number };
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('oops-stderr');
      expect(result.stdout).not.toContain('oops-stderr');
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
    session: {
      id: 'test',
      append: async () => {},
      close: async () => {},
      recordFileChange: () => {},
    },
    messages: [],
    todos: [],
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    hasRead: (p: string) => ctx.readFiles.has(p),
    lastReadMtime: (p: string) => ctx.fileMtimes.get(p),
    recordRead: (p: string, m: number) => {
      ctx.readFiles.add(p);
      ctx.fileMtimes.set(p, m);
    },
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
      // Not '': with an empty PATH Bun falls back to a default search path and
      // still finds mkdir. A directory that does not exist hides it in both runtimes.
      process.env.PATH = path.join(sb.ctx.cwd, 'no-bin');
      try {
        // ENOENT (caught async via the 'error' event OR a synchronous spawn
        // throw caught by try/catch) now REJECTS the call — the command never
        // ran, so it must not be recorded as a successful exit-code result —
        // and it still must not crash the host.
        await expect(
          execTool.execute({ command: 'mkdir', args: ['-p', 'subdir'], timeout: 5000 }, sb.ctx, {
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(/exec: (spawn failed|process error)/);
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

describe('exec command policy (configurable allowlist)', () => {
  const makeCtx2 = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
  const makeOpts2 = () => ({ signal: new AbortController().signal });

  beforeEach(() => {
    // #249: exec.test.ts had no circuit-breaker reset between tests, so a
    // transient earlier failure (or shared state from a sibling file)
    // could trip the breaker and cause later `rm -rf` / `git status` tests
    // to see `allowed: false`. Reset the singleton's breaker per-test.
    getProcessRegistry().forceBreakerReset();
  });

  afterEach(() => {
    resetExecPolicy();
    resetDangerBypass();
  });

  it('ships common build tools in the default allowlist (incl. modern dev runners)', () => {
    for (const cmd of [
      'go',
      'cargo',
      'make',
      'dotnet',
      'gradle',
      'mvn',
      'deno',
      'yarn',
      'tsx',
      'vite',
      'turbo',
      'nx',
      'rg',
      'pytest',
      'uv',
      'uvx',
      'pipx',
      'pdm',
      'conda',
      'nox',
      'pyright',
      'bazel',
      'just',
      'rustup',
      'golangci-lint',
      'swift',
      'flutter',
      'zig',
      'shellcheck',
      'poetry',
      'composer',
      'phpunit',
      // Windows shell interpreters — required so `exec cmd /c dir` / PowerShell
      // cmdlets work on Windows instead of hard-failing the allowlist.
      'cmd',
      'cmd.exe',
      'powershell',
      'powershell.exe',
      'pwsh',
      'pwsh.exe',
    ]) {
      expect(isExecCommandAllowed(cmd)).toBe(true);
    }
  });

  it('go build is gated through (allowlisted command, unblocked args)', async () => {
    // go is allowlisted and `build` is not in BLOCKED_ARG_PATTERNS — the gate
    // lets it through (it may still ENOENT if go is not installed, but `allowed`
    // proves the allowlist did not reject it). Needs a real cwd because the
    // cwd-containment check (after the allowlist) realpath-resolves it.
    const sb = await mkRealSandbox();
    try {
      expectNotRefused(
        await settle(
          execTool.execute({ command: 'go', args: ['build', './...'] }, sb.ctx, makeOpts2()),
        ),
      );
    } finally {
      await sb.cleanup();
    }
  });

  it('configureExecPolicy adds allow entries and removes deny entries', () => {
    configureExecPolicy({ allow: ['terraform', 'kubectl'], deny: ['rm', 'docker'] });
    expect(isExecCommandAllowed('terraform')).toBe(true); // added
    expect(isExecCommandAllowed('rm')).toBe(false); // removed from defaults
    expect(isExecCommandAllowed('docker')).toBe(false); // removed
    expect(isExecCommandAllowed('go')).toBe(true); // default preserved
  });

  it('matches Windows aliases consistently for defaults, allow, and deny', () => {
    const windows = process.platform === 'win32';
    expect(isExecCommandAllowed('UV.EXE')).toBe(windows);
    expect(isExecCommandAllowed('uv run pytest')).toBe(false);
    expect(isExecCommandAllowed('./uv')).toBe(false);
    expect(isExecCommandAllowed('C:\\tools\\uv.exe')).toBe(false);
    configureExecPolicy({ allow: ['custom-runner'], deny: ['uv', 'git'] });
    expect(isExecCommandAllowed('CUSTOM-RUNNER.CMD')).toBe(windows);
    expect(isExecCommandAllowed('uv.exe')).toBe(false);
    expect(isExecCommandAllowed('GIT.EXE')).toBe(false);
    configureExecPolicy({ allow: ['uv'], deny: ['UV.EXE'] });
    expect(isExecCommandAllowed('uv')).toBe(!windows);
  });

  it('keeps hard argument guards for explicitly configured executable paths', async () => {
    const command = process.platform === 'win32' ? 'C:\\tools\\GIT.EXE' : '/opt/tools/git';
    configureExecPolicy({ allow: [command] });
    await expect(
      execTool.execute({ command, args: ['-C', '..', 'status'] }, makeCtx2(), makeOpts2()),
    ).rejects.toThrow('Blocked option');
  });

  it('keeps hard argument guards for Windows executable aliases', async () => {
    const command = process.platform === 'win32' ? 'GIT.EXE' : 'git';
    await expect(
      execTool.execute(
        { command, args: ['-c', 'alias.x=!echo bypass', 'x'] },
        makeCtx2(),
        makeOpts2(),
      ),
    ).rejects.toThrow('Blocked option');
  });

  it('retains destructive classification for permitted aliases without launching them', async () => {
    const sb = await mkRealSandbox();
    try {
      const command = process.platform === 'win32' ? 'GIT.EXE' : 'git';
      const result = await execTool.execute({ command, args: ['reset', '--hard'] }, sb.ctx, {
        ...makeOpts2(),
        signal: AbortSignal.abort(),
      });
      expect(result.stderr).toBe('Aborted');
      expect(result.danger?.level).toBe('destructive');
    } finally {
      await sb.cleanup();
    }
  });

  it('is rebuilt from defaults each call (not cumulative)', () => {
    configureExecPolicy({ allow: ['terraform'] });
    expect(isExecCommandAllowed('terraform')).toBe(true);
    configureExecPolicy({ deny: ['go'] }); // no allow → terraform gone again
    expect(isExecCommandAllowed('terraform')).toBe(false);
    expect(isExecCommandAllowed('go')).toBe(false);
  });

  it('resetExecPolicy restores the built-in defaults', () => {
    configureExecPolicy({ allow: ['terraform'], deny: ['go'] });
    resetExecPolicy();
    expect(isExecCommandAllowed('terraform')).toBe(false);
    expect(isExecCommandAllowed('go')).toBe(true);
    expect(getExecAllowlist()).toContain('node');
  });

  it('a configured-allow command runs through the gate; the unallowed error names the config key', async () => {
    // Unallowed: rejected before cwd resolution, so a fake ctx is fine here.
    await expect(
      execTool.execute({ command: 'terraform' }, makeCtx2(), makeOpts2()),
    ).rejects.toThrow('tools": { "exec": { "allow"');

    // Allowed: reaches cwd resolution, so use a real sandbox dir. terraform is
    // usually not installed, so it may fail to launch — but never as a refusal.
    configureExecPolicy({ allow: ['terraform'] });
    const sb = await mkRealSandbox();
    try {
      expectNotRefused(
        await settle(
          execTool.execute({ command: 'terraform', args: ['version'] }, sb.ctx, makeOpts2()),
        ),
      );
    } finally {
      await sb.cleanup();
    }
  });

  it('default allowlist includes Windows-native dev tooling and read-only system utilities', () => {
    // Regression: gh / where / tasklist / etc. were historically rejected
    // even under --yolo, because YOLO only skips the confirmation prompt —
    // it does not bypass the command-name allowlist. Adding them to the
    // default set is the correct fix for that class of "useful tool, no
    // policy reason to block" cases. Per-arg safety still comes from
    // BLOCKED_ARG_PATTERNS + the destructive-ops gate in bash-kill-guard.ts.
    for (const cmd of [
      'gh', // GitHub CLI — lives at "C:\Program Files\GitHub CLI\gh.exe"
      'where',
      'tasklist',
      'systeminfo',
      'wmic',
      'sc',
      'netstat',
      'ipconfig',
      'nslookup',
      'tracert',
      'pathping',
      'tar',
      'curl',
      'wget',
      'clang',
      'clang-cl',
      'gcc',
      'g++',
      'ninja',
      'msbuild',
    ]) {
      expect(isExecCommandAllowed(cmd)).toBe(true);
    }
  });

  it('default allowlist includes the [core] extended dev tooling set', () => {
    // Smoke test: pick at least one representative from every [core] category
    // added in this commit. We don't enumerate all ~280 entries — a duplicate
    // check in CI catches that case — but we want a regression test that
    // pins a name from each bucket so a future refactor that accidentally
    // drops a category fails loudly.
    for (const cmd of [
      // Archives
      '7z',
      'xz',
      'unzip',
      // Android / mobile
      'adb',
      'fastboot',
      // DevOps / config mgmt
      'ansible',
      'ansible-playbook',
      // Cloud CLIs
      'aws',
      'az',
      'gcloud',
      // Native / linker
      'clang-format',
      'clangd',
      'lld',
      'lldb',
      'meson',
      'conan',
      // Image / media
      'ffmpeg',
      'magick',
      'exiftool',
      // HTTP / fetch
      'httpie',
      'wget2',
      // Diff / patch
      'diff',
      'patch',
      'meld',
      // Encoding / file inspection
      'iconv',
      'file',
      'xxd',
      'base64',
      // SSH / crypto
      'ssh',
      'ssh-keygen',
      'scp',
      'rsync',
      'gpg',
      'openssl',
      // Search
      'jq',
      'yq',
      'fd',
      'ugrep',
      // K8s ecosystem
      'helm',
      'k9s',
      'kustomize',
      'skaffold',
      'minikube',
      'kind',
      // Container ecosystem
      'docker-compose',
      'buildah',
      'nerdctl',
      // Databases
      'sqlite3',
      'psql',
      'mysql',
      'redis-cli',
      'mongosh',
      'etcdctl',
      // Windows extended
      'taskkill',
      'hostname',
      'whoami',
      // VCS ecosystem
      'glab',
      'hub',
      'lazygit',
      'tig',
      // POSIX extended
      'tree',
      'env',
      'tr',
      'cut',
      'printf',
      'timeout',
      // Process / system
      'htop',
      'lsof',
      'strace',
      'kill',
      'pkill',
      'ps',
      // Network
      'ip',
      'ss',
      'tcpdump',
      'nmap',
      'socat',
      // Sync / backup
      'rclone',
      'restic',
      'borg',
      // Permissions
      'chown',
      'chmod',
      'setfacl',
      // Crypto / cert
      'certbot',
      'mkcert',
      // Editors
      'vim',
      'nvim',
      'code',
      'helix',
      'micro',
      // Multiplexers
      'tmux',
      'screen',
      'expect',
      // Calculators / REPLs
      'bc',
      'julia',
      'irb',
      'octave',
      // PHP / Lua / Perl / Ruby
      'phpcs',
      'luarocks',
      'cpan',
      'rake',
      // JS / TS toolchain extended
      'electron',
      'swc',
      'mocha',
      'puppeteer',
      'lighthouse',
      // Linters
      'tslint',
      'stylelint',
      // Document conversion
      'pandoc',
      'wkhtmltopdf',
      // Office
      'soffice',
      'libreoffice',
      // Spell
      'aspell',
      'hunspell',
      // Source highlight
      'delta',
      'bat',
      // Job schedulers
      'systemd-run',
      'cronie',
      // Plotting
      'gnuplot',
      'grace',
      // Security / recon
      'nmap',
      'tcpdump',
      'masscan',
      'nuclei',
    ]) {
      expect(isExecCommandAllowed(cmd)).toBe(true);
    }
  });

  it.skipIf(!HAS_RM)('attaches a danger assessment to every exec return', async () => {
    // Integration: verify that the danger-detection layer is wired into the
    // exec tool. This is the contract that UI/TUI consumers rely on to
    // render a banner. We test three categories:
    //   - a pre-execution refusal (allowlist miss) → throws, no result at all
    //   - a destructive command (rm -rf in a sandbox) → level 'destructive'
    //   - a normal command (git status in a sandbox) → level 'safe'
    //
    // #249: reset the circuit breaker here as well (not just in beforeEach)
    // because parallel test files (e.g. bash.test.ts) can trip the shared
    // singleton between the beforeEach reset and this test's assertions.
    getProcessRegistry().forceBreakerReset();
    await expect(
      execTool.execute({ command: 'not-in-allowlist' }, makeCtx2(), makeOpts2()),
    ).rejects.toThrow(/not in allowlist/);

    configureExecPolicy({ allow: ['rm'] });
    const sb = await mkRealSandbox();
    try {
      // Relative target: absolute paths are BLOCKED by rm's security patterns
      // (/^\// and the win32 drive-letter equivalent), so an absolute arg here
      // would exercise the refusal path, not the danger banner.
      await fs.mkdir(path.join(sb.ctx.cwd, 'build'), { recursive: true });
      const r2 = await execTool.execute(
        { command: 'rm', args: ['-rf', 'build'] },
        sb.ctx,
        makeOpts2(),
      );
      expect(r2.allowed).toBe(true);
      expect(r2.danger.level).toBe('destructive');
      expect(r2.danger.reasons).toContain('recursive force-delete');
      expect(r2.danger.matchedRule).toBe('rm-recursive');

      const r3 = await execTool.execute({ command: 'git', args: ['status'] }, sb.ctx, makeOpts2());
      expect(r3.allowed).toBe(true);
      expect(r3.danger.level).toBe('safe');
      expect(r3.danger.reasons).toEqual([]);
    } finally {
      await sb.cleanup();
    }
  });

  it.skipIf(!HAS_RM)(
    'honors configureDangerBypass: a bypassed rule is suppressed in danger output',
    async () => {
      configureExecPolicy({ allow: ['rm'] });
      const sb = await mkRealSandbox();
      try {
        // Relative targets: absolute paths are BLOCKED by rm's security patterns
        // and a refusal now throws before any danger assessment is returned.
        // Without bypass: rm -rf is destructive.
        configureDangerBypass({ bypass: [] });
        const r1 = await execTool.execute(
          { command: 'rm', args: ['-rf', 'a'] },
          sb.ctx,
          makeOpts2(),
        );
        expect(r1.danger.level).toBe('destructive');
        expect(r1.danger.matchedRule).toBe('rm-recursive');

        // With bypass on the rule: level drops to safe.
        configureDangerBypass({ bypass: ['rm-recursive'] });
        expect(getDangerBypass().has('rm-recursive')).toBe(true);
        const r2 = await execTool.execute(
          { command: 'rm', args: ['-rf', 'b'] },
          sb.ctx,
          makeOpts2(),
        );
        expect(r2.danger.level).toBe('safe');
        expect(r2.danger.reasons).toEqual([]);
        expect(r2.danger.matchedRule).toBeUndefined();

        // Bypass on a different rule does NOT affect rm-recursive.
        configureDangerBypass({ bypass: ['inline-eval'] });
        const r3 = await execTool.execute(
          { command: 'rm', args: ['-rf', 'c'] },
          sb.ctx,
          makeOpts2(),
        );
        expect(r3.danger.level).toBe('destructive');
        expect(r3.danger.matchedRule).toBe('rm-recursive');
      } finally {
        await sb.cleanup();
      }
    },
  );
});
