import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock.spawn(...args),
  };
});

import { writeClipboardText } from '../src/clipboard.js';

/** Captures what was written to stdin and lets the test drive the exit event. */
class FakeChild extends EventEmitter {
  stdin = new FakeStdin();
  kill = vi.fn();
}

class FakeStdin extends EventEmitter {
  written = '';
  ended = false;
  end(chunk?: string, _enc?: BufferEncoding): void {
    if (chunk) this.written += chunk;
    this.ended = true;
  }
}

let realPlatform: NodeJS.Platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** Schedule a fake child that exits with `code` on the next tick. */
function mkChild(code = 0): FakeChild {
  const c = new FakeChild();
  setImmediate(() => c.emit('exit', code));
  return c;
}

beforeEach(() => {
  spawnMock.spawn.mockReset();
  realPlatform = process.platform;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe('writeClipboardText', () => {
  it('returns false on an unsupported platform without spawning', async () => {
    setPlatform('freebsd');
    expect(await writeClipboardText('hi')).toBe(false);
    expect(spawnMock.spawn).not.toHaveBeenCalled();
  });

  describe('windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('pipes the text to powershell stdin and returns true on exit 0', async () => {
      let child: FakeChild | undefined;
      spawnMock.spawn.mockImplementation(() => {
        child = mkChild(0);
        return child;
      });
      const ok = await writeClipboardText('hello ünïcode');
      expect(ok).toBe(true);
      const [cmd, args] = spawnMock.spawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('powershell');
      expect(args).toContain('-NoProfile');
      expect(child?.stdin.written).toBe('hello ünïcode');
      expect(child?.stdin.ended).toBe(true);
    });

    it('returns false when powershell exits non-zero', async () => {
      spawnMock.spawn.mockImplementation(() => mkChild(1));
      expect(await writeClipboardText('x')).toBe(false);
    });

    it('returns false when the child errors', async () => {
      spawnMock.spawn.mockImplementation(() => {
        const c = new FakeChild();
        setImmediate(() => c.emit('error', new Error('spawn failed')));
        return c;
      });
      expect(await writeClipboardText('x')).toBe(false);
    });
  });

  describe('darwin', () => {
    beforeEach(() => setPlatform('darwin'));

    it('pipes the text to pbcopy', async () => {
      let child: FakeChild | undefined;
      spawnMock.spawn.mockImplementation(() => {
        child = mkChild(0);
        return child;
      });
      const ok = await writeClipboardText('copy me');
      expect(ok).toBe(true);
      const [cmd] = spawnMock.spawn.mock.calls[0] as [string, string[]];
      expect(cmd).toBe('pbcopy');
      expect(child?.stdin.written).toBe('copy me');
    });
  });

  describe('linux', () => {
    beforeEach(() => setPlatform('linux'));

    it('falls back from wl-copy to xclip when the first tool fails', async () => {
      const cmds: string[] = [];
      spawnMock.spawn.mockImplementation((cmd: string) => {
        cmds.push(cmd);
        // wl-copy fails to spawn, xclip succeeds.
        if (cmd === 'wl-copy') {
          const c = new FakeChild();
          setImmediate(() => c.emit('error', new Error('not found')));
          return c;
        }
        return mkChild(0);
      });
      const ok = await writeClipboardText('data');
      expect(ok).toBe(true);
      expect(cmds).toEqual(['wl-copy', 'xclip']);
    });

    it('returns false when every linux tool fails', async () => {
      spawnMock.spawn.mockImplementation(() => {
        const c = new FakeChild();
        setImmediate(() => c.emit('error', new Error('nope')));
        return c;
      });
      expect(await writeClipboardText('data')).toBe(false);
    });
  });
});
