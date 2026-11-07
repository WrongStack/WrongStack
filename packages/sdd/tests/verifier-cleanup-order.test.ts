import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, killTree } = vi.hoisted(() => ({ spawnMock: vi.fn(), killTree: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));
vi.mock('@wrongstack/core/utils/tree-kill', async (original) => ({
  ...(await original<typeof import('@wrongstack/core/utils/tree-kill')>()),
  treeKill: killTree,
}));

import { makeCommandVerifier } from '../src/verify-task.js';

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.useRealTimers();
  spawnMock.mockReset();
  killTree.mockReset();
});
const info = {
  task: { metadata: { verificationCommand: 'owned-verifier-fixture' } },
  result: {},
  cwd: process.cwd(),
} as unknown as Parameters<ReturnType<typeof makeCommandVerifier>>[0];
describe('Windows verifier timeout cleanup ordering', () => {
  it('retains the timeout result until the actual child exits', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    let settled = false;
    const pending = makeCommandVerifier({ timeoutMs: 100 })(info).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child);
    expect(settled).toBe(false);
    child.emit('exit', 1);
    expect(await pending).toMatchObject({
      ok: false,
      reason: expect.stringContaining('timed out'),
    });
  });
  it('returns a normal successful exit immediately', async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);
    const pending = makeCommandVerifier({ timeoutMs: 100 })(info);
    child.emit('exit', 0);
    expect(await pending).toEqual({ ok: true });
    expect(killTree).not.toHaveBeenCalled();
  });
});
