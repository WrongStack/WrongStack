import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }));
const fsFailures = vi.hoisted(() => ({ unlink: false, writeFile: false }));

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock.spawn(...args),
  };
});

vi.mock('node:fs/promises', async (orig) => {
  const actual = (await orig()) as typeof import('node:fs/promises');
  return {
    ...actual,
    unlink: (...args: Parameters<typeof actual.unlink>) =>
      fsFailures.unlink ? Promise.reject(new Error('unlink failed')) : actual.unlink(...args),
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      fsFailures.writeFile ? Promise.reject(new Error('write failed')) : actual.writeFile(...args),
  };
});

import { readClipboardImage, readClipboardText } from '../src/clipboard.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

let tmpDir: string;
let realPlatform: NodeJS.Platform;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-test-'));
  spawnMock.spawn.mockReset();
  fsFailures.unlink = false;
  fsFailures.writeFile = false;
  realPlatform = process.platform;
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p });
}

// Helper to schedule a fake child that writes a file then exits cleanly.
function mkChildSavingFile(
  finalPath: () => string,
  content: Buffer | string,
  exitCode = 0,
  stdoutText = '',
): FakeChild {
  const c = new FakeChild();
  setImmediate(async () => {
    if (stdoutText) c.stdout.emit('data', Buffer.from(stdoutText));
    if (content) await fs.writeFile(finalPath(), content).catch(() => undefined);
    c.emit('exit', exitCode);
  });
  return c;
}

function mkChildEmittingStdout(text: string, exitCode = 0): FakeChild {
  const c = new FakeChild();
  setImmediate(() => {
    c.stdout.emit('data', Buffer.from(text));
    c.emit('exit', exitCode);
  });
  return c;
}

function mkErrorChild(): FakeChild {
  const c = new FakeChild();
  setImmediate(() => c.emit('error', new Error('spawn failed')));
  return c;
}

describe('readClipboardImage', () => {
  it('returns null on unsupported platforms', async () => {
    setPlatform('freebsd');
    const result = await readClipboardImage();
    expect(result).toBeNull();
    expect(spawnMock.spawn).not.toHaveBeenCalled();
  });

  // ── win32 ───────────────────────────────────────────────────────────────

  describe('windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('returns null when powershell reports NO_IMAGE', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('NO_IMAGE'));
      expect(await readClipboardImage()).toBeNull();
    });

    it('returns null when powershell exits with no OK marker', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('something else'));
      expect(await readClipboardImage()).toBeNull();
    });

    it('reads the saved PNG file when powershell prints OK', async () => {
      const png = Buffer.concat([PNG_MAGIC, Buffer.from('payload')]);
      spawnMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
        // Extract the tmp path from the inline PS script
        const psCmd = (args[args.length - 1] as string) || '';
        const match = psCmd.match(/\$img\.Save\('([^']+)'/);
        const filePath = match ? match[1].replace(/\\\\/g, '\\') : '';
        return mkChildSavingFile(() => filePath, png, 0, 'OK');
      });
      const result = await readClipboardImage();
      expect(result).not.toBeNull();
      expect(result?.mediaType).toBe('image/png');
      expect(result?.bytes).toBe(png.length);
      // base64-decoded back to original bytes
      expect(Buffer.from(result!.base64, 'base64')).toEqual(png);
    });

    it('returns null when the saved file is missing PNG magic bytes', async () => {
      spawnMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const psCmd = (args[args.length - 1] as string) || '';
        const match = psCmd.match(/\$img\.Save\('([^']+)'/);
        const filePath = match ? match[1].replace(/\\\\/g, '\\') : '';
        return mkChildSavingFile(() => filePath, Buffer.from('not-a-png'), 0, 'OK');
      });
      expect(await readClipboardImage()).toBeNull();
    });

    it('returns null when child spawn emits an error', async () => {
      spawnMock.spawn.mockReturnValue(mkErrorChild());
      expect(await readClipboardImage()).toBeNull();
    });

    it('returns null when child exits non-zero', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('', 1));
      expect(await readClipboardImage()).toBeNull();
    });

    it('returns null when PowerShell reports success but creates no file', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('OK'));
      expect(await readClipboardImage()).toBeNull();
    });
  });

  // ── darwin ──────────────────────────────────────────────────────────────

  describe('darwin', () => {
    beforeEach(() => setPlatform('darwin'));

    it('returns null when osascript signals NO_IMAGE', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('NO_IMAGE'));
      expect(await readClipboardImage()).toBeNull();
    });

    it('returns null when osascript output is missing the OK marker', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('some weird output'));
      expect(await readClipboardImage()).toBeNull();
    });

    it('reads the saved PNG file when osascript prints OK', async () => {
      const png = Buffer.concat([PNG_MAGIC, Buffer.from('darwin')]);
      spawnMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const script = args[1] as string;
        const m = script.match(/POSIX file "([^"]+)"/);
        const filePath = m ? m[1] : '';
        return mkChildSavingFile(() => filePath, png, 0, 'OK');
      });
      const result = await readClipboardImage();
      expect(result).not.toBeNull();
      expect(result?.bytes).toBe(png.length);
    });
  });

  // ── linux ───────────────────────────────────────────────────────────────

  describe('linux', () => {
    beforeEach(() => setPlatform('linux'));

    it('returns null when neither wl-paste nor xclip succeeds', async () => {
      // Use mockImplementation so a fresh child is returned per call —
      // mockReturnValue would re-use one EventEmitter and the second
      // listener attach would miss the already-emitted events.
      spawnMock.spawn.mockImplementation(() => mkChildEmittingStdout('', 1));
      expect(await readClipboardImage()).toBeNull();
      // Both wl-paste and xclip attempted
      expect(spawnMock.spawn).toHaveBeenCalledTimes(2);
    });

    it('reads PNG output piped through wl-paste', async () => {
      const png = Buffer.concat([PNG_MAGIC, Buffer.from('linux')]);
      spawnMock.spawn.mockImplementation((cmd: string) => {
        const child = new FakeChild();
        setImmediate(() => {
          if (cmd === 'wl-paste') {
            child.stdout.emit('data', png);
            child.emit('exit', 0);
          } else {
            child.emit('exit', 1);
          }
        });
        return child;
      });
      const result = await readClipboardImage();
      expect(result).not.toBeNull();
      expect(result?.bytes).toBe(png.length);
    });

    it('falls back to xclip when wl-paste fails', async () => {
      const png = Buffer.concat([PNG_MAGIC, Buffer.from('xclip')]);
      let calls = 0;
      spawnMock.spawn.mockImplementation((cmd: string) => {
        calls++;
        const child = new FakeChild();
        setImmediate(() => {
          if (cmd === 'xclip') {
            child.stdout.emit('data', png);
            child.emit('exit', 0);
          } else {
            child.emit('exit', 1);
          }
        });
        return child;
      });
      const result = await readClipboardImage();
      expect(result?.bytes).toBe(png.length);
      expect(calls).toBe(2);
    });

    it('returns null when child errors during exec', async () => {
      spawnMock.spawn.mockImplementation(() => mkErrorChild());
      expect(await readClipboardImage()).toBeNull();
    });
  });

  // ── readPngFile edge cases ──────────────────────────────────────────────

  describe('readPngFile edge cases', () => {
    beforeEach(() => setPlatform('win32'));

    it('throws when saved image exceeds the 10MB cap', async () => {
      // 11 MB buffer with PNG magic — exceeds the MAX_IMAGE_BYTES limit
      const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(11 * 1024 * 1024)]);
      spawnMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const psCmd = (args[args.length - 1] as string) || '';
        const match = psCmd.match(/\$img\.Save\('([^']+)'/);
        const filePath = match ? match[1].replace(/\\\\/g, '\\') : '';
        return mkChildSavingFile(() => filePath, big, 0, 'OK');
      });
      await expect(readClipboardImage()).rejects.toThrow(/exceeds.*MB limit/);
    });

    it('returns null when the saved file is empty', async () => {
      spawnMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const psCmd = (args[args.length - 1] as string) || '';
        const match = psCmd.match(/\$img\.Save\('([^']+)'/);
        const filePath = match ? match[1].replace(/\\\\/g, '\\') : '';
        return mkChildSavingFile(() => filePath, Buffer.alloc(0), 0, 'OK');
      });
      expect(await readClipboardImage()).toBeNull();
    });

    it('ignores cleanup failures after reading empty, invalid, oversized, and valid files', async () => {
      fsFailures.unlink = true;
      const contents = [
        Buffer.alloc(0),
        Buffer.from('not-png'),
        Buffer.concat([PNG_MAGIC, Buffer.alloc(11 * 1024 * 1024)]),
        Buffer.concat([PNG_MAGIC, Buffer.from('valid')]),
      ];
      spawnMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
        const psCmd = (args[args.length - 1] as string) || '';
        const filePath = psCmd.match(/\$img\.Save\('([^']+)'/)?.[1]?.replace(/\\\\/g, '\\') ?? '';
        return mkChildSavingFile(() => filePath, contents.shift()!, 0, 'OK');
      });

      expect(await readClipboardImage()).toBeNull();
      expect(await readClipboardImage()).toBeNull();
      await expect(readClipboardImage()).rejects.toThrow(/exceeds.*MB limit/);
      expect(await readClipboardImage()).not.toBeNull();
    });
  });
});

describe('readClipboardText', () => {
  it('returns null on unsupported platforms', async () => {
    setPlatform('freebsd');
    expect(await readClipboardText()).toBeNull();
    expect(spawnMock.spawn).not.toHaveBeenCalled();
  });

  describe('windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('reads clipboard text and strips the trailing newline PowerShell adds', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('hello world\r\n'));
      expect(await readClipboardText()).toBe('hello world');
    });

    it('preserves embedded newlines', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('line1\r\nline2\r\n'));
      expect(await readClipboardText()).toBe('line1\r\nline2');
    });

    it('returns null for an empty clipboard', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('\r\n'));
      expect(await readClipboardText()).toBeNull();
    });

    it('returns null when the child exits non-zero', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('junk', 1));
      expect(await readClipboardText()).toBeNull();
    });

    it('returns null when spawn errors', async () => {
      spawnMock.spawn.mockReturnValue(mkErrorChild());
      expect(await readClipboardText()).toBeNull();
    });

    it('settles once when a child emits both error and exit', async () => {
      const child = new FakeChild();
      spawnMock.spawn.mockReturnValue(child);
      const result = readClipboardText();
      child.emit('error', new Error('failed'));
      child.emit('exit', 0);
      await expect(result).resolves.toBeNull();
    });

    it('kills a stalled command and accepts its eventual exit', async () => {
      vi.useFakeTimers();
      try {
        const child = new FakeChild();
        spawnMock.spawn.mockReturnValue(child);
        const result = readClipboardText();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        child.emit('exit', 0);
        await expect(result).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the hard safety cap when a stalled command ignores SIGTERM', async () => {
      vi.useFakeTimers();
      try {
        const child = new FakeChild();
        spawnMock.spawn.mockReturnValue(child);
        const result = readClipboardText();
        await vi.advanceTimersByTimeAsync(7_000);
        await expect(result).resolves.toBeNull();
        child.emit('error', new Error('late error'));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('darwin', () => {
    beforeEach(() => setPlatform('darwin'));

    it('returns pbpaste output verbatim', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout('mac clip'));
      expect(await readClipboardText()).toBe('mac clip');
    });

    it('returns null for empty pbpaste output', async () => {
      spawnMock.spawn.mockReturnValue(mkChildEmittingStdout(''));
      expect(await readClipboardText()).toBeNull();
    });
  });

  describe('linux', () => {
    beforeEach(() => setPlatform('linux'));

    it('reads via wl-paste', async () => {
      spawnMock.spawn.mockImplementation((cmd: string) =>
        cmd === 'wl-paste' ? mkChildEmittingStdout('wayland clip') : mkChildEmittingStdout('', 1),
      );
      expect(await readClipboardText()).toBe('wayland clip');
    });

    it('falls back to xclip when wl-paste yields nothing', async () => {
      spawnMock.spawn.mockImplementation((cmd: string) =>
        cmd === 'xclip' ? mkChildEmittingStdout('x clip') : mkChildEmittingStdout('', 1),
      );
      expect(await readClipboardText()).toBe('x clip');
      expect(spawnMock.spawn).toHaveBeenCalledTimes(2);
    });

    it('returns null when neither tool yields text', async () => {
      spawnMock.spawn.mockImplementation(() => mkChildEmittingStdout('', 1));
      expect(await readClipboardText()).toBeNull();
    });
  });
});

describe('clipboard image subprocess failures', () => {
  beforeEach(() => setPlatform('linux'));

  it('returns null when writing captured image bytes fails', async () => {
    fsFailures.writeFile = true;
    spawnMock.spawn.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', PNG_MAGIC);
        child.emit('exit', 0);
      });
      return child;
    });
    expect(await readClipboardImage()).toBeNull();
  });

  it('tries the next image command when spawning throws synchronously', async () => {
    spawnMock.spawn.mockImplementation(() => {
      throw new Error('spawn unavailable');
    });
    expect(await readClipboardImage()).toBeNull();
    expect(spawnMock.spawn).toHaveBeenCalledTimes(2);
  });

  it('settles each capture once when error and exit are both emitted', async () => {
    spawnMock.spawn.mockImplementation(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.emit('error', new Error('failed'));
        child.emit('exit', 0);
      });
      return child;
    });
    expect(await readClipboardImage()).toBeNull();
  });

  it('kills stalled image commands before resolving the safe default', async () => {
    vi.useFakeTimers();
    try {
      const children: FakeChild[] = [];
      spawnMock.spawn.mockImplementation(() => {
        const child = new FakeChild();
        children.push(child);
        return child;
      });
      const result = readClipboardImage();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
      children[0]?.emit('exit', 0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(7_000);

      await expect(result).resolves.toBeNull();
      expect(children[1]?.kill).toHaveBeenCalledWith('SIGTERM');
      children[1]?.emit('error', new Error('late error'));
    } finally {
      vi.useRealTimers();
    }
  });
});
