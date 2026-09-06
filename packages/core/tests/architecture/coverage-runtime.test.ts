import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkZeroCoverage,
  compareZeroCoverage,
  isDirectRun as isZeroCoverageDirectRun,
  normalizeCoveragePath,
  runDirect as runZeroCoverageDirect,
  zeroStatementFiles,
} from '../../../../scripts/check-zero-coverage.mjs';
import {
  createCoverageLock,
  defaultCheckProcessAlive,
  executeCoverageLock,
  isDirectRun as isCoverageLockDirectRun,
  sleep,
} from '../../../../scripts/coverage-lock.mjs';
import {
  COVERAGE_RUNS,
  isDirectRun as isTestCoverageDirectRun,
  runCoverage,
} from '../../../../scripts/test-coverage.mjs';
import { getVitestMaxWorkers } from '../../../../vitest.workers.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function existingLockError() {
  return Object.assign(new Error('exists'), { code: 'EEXIST' });
}

function spawnResult(status: number | null, error?: Error) {
  return {
    pid: 1,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status,
    signal: null,
    ...(error ? { error } : {}),
  };
}

function createLockHarness() {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn((_signal: string) => true),
  });
  const listeners = new Map<string, () => void>();
  const stderr = vi.fn();
  const options = {
    command: ['node', '--version'],
    env: {} as NodeJS.ProcessEnv,
    pid: 42,
    now: vi.fn(() => 100),
    spawnCommand: vi.fn(() => child),
    openFile: vi.fn(() => 7),
    closeFile: vi.fn((_fd: number) => undefined),
    readFile: vi.fn(() => '42\n'),
    statFile: vi.fn(() => ({ mtimeMs: 99 })),
    unlinkFile: vi.fn((_file: string) => undefined),
    writeFile: vi.fn((_file: string, _value: string) => undefined),
    checkProcessAlive: vi.fn((_pid: number) => true),
    onProcess: vi.fn((signal: string, listener: () => void) => {
      listeners.set(signal, listener);
      return process;
    }),
    stderr,
    lockPath: 'test.coverage.lock',
    pollMs: 1,
    maxWaitMs: 10,
    sleepFor: vi.fn(async (_ms: number) => undefined),
  };

  return { child, listeners, options, stderr };
}

describe('coverage lock script', () => {
  it('recognizes direct and imported execution', () => {
    const scriptPath = path.join(repoRoot, 'scripts', 'coverage-lock.mjs');
    const scriptUrl = pathToFileURL(scriptPath).href;

    expect(isCoverageLockDirectRun(scriptUrl, scriptPath)).toBe(true);
    expect(isCoverageLockDirectRun(scriptUrl, path.join(repoRoot, 'other.mjs'))).toBe(false);
    expect(isCoverageLockDirectRun(scriptUrl, null as never)).toBe(false);
  });

  it('uses the real timer helper', async () => {
    vi.useFakeTimers();
    const pending = sleep(25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('reports a missing wrapped command', async () => {
    const harness = createLockHarness();
    harness.options.command = [];

    await expect(createCoverageLock(harness.options).execute()).resolves.toBe(2);
    expect(harness.stderr).toHaveBeenCalledWith(
      'coverage-lock: no command given (usage: coverage-lock.mjs <cmd> [args...])',
    );
  });

  it('runs immediately when an ancestor owns the lock', async () => {
    const harness = createLockHarness();
    harness.options.env.WRONGSTACK_COVERAGE_LOCK_HELD = '1';

    const result = executeCoverageLock(harness.options);
    harness.child.emit('exit', 0);

    await expect(result).resolves.toBe(0);
    expect(harness.options.openFile).not.toHaveBeenCalled();
    expect(harness.options.spawnCommand).toHaveBeenCalledWith('node --version', {
      stdio: 'inherit',
      shell: true,
      env: { WRONGSTACK_COVERAGE_LOCK_HELD: '1' },
    });
  });

  it('acquires and releases the lock around a command', async () => {
    const harness = createLockHarness();
    const result = createCoverageLock(harness.options).execute();
    await Promise.resolve();
    harness.child.emit('exit', 0);

    await expect(result).resolves.toBe(0);
    expect(harness.options.writeFile).toHaveBeenCalledWith(7, '42\n');
    const writeCallOrder = harness.options.writeFile.mock.invocationCallOrder[0];
    const closeCallOrder = harness.options.closeFile.mock.invocationCallOrder[0];
    expect(writeCallOrder).toBeDefined();
    expect(closeCallOrder).toBeDefined();
    if (writeCallOrder === undefined || closeCallOrder === undefined) {
      throw new Error('expected coverage lock writes and closes to be called');
    }
    expect(writeCallOrder).toBeLessThan(closeCallOrder);
    expect(harness.options.closeFile).toHaveBeenCalledWith(7);
    expect(harness.options.unlinkFile).toHaveBeenCalledWith('test.coverage.lock');
  });

  it('closes a newly-created lock when writing its owner fails', async () => {
    const harness = createLockHarness();
    harness.options.writeFile.mockImplementation(() => {
      throw new Error('write failed');
    });

    await expect(createCoverageLock(harness.options).acquire()).rejects.toThrow('write failed');
    expect(harness.options.closeFile).toHaveBeenCalledWith(7);
  });

  it('releases the lock when the protected runner throws', async () => {
    const harness = createLockHarness();
    const lock = createCoverageLock(harness.options);

    await expect(
      lock.withLock(() => {
        throw new Error('runner failed');
      }),
    ).rejects.toThrow('runner failed');
    expect(harness.options.unlinkFile).toHaveBeenCalledWith('test.coverage.lock');
  });

  it('propagates unexpected lock creation errors', async () => {
    const harness = createLockHarness();
    harness.options.openFile.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    await expect(createCoverageLock(harness.options).acquire()).rejects.toThrow('denied');
  });

  it('breaks a missing stale lock and tolerates an unlink race', async () => {
    const harness = createLockHarness();
    harness.options.openFile
      .mockImplementationOnce(() => {
        throw existingLockError();
      })
      .mockReturnValue(7);
    harness.options.statFile.mockImplementation(() => {
      throw new Error('gone');
    });
    harness.options.unlinkFile.mockImplementationOnce(() => {
      throw new Error('released');
    });

    await expect(createCoverageLock(harness.options).acquire()).resolves.toBeUndefined();
    expect(harness.options.openFile).toHaveBeenCalledTimes(2);
  });

  it('identifies stale locks by age, invalid owner, and dead owner', () => {
    const oldHarness = createLockHarness();
    oldHarness.options.statFile.mockReturnValue({ mtimeMs: 0 });
    expect(createCoverageLock(oldHarness.options).isStale()).toBe(true);

    const invalidHarness = createLockHarness();
    invalidHarness.options.readFile.mockReturnValue('not-a-pid');
    // Age beyond the grace period (pollMs * 2 = 2ms): now()=100, mtimeMs=97 → 3ms old
    invalidHarness.options.statFile.mockReturnValue({ mtimeMs: 97 });
    expect(createCoverageLock(invalidHarness.options).isStale()).toBe(true);

    const deadHarness = createLockHarness();
    deadHarness.options.checkProcessAlive.mockReturnValue(false);
    expect(createCoverageLock(deadHarness.options).isStale()).toBe(true);

    const liveHarness = createLockHarness();
    expect(createCoverageLock(liveHarness.options).isStale()).toBe(false);
  });

  it('treats a freshly-created lock with empty owner as not-yet-stale (grace period)', () => {
    // now()=100, mtimeMs=99 → 1ms old, within pollMs*2=2ms grace period
    const freshHarness = createLockHarness();
    freshHarness.options.readFile.mockReturnValue('');
    freshHarness.options.statFile.mockReturnValue({ mtimeMs: 99 });
    expect(createCoverageLock(freshHarness.options).isStale()).toBe(false);

    // now()=100, mtimeMs=97 → 3ms old, beyond grace period
    const expiredHarness = createLockHarness();
    expiredHarness.options.readFile.mockReturnValue('');
    expiredHarness.options.statFile.mockReturnValue({ mtimeMs: 97 });
    expect(createCoverageLock(expiredHarness.options).isStale()).toBe(true);
  });

  it('waits once, warns once, and then acquires a live lock', async () => {
    const harness = createLockHarness();
    harness.options.openFile
      .mockImplementationOnce(() => {
        throw existingLockError();
      })
      .mockImplementationOnce(() => {
        throw existingLockError();
      })
      .mockReturnValue(7);

    await expect(createCoverageLock(harness.options).acquire()).resolves.toBeUndefined();
    expect(harness.stderr).toHaveBeenCalledTimes(1);
    expect(harness.options.sleepFor).toHaveBeenCalledTimes(2);
  });

  it('force-breaks a live lock after the timeout', async () => {
    const harness = createLockHarness();
    harness.options.maxWaitMs = 0;
    harness.options.statFile.mockReturnValue({ mtimeMs: 100 });
    harness.options.openFile
      .mockImplementationOnce(() => {
        throw existingLockError();
      })
      .mockReturnValue(7);

    await expect(createCoverageLock(harness.options).acquire()).resolves.toBeUndefined();
    expect(harness.stderr).toHaveBeenCalledTimes(2);
    expect(harness.options.sleepFor).not.toHaveBeenCalled();
  });

  it('tolerates a timeout unlink race', async () => {
    const harness = createLockHarness();
    harness.options.maxWaitMs = 0;
    harness.options.openFile
      .mockImplementationOnce(() => {
        throw existingLockError();
      })
      .mockReturnValue(7);
    harness.options.unlinkFile.mockImplementationOnce(() => {
      throw new Error('already released');
    });

    await expect(createCoverageLock(harness.options).acquire()).resolves.toBeUndefined();
    expect(harness.options.openFile).toHaveBeenCalledTimes(2);
  });

  it('returns an empty owner when lock contents cannot be read', () => {
    const harness = createLockHarness();
    harness.options.readFile.mockImplementation(() => {
      throw new Error('unreadable');
    });

    expect(createCoverageLock(harness.options).readOwner()).toBe('');
  });

  it('only releases a lock owned by the current process and tolerates unlink errors', () => {
    const foreignHarness = createLockHarness();
    foreignHarness.options.readFile.mockReturnValue('99');
    createCoverageLock(foreignHarness.options).release();
    expect(foreignHarness.options.unlinkFile).not.toHaveBeenCalled();

    const failingHarness = createLockHarness();
    failingHarness.options.unlinkFile.mockImplementation(() => {
      throw new Error('busy');
    });
    expect(() => createCoverageLock(failingHarness.options).release()).not.toThrow();
  });

  it('forwards signals and tolerates a child that already exited', async () => {
    const harness = createLockHarness();
    harness.options.env.WRONGSTACK_COVERAGE_LOCK_HELD = '1';
    harness.child.kill
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error('gone');
      })
      .mockReturnValueOnce(true);

    const result = createCoverageLock(harness.options).execute();
    harness.listeners.get('SIGINT')?.();
    harness.listeners.get('SIGTERM')?.();
    harness.listeners.get('SIGHUP')?.();
    harness.child.emit('exit', null);

    await expect(result).resolves.toBe(1);
    expect(harness.child.kill).toHaveBeenCalledTimes(3);
  });

  it('converts child spawn errors to a failed exit code', async () => {
    const harness = createLockHarness();
    harness.options.env.WRONGSTACK_COVERAGE_LOCK_HELD = '1';

    const result = createCoverageLock(harness.options).execute();
    harness.child.emit('error', new Error('spawn failed'));

    await expect(result).resolves.toBe(1);
    expect(harness.stderr).toHaveBeenCalledWith('coverage-lock:', 'spawn failed');
  });

  it('executes the direct CLI branch with default runtime dependencies', async () => {
    const scriptPath = path.join(repoRoot, 'scripts', 'coverage-lock.mjs');
    const originalArgv = process.argv;
    const originalHeld = process.env.WRONGSTACK_COVERAGE_LOCK_HELD;
    process.argv = [process.execPath, scriptPath, 'node', '--version'];
    process.env.WRONGSTACK_COVERAGE_LOCK_HELD = '1';
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await import(/* @vite-ignore */ `${pathToFileURL(scriptPath).href}?direct=${Date.now()}`);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      process.argv = originalArgv;
      if (originalHeld === undefined) {
        delete process.env.WRONGSTACK_COVERAGE_LOCK_HELD;
      } else {
        process.env.WRONGSTACK_COVERAGE_LOCK_HELD = originalHeld;
      }
    }
  });
});

describe('defaultCheckProcessAlive', () => {
  it('detects the current process as alive', () => {
    expect(defaultCheckProcessAlive(process.pid)).toBe(true);
  });

  it('detects a non-existent PID as dead', () => {
    // PID 999999 is vanishingly unlikely to exist
    expect(defaultCheckProcessAlive(999999)).toBe(false);
  });
});

describe('coverage runner script', () => {
  it('serializes package-local coverage entrypoints', () => {
    // Map of every coverage-gate participant to its workspace directory.
    // desktop is an app under apps/, not a package under packages/.
    const gateLocation: Record<string, string> = {
      'plug-lsp': 'packages',
      webui: 'packages',
      'webui-protocol': 'packages',
      desktop: 'apps',
    };
    for (const [packageName, parentDir] of Object.entries(gateLocation)) {
      const packageJson = JSON.parse(
        readFileSync(path.join(repoRoot, parentDir, packageName, 'package.json'), 'utf8'),
      ) as { scripts?: { 'test:coverage'?: string } };

      expect(packageJson.scripts?.['test:coverage']).toMatch(
        /^node \.\.\/\.\.\/scripts\/coverage-lock\.mjs node \.\.\/\.\.\/scripts\/run-vitest-coverage\.mjs /u,
      );
    }
  });

  it('recognizes direct and imported execution', () => {
    const scriptPath = path.join(repoRoot, 'scripts', 'test-coverage.mjs');
    const scriptUrl = pathToFileURL(scriptPath).href;

    expect(isTestCoverageDirectRun(scriptUrl, scriptPath)).toBe(true);
    expect(isTestCoverageDirectRun(scriptUrl, path.join(repoRoot, 'other.mjs'))).toBe(false);
    expect(isTestCoverageDirectRun(scriptUrl, null as never)).toBe(false);
  });

  it('defines every coverage gate including script coverage', () => {
    expect(COVERAGE_RUNS).toEqual([
      { label: 'Node packages', args: ['test:coverage:root'], vitest: true },
      { label: 'Zero-statement file ratchet', args: ['check:coverage-zero'] },
      {
        label: 'LSP package per-file gate',
        args: ['--filter', '@wrongstack/plug-lsp', 'test:coverage'],
        vitest: true,
      },
      {
        label: 'WebUI package',
        args: ['--filter', '@wrongstack/webui', 'test:coverage'],
        vitest: true,
      },
      {
        label: 'webui-protocol package',
        args: ['--filter', '@wrongstack/webui-protocol', 'test:coverage'],
        vitest: true,
      },
      {
        label: 'Desktop package',
        args: ['--filter', '@wrongstack/desktop', 'test:coverage'],
        vitest: true,
      },
      { label: 'Coverage runtime scripts', args: ['test:coverage:scripts'], vitest: true },
    ]);
  });

  it('requires pnpm', () => {
    expect(() => runCoverage({ pnpmCli: '' })).toThrow(
      'test:coverage must be started through pnpm',
    );
  });

  it('runs every gate and succeeds when all children pass', () => {
    const spawnPnpm = vi.fn(() => spawnResult(0));
    const log = vi.fn();
    const runs = [
      { label: 'one', args: ['first'] },
      { label: 'two', args: ['second', '--flag'] },
    ];

    expect(
      runCoverage({
        pnpmCli: 'pnpm.cjs',
        runs,
        spawnPnpm,
        execPath: 'node',
        cwd: 'repo',
        env: { TEST: '1' },
        log,
      }),
    ).toBe(0);
    expect(spawnPnpm).toHaveBeenNthCalledWith(2, 'node', ['pnpm.cjs', 'second', '--flag'], {
      cwd: 'repo',
      env: { TEST: '1' },
      stdio: 'inherit',
    });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('retries only transient Vitest failures in CI', () => {
    const spawnPnpm = vi.fn(() => spawnResult(0));

    expect(
      runCoverage({
        pnpmCli: 'pnpm.cjs',
        runs: [
          { label: 'Vitest gate', args: ['test:coverage'], vitest: true },
          { label: 'Node-only gate', args: ['check:coverage-zero'] },
        ],
        spawnPnpm,
        execPath: 'node',
        cwd: 'repo',
        env: { CI: 'true' },
        log: vi.fn(),
      }),
    ).toBe(0);

    expect(spawnPnpm).toHaveBeenNthCalledWith(
      1,
      'node',
      [
        'pnpm.cjs',
        'test:coverage',
        '--',
        '--retry.count',
        '2',
        '--retry.delay',
        '250',
        '--retry.condition',
        'ENOBUFS|EADDRINUSE|EADDRNOTAVAIL|EACCES|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE',
      ],
      expect.objectContaining({ cwd: 'repo', env: { CI: 'true' }, stdio: 'inherit' }),
    );
    expect(spawnPnpm).toHaveBeenNthCalledWith(
      2,
      'node',
      ['pnpm.cjs', 'check:coverage-zero'],
      expect.objectContaining({ cwd: 'repo', env: { CI: 'true' }, stdio: 'inherit' }),
    );
  });

  it('continues after failed gates and returns failure', () => {
    const spawnPnpm = vi
      .fn()
      .mockReturnValueOnce(spawnResult(1))
      .mockReturnValueOnce(spawnResult(null));

    expect(
      runCoverage({
        pnpmCli: 'pnpm.cjs',
        runs: [
          { label: 'one', args: [] },
          { label: 'two', args: [] },
        ],
        spawnPnpm,
        log: vi.fn(),
      }),
    ).toBe(1);
    expect(spawnPnpm).toHaveBeenCalledTimes(2);
  });

  it('propagates child process errors', () => {
    const error = new Error('cannot spawn');

    expect(() =>
      runCoverage({
        pnpmCli: 'pnpm.cjs',
        runs: [{ label: 'one', args: [] }],
        spawnPnpm: vi.fn(() => spawnResult(null, error)),
        log: vi.fn(),
      }),
    ).toThrow(error);
  });

  it('executes the direct CLI branch with default runtime dependencies', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'wrongstack-coverage-runner-'));
    temporaryDirectories.push(directory);
    const fakePnpm = path.join(directory, 'fake-pnpm.mjs');
    writeFileSync(fakePnpm, 'process.exit(0);\n');

    const scriptPath = path.join(repoRoot, 'scripts', 'test-coverage.mjs');
    const originalArgv = process.argv;
    const originalNpmExecPath = process.env.npm_execpath;
    const originalExitCode = process.exitCode;
    process.argv = [process.execPath, scriptPath];
    process.env.npm_execpath = fakePnpm;

    try {
      await import(/* @vite-ignore */ `${pathToFileURL(scriptPath).href}?direct=${Date.now()}`);
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      if (originalNpmExecPath === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = originalNpmExecPath;
      }
    }
  });
});

describe('zero-coverage ratchet script', () => {
  const summary = {
    total: { statements: { total: 3, covered: 1 } },
    'D:\\repo\\packages\\core\\src\\covered.ts': {
      statements: { total: 1, covered: 1 },
    },
    'D:\\repo\\packages\\core\\src\\zero.ts': {
      statements: { total: 2, covered: 0 },
    },
  };

  it('normalizes paths and finds only executable zero-statement files', () => {
    expect(normalizeCoveragePath('D:\\repo\\packages\\core\\src\\zero.ts', 'D:\\repo')).toBe(
      'packages/core/src/zero.ts',
    );
    // Host-neutral POSIX pin: path.win32.isAbsolute('/repo/...') is true, so
    // an isAbsolute-based Windows predicate misclassifies native Linux
    // summaries and trips the cross-host guard. This assertion throws on that
    // regression and passes on both hosts with the drive-letter regex.
    expect(normalizeCoveragePath('/repo/packages/core/src/zero.ts', '/repo')).toBe(
      'packages/core/src/zero.ts',
    );
    // Cross-host artifact must fail loudly (never silently leak into the
    // ratchet comparison, where it can never match a baseline key).
    expect(() => normalizeCoveragePath('D:\\repo\\x.ts', '/repo')).toThrow(/Windows path/);
    expect(zeroStatementFiles(summary, 'D:\\repo')).toEqual(['packages/core/src/zero.ts']);
    expect(normalizeCoveragePath('./packages/core/src/zero.ts', 'D:\\repo')).toBe(
      'packages/core/src/zero.ts',
    );
    expect(
      zeroStatementFiles(
        {
          total: { statements: { total: 1, covered: 0 } },
          invalid: null,
          empty: { statements: { total: 0, covered: 0 } },
          covered: { statements: { total: 1, covered: 1 } },
        },
        'D:\\repo',
      ),
    ).toEqual([]);
    expect(normalizeCoveragePath('packages/core/src/zero.ts')).toBe('packages/core/src/zero.ts');
    expect(
      zeroStatementFiles({
        'packages/core/src/zero.ts': { statements: { total: 1, covered: 0 } },
      }),
    ).toEqual(['packages/core/src/zero.ts']);
  });

  it('distinguishes new zero files from resolved baseline debt', () => {
    expect(
      compareZeroCoverage(summary, { files: ['packages/core/src/old-zero.ts'] }, 'D:\\repo'),
    ).toMatchObject({
      unexpected: ['packages/core/src/zero.ts'],
      resolved: ['packages/core/src/old-zero.ts'],
    });
    expect(compareZeroCoverage({}, {})).toEqual({ actual: [], unexpected: [], resolved: [] });
  });

  it('fails new zero files and passes known debt', () => {
    const error = vi.fn();
    const log = vi.fn();
    const readJson = vi
      .fn()
      .mockReturnValueOnce(summary)
      .mockReturnValueOnce({ schemaVersion: 1, files: [] });
    expect(checkZeroCoverage({ readJson, repoRoot: 'D:\\repo', error, log })).toBe(1);
    expect(error).toHaveBeenCalledWith('  - packages/core/src/zero.ts');

    const knownReadJson = vi
      .fn()
      .mockReturnValueOnce(summary)
      .mockReturnValueOnce({ schemaVersion: 1, files: ['packages/core/src/zero.ts'] });
    expect(checkZeroCoverage({ readJson: knownReadJson, repoRoot: 'D:\\repo', log })).toBe(0);

    const resolvedReadJson = vi
      .fn()
      .mockReturnValueOnce({ total: { statements: { total: 0, covered: 0 } } })
      .mockReturnValueOnce({ schemaVersion: 1, files: ['packages/core/src/zero.ts'] });
    expect(checkZeroCoverage({ readJson: resolvedReadJson, repoRoot: 'D:\\repo', log })).toBe(0);
    expect(log).toHaveBeenCalledWith('Remove 1 resolved file(s) from the zero-coverage baseline.');
  });

  it('rejects malformed baselines and recognizes direct execution', () => {
    expect(() =>
      checkZeroCoverage({
        readJson: vi
          .fn()
          .mockReturnValueOnce(summary)
          .mockReturnValueOnce({ schemaVersion: 2, files: [] }),
      }),
    ).toThrow('coverage zero baseline');
    const scriptPath = path.join(repoRoot, 'scripts', 'check-zero-coverage.mjs');
    const scriptUrl = pathToFileURL(scriptPath).href;
    expect(isZeroCoverageDirectRun(scriptUrl, scriptPath)).toBe(true);
    expect(isZeroCoverageDirectRun(scriptUrl, null as never)).toBe(false);
  });

  it('converts direct-run failures to exit code 1', () => {
    const error = vi.fn();
    expect(runZeroCoverageDirect({ check: () => 0, error })).toBe(0);
    expect(
      runZeroCoverageDirect({
        check: () => {
          throw new Error('missing summary');
        },
        error,
      }),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith('coverage zero ratchet failed: missing summary');
    expect(
      runZeroCoverageDirect({
        check: () => {
          throw 'broken';
        },
        error,
      }),
    ).toBe(1);
  });
});

describe('Vitest worker selection', () => {
  it('uses process arguments when no explicit list is provided', () => {
    expect(getVitestMaxWorkers()).toBe(2);
  });

  it.each([['--watch'], ['-w'], ['--watch=true']])('uses two workers for %s', (...args) => {
    expect(getVitestMaxWorkers(args)).toBe(2);
  });

  it.each([['run'], ['--run'], ['--run=true'], ['--watch=false']])(
    'uses four workers for %s',
    (...args) => {
      expect(getVitestMaxWorkers(args)).toBe(4);
    },
  );

  it('treats an implicit or explicitly conflicting mode as watch', () => {
    expect(getVitestMaxWorkers([])).toBe(2);
    expect(getVitestMaxWorkers(['--unknown'])).toBe(2);
    expect(getVitestMaxWorkers(['run', '--watch'])).toBe(2);
  });

  it('honors a valid WRONGSTACK_VITEST_MAX_WORKERS override over both modes', () => {
    const previous = process.env.WRONGSTACK_VITEST_MAX_WORKERS;
    process.env.WRONGSTACK_VITEST_MAX_WORKERS = '8';
    try {
      expect(getVitestMaxWorkers(['run'])).toBe(8);
      expect(getVitestMaxWorkers(['--watch'])).toBe(8);
      expect(getVitestMaxWorkers([])).toBe(8);
    } finally {
      if (previous === undefined) delete process.env.WRONGSTACK_VITEST_MAX_WORKERS;
      else process.env.WRONGSTACK_VITEST_MAX_WORKERS = previous;
    }
  });

  it.each([['abc'], ['0'], ['-3'], ['1.5'], ['']])(
    'falls through to mode defaults on an invalid %s override',
    (value) => {
      const previous = process.env.WRONGSTACK_VITEST_MAX_WORKERS;
      process.env.WRONGSTACK_VITEST_MAX_WORKERS = value;
      try {
        expect(getVitestMaxWorkers(['run'])).toBe(4);
        expect(getVitestMaxWorkers(['--watch'])).toBe(2);
      } finally {
        if (previous === undefined) delete process.env.WRONGSTACK_VITEST_MAX_WORKERS;
        else process.env.WRONGSTACK_VITEST_MAX_WORKERS = previous;
      }
    },
  );
});
