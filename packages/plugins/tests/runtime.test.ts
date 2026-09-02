import { describe, expect, it } from 'vitest';
import {
  type LanguageRuntime,
  resolveRunnerCommand,
  sanitizeRunnerPath,
} from '../src/runtime/index.js';

const TYPESCRIPT_RUNTIME: LanguageRuntime = {
  id: 'typescript',
  packageManager: 'pnpm',
  executable: 'tsc',
  allowedFlags: new Set([
    '--noEmit',
    '--pretty',
    '--pretty=false',
    '--incremental',
    '--watch',
    '--build',
  ]),
  subcommands: ['exec'],
  defaultCommand: 'pnpm exec tsc --noEmit',
};

const VITEST_RUNTIME: LanguageRuntime = {
  id: 'javascript',
  packageManager: 'pnpm',
  executable: 'vitest',
  allowedFlags: new Set(['run', '--run', '--runInBand', '--passWithNoTests']),
  subcommands: ['exec'],
  defaultCommand: 'pnpm exec vitest run',
};

const PYTEST_RUNTIME: LanguageRuntime = {
  id: 'python',
  packageManager: 'pip',
  executable: 'pytest',
  allowedFlags: new Set(['-q', '--quiet', '-x', '--exitfirst', '--maxfail']),
  subcommands: [],
  defaultCommand: 'pytest -q',
};

const CARGO_RUNTIME: LanguageRuntime = {
  id: 'rust',
  packageManager: 'cargo',
  executable: 'test',
  allowedFlags: new Set(['--quiet', '-q', '--release', '--no-run']),
  subcommands: [],
  defaultCommand: 'cargo test',
};

const GOLANG_TEST_RUNTIME: LanguageRuntime = {
  id: 'go',
  packageManager: 'go',
  executable: 'test',
  allowedFlags: new Set(['-v', '-count=1', '-run', '-short']),
  subcommands: [],
  defaultCommand: 'go test',
};

describe('runtime helper', () => {
  describe('sanitizeRunnerPath', () => {
    it('rejects empty, leading-dash, and outside-project paths', () => {
      const projectRoot = process.cwd();
      expect(sanitizeRunnerPath('', { projectRoot })).toBeNull();
      expect(sanitizeRunnerPath('--evil', { projectRoot })).toBeNull();
      expect(sanitizeRunnerPath('/etc/passwd', { projectRoot })).toBeNull();
      expect(sanitizeRunnerPath('../outside.ts', { projectRoot })).toBeNull();
    });
    it('accepts paths inside the project', () => {
      const projectRoot = process.cwd();
      const path = sanitizeRunnerPath('src/foo.test.ts', { projectRoot });
      expect(path).toMatch(/[\\/]src[\\/]foo\.test\.ts$/);
    });
  });

  describe('resolveRunnerCommand — TypeScript tsc', () => {
    it('accepts explicit tsc with allowlisted flags', () => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, 'tsc --noEmit --pretty')).toEqual({
        cmd: 'tsc',
        args: ['--noEmit', '--pretty'],
        display: 'tsc --noEmit --pretty',
      });
    });
    it('accepts pnpm exec tsc with allowlisted flags', () => {
      const r = resolveRunnerCommand(TYPESCRIPT_RUNTIME, 'pnpm exec tsc --noEmit');
      expect(r?.cmd).toBe('pnpm');
      expect(r?.args).toEqual(['exec', 'tsc', '--noEmit']);
    });
    it.each([
      'pnpm',
      'npx tsc',
      'tsc --config=evil.json',
      'tsc --eval "evil"',
      'tsc --project=../evil.json',
      'pnpm exec tsc --config=evil.json',
      'pnpm tsc --isolatedModules',
      'pnpm --filter evil tsc',
      'pnpm exec tsc --eval "evil"',
      "node -e \"require('child_process').exec('calc.exe')\"",
    ])('rejects unsafe TypeScript command %#', (command) => {
      expect(resolveRunnerCommand(TYPESCRIPT_RUNTIME, command)).toBeNull();
    });
  });

  describe('resolveRunnerCommand — Vitest', () => {
    it('accepts pnpm exec vitest run', () => {
      const r = resolveRunnerCommand(VITEST_RUNTIME, 'pnpm exec vitest run');
      expect(r?.cmd).toBe('pnpm');
      expect(r?.args).toEqual(['exec', 'vitest', 'run']);
    });
    it.each([
      'pnpm exec vitest --config=evil.ts',
      'vitest --config=evil.ts',
      'pnpm',
      'pnpm exec malicious-pkg',
      'pnpm exec vitest run --config evil.ts',
    ])('rejects unsafe Vitest command %#', (command) => {
      expect(resolveRunnerCommand(VITEST_RUNTIME, command)).toBeNull();
    });
  });

  describe('resolveRunnerCommand — Python pytest', () => {
    it('accepts bare pytest -q', () => {
      const r = resolveRunnerCommand(PYTEST_RUNTIME, 'pytest -q');
      expect(r?.cmd).toBe('pytest');
      expect(r?.args).toEqual(['-q']);
    });
    it.each(['pytest --inject=evil', 'pytest -e "import os; os.system(\'id\')"'])(
      'rejects unsafe pytest command %#',
      (command) => {
        expect(resolveRunnerCommand(PYTEST_RUNTIME, command)).toBeNull();
      },
    );
  });

  describe('resolveRunnerCommand — Rust cargo test', () => {
    it('accepts cargo test --release', () => {
      const r = resolveRunnerCommand(CARGO_RUNTIME, 'cargo test --release');
      expect(r?.cmd).toBe('cargo');
      expect(r?.args).toEqual(['test', '--release']);
    });
    it.each(['cargo run --evil', 'cargo build'])(
      'rejects non-test cargo invocations %#',
      (command) => {
        expect(resolveRunnerCommand(CARGO_RUNTIME, command)).toBeNull();
      },
    );
  });

  describe('resolveRunnerCommand — Go test', () => {
    it('accepts go test -v ./...', () => {
      const r = resolveRunnerCommand(GOLANG_TEST_RUNTIME, 'go test -v ./...');
      expect(r?.cmd).toBe('go');
      expect(r?.args).toEqual(['test', '-v', './...']);
    });
    it.each(['go build ./...', 'go run main.go'])(
      'rejects non-test go invocations %#',
      (command) => {
        expect(resolveRunnerCommand(GOLANG_TEST_RUNTIME, command)).toBeNull();
      },
    );
  });

  describe('shared invariants', () => {
    it('rejects shell metacharacters in every runtime', () => {
      for (const runtime of [TYPESCRIPT_RUNTIME, VITEST_RUNTIME, PYTEST_RUNTIME, CARGO_RUNTIME]) {
        expect(resolveRunnerCommand(runtime, `${runtime.executable} -q; calc.exe`)).toBeNull();
        expect(resolveRunnerCommand(runtime, `${runtime.executable} -q & echo bad`)).toBeNull();
      }
    });
    it('rejects absolute executable paths outside the project', () => {
      expect(
        resolveRunnerCommand(TYPESCRIPT_RUNTIME, '/usr/bin/tsc --noEmit', {
          projectRoot: process.cwd(),
        }),
      ).toBeNull();
    });
    it('rejects runtimes where allowedFlags is null with leading-dash tokens', () => {
      // Defense in depth: if a runtime declares null allowedFlags, every
      // leading-dash token must be rejected, not silently forwarded. This
      // is the same defensive check everyFlagAllowed enforces.
      const open = { ...TYPESCRIPT_RUNTIME, allowedFlags: null };
      expect(resolveRunnerCommand(open, 'tsc --noEmit')).toBeNull();
    });
  });

  describe('runRunnerCommand timeout (regression for mem_01KXXKN8WYPCB6C2FJN61H823M)', () => {
    // Regression fixture for the confirmed bug:
    //   `const timedOut = false` (never reassigned) at runtime/index.ts
    //   broke RunResult.timedOut for every subprocess-spawning plugin.
    // After the fix, a deliberately slow child process must produce
    // `timedOut: true` and `code: null` — not the generic error shape
    // with `timedOut: false` the bug produced.
    it('reports timedOut:true and code:null when execFile kills the child via its built-in timeout', async () => {
      const { runRunnerCommand } = await import('../src/runtime/index.js');
      // argv-form, no shell: a pure-Node expression that takes 10s to
      // resolve. execFile's `timeout: 200` will SIGTERM the child well
      // before then. The fix at runtime/index.ts:436-467 detects
      // killed/SIGTERM + elapsed-time and short-circuits to the
      // timeout-shaped resolve.
      const result = await runRunnerCommand(['node', '-e', 'setTimeout(()=>{},10000)'], {
        cwd: process.cwd(),
        timeoutMs: 200,
      });
      expect(result.timedOut).toBe(true);
      expect(result.code).toBeNull();
      expect(result.spawnError).toBe(false);
    }, 5_000);

    // Companion regression for the same defect class: maxBuffer
    // overflow (stderr/exec_buffer exceeded the 16 MiB cap) also
    // produces an err shape with `killed: true` + `signal: 'SIGTERM'`
    // in Node — same as a real timeout kill. The chimera-corrected
    // fix at runtime/index.ts:436-467 gates the timeout-shaped
    // resolve on three conditions, including a `maxBuffer length
    // exceeded` exclusion; without that gate, a maxBuffer overflow
    // would be silently misreported as `timedOut: true`, and
    // downstream callers (type-gate/index.ts:227) return null on
    // timedOut=true — swallowing the real failure into an
    // empty-output result. This test pins the exclusion.
    //
    // We write >16 MiB to stdout in argv-form (no shell). execFile's
    // default maxBuffer is 16 MiB, so the child is killed with the
    // maxBuffer error. The fix must NOT resolve this as a timeout.
    it('does NOT report timedOut:true when execFile kills the child for maxBuffer overflow', async () => {
      const { runRunnerCommand } = await import('../src/runtime/index.js');
      // Write 17 MiB (17*1024*1024 bytes) to stdout. The runtime
      // helper's MAX_BUFFER_BYTES is 16 MiB; exceeding it triggers
      // execFile to kill the child and pass an err with the
      // `maxBuffer length exceeded` message. The fix must exclude
      // this case from the timeout-shaped resolve.
      const SIZE = 17 * 1024 * 1024;
      const result = await runRunnerCommand(
        [
          'node',
          '-e',
          // Use process.stdout.write in a tight loop to avoid the
          // overhead of building a single 17 MiB string literal.
          `process.stdout.write('x'.repeat(${SIZE}))`,
        ],
        {
          cwd: process.cwd(),
          timeoutMs: 60_000, // generous; we want maxBuffer to fire, not the timer
        },
      );
      expect(result.timedOut).toBe(false);
      // maxBuffer overflow is NOT a spawn failure — the child spawned
      // and ran, it just wrote too much output. Truthful shape: a real
      // non-null code (1), spawnError false, timedOut false. Only the
      // timedOut flag matters to downstream callers (type-gate returns
      // null on timedOut=true), but the shape should not lie either.
      expect(result.spawnError).toBe(false);
      expect(result.code).not.toBeNull();
    }, 30_000);
  });
});

describe('runtime descriptor on plugin manifests', () => {
  it('type-gate declares its runtime so /diag plugins can list it', async () => {
    const { default: typeGate } = await import('../src/type-gate/index.js');
    const runtime = typeGate.runtime;
    expect(runtime).toBeDefined();
    expect(runtime?.language).toBe('typescript');
    expect(runtime?.executable).toBe('tsc');
    expect(runtime?.packageManager).toBe('pnpm');
    expect(runtime?.defaultCommand).toMatch(/^pnpm exec tsc/);
  });
});
