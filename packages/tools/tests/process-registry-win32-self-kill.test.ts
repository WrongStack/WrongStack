import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// The shutdown path calls killAll({ force: true, includeProtected: true }).
// A mirror entry can name this process (registerMainProcess writes exactly
// that), and `taskkill /T` on self would end WrongStack before the remaining
// shutdown steps run. POSIX already refuses self/parent; Windows must too.

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

const platformState = vi.hoisted(() => ({ platform: 'win32' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const patched = { ...actual, platform: () => platformState.platform };
  return { ...patched, default: patched };
});

const { ProcessRegistryImpl } = await import('../src/process-registry.js');

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: null;
    signalCode: null;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  child.unref = vi.fn();
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

function entry(pid: number, child: unknown = null) {
  return {
    pid,
    name: 'wrongstack',
    command: 'wrongstack',
    startedAt: Date.now(),
    child: child as never,
    protected: true,
  };
}

const taskkillFor = (pid: number) =>
  spawnMock.mock.calls.find(
    ([command, args]) => command === 'taskkill' && (args as string[])[1] === String(pid),
  );

describe('win32 registry kill never signals self or parent', () => {
  it('skips taskkill for this process and its parent', () => {
    for (const target of [process.pid, process.ppid]) {
      spawnMock.mockClear();
      spawnMock.mockReturnValue(fakeChild(target));
      const registry = new ProcessRegistryImpl();
      registry.register(entry(target));
      expect(registry.kill(target, { force: true, includeProtected: true })).toBe(true);
      expect(taskkillFor(target)).toBeUndefined();
    }
  });

  it('still tree-kills an ordinary mirror pid and a live child', () => {
    spawnMock.mockClear();
    spawnMock.mockReturnValue(fakeChild(43210));
    const mirror = new ProcessRegistryImpl();
    mirror.register(entry(43210));
    mirror.kill(43210, { force: true, includeProtected: true });
    expect(taskkillFor(43210)).toBeDefined();

    spawnMock.mockClear();
    spawnMock.mockReturnValue(fakeChild(43211));
    const live = new ProcessRegistryImpl();
    live.register(entry(43211, fakeChild(43211)));
    live.kill(43211, { force: true, includeProtected: true });
    expect(taskkillFor(43211)).toBeDefined();
  });

  it('keeps the protected refusal and POSIX self parity', () => {
    spawnMock.mockClear();
    spawnMock.mockReturnValue(fakeChild(43212));
    const protectedRegistry = new ProcessRegistryImpl();
    protectedRegistry.register(entry(43212));
    expect(protectedRegistry.kill(43212, { force: true })).toBe(false);
    expect(taskkillFor(43212)).toBeUndefined();

    const realKill = process.kill;
    const killCalls: number[] = [];
    process.kill = ((pid: number) => {
      killCalls.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      platformState.platform = 'linux';
      const posix = new ProcessRegistryImpl();
      posix.register(entry(process.pid));
      posix.kill(process.pid, { force: true, includeProtected: true });
      expect(killCalls).toEqual([]);
    } finally {
      process.kill = realKill;
      platformState.platform = 'win32';
    }
  });
});
