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

import { realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileServerOperations } from '../src/client/file-server.js';
import { FileServer, FsError } from '../src/client/file-server.js';

let projectRoot: string;
let server: FileServer;

/**
 * Mirror real realpath() for in-root probes: macOS os.tmpdir() is
 * `/var/folders/...`, a symlink to `/private/var/folders/...`, so an
 * identity fake disagrees with the canonicalized realRoot and every
 * containment check reads as an escape. Synchronous internally so the
 * promise settles in a microtask — fake-timer tests rely on that.
 */
function fakeRealpath(file: string): Promise<string> {
  const rel = path.relative(projectRoot, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return Promise.resolve(file);
  return Promise.resolve(path.join(realpathSync(projectRoot), rel));
}

function fakeOperations(overrides: Partial<FileServerOperations> = {}): FileServerOperations {
  return {
    stat: async () => ({ size: 0 }),
    readFile: async () => '',
    writeFile: async () => {},
    realpath: fakeRealpath,
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
    const read = server.readTextFile({ sessionId: 's1', path: '/etc/passwd' });
    await expect(read).rejects.toBeInstanceOf(FsError);
    await expect(read).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
  });

  it('rejects relative paths (ACP requires absolute)', async () => {
    const read = server.readTextFile({ sessionId: 's1', path: 'relative/file.txt' });
    await expect(read).rejects.toBeInstanceOf(FsError);
    await expect(read).rejects.toMatchObject({ code: 'INVALID_PATH' });
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
          return fakeRealpath(file);
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

  it('writeTextFile rejects non-string content', async () => {
    await expect(
      server.writeTextFile({
        sessionId: 's1',
        path: path.join(projectRoot, 'test.txt'),
        content: 123 as any,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PATH',
      message: expect.stringContaining('content must be a string'),
    });
  });

  it('rejects when realpath resolves outside root', async () => {
    const symlinkServer = new FileServer({
      projectRoot,
      operations: fakeOperations({
        realpath: async () => path.resolve(projectRoot, '..', 'escaped'),
      }),
    });
    await expect(
      symlinkServer.readTextFile({
        sessionId: 's1',
        path: path.join(projectRoot, 'file.txt'),
      }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
  });

  it('covers non-Windows normalization when platform is not win32', async () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const linuxServer = new FileServer({
        projectRoot,
        operations: fakeOperations({ readFile: async () => 'linux-content' }),
      });
      await expect(
        linuxServer.readTextFile({ sessionId: 's1', path: path.join(projectRoot, 'file.txt') }),
      ).resolves.toEqual({ content: 'linux-content' });
      // Off Windows the root comparison is case-SENSITIVE: a case-changed
      // spelling of the root is a different directory and must be refused.
      await expect(
        linuxServer.readTextFile({
          sessionId: 's1',
          path: path.join(projectRoot.toUpperCase(), 'file.txt'),
        }),
      ).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  // `line`/`limit` arrive straight from the agent on `fs/read_text_file`, so
  // this validation is an input boundary. `line` is 1-based (ACP spec) and
  // `limit` is a line count, so 0/-1/fractional values must be rejected rather
  // than silently coerced into a surprising slice.
  describe('line/limit validation', () => {
    const file = () => path.join(projectRoot, 'lines.txt');
    const withContent = (text: string) =>
      new FileServer({
        projectRoot,
        operations: fakeOperations({
          realpath: async (f) => f,
          readFile: async () => text,
        }),
      });

    for (const [label, line, limit] of [
      ['line 0', 0, undefined],
      ['negative line', -1, undefined],
      ['fractional line', 1.5, undefined],
      ['NaN line', Number.NaN, undefined],
      ['negative limit', undefined, -1],
      ['fractional limit', undefined, 2.5],
    ] as const) {
      it(`rejects ${label}`, async () => {
        await expect(
          withContent('a\nb\nc\n').readTextFile({
            sessionId: 's1',
            path: file(),
            ...(line !== undefined ? { line } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      });
    }

    // Boundaries that must keep working. `line` is a 1-based START offset and
    // `limit` bounds how many lines from there — so `line` alone returns the
    // remainder, and only `line` + `limit` narrows to a single line.
    it('treats line 1 with no limit as the whole file', async () => {
      const result = await withContent('a\nb\nc\n').readTextFile({
        sessionId: 's1',
        path: file(),
        line: 1,
      });
      expect(result.content).toBe('a\nb\nc\n');
    });

    it('reads a single line with line 1 and limit 1', async () => {
      const result = await withContent('a\nb\nc\n').readTextFile({
        sessionId: 's1',
        path: file(),
        line: 1,
        limit: 1,
      });
      expect(result.content).toBe('a\n');
    });

    it('starts at the requested line', async () => {
      const result = await withContent('a\nb\nc\n').readTextFile({
        sessionId: 's1',
        path: file(),
        line: 2,
      });
      expect(result.content).toBe('b\nc\n');
    });

    it('treats limit 0 as an empty window rather than an error', async () => {
      const result = await withContent('a\nb\nc\n').readTextFile({
        sessionId: 's1',
        path: file(),
        limit: 0,
      });
      expect(result.content).toBe('');
    });
  });

  it('correctly handles root directories ending with a path separator', async () => {
    const isWin = process.platform === 'win32';
    const rootPath = isWin ? 'C:\\' : '/';
    const filePath = isWin ? 'C:\\file.txt' : '/file.txt';
    const server = new FileServer({
      projectRoot: rootPath,
      operations: fakeOperations({
        realpath: async (f) => f,
        readFile: async () => 'root content',
      }),
    });
    await expect(server.readTextFile({ sessionId: 's1', path: filePath })).resolves.toEqual({
      content: 'root content',
    });
  });

  it('enforces maxReadBytes on both pre-read stat size and post-read content byte length, plus maxWriteBytes and parent dir TOCTOU', async () => {
    const statOversized = new FileServer({
      projectRoot,
      maxReadBytes: 10,
      operations: fakeOperations({
        stat: async () => ({ size: 11 }) as any,
      }),
    });
    await expect(
      statOversized.readTextFile({ sessionId: 's1', path: path.join(projectRoot, 'big.txt') }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });

    const contentOversized = new FileServer({
      projectRoot,
      maxReadBytes: 10,
      operations: fakeOperations({
        stat: async () => ({ size: 5 }) as any,
        readFile: async () => '01234567890',
      }),
    });
    await expect(
      contentOversized.readTextFile({ sessionId: 's1', path: path.join(projectRoot, 'grew.txt') }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });

    const writeOversized = new FileServer({
      projectRoot,
      maxWriteBytes: 5,
      operations: fakeOperations(),
    });
    await expect(
      writeOversized.writeTextFile({
        sessionId: 's1',
        path: path.join(projectRoot, 'out.txt'),
        content: '123456',
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });

    let parentChecks = 0;
    const targetSubdir = path.join(projectRoot, 'sub');
    const parentSwapServer = new FileServer({
      projectRoot,
      operations: fakeOperations({
        realpath: async (f) => {
          if (f === targetSubdir) {
            parentChecks++;
            if (parentChecks >= 3) {
              return path.resolve(projectRoot, '..', 'escaped-dir');
            }
          }
          if (f.startsWith(`${targetSubdir}${path.sep}`)) {
            throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
          }
          return fakeRealpath(f);
        },
      }),
    });
    await expect(
      parentSwapServer.writeTextFile({
        sessionId: 's1',
        path: path.join(targetSubdir, 'file.txt'),
        content: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
  });
});

describe('FileServer with allowOutsideRoot (features.allowOutsideProjectRoot)', () => {
  // An external agent (Claude Code over ACP) reads its own settings and temp
  // files outside the project. Under the host's default policy WrongStack's
  // own `read` opens them, but this server answered "path is outside the
  // project root" — the "IO Error" users saw from ACP agents.
  let outside: string;
  beforeEach(async () => {
    outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-fs-outside-'));
  });
  afterEach(async () => {
    await fsp.rm(outside, { recursive: true, force: true });
  });

  it('reads and writes absolute paths outside the root when allowed', async () => {
    const open = new FileServer({ projectRoot, allowOutsideRoot: true });
    const file = path.join(outside, 'agent-settings.json');
    await fsp.writeFile(file, '{"a":1}', 'utf8');
    expect((await open.readTextFile({ sessionId: 's1', path: file })).content).toBe('{"a":1}');

    const created = path.join(outside, 'nested', 'plan.md');
    await fsp.mkdir(path.dirname(created));
    await open.writeTextFile({ sessionId: 's1', path: created, content: 'plan' });
    expect(await fsp.readFile(created, 'utf8')).toBe('plan');
  });

  it('still refuses the same paths by default, and relative paths either way', async () => {
    const file = path.join(outside, 'agent-settings.json');
    await fsp.writeFile(file, 'x', 'utf8');
    await expect(server.readTextFile({ sessionId: 's1', path: file })).rejects.toMatchObject({
      code: 'OUTSIDE_ROOT',
    });
    const open = new FileServer({ projectRoot, allowOutsideRoot: true });
    await expect(
      open.readTextFile({ sessionId: 's1', path: 'relative/file.txt' }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
});
