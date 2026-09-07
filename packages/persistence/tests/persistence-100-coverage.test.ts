import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atomicReplaceWithWriter,
  atomicWrite,
  ensureDir,
  withFileLock,
} from '../src/atomic-write.js';
import {
  _filePermOps,
  restrictDirPermissions,
  restrictFilePermissions,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
} from '../src/file-permissions.js';
import {
  _projectEndpointOps,
  bindProjectEndpoint,
  isProjectEndpointLive,
} from '../src/project-endpoint.js';
import {
  assertUnixSocketPathWithinLimit,
  checkUnixSocketPath,
  unixSocketPathLimit,
} from '../src/socket-path.js';
import { isRuntimeSqliteAvailable, loadRuntimeDatabaseSync } from '../src/sqlite-runtime.js';

describe('persistence 100% coverage suite', () => {
  const originalEnv = { ...process.env };
  const origFilePermOps = { ..._filePermOps };
  const origEndpointOps = { ..._projectEndpointOps };

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(_filePermOps, origFilePermOps);
    Object.assign(_projectEndpointOps, origEndpointOps);
    process.env = { ...originalEnv };
  });

  describe('atomic-write.ts default exports', () => {
    it('covers exported default primitives', async () => {
      expect(typeof atomicWrite).toBe('function');
      expect(typeof atomicReplaceWithWriter).toBe('function');
      expect(typeof ensureDir).toBe('function');
      expect(typeof withFileLock).toBe('function');

      const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ws-def-prim-'));
      const testFile = path.join(tmpDir, 'test.txt');
      try {
        await atomicWrite(testFile, 'hello');
        await ensureDir(path.join(tmpDir, 'sub'));
        await atomicReplaceWithWriter(testFile, async (handle) => {
          await handle.writeFile('updated');
        });
        await withFileLock(testFile, async () => 'locked');
      } finally {
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('socket-path.ts', () => {
    it('covers all platforms and limits', () => {
      expect(unixSocketPathLimit('darwin')).toBe(103);
      expect(unixSocketPathLimit('freebsd')).toBe(103);
      expect(unixSocketPathLimit('openbsd')).toBe(103);
      expect(unixSocketPathLimit('linux')).toBe(107);
      expect(unixSocketPathLimit('win32')).toBe(107);
    });

    it('covers checkUnixSocketPath edge cases', () => {
      // non-string
      const nonStr = checkUnixSocketPath(123 as any, 'linux');
      expect(nonStr.ok).toBe(false);
      expect(nonStr.byteLength).toBe(0);

      // nul byte
      const nul = checkUnixSocketPath('sock\0path', 'linux');
      expect(nul.ok).toBe(false);
      expect(nul.byteLength).toBe(0);

      // win32 always ok
      const win = checkUnixSocketPath('any-long-pipe-name', 'win32');
      expect(win.ok).toBe(true);

      // linux within limit
      const linOk = checkUnixSocketPath('/tmp/short.sock', 'linux');
      expect(linOk.ok).toBe(true);

      // linux exceeds limit
      const linTooLong = checkUnixSocketPath('/tmp/' + 'a'.repeat(120), 'linux');
      expect(linTooLong.ok).toBe(false);
    });

    it('covers assertUnixSocketPathWithinLimit errors and success', () => {
      // ok
      expect(() =>
        assertUnixSocketPathWithinLimit('/tmp/valid.sock', 'test', 'linux'),
      ).not.toThrow();

      // non-string
      expect(() => assertUnixSocketPathWithinLimit(null as any, 'test', 'linux')).toThrow(
        /must be a string/,
      );

      // nul byte
      expect(() => assertUnixSocketPathWithinLimit('bad\0path', 'test', 'linux')).toThrow(
        /contains a NUL byte/,
      );

      // over limit
      expect(() =>
        assertUnixSocketPathWithinLimit('/tmp/' + 'x'.repeat(120), 'test', 'darwin'),
      ).toThrow(/over the darwin sun_path limit/);
    });
  });

  describe('sqlite-runtime.ts', () => {
    it('covers databaseSyncFromNode and databaseSyncFromBun edge cases', () => {
      // null module
      expect(() => loadRuntimeDatabaseSync(() => null)).toThrow(/No supported synchronous SQLite/);

      // non-object module
      expect(() => loadRuntimeDatabaseSync(() => 'invalid')).toThrow(
        /No supported synchronous SQLite/,
      );

      // module without DatabaseSync
      const loaderNoDbSync = (spec: string) => {
        if (spec === 'node:sqlite') return {};
        if (spec === 'bun:sqlite') return {};
        return null;
      };
      expect(() => loadRuntimeDatabaseSync(loaderNoDbSync)).toThrow(
        /node:sqlite did not export DatabaseSync.*bun:sqlite did not export Database/,
      );

      // module with DatabaseSync not a function
      const loaderInvalidTypes = (spec: string) => {
        if (spec === 'node:sqlite') return { DatabaseSync: 'not-fn' };
        if (spec === 'bun:sqlite') return { Database: 123 };
        return null;
      };
      expect(() => loadRuntimeDatabaseSync(loaderInvalidTypes)).toThrow(
        /node:sqlite did not export DatabaseSync.*bun:sqlite did not export Database/,
      );

      // non-Error thrown by loaders
      const loaderThrowsStrings = (spec: string) => {
        throw `custom error for ${spec}`;
      };
      expect(() => loadRuntimeDatabaseSync(loaderThrowsStrings)).toThrow(
        /custom error for node:sqlite.*custom error for bun:sqlite/,
      );

      // Bun database wrapper
      class MockBunDatabase {
        filename: string;
        options: any;
        constructor(filename: string, options?: any) {
          this.filename = filename;
          this.options = options;
        }
      }
      const bunLoader = (spec: string) => {
        if (spec === 'node:sqlite') throw new Error('Cannot find module');
        if (spec === 'bun:sqlite') return { Database: MockBunDatabase };
        return null;
      };

      const BunSyncCtor = loadRuntimeDatabaseSync(bunLoader);
      expect(BunSyncCtor).toBeDefined();

      // instantiate without options
      const db1 = new BunSyncCtor('test.db') as any;
      expect(db1.filename).toBe('test.db');
      expect(db1.options).toBeUndefined();

      // instantiate with readOnly: true
      const db2 = new BunSyncCtor('readonly.db', { readOnly: true }) as any;
      expect(db2.options).toEqual({ readonly: true, create: false, readwrite: false });

      // isRuntimeSqliteAvailable
      expect(isRuntimeSqliteAvailable(bunLoader)).toBe(true);
      expect(isRuntimeSqliteAvailable(() => null)).toBe(false);
    });
  });

  describe('file-permissions.ts', () => {
    it('covers POSIX path and chmod handling', async () => {
      _filePermOps.platform = 'linux';
      const chmodMock = vi.fn().mockResolvedValue(undefined);
      _filePermOps.chmod = chmodMock as any;

      await restrictFilePermissions('/tmp/secret.json');
      expect(chmodMock).toHaveBeenCalledWith('/tmp/secret.json', SECRET_FILE_MODE);

      await restrictDirPermissions('/tmp/secret-dir');
      expect(chmodMock).toHaveBeenCalledWith('/tmp/secret-dir', SECRET_DIR_MODE);

      // chmod rejection is tolerated
      chmodMock.mockRejectedValueOnce(new Error('EPERM'));
      await expect(restrictFilePermissions('/tmp/secret.json')).resolves.toBeUndefined();
    });

    it('covers Windows path, user resolution, and icacls handling', async () => {
      _filePermOps.platform = 'win32';

      // 1. Missing user: env USERNAME/USER unset, os.userInfo throws
      delete process.env['USERNAME'];
      delete process.env['USER'];
      delete process.env['USERDOMAIN'];
      _filePermOps.userInfo = () => {
        throw new Error('userInfo failed');
      };

      const warnings: string[] = [];
      const customWarn = (msg: string) => warnings.push(msg);

      await restrictFilePermissions('C:\\secret.json', { warn: customWarn, label: 'test-sec' });
      expect(warnings.some((w) => w.includes('Could not determine the current Windows user'))).toBe(
        true,
      );

      // 2. User with null byte is rejected
      process.env['USERNAME'] = 'bad\0user';
      warnings.length = 0;
      await restrictFilePermissions('C:\\secret.json', { warn: customWarn });
      expect(warnings.some((w) => w.includes('Could not determine the current Windows user'))).toBe(
        true,
      );

      // 3. Valid user, domain with null byte falls back to user without domain
      process.env['USERNAME'] = 'testuser';
      process.env['USERDOMAIN'] = 'bad\0domain';

      // 4. stat check for vanished path (pathIsGone) vs live path error
      // When icacls fails and file is gone, no warning
      _filePermOps.stat = vi.fn().mockRejectedValue(new Error('ENOENT')) as any;
      _filePermOps.execFileAsync = vi.fn().mockRejectedValue(new Error('icacls failure'));

      warnings.length = 0;
      await restrictFilePermissions('C:\\vanished.json', { warn: customWarn });
      expect(warnings).toHaveLength(0);

      // When icacls fails and file is live, warnings emitted with reason
      _filePermOps.stat = vi.fn().mockResolvedValue({} as any) as any;
      warnings.length = 0;
      await restrictFilePermissions('C:\\live.json', { warn: customWarn });
      expect(
        warnings.some((w) => w.includes('Could not restrict permissions on C:\\live.json')),
      ).toBe(true);

      // When icacls throws non-Error
      _filePermOps.execFileAsync = vi.fn().mockRejectedValue('string error from icacls');
      warnings.length = 0;
      await restrictFilePermissions('C:\\live.json', { warn: customWarn });
      expect(warnings.some((w) => w.includes('string error from icacls'))).toBe(true);

      // 5. Default warn fallback (calls console.warn)
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _filePermOps.execFileAsync = vi.fn().mockRejectedValue(new Error('boom'));
      await restrictFilePermissions('C:\\live.json');
      expect(consoleWarnSpy).toHaveBeenCalled();

      // 6. Directory permissions with domain
      process.env['USERDOMAIN'] = 'MYDOMAIN';
      let capturedArgs: any = null;
      _filePermOps.execFileAsync = vi.fn(async (_cmd: string, args: any) => {
        capturedArgs = args;
        return { stdout: '', stderr: '' };
      });
      await restrictDirPermissions('C:\\secret-dir');
      expect(capturedArgs).toContain('MYDOMAIN\\testuser:(OI)(CI)(F)');

      // 7. os.userInfo fallback when env is empty
      delete process.env['USERNAME'];
      delete process.env['USER'];
      delete process.env['USERDOMAIN'];
      _filePermOps.userInfo = () => ({ username: 'osUser' }) as any;
      _filePermOps.execFileAsync = vi.fn(async (_cmd: string, args: any) => {
        capturedArgs = args;
        return { stdout: '', stderr: '' };
      });
      await restrictFilePermissions('C:\\os-secret.json');
      expect(capturedArgs).toContain('osUser:(F)');

      // 8. Missing execFn
      _filePermOps.execFileAsync = null as any;
      warnings.length = 0;
      await restrictFilePermissions('C:\\secret.json', { warn: customWarn });
      expect(warnings.some((w) => w.includes('child_process.execFile unavailable'))).toBe(true);
    });
  });

  describe('project-endpoint.ts', () => {
    it('covers isProjectEndpointLive probe variations', async () => {
      // createConnection throws synchronously
      _projectEndpointOps.createConnection = () => {
        throw new Error('sync throw');
      };
      expect(await isProjectEndpointLive('bad-endpoint', 50)).toBe(false);

      // probe connects
      const fakeSocket = new EventEmitter() as any;
      fakeSocket.destroy = vi.fn();
      _projectEndpointOps.createConnection = () => fakeSocket;

      const livePromise = isProjectEndpointLive('test-endpoint', 100);
      fakeSocket.emit('connect');
      expect(await livePromise).toBe(true);

      // probe error
      const errSocket = new EventEmitter() as any;
      errSocket.destroy = vi.fn();
      _projectEndpointOps.createConnection = () => errSocket;

      const errPromise = isProjectEndpointLive('test-endpoint', 100);
      errSocket.emit('error', new Error('ECONNREFUSED'));
      expect(await errPromise).toBe(false);

      // probe timeout
      const timeoutSocket = new EventEmitter() as any;
      timeoutSocket.destroy = vi.fn();
      _projectEndpointOps.createConnection = () => timeoutSocket;

      const timeoutPromise = isProjectEndpointLive('test-endpoint', 10);
      expect(await timeoutPromise).toBe(false);

      // probe settled test (when finish is called twice)
      const fakeSocketSettled = new EventEmitter() as any;
      fakeSocketSettled.destroy = vi.fn();
      _projectEndpointOps.createConnection = () => fakeSocketSettled;
      const settledPromise = isProjectEndpointLive('test-endpoint', 100);
      fakeSocketSettled.emit('connect');
      fakeSocketSettled.emit('error', new Error('secondary error'));
      expect(await settledPromise).toBe(true);
    });

    it('covers bindProjectEndpoint Windows branches', async () => {
      _projectEndpointOps.platform = 'win32';

      // 1. Successful listen on Windows
      const fakeServerSuccess = new EventEmitter() as any;
      fakeServerSuccess.listen = vi.fn(() => {
        setTimeout(() => fakeServerSuccess.emit('listening'), 2);
      });
      const resSuccess = await bindProjectEndpoint({
        server: fakeServerSuccess,
        endpoint: '\\\\.\\pipe\\test-pipe',
        service: 'test-svc',
      });
      expect(resSuccess.outcome).toBe('bound');

      // 2. EADDRINUSE on Windows returns already-owned immediately without probing
      const fakeServerInUse = new EventEmitter() as any;
      fakeServerInUse.listen = vi.fn(() => {
        const err: any = new Error('address in use');
        err.code = 'EADDRINUSE';
        setTimeout(() => fakeServerInUse.emit('error', err), 2);
      });
      const resInUse = await bindProjectEndpoint({
        server: fakeServerInUse,
        endpoint: '\\\\.\\pipe\\test-pipe',
        service: 'test-svc',
      });
      expect(resInUse.outcome).toBe('already-owned');

      // 3. Other error (e.g. EACCES) returns failed
      const fakeServerAccess = new EventEmitter() as any;
      fakeServerAccess.listen = vi.fn(() => {
        const err: any = new Error('permission denied');
        err.code = 'EACCES';
        setTimeout(() => fakeServerAccess.emit('error', err), 2);
      });
      const resAccess = await bindProjectEndpoint({
        server: fakeServerAccess,
        endpoint: '\\\\.\\pipe\\test-pipe',
        service: 'test-svc',
      });
      expect(resAccess.outcome).toBe('failed');

      // 4. listen throws synchronously (e.g. ERR_SERVER_ALREADY_LISTEN)
      const fakeServerThrows = new EventEmitter() as any;
      fakeServerThrows.listen = vi.fn(() => {
        const err: any = new Error('server already listening');
        err.code = 'ERR_SERVER_ALREADY_LISTEN';
        throw err;
      });
      const resThrows = await bindProjectEndpoint({
        server: fakeServerThrows,
        endpoint: '\\\\.\\pipe\\test-pipe',
        service: 'test-svc',
      });
      expect(resThrows.outcome).toBe('failed');
    });

    it('covers bindProjectEndpoint POSIX branches, directory creation, and stale socket recovery', async () => {
      _projectEndpointOps.platform = 'linux';

      // 1. Directory creation fails (e.g. over-long socket path)
      const fakeServer = new EventEmitter() as any;
      fakeServer.listen = vi.fn();
      const failDirRes = await bindProjectEndpoint({
        server: fakeServer,
        endpoint: '/tmp/' + 'x'.repeat(120),
        service: 'test-svc',
      });
      expect(failDirRes.outcome).toBe('failed');

      // 2. Directory creation fails with non-Error
      _projectEndpointOps.mkdir = vi.fn().mockRejectedValue('raw string error') as any;
      const failNonError = await bindProjectEndpoint({
        server: fakeServer,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      expect(failNonError.outcome).toBe('failed');

      // 3. Successful listen on POSIX with chmod
      _projectEndpointOps.mkdir = vi.fn().mockResolvedValue(undefined) as any;
      const chmodMock = vi.fn().mockResolvedValue(undefined);
      _projectEndpointOps.chmod = chmodMock as any;
      // G1 (DIP-002/DIP-003): the directory is now also stat'd and the
      // ownership compared against the current uid; mock the stat to
      // match the current process so the successful-listen path still
      // succeeds. (Cross-process squatter tests live in the dedicated
      // regression below.)
      const fakeStat = { uid: typeof process.getuid === 'function' ? process.getuid()! : 0 };
      _projectEndpointOps.stat = vi.fn().mockResolvedValue(fakeStat) as any;

      const fakeServerLinux = new EventEmitter() as any;
      fakeServerLinux.listen = vi.fn(() => {
        setTimeout(() => fakeServerLinux.emit('listening'), 2);
      });
      const resLinux = await bindProjectEndpoint({
        server: fakeServerLinux,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      expect(resLinux.outcome).toBe('bound');
      expect(chmodMock).toHaveBeenCalledWith('/tmp/test.sock', 0o600);

      // Chmod fails (rejected) -> still returns bound
      chmodMock.mockRejectedValueOnce(new Error('chmod fail'));
      const fakeServerChmodFail = new EventEmitter() as any;
      fakeServerChmodFail.listen = vi.fn(() => {
        setTimeout(() => fakeServerChmodFail.emit('listening'), 2);
      });
      const resChmodFail = await bindProjectEndpoint({
        server: fakeServerChmodFail,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      expect(resChmodFail.outcome).toBe('bound');

      // 4. POSIX EADDRINUSE where socket is live -> already-owned
      const fakeSocket = new EventEmitter() as any;
      fakeSocket.destroy = vi.fn();
      _projectEndpointOps.createConnection = () => fakeSocket;

      const fakeServerLive = new EventEmitter() as any;
      fakeServerLive.listen = vi.fn(() => {
        const err: any = new Error('address in use');
        err.code = 'EADDRINUSE';
        setTimeout(() => fakeServerLive.emit('error', err), 2);
      });
      const livePromise = bindProjectEndpoint({
        server: fakeServerLive,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      setTimeout(() => fakeSocket.emit('connect'), 10);
      const resLive = await livePromise;
      expect(resLive.outcome).toBe('already-owned');

      // 5. POSIX EADDRINUSE where socket is dead -> probe fails -> unlinks stale file -> rebinds!
      const errSocket = new EventEmitter() as any;
      errSocket.destroy = vi.fn();
      _projectEndpointOps.createConnection = () => errSocket;

      let attemptCount = 0;
      const fakeServerReclaim = new EventEmitter() as any;
      fakeServerReclaim.listen = vi.fn(() => {
        attemptCount++;
        if (attemptCount === 1) {
          const err: any = new Error('address in use');
          err.code = 'EADDRINUSE';
          setTimeout(() => fakeServerReclaim.emit('error', err), 2);
        } else {
          setTimeout(() => fakeServerReclaim.emit('listening'), 2);
        }
      });
      const rmMock = vi.fn().mockResolvedValue(undefined);
      _projectEndpointOps.rm = rmMock as any;

      const reclaimPromise = bindProjectEndpoint({
        server: fakeServerReclaim,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      setTimeout(() => errSocket.emit('error', new Error('ECONNREFUSED')), 10);
      const resReclaimed = await reclaimPromise;
      expect(resReclaimed.outcome).toBe('bound');
      expect((resReclaimed as any).reclaimedStaleEndpoint).toBe(true);
      expect(rmMock).toHaveBeenCalledWith('/tmp/test.sock', { force: true });

      // 6. POSIX EADDRINUSE where rm throws EPERM -> fails immediately
      attemptCount = 0;
      rmMock.mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EPERM' }),
      );
      const failRmPromise = bindProjectEndpoint({
        server: fakeServerReclaim,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      setTimeout(() => errSocket.emit('error', new Error('ECONNREFUSED')), 10);
      const resRmFail = await failRmPromise;
      expect(resRmFail.outcome).toBe('failed');
      expect((resRmFail as any).error.message).toContain(
        'could not reclaim its stale IPC endpoint',
      );

      // 6b. POSIX EADDRINUSE where rm throws non-Error
      attemptCount = 0;
      rmMock.mockRejectedValueOnce('raw string rm error');
      const failNonErrorRmPromise = bindProjectEndpoint({
        server: fakeServerReclaim,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      setTimeout(() => errSocket.emit('error', new Error('ECONNREFUSED')), 10);
      const resNonErrorRm = await failNonErrorRmPromise;
      expect(resNonErrorRm.outcome).toBe('failed');
      expect((resNonErrorRm as any).error.message).toContain('raw string rm error');

      // 7. POSIX EADDRINUSE where rm throws ENOENT (competing contender unlinked it) -> retries
      attemptCount = 0;
      rmMock.mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
      const enoentPromise = bindProjectEndpoint({
        server: fakeServerReclaim,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
      });
      setTimeout(() => errSocket.emit('error', new Error('ECONNREFUSED')), 10);
      const resEnoent = await enoentPromise;
      expect(resEnoent.outcome).toBe('bound');

      // 8. POSIX EADDRINUSE where all maxAttempts fail -> fails after maxAttempts
      const fakeServerAlwaysInUse = new EventEmitter() as any;
      fakeServerAlwaysInUse.listen = vi.fn(() => {
        const err: any = new Error('address in use');
        err.code = 'EADDRINUSE';
        setTimeout(() => fakeServerAlwaysInUse.emit('error', err), 2);
      });
      rmMock.mockResolvedValue(undefined);
      const maxAttemptsPromise = bindProjectEndpoint({
        server: fakeServerAlwaysInUse,
        endpoint: '/tmp/test.sock',
        service: 'test-svc',
        maxAttempts: 2,
      });
      const interval = setInterval(() => errSocket.emit('error', new Error('ECONNREFUSED')), 5);
      const resMaxAttempts = await maxAttemptsPromise;
      clearInterval(interval);
      expect(resMaxAttempts.outcome).toBe('failed');
      expect((resMaxAttempts as any).error.message).toContain('after 2 attempts');
    });
  });
});
