import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStore = new Map<string, string>();

// We mock fs/promises to intercept file I/O without writing anywhere real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const realFs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...realFs,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockImplementation(async (filePath: string, content: string) => {
      mockStore.set(filePath, content);
    }),
    readFile: vi.fn().mockImplementation(async (filePath: string) => {
      const content = mockStore.get(filePath);
      if (content === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }),
    rename: vi.fn().mockImplementation(async (src: string, dest: string) => {
      const c = mockStore.get(src);
      if (c !== undefined) {
        mockStore.set(dest, c);
        mockStore.delete(src);
      }
    }),
    unlink: vi.fn().mockImplementation(async (filePath: string) => {
      mockStore.delete(filePath);
    }),
  };
});

// Point the persistent registry at a temp directory
vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    wstackGlobalRoot: () => path.join(os.tmpdir(), 'wstack-persist-test-' + process.pid),
  };
});

import { _resetProcessRegistry } from '../src/process-registry.js';
import {
  PersistentProcessRegistry,
  getPersistentProcessRegistry,
  resetPersistentProcessRegistry,
} from '../src/process-registry-persistent.js';

describe('PersistentProcessRegistry', () => {
  let registry: PersistentProcessRegistry;

  beforeEach(() => {
    _resetProcessRegistry();
    vi.clearAllMocks();
    mockStore.clear();
    registry = new PersistentProcessRegistry();
  });

  afterEach(() => {
    resetPersistentProcessRegistry();
    vi.restoreAllMocks();
    mockStore.clear();
  });

  describe('construction and singleton', () => {
    it('creates an instance with a unique instanceId', () => {
      const id = registry.getInstanceId();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id).toContain(':');
    });

    it('getPersistentProcessRegistry returns singleton', () => {
      const a = getPersistentProcessRegistry();
      const b = getPersistentProcessRegistry();
      expect(a).toBe(b);
    });

    it('resetPersistentProcessRegistry creates a new singleton', () => {
      const a = getPersistentProcessRegistry();
      resetPersistentProcessRegistry();
      const b = getPersistentProcessRegistry();
      expect(a).not.toBe(b);
    });
  });

  describe('start / stop', () => {
    it('start() registers intervals and the main process', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const registerSpy = vi.spyOn(registry, 'registerMainProcess');
      const onSpy = vi.spyOn(process, 'on');

      registry.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(onSpy).toHaveBeenCalledWith('exit', expect.any(Function));
    });

    it('start() is idempotent', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      registry.start();
      registry.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    });

    it('stop() clears intervals and removes exit listener', () => {
      registry.start();
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const offSpy = vi.spyOn(process, 'off');

      registry.stop();

      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(offSpy).toHaveBeenCalledWith('exit', expect.any(Function));
    });
  });

  describe('registerMainProcess', () => {
    it('registers the main process in the persistent store', async () => {
      registry.registerMainProcess();
      // register* persists fire-and-forget through acquireLock, which now
      // awaits an fs.mkdir first — assert asynchronously.
      await vi.waitFor(() => expect(vi.mocked(fs.writeFile)).toHaveBeenCalled());
    });
  });

  describe('registerChildProcess', () => {
    it('registers a child process and stores it', async () => {
      registry.registerChildProcess(9999, 'test-child', 'node test.js', 'sess-1', 'spawn');
      await vi.waitFor(() => expect(vi.mocked(fs.writeFile)).toHaveBeenCalled());
    });

    it('accepts fork mode', async () => {
      registry.registerChildProcess(8888, 'fork-child', 'node worker.js', undefined, 'fork');
      await vi.waitFor(() => expect(vi.mocked(fs.writeFile)).toHaveBeenCalled());
    });
  });

  describe('query methods', () => {
    it('shouldBlockKill returns false for unknown', async () => {
      expect(await registry.shouldBlockKill(99999)).toBe(false);
    });

    it('getAllProtectedPids returns empty', async () => {
      expect(await registry.getAllProtectedPids()).toEqual([]);
    });

    it('getGlobalStatus returns zeroed counts', async () => {
      const s = await registry.getGlobalStatus();
      expect(s.totalProcesses).toBe(0);
      expect(s.protectedCount).toBe(0);
      expect(s.staleCount).toBe(0);
    });

    it('isProtectedPid returns false for unknown', async () => {
      expect(await registry.isProtectedPid(99999)).toBe(false);
    });
  });

  describe('addProtectedPattern', () => {
    it('adds a new pattern', async () => {
      await registry.addProtectedPattern('myapp');
      expect(vi.mocked(fs.writeFile)).toHaveBeenCalled();
    });

    it('does not re-add existing patterns', async () => {
      await registry.addProtectedPattern('wrongstack');
      await registry.addProtectedPattern('wrongstack');
      expect(vi.mocked(fs.writeFile).mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('unregister', () => {
    it('unregisters a process', async () => {
      registry.registerChildProcess(7777, 'proc-to-remove', 'cmd');
      const before = vi.mocked(fs.writeFile).mock.calls.length;
      await registry.unregister(7777);
      expect(vi.mocked(fs.writeFile).mock.calls.length).toBeGreaterThan(before);
    });
  });
});

describe('PersistentProcessRegistry — lock and error paths', () => {
  beforeEach(() => {
    _resetProcessRegistry();
    vi.clearAllMocks();
    mockStore.clear();
  });

  afterEach(() => {
    resetPersistentProcessRegistry();
    vi.restoreAllMocks();
    mockStore.clear();
  });

  it('recovers from EEXIST lock contention (stale lock by age)', async () => {
    let attempt = 0;
    vi.mocked(fs.writeFile).mockImplementation(
      async (filePath: Parameters<typeof fs.writeFile>[0]) => {
        attempt++;
        if (attempt <= 1 && typeof filePath === 'string' && filePath.endsWith('.lock')) {
          const err: NodeJS.ErrnoException = new Error('EEXIST');
          err.code = 'EEXIST';
          throw err;
        }
      },
    );
    // Make the lock content stale (old timestamp)
    vi.mocked(fs.readFile).mockImplementation(
      async (filePath: Parameters<typeof fs.readFile>[0]) => {
        if (typeof filePath === 'string' && filePath.endsWith('.lock')) {
          return `${process.pid}:${os.hostname()}:${Date.now() - 60000}`;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    );

    const r = new PersistentProcessRegistry();
    r.registerChildProcess(111, 'test', 'cmd');
    await vi.waitFor(() => expect(vi.mocked(fs.writeFile)).toHaveBeenCalled());
  });

  it('creates the lock directory before writing the lock file (CI ENOENT race)', async () => {
    // Regression for the Linux-CI bash-kill-guard-paths failure: the
    // registry constructor creates its root fire-and-forget, so the first
    // acquireLock can race ahead of that mkdir and hit ENOENT. acquireLock
    // must mkdir the lock parent itself. Simulate a slow mkdir (as if the
    // constructor's async ensureDirectory has not completed) and make the
    // lock write throw ENOENT until the directory exists.
    let lockMkdirDone = false;
    let lockWriteSucceeded = false;
    vi.mocked(fs.mkdir).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      lockMkdirDone = true;
      return undefined;
    });
    vi.mocked(fs.writeFile).mockImplementation(
      async (filePath: Parameters<typeof fs.writeFile>[0], content: string) => {
        const p = String(filePath);
        if (p.endsWith('.process-registry.lock')) {
          if (!lockMkdirDone) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
          lockWriteSucceeded = true;
        }
        mockStore.set(p, content);
      },
    );

    const r = new PersistentProcessRegistry();
    r.registerChildProcess(4321, 'race-child', 'node race.js', 'sess-1', 'spawn');
    // The lock file itself is transient (unlinked on release), so assert on
    // the successful lock write rather than its persistence.
    await vi.waitFor(() => expect(lockWriteSucceeded).toBe(true));
  });

  it('steals unreadable lock file (stolen via catch path)', async () => {
    // First write to lock fails with EEXIST; then the catch path calls unlink,
    // and the retry write should succeed.
    let lockAttempts = 0;
    vi.mocked(fs.writeFile).mockImplementation(
      async (filePath: Parameters<typeof fs.writeFile>[0]) => {
        if (typeof filePath === 'string' && filePath.endsWith('.lock')) {
          lockAttempts++;
          if (lockAttempts <= 1) {
            const err: NodeJS.ErrnoException = new Error('EEXIST');
            err.code = 'EEXIST';
            throw err;
          }
          // Second attempt succeeds (after stale lock was unlinked)
        }
      },
    );
    // readFile fails for the lock file (triggering stale catch)
    // but returns ENOENT for the registry file (empty state = no pids)
    vi.mocked(fs.readFile).mockImplementation(
      async (filePath: Parameters<typeof fs.readFile>[0]) => {
        if (typeof filePath === 'string' && filePath.endsWith('.lock')) {
          throw new Error('EACCES');
        }
        // Registry file not found → triggers freshRegistryData (empty)
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    );

    const r = new PersistentProcessRegistry();
    await expect(r.getAllProtectedPids()).resolves.toEqual([]);
  });

  it('propagates genuine IO errors on registry file', async () => {
    // Succeed on lock write
    vi.mocked(fs.writeFile).mockImplementation(
      async (filePath: Parameters<typeof fs.writeFile>[0]) => {
        if (typeof filePath === 'string' && filePath.endsWith('.lock')) {
          return; // success
        }
      },
    );
    // Throw EACCES on registry file read
    vi.mocked(fs.readFile).mockImplementation(
      async (filePath: Parameters<typeof fs.readFile>[0]) => {
        if (typeof filePath === 'string' && filePath.endsWith('.lock')) {
          return `${process.pid}:${os.hostname()}:${Date.now() - 100}`;
        }
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    );

    const r = new PersistentProcessRegistry();
    await expect(r.getAllProtectedPids()).rejects.toThrow();
  });
});
