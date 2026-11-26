import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import { afterEach, expect, it, vi } from 'vitest';
import { runWstack } from '../src/runner.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawn.mockReset();
});

it.each([false, true])('returns a timeout when child close is emitted: %s', async (closes) => {
  vi.useFakeTimers();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
  spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
  const observer = vi.fn();
  const pending = runWstack({
    nodeBin: process.execPath,
    wstackEntry: 'fixture.cjs',
    workdir: process.cwd(),
    homeDir: process.cwd(),
    cell: { label: 'fixture', provider: 'test', model: 'test' },
    prompt: 'fixture',
    timeoutMs: 100,
  });
  void pending.then(observer);
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]?.[0]).toBe('taskkill');
    expect(observer).not.toHaveBeenCalled();
    child.exitCode = 1;
    child.emit('exit', 1);
    killer.emit('close', 0);
    if (closes) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.emit('close', 1);
    }
    await vi.advanceTimersByTimeAsync(closes ? 0 : WIN32_TREE_KILL_BUDGET_MS + 1_000);
    expect(observer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 'timeout', exitCode: 1 }),
    );
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    child.exitCode = 1;
    killer.emit('close', 0);
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit('close', 1);
    await pending;
  }
});
