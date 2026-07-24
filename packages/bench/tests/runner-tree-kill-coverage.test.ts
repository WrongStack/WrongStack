import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { treeKill } from '../src/runner.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('treeKill Windows fallback', () => {
  it('falls back to child.kill when taskkill cannot spawn and tolerates an exited child', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const killers = Array.from({ length: 2 }, () => ({
      once: vi.fn((_event: string, callback: () => void) => {
        callback();
      }),
      unref: vi.fn(),
    }));
    spawnMock.mockReturnValueOnce(killers[0]).mockReturnValueOnce(killers[1]);
    const firstChild = {
      pid: 101,
      kill: vi.fn(() => true),
    } as unknown as ChildProcess;
    const secondChild = {
      pid: 102,
      kill: vi.fn(() => {
        throw new Error('already gone');
      }),
    } as unknown as ChildProcess;

    treeKill(firstChild);
    treeKill(secondChild);

    expect(firstChild.kill).toHaveBeenCalledOnce();
    expect(secondChild.kill).toHaveBeenCalledOnce();
    expect(killers.every((killer) => killer.unref.mock.calls.length === 1)).toBe(true);
  });
});
