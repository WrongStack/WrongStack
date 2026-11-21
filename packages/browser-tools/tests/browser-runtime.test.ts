import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  spawn: vi.fn(),
  launch: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ access: mocks.access }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@playwright/test', () => ({
  chromium: {
    executablePath: () => '/browser/chromium',
    launch: mocks.launch,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(undefined);
  mocks.launch.mockResolvedValue({ close: vi.fn() });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('automatic browser runtime setup', () => {
  it('keeps the binary fallback version aligned with the package dependency', () => {
    const source = readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.devDependencies['@playwright/test']).toBe(
      `^${source.match(/PLAYWRIGHT_VERSION = '([^']+)'/)?.[1]}`,
    );
  });

  it('launches an installed browser without running an installer', async () => {
    const { launchBrowserRuntime } = await import('../src/runtime.js');
    await launchBrowserRuntime(true);
    expect(mocks.launch).toHaveBeenCalledWith({ headless: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('downloads missing Chromium once for concurrent first opens, then launches', async () => {
    mocks.access.mockImplementation(async (path: string) => {
      if (path === '/browser/chromium')
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const { launchBrowserRuntime } = await import('../src/runtime.js');
    await Promise.all([launchBrowserRuntime(true), launchBrowserRuntime(false)]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([
      expect.stringMatching(/cli\.js$/),
      'install',
      'chromium',
    ]);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 180_000 });
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('reports failed downloads and permits a later retry', async () => {
    mocks.access.mockImplementation(async (path: string) => {
      if (path === '/browser/chromium')
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    mocks.spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('download unavailable'));
        child.emit('close', 1, null);
      });
      return child;
    });
    const { launchBrowserRuntime } = await import('../src/runtime.js');
    await expect(launchBrowserRuntime(true)).rejects.toThrow('download unavailable');
    expect(mocks.launch).not.toHaveBeenCalled();
    await launchBrowserRuntime(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('does not download again for filesystem permission or browser launch failures', async () => {
    const { launchBrowserRuntime } = await import('../src/runtime.js');
    mocks.access.mockRejectedValueOnce(
      Object.assign(new Error('access denied'), { code: 'EACCES' }),
    );
    await expect(launchBrowserRuntime(true)).rejects.toThrow('access denied');
    mocks.launch.mockRejectedValueOnce(new Error('missing system libraries'));
    await expect(launchBrowserRuntime(true)).rejects.toThrow('missing system libraries');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
