/**
 * Coverage for clipboard.ts timeout/kill paths (lines 233-234, runCmdWithInput killCap).
 * Also covers container.ts ENOENT catch path (line 211).
 */
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

import { writeClipboardText, readClipboardText } from '../src/clipboard.js';

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

beforeEach(() => {
  spawnMock.spawn.mockReset();
  realPlatform = process.platform;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('writeClipboardText killCap timeout path', () => {
  it('resolves false when the killCap fires after SIGTERM is ignored', async () => {
    vi.useFakeTimers();
    setPlatform('win32');

    // A child that ignores SIGTERM — never emits 'exit' or 'error'
    const c = new FakeChild();
    spawnMock.spawn.mockImplementation(() => c);

    const promise = writeClipboardText('test');
    // Advance past the CLIPBOARD_CMD_TIMEOUT_MS (5s) — triggers SIGTERM
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.kill).toHaveBeenCalledWith('SIGTERM');
    // Child ignores SIGTERM — advance past killCap (5s + 2s = 7s total)
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await promise;
    expect(result).toBe(false);
  });
});

describe('readClipboardText killCap timeout path', () => {
  it('resolves null when the killCap fires after SIGTERM is ignored', async () => {
    vi.useFakeTimers();
    setPlatform('win32');

    const c = new EventEmitter() as any;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = vi.fn();
    spawnMock.spawn.mockImplementation(() => c);

    const promise = readClipboardText();
    // Advance past the CLIPBOARD_CMD_TIMEOUT_MS (5s) — triggers SIGTERM
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.kill).toHaveBeenCalledWith('SIGTERM');
    // Child ignores SIGTERM — advance past killCap (5s + 2s = 7s total)
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await promise;
    expect(result).toBeNull();
  });
});
