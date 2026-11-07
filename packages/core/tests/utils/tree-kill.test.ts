import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { treeKill, WIN32_TASKKILL_BACKSTOP_MS } from '../../src/utils/tree-kill.js';

const REAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** A fake taskkill process whose 'error' event can be emitted on demand. */
function fakeKiller(): EventEmitter & { unref: () => void } {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = vi.fn();
  return ee;
}

afterEach(() => {
  setPlatform(REAL_PLATFORM);
  spawnMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('treeKill', () => {
  it('force-kills an explicitly owned POSIX group through the shared helper', () => {
    setPlatform('linux');
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = { pid: process.pid + process.ppid + 10_000, kill: vi.fn() };
    treeKill(child, { force: true, processGroupLeader: true });
    expect(signal).toHaveBeenCalledExactlyOnceWith(-child.pid, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([0, 1, -1, 1.5, process.pid, process.ppid])(
    'never group-signals an unsafe PID (%s)',
    (pid) => {
      setPlatform('linux');
      const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
      const child = { pid, kill: vi.fn() };
      treeKill(child, { force: true, processGroupLeader: true });
      expect(signal).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    },
  );

  it('uses the child handle when a dedicated POSIX group is already gone', () => {
    setPlatform('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    const child = { pid: process.pid + process.ppid + 10_000, kill: vi.fn() };
    treeKill(child, { force: true, processGroupLeader: true });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it.each([
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' as const },
  ])('never group-signals a child whose exit has been observed (%j)', (state) => {
    setPlatform('linux');
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const child = { pid: process.pid + process.ppid + 10_000, ...state, kill: vi.fn() };
    treeKill(child, { force: true, processGroupLeader: true });
    expect(signal).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('falls back to a graceful kill when pid is undefined', () => {
    const kill = vi.fn();
    treeKill({ pid: undefined, kill });
    // graceful default → no explicit signal (SIGTERM)
    expect(kill).toHaveBeenCalledWith(undefined);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('force + undefined pid sends SIGKILL directly', () => {
    const kill = vi.fn();
    treeKill({ pid: undefined, kill }, { force: true });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('on Windows spawns taskkill /T /F for the whole tree', () => {
    setPlatform('win32');
    spawnMock.mockReturnValue(fakeKiller());
    const kill = vi.fn();
    treeKill({ pid: 4321, kill });
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it('on Windows falls back to child.kill() if taskkill errors, tolerating a dead child', () => {
    setPlatform('win32');
    const killer = fakeKiller();
    spawnMock.mockReturnValue(killer);
    const kill = vi.fn(() => {
      throw new Error('already gone');
    });
    treeKill({ pid: 42, kill });
    killer.emit('error', new Error('ENOENT'));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(killer.unref).toHaveBeenCalledTimes(1);
  });

  it('on Windows kills the child directly when taskkill exits but left it alive', () => {
    // taskkill exits non-zero on a race inside its tree walk; fire-and-forget
    // left the child running until it exited on its own.
    setPlatform('win32');
    const killer = fakeKiller();
    spawnMock.mockReturnValue(killer);
    const kill = vi.fn();
    treeKill({ pid: 42, exitCode: null, kill }, { force: true });
    expect(kill).not.toHaveBeenCalled();
    killer.emit('close', 255);
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });

  it('on Windows skips the direct kill once Node has seen the child exit', () => {
    setPlatform('win32');
    const killer = fakeKiller();
    spawnMock.mockReturnValue(killer);
    const child = { pid: 42, exitCode: null as number | null, kill: vi.fn() };
    treeKill(child);
    child.exitCode = 1;
    killer.emit('close', 0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('keeps the shell alive while an eight-second Windows tree walk is still running', () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const killer = fakeKiller();
    spawnMock.mockReturnValue(killer);
    const child = { pid: 42, exitCode: null as number | null, kill: vi.fn() };
    treeKill(child);
    vi.advanceTimersByTime(8000);
    expect(child.kill).not.toHaveBeenCalled();
    child.exitCode = 1;
    killer.emit('close', 0);
    vi.advanceTimersByTime(30000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('on Windows kills the child directly when taskkill stalls past the backstop', () => {
    vi.useFakeTimers();
    setPlatform('win32');
    const killer = fakeKiller();
    spawnMock.mockReturnValue(killer);
    const kill = vi.fn();
    treeKill({ pid: 42, exitCode: null, kill });
    vi.advanceTimersByTime(WIN32_TASKKILL_BACKSTOP_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(1);
    // A late taskkill exit does not kill twice.
    killer.emit('close', 0);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('on Windows falls back to child.kill() when spawning taskkill throws', () => {
    setPlatform('win32');
    spawnMock.mockImplementation(() => {
      throw new Error('spawn EACCES');
    });
    const kill = vi.fn();
    treeKill({ pid: 7, kill });
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('on Windows does not taskkill a PID after the child has exited', () => {
    // The PID may already belong to an unrelated process tree.
    setPlatform('win32');
    spawnMock.mockReturnValue(fakeKiller());
    treeKill({ pid: 4321, exitCode: 0, kill: vi.fn() });
    treeKill({ pid: 4322, exitCode: 1, kill: vi.fn() }, { force: true });
    treeKill({ pid: 4324, exitCode: null, signalCode: 'SIGTERM', kill: vi.fn() });
    expect(spawnMock).not.toHaveBeenCalled();
    treeKill({ pid: 4323, exitCode: null, kill: vi.fn() });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('on POSIX sends SIGTERM then a SIGKILL backstop', () => {
    setPlatform('linux');
    vi.useFakeTimers();
    const kill = vi.fn();
    treeKill({ pid: 99, kill });
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(spawnMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('on POSIX with force sends SIGKILL immediately and skips the backstop', () => {
    setPlatform('linux');
    vi.useFakeTimers();
    const kill = vi.fn();
    treeKill({ pid: 5, kill }, { force: true });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    vi.advanceTimersByTime(5000);
    expect(kill).toHaveBeenCalledTimes(1); // no backstop
  });

  it('honors a custom graceMs for the POSIX backstop', () => {
    setPlatform('linux');
    vi.useFakeTimers();
    const kill = vi.fn();
    treeKill({ pid: 3, kill }, { graceMs: 500 });
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    vi.advanceTimersByTime(499);
    expect(kill).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });
});
