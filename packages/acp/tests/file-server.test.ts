/**
 * Tests for FileServer.
 *
 * Uses a temp directory as the project root. Tests cover:
 *   - in-root read
 *   - in-root write (atomic via rename)
 *   - out-of-root read rejected with FsError
 *   - relative path rejected (ACP requires absolute)
 *   - non-existent file rejected with ENOENT
 *   - timeout path (using a very short timeout)
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileServer, FsError } from '../src/client/file-server.js';
import type { FileServerOperations } from '../src/client/file-server.js';

let projectRoot: string;
let server: FileServer;

function fakeOperations(overrides: Partial<FileServerOperations> = {}): FileServerOperations {
  return {
    stat: async () => ({ size: 0 }),
    readFile: async () => '',
    writeFile: async () => {},
    realpath: async (file) => file,
    rename: async () => {},
    unlink: async () => {},
    ...overrides,
  };
}

beforeEach(async () => {
  projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-fs-'));
  server = new FileServer({ projectRoot });
});

afterEach(async () => {
  await fsp.rm(projectRoot, { recursive: true, force: true });
});

describe('FileServer', () => {
  it('reads a file inside the project root', async () => {
    const p = path.join(projectRoot, 'hello.txt');
    await fsp.writeFile(p, 'world', 'utf8');
    const out = await server.readTextFile({ sessionId: 's1', path: p });
    expect(out.content).toBe('world');
  });

  it('writes a file inside the project root (atomic via rename)', async () => {
    const p = path.join(projectRoot, 'out.txt');
    await server.writeTextFile({ sessionId: 's1', path: p, content: 'data' });
    const onDisk = await fsp.readFile(p, 'utf8');
    expect(onDisk).toBe('data');
  });

  it('rejects paths outside the project root with OUTSIDE_ROOT', async () => {
    await expect(
      server.readTextFile({ sessionId: 's1', path: '/etc/passwd' }),
    ).rejects.toBeInstanceOf(FsError);
    try {
      await server.readTextFile({ sessionId: 's1', path: '/etc/passwd' });
    } catch (err) {
      expect((err as FsError).code).toBe('OUTSIDE_ROOT');
    }
  });

  it('rejects relative paths (ACP requires absolute)', async () => {
    await expect(
      server.readTextFile({ sessionId: 's1', path: 'relative/file.txt' }),
    ).rejects.toBeInstanceOf(FsError);
    try {
      await server.readTextFile({ sessionId: 's1', path: 'relative/file.txt' });
    } catch (err) {
      expect((err as FsError).code).toBe('INVALID_PATH');
    }
  });

  it('rejects sibling-prefix attacks (e.g. /project-evil vs /project)', async () => {
    // projectRoot is something like /tmp/wstack-fs-abc123
    // /tmp/wstack-fs-abc123-evil is NOT a child
    const evil = projectRoot + '-evil';
    try {
      await server.readTextFile({ sessionId: 's1', path: evil });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('OUTSIDE_ROOT');
    }
  });

  it('returns ENOENT for a missing file', async () => {
    const p = path.join(projectRoot, 'missing.txt');
    try {
      await server.readTextFile({ sessionId: 's1', path: p });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('ENOENT');
    }
  });

  it('write replaces existing file content', async () => {
    const p = path.join(projectRoot, 'replace.txt');
    await fsp.writeFile(p, 'old', 'utf8');
    await server.writeTextFile({ sessionId: 's1', path: p, content: 'new' });
    expect(await fsp.readFile(p, 'utf8')).toBe('new');
  });

  it('rejects empty path with INVALID_PATH', async () => {
    try {
      await server.readTextFile({ sessionId: 's1', path: '' });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('INVALID_PATH');
    }
  });

  it('rejects attempt to write outside project root', async () => {
    try {
      await server.writeTextFile({ sessionId: 's1', path: '/etc/passwd', content: 'x' });
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(FsError);
      expect((err as FsError).code).toBe('OUTSIDE_ROOT');
    }
  });

  it('cleans up the .tmp file on write failure', async () => {
    if (process.platform === 'win32') {
      // POSIX permission bits are ignored on Windows, so we can't rely
      // on chmod to force a write failure. Use an invalid path instead
      // to force a write error and verify the .tmp cleanup still runs.
      const p = path.join(projectRoot, 'no\0pe.txt');
      await expect(
        server.writeTextFile({ sessionId: 's1', path: p, content: 'x' }),
      ).rejects.toBeInstanceOf(FsError);
      const entries = await fsp.readdir(projectRoot);
      expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
      return;
    }
    // Make the projectRoot read-only so writeFile throws
    const p = path.join(projectRoot, 'nope.txt');
    await fsp.chmod(projectRoot, 0o500);
    try {
      await expect(
        server.writeTextFile({ sessionId: 's1', path: p, content: 'x' }),
      ).rejects.toBeInstanceOf(FsError);
    } finally {
      await fsp.chmod(projectRoot, 0o700);
    }
    // The .tmp file should not be left behind
    const entries = await fsp.readdir(projectRoot);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('falls back to the given root when its synchronous realpath fails', () => {
    const missingRoot = path.join(projectRoot, 'not-created');
    expect(() => new FileServer({ projectRoot: missingRoot })).not.toThrow();
  });

  it('accepts the filesystem root without a sibling-prefix false positive', async () => {
    const filesystemRoot = path.parse(projectRoot).root;
    const rootServer = new FileServer({
      projectRoot: filesystemRoot,
      operations: fakeOperations(),
    });
    await expect(
      rootServer.readTextFile({ sessionId: 's1', path: filesystemRoot }),
    ).resolves.toEqual({ content: '' });
  });

  it.each(['EACCES', 'EPERM'])('maps stat %s failures to EACCES', async (code) => {
    const denied = new FileServer({
      projectRoot,
      operations: fakeOperations({
        stat: async () => Promise.reject(Object.assign(new Error('denied'), { code })),
      }),
    });
    await expect(
      denied.readTextFile({ sessionId: 's1', path: path.join(projectRoot, 'file') }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('maps a non-Error read failure to INVALID_PATH', async () => {
    const broken = new FileServer({
      projectRoot,
      operations: fakeOperations({
        readFile: async () => Promise.reject('broken read'),
      }),
    });
    await expect(
      broken.readTextFile({ sessionId: 's1', path: path.join(projectRoot, 'file') }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH', message: 'broken read' });
  });

  it('times out a stalled read', async () => {
    vi.useFakeTimers();
    try {
      const stalled = new FileServer({
        projectRoot,
        timeoutMs: 10,
        operations: fakeOperations({
          readFile: async (_file, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        }),
      });
      const pending = stalled.readTextFile({
        sessionId: 's1',
        path: path.join(projectRoot, 'file'),
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up and preserves an FsError raised during an atomic write', async () => {
    const unlink = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const guarded = new FileServer({
      projectRoot,
      operations: fakeOperations({
        realpath: async (file) => {
          if (file.endsWith('.tmp')) {
            return path.join(path.dirname(projectRoot), 'outside', 'file');
          }
          return file;
        },
        unlink,
      }),
    });
    await expect(
      guarded.writeTextFile({
        sessionId: 's1',
        path: path.join(projectRoot, 'file'),
        content: 'data',
      }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    expect(unlink).toHaveBeenCalledOnce();
  });

  it('maps a failed write after successful cleanup', async () => {
    const unlink = vi.fn(async () => {});
    const broken = new FileServer({
      projectRoot,
      operations: fakeOperations({
        writeFile: async () => {
          throw new Error('disk failed');
        },
        unlink,
      }),
    });
    await expect(
      broken.writeTextFile({
        sessionId: 's1',
        path: path.join(projectRoot, 'file'),
        content: 'data',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH', message: 'disk failed' });
    expect(unlink).toHaveBeenCalledOnce();
  });

  it('times out a stalled write and tolerates a missing temp file', async () => {
    vi.useFakeTimers();
    try {
      const stalled = new FileServer({
        projectRoot,
        timeoutMs: 10,
        operations: fakeOperations({
          writeFile: async (_file, _content, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
          unlink: async () => {
            throw new Error('missing');
          },
        }),
      });
      const pending = stalled.writeTextFile({
        sessionId: 's1',
        path: path.join(projectRoot, 'file'),
        content: 'data',
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a path when no ancestor can be resolved', async () => {
    const root = path.parse(projectRoot).root;
    const missing = new FileServer({
      projectRoot: root,
      operations: fakeOperations({
        realpath: async () =>
          Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
      }),
    });
    await expect(
      missing.readTextFile({ sessionId: 's1', path: path.join(root, 'never', 'exists') }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
