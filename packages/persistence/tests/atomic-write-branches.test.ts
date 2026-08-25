import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => {
  const syncHandle = {
    sync: vi.fn(),
    close: vi.fn(),
  };
  const lockHandle = {
    writeFile: vi.fn(),
    close: vi.fn(),
  };
  const fs = {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    open: vi.fn(),
    stat: vi.fn(),
    chmod: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    utimes: vi.fn(),
    access: vi.fn(),
  };
  return {
    fs,
    syncHandle,
    lockHandle,
    watch: vi.fn(),
    randomBytes: vi.fn(() => Buffer.from('abcdef')),
  };
});

vi.mock('node:crypto', () => ({ randomBytes: doubles.randomBytes }));
vi.mock('node:fs', () => ({ watch: doubles.watch }));
vi.mock('node:fs/promises', () => doubles.fs);

import {
  createPersistencePrimitives,
  PersistenceFsError,
} from '../src/atomic-write.js';

function errorWithCode(code?: string): NodeJS.ErrnoException {
  const error = new Error(code ?? 'without-code') as NodeJS.ErrnoException;
  if (code) error.code = code;
  return error;
}

function usePlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.fs.mkdir.mockResolvedValue(undefined);
  doubles.fs.writeFile.mockResolvedValue(undefined);
  doubles.fs.stat.mockRejectedValue(errorWithCode('ENOENT'));
  doubles.fs.chmod.mockResolvedValue(undefined);
  doubles.fs.rename.mockResolvedValue(undefined);
  doubles.fs.unlink.mockResolvedValue(undefined);
  doubles.fs.utimes.mockResolvedValue(undefined);
  doubles.fs.access.mockResolvedValue(undefined);
  doubles.syncHandle.sync.mockResolvedValue(undefined);
  doubles.syncHandle.close.mockResolvedValue(undefined);
  doubles.lockHandle.writeFile.mockResolvedValue(undefined);
  doubles.lockHandle.close.mockResolvedValue(undefined);
  doubles.fs.open.mockImplementation(async (_file: string, flag: string) =>
    flag === 'r+' ? doubles.syncHandle : doubles.lockHandle,
  );
  doubles.watch.mockReturnValue({ close: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('persistence primitive edge branches', () => {
  it('covers non-Windows atomic writes, best-effort fsync, cleanup, and ensureDir', async () => {
    usePlatform('linux');
    const primitives = createPersistencePrimitives();

    doubles.fs.open.mockRejectedValueOnce(errorWithCode('EIO'));
    await expect(primitives.atomicWrite('/tmp/value.txt', 'value', { mode: 0o640 })).resolves.toBe(
      undefined,
    );
    expect(doubles.fs.chmod).toHaveBeenCalledTimes(1);
    expect(doubles.fs.rename).toHaveBeenCalledTimes(1);

    await primitives.ensureDir('/tmp/nested');
    expect(doubles.fs.mkdir).toHaveBeenCalledWith('/tmp/nested', { recursive: true });

    const writeError = errorWithCode('EIO');
    doubles.fs.writeFile.mockRejectedValueOnce(writeError);
    doubles.fs.unlink.mockRejectedValueOnce(errorWithCode('EPERM'));
    await expect(primitives.atomicWrite('/tmp/failure.txt', 'value')).rejects.toBe(writeError);
  });

  it('covers Windows chmod fallback and transient rename retry', async () => {
    usePlatform('win32');
    const primitives = createPersistencePrimitives();
    doubles.fs.stat.mockResolvedValue({ mode: 0o100600 });
    doubles.fs.chmod
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(errorWithCode('EPERM'));
    doubles.fs.rename
      .mockRejectedValueOnce(errorWithCode('EPERM'))
      .mockResolvedValueOnce(undefined);

    await expect(primitives.atomicWrite('C:\\tmp\\value.txt', 'value')).resolves.toBe(undefined);
    expect(doubles.fs.rename).toHaveBeenCalledTimes(2);
    expect(doubles.fs.chmod).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an error without a code', errorWithCode()],
    ['a non-transient error', errorWithCode('EINVAL')],
  ])('does not retry Windows rename for %s', async (_label, renameError) => {
    usePlatform('win32');
    doubles.fs.rename.mockRejectedValue(renameError);
    const primitives = createPersistencePrimitives();

    await expect(primitives.atomicWrite('C:\\tmp\\value.txt', 'value')).rejects.toBe(renameError);
    expect(doubles.fs.rename).toHaveBeenCalledTimes(1);
  });

  it('does not retry or warn when the Windows rename target is a directory', async () => {
    usePlatform('win32');
    const renameError = errorWithCode('EPERM');
    doubles.fs.rename.mockRejectedValue(renameError);
    doubles.fs.stat.mockResolvedValue({
      mode: 0o040755,
      isDirectory: () => true,
    });
    const emitSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const primitives = createPersistencePrimitives();

    await expect(primitives.atomicWrite('C:\\tmp\\existing-dir', 'value')).rejects.toBe(
      renameError,
    );
    expect(doubles.fs.rename).toHaveBeenCalledTimes(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('retries Windows rename on ENOENT when the source still exists', async () => {
    usePlatform('win32');
    // commitTemp's stat(target) rejects (new file); the retry's stat(from)
    // resolves — the temp is only momentarily invisible to MoveFileEx.
    doubles.fs.stat.mockImplementation(async (p: string) => {
      if (String(p).includes('.tmp')) return { mode: 0o100600 };
      throw errorWithCode('ENOENT');
    });
    doubles.fs.rename
      .mockRejectedValueOnce(errorWithCode('ENOENT'))
      .mockResolvedValueOnce(undefined);
    const primitives = createPersistencePrimitives();

    await expect(primitives.atomicWrite('C:\\tmp\\value.txt', 'value')).resolves.toBe(undefined);
    expect(doubles.fs.rename).toHaveBeenCalledTimes(2);
  });

  it('fails fast on Windows rename ENOENT when the source is gone', async () => {
    usePlatform('win32');
    // Both commitTemp's stat(target) and the retry's stat(from) reject
    // (ENOENT default) — a genuinely deleted temp cannot be healed by waiting.
    const renameError = errorWithCode('ENOENT');
    doubles.fs.rename.mockRejectedValue(renameError);
    const primitives = createPersistencePrimitives();

    await expect(primitives.atomicWrite('C:\\tmp\\value.txt', 'value')).rejects.toBe(renameError);
    expect(doubles.fs.rename).toHaveBeenCalledTimes(1);
  });

  it('stops retrying Windows rename after the extended transient window', async () => {
    usePlatform('win32');
    const renameError = errorWithCode('EBUSY');
    doubles.fs.rename.mockRejectedValue(renameError);
    const emitSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const primitives = createPersistencePrimitives();

    await expect(primitives.atomicWrite('C:\\tmp\\value.txt', 'value')).rejects.toBe(renameError);
    // 1 initial attempt + one retry per backoff step (~4s total on Windows).
    expect(doubles.fs.rename).toHaveBeenCalledTimes(9);
    // A diagnostic warning is emitted before throwing.
    expect(emitSpy).toHaveBeenCalledWith(
      expect.stringContaining('Windows rename retries exhausted'),
      expect.objectContaining({ code: 'WRONGSTACK_WIN32_RENAME_EXHAUSTED' }),
    );
    emitSpy.mockRestore();
  });

  it('cleans a partially acquired lock and retries after a missing directory', async () => {
    const firstHandle = {
      writeFile: vi.fn().mockRejectedValue(errorWithCode('ENOENT')),
      close: vi.fn().mockRejectedValue(errorWithCode('EIO')),
    };
    const secondHandle = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockRejectedValue(errorWithCode('EIO')),
    };
    doubles.fs.open.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);
    doubles.fs.unlink.mockRejectedValue(errorWithCode('EPERM'));
    const primitives = createPersistencePrimitives();

    await expect(primitives.withFileLock('/tmp/state.json', async () => 'done')).resolves.toBe(
      'done',
    );
    expect(firstHandle.close).toHaveBeenCalledOnce();
    expect(secondHandle.close).toHaveBeenCalledOnce();
    expect(doubles.fs.mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
  });

  it('rejects unexpected lock errors and supports a custom bounded timeout error', async () => {
    const primitives = createPersistencePrimitives({
      createLockTimeoutError: ({ timeoutMs }) => new Error(`custom timeout ${timeoutMs}`),
    });
    const unexpected = errorWithCode('EIO');
    doubles.fs.open.mockRejectedValueOnce(unexpected);
    await expect(primitives.withFileLock('/tmp/state.json', async () => undefined)).rejects.toBe(
      unexpected,
    );

    doubles.fs.open.mockRejectedValue(errorWithCode('EPERM'));
    doubles.fs.stat.mockResolvedValue({ mtimeMs: Date.now() });
    await expect(
      primitives.withFileLock('/tmp/state.json', async () => undefined, { timeoutMs: 0 }),
    ).rejects.toThrow('custom timeout 0');
  });

  it('handles every stale-lock recheck outcome before acquiring', async () => {
    const existing = errorWithCode('EEXIST');
    doubles.fs.open
      .mockRejectedValueOnce(existing)
      .mockRejectedValueOnce(existing)
      .mockRejectedValueOnce(existing)
      .mockRejectedValueOnce(existing)
      .mockResolvedValueOnce(doubles.lockHandle);
    const stale = { mtimeMs: 1 };
    doubles.fs.stat
      .mockRejectedValueOnce(errorWithCode('EIO'))
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(errorWithCode('ENOENT'))
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce({ mtimeMs: 2 })
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale);
    doubles.fs.unlink.mockRejectedValueOnce(errorWithCode('EPERM')).mockResolvedValue(undefined);
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const primitives = createPersistencePrimitives();

    await expect(
      primitives.withFileLock('/tmp/state.json', async () => 'acquired', {
        timeoutMs: 1_000,
        staleMs: 10,
      }),
    ).resolves.toBe('acquired');
    expect(doubles.fs.open).toHaveBeenCalledTimes(5);
  });

  it('refreshes the heartbeat and tolerates heartbeat cleanup failures', async () => {
    vi.useFakeTimers();
    doubles.fs.utimes.mockRejectedValue(errorWithCode('EIO'));
    doubles.lockHandle.close.mockRejectedValue(errorWithCode('EIO'));
    doubles.fs.unlink.mockRejectedValue(errorWithCode('EPERM'));
    const primitives = createPersistencePrimitives();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    // Deferred heartbeat: with staleMs=2000, refreshMs=1000 → the heartbeat
    // starts at 1001ms and first refreshes at ~2001ms. The critical section
    // must stay open past that window so a live holder refreshes.
    const pending = primitives.withFileLock(
      '/tmp/state.json',
      async () => {
        await gate;
        return 'done';
      },
      { staleMs: 2_000 },
    );
    await vi.advanceTimersByTimeAsync(2_050);
    expect(doubles.fs.utimes).toHaveBeenCalled();
    release();
    await expect(pending).resolves.toBe('done');
  });

  // Regression: both of these used to `continue` back to `fs.open` without
  // consulting the deadline and without yielding. Because every double here
  // settles synchronously, that was a pure-microtask loop — it starved the
  // event loop outright, so the call never returned and no timer could fire.
  it('times out instead of spinning when a stale lock can never be unlinked', async () => {
    doubles.fs.open.mockRejectedValue(errorWithCode('EEXIST'));
    doubles.fs.stat.mockResolvedValue({ mtimeMs: 0 });
    doubles.fs.unlink.mockRejectedValue(errorWithCode('EPERM'));
    const primitives = createPersistencePrimitives();

    await expect(
      primitives.withFileLock('/tmp/state.json', async () => 'never', {
        timeoutMs: 60,
        staleMs: 10,
      }),
    ).rejects.toThrow(/Timed out waiting for file lock/);
    expect(doubles.fs.open.mock.calls.length).toBeLessThan(50);
  });

  it('times out instead of spinning when the lock stat keeps failing', async () => {
    doubles.fs.open.mockRejectedValue(errorWithCode('EPERM'));
    doubles.fs.stat.mockRejectedValue(errorWithCode('EACCES'));
    const primitives = createPersistencePrimitives();

    await expect(
      primitives.withFileLock('/tmp/state.json', async () => 'never', { timeoutMs: 50 }),
    ).rejects.toThrow(PersistenceFsError);
    expect(doubles.fs.open.mock.calls.length).toBeLessThan(50);
  });

  it('still acquires with a zero timeout when only the lock directory was missing', async () => {
    doubles.fs.open
      .mockRejectedValueOnce(errorWithCode('ENOENT'))
      .mockResolvedValueOnce(doubles.lockHandle);
    const primitives = createPersistencePrimitives();

    await expect(
      primitives.withFileLock('/tmp/nested/state.json', async () => 'done', { timeoutMs: 0 }),
    ).resolves.toBe('done');
    expect(doubles.fs.mkdir).toHaveBeenCalledWith('/tmp/nested', { recursive: true });
  });

  it('gives up when the lock directory keeps vanishing underneath the retry', async () => {
    doubles.fs.open.mockRejectedValue(errorWithCode('ENOENT'));
    const primitives = createPersistencePrimitives();

    await expect(
      primitives.withFileLock('/tmp/state.json', async () => 'never', { timeoutMs: 40 }),
    ).rejects.toThrow(/Timed out waiting for file lock/);
    expect(doubles.fs.open.mock.calls.length).toBeLessThan(50);
  });

  it('wakes a contended lock through access and ignores a duplicate watcher event', async () => {
    let onWatch: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watcher = { close: vi.fn() };
    doubles.watch.mockImplementation((_dir, callback) => {
      onWatch = callback;
      return watcher;
    });
    doubles.fs.open
      .mockRejectedValueOnce(errorWithCode('EEXIST'))
      .mockResolvedValueOnce(doubles.lockHandle);
    doubles.fs.stat.mockResolvedValue({ mtimeMs: Date.now() });
    doubles.fs.access.mockRejectedValue(errorWithCode('ENOENT'));
    const primitives = createPersistencePrimitives();

    await expect(primitives.withFileLock('/tmp/state.json', async () => 'done')).resolves.toBe(
      'done',
    );
    expect(watcher.close).toHaveBeenCalledOnce();
    onWatch?.('rename', '.state.json.lock');
  });

  it('covers watcher filters, change wakeups, timer wakeups, and watch fallback', async () => {
    let iteration = 0;
    doubles.fs.open.mockImplementation(async () => {
      iteration++;
      if (iteration <= 3) throw errorWithCode('EEXIST');
      return doubles.lockHandle;
    });
    doubles.fs.stat.mockResolvedValue({ mtimeMs: Date.now() });
    doubles.fs.access.mockResolvedValue(undefined);
    doubles.watch
      .mockImplementationOnce((_dir, callback) => {
        queueMicrotask(() => {
          callback('rename', 'other.lock');
          callback('other', '.state.json.lock');
          callback('change', '.state.json.lock');
        });
        return { close: vi.fn() };
      })
      .mockImplementationOnce(() => ({ close: vi.fn() }))
      .mockImplementationOnce(() => {
        throw errorWithCode('ENOSYS');
      });
    const primitives = createPersistencePrimitives();

    await expect(
      primitives.withFileLock('/tmp/state.json', async () => 'done', { timeoutMs: 500 }),
    ).resolves.toBe('done');
    expect(doubles.watch).toHaveBeenCalledTimes(3);
  });

  it('constructs the default structured timeout error', () => {
    const error = new PersistenceFsError({
      message: 'failed',
      code: 'E_TEST',
      path: '/tmp/value',
      context: { attempt: 1 },
      cause: 'cause',
    });

    expect(error).toMatchObject({
      name: 'FsError',
      message: 'failed',
      code: 'E_TEST',
      path: '/tmp/value',
      context: { attempt: 1 },
      cause: 'cause',
    });
  });

  it('atomicReplaceWithWriter streams through the handle and returns the result', async () => {
    usePlatform('linux');
    const primitives = createPersistencePrimitives();
    const handle = {
      write: vi.fn(async () => 7),
      close: vi.fn(async () => undefined),
    };
    doubles.fs.open.mockResolvedValue(handle);
    const written = await primitives.atomicReplaceWithWriter(
      '/tmp/rotated.log',
      async (h) => {
        await h.write(Buffer.from('new tail'));
        return 'result-1';
      },
    );
    expect(written).toBe('result-1');
    expect(handle.write).toHaveBeenCalledWith(Buffer.from('new tail'));
    expect(handle.close).toHaveBeenCalled();
    // The temp file is renamed into place, not the target written directly.
    expect(doubles.fs.rename).toHaveBeenCalled();
  });

  it('atomicReplaceWithWriter cleans up the temp file when the writer throws', async () => {
    usePlatform('linux');
    const primitives = createPersistencePrimitives();
    const handle = { write: vi.fn(), close: vi.fn(async () => undefined) };
    doubles.fs.open.mockResolvedValue(handle);
    const boom = new Error('writer exploded');
    await expect(
      primitives.atomicReplaceWithWriter('/tmp/rotated.log', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(doubles.fs.unlink).toHaveBeenCalledWith(expect.stringContaining('.tmp'));
    expect(doubles.fs.rename).not.toHaveBeenCalled();
  });

  it('atomicReplaceWithWriter tolerates a failing cleanup unlink (catch arrow)', async () => {
    usePlatform('linux');
    const primitives = createPersistencePrimitives();
    const handle = { write: vi.fn(), close: vi.fn(async () => undefined) };
    doubles.fs.open.mockResolvedValue(handle);
    // The writer throws, and the best-effort temp cleanup also fails — the
    // `.catch(() => undefined)` at atomic-write.ts:188 must swallow it so the
    // original writer error still propagates.
    doubles.fs.unlink.mockRejectedValueOnce(errorWithCode('EPERM'));
    const boom = new Error('writer exploded');
    await expect(
      primitives.atomicReplaceWithWriter('/tmp/rotated.log', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('atomicReplaceWithWriter tolerates a failing handle close in the finally', async () => {
    usePlatform('linux');
    const primitives = createPersistencePrimitives();
    const handle = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        throw new Error('close failed');
      }),
    };
    doubles.fs.open.mockResolvedValue(handle);
    await expect(
      primitives.atomicReplaceWithWriter('/tmp/rotated.log', async (h) => {
        await h.write(Buffer.from('x'));
        return 42;
      }),
    ).resolves.toBe(42);
  });
});

describe('withFileLock deferred heartbeat (CPU fix)', () => {
  it('does not touch utimes for a short critical section', async () => {
    usePlatform('linux');
    vi.useFakeTimers();
    const primitives = createPersistencePrimitives();
    await expect(
      primitives.withFileLock('/tmp/state.json', async () => 'fast'),
    ).resolves.toBe('fast');
    // Fast fn() resolves before the deferred-start window (refreshMs+1) fires,
    // and the finally clears firstHeartbeat — so zero heartbeat syscalls.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(doubles.fs.utimes).not.toHaveBeenCalled();
  });

  it('starts the heartbeat and refreshes the lock mtime for a long critical section', async () => {
    usePlatform('linux');
    vi.useFakeTimers();
    const primitives = createPersistencePrimitives();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    // Explicit small staleMs keeps the heartbeat schedule fast: refreshMs =
    // max(1000, staleMs/2) = 1000, deferred start at 1001ms, first utimes at
    // ~2001ms, then every 1000ms.
    const pending = primitives.withFileLock(
      '/tmp/state.json',
      async () => {
        await gate;
        return 'slow';
      },
      { staleMs: 2_000 },
    );
    // Advance past the deferred-start (refreshMs+1) and one refresh tick —
    // a live holder must refresh so the stale-break never fires on it.
    await vi.advanceTimersByTimeAsync(2_050);
    expect(doubles.fs.utimes).toHaveBeenCalled();
    const callsAtFirstHeartbeat = doubles.fs.utimes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(doubles.fs.utimes.mock.calls.length).toBeGreaterThan(callsAtFirstHeartbeat);
    release();
    await expect(pending).resolves.toBe('slow');
  });
});

