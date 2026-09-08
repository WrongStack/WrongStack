import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => {
  return {
    watch: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
  };
});

describe('registerSetupEventsStatusWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('returns undefined if wpaths or globalRoot are missing', async () => {
    const { registerSetupEventsStatusWatcher } = await import(
      '../src/server/setup-events-status-watcher.js'
    );

    const result1 = registerSetupEventsStatusWatcher({
      wpaths: undefined,
      clients: new Map(),
      broadcast: vi.fn(),
      on: vi.fn(),
      isDisposed: () => false,
    });
    expect(result1).toBeUndefined();

    const result2 = registerSetupEventsStatusWatcher({
      wpaths: { projectStatus: 'status.json' } as never,
      clients: new Map(),
      broadcast: vi.fn(),
      on: vi.fn(),
      isDisposed: () => false,
    });
    expect(result2).toBeUndefined();
  });

  it('sets up watcher, registers client.status event listener, processes file changes and debounces broadcasts', async () => {
    const { watch: fsWatch } = await import('node:fs');
    const fs = await import('node:fs/promises');
    const { registerSetupEventsStatusWatcher } = await import(
      '../src/server/setup-events-status-watcher.js'
    );

    let watchCallback: (eventType: string, filename: string | null) => Promise<void> =
      async () => {};
    const closeWatcher = vi.fn();
    vi.mocked(fsWatch).mockImplementation(((_dir: unknown, _opts: unknown, cb: unknown) => {
      watchCallback = cb as typeof watchCallback;
      return { close: closeWatcher } as never;
    }) as never);

    const listeners: Record<string, (e: any) => void> = {};
    const on = vi.fn((event: string, listener: (e: any) => void) => {
      listeners[event] = listener;
      return () => {
        delete listeners[event];
      };
    });

    const broadcast = vi.fn();
    const clients = new Map();
    const metrics = {
      fileChangesDetected: 0,
      filesProcessed: 0,
      broadcastsSent: 0,
      debounceResets: 0,
      totalDebounceDelayMs: 0,
      activeProjects: 0,
      averageDebounceDelayMs: 0,
      watcherActive: false,
    };

    const globalRoot = path.join('workspace', '.wrongstack');

    const dispose = registerSetupEventsStatusWatcher({
      wpaths: {
        projectStatus: 'status.json',
        globalRoot,
      } as never,
      watcherMetrics: metrics,
      clients,
      broadcast,
      on: on as never,
      isDisposed: () => false,
    });

    expect(dispose).toBeDefined();
    expect(metrics.watcherActive).toBe(true);
    expect(on).toHaveBeenCalledWith('client.status', expect.any(Function));

    // Register a known project hash
    listeners['client.status']?.({ projectHash: 'hash-abc' });
    expect(metrics.activeProjects).toBe(1);

    // Re-register same hash should not duplicate
    listeners['client.status']?.({ projectHash: 'hash-abc' });
    expect(metrics.activeProjects).toBe(1);

    // Empty hash should be ignored
    listeners['client.status']?.({ projectHash: '' });

    // File change callback tests:
    // 1. Non-change/rename event ignored
    await watchCallback('other', 'hash-abc/status.json');
    expect(metrics.fileChangesDetected).toBe(0);

    // 2. Null filename ignored
    await watchCallback('change', null);
    expect(metrics.fileChangesDetected).toBe(0);

    // 3. Filename that doesn't match statusProjectHash
    await watchCallback('change', 'session.jsonl');
    expect(metrics.fileChangesDetected).toBe(0);

    // 4. Unknown project hash
    await watchCallback('change', path.join('unknown-hash', 'status.json'));
    expect(metrics.fileChangesDetected).toBe(1);
    expect(metrics.filesProcessed).toBe(0);

    // 5. Valid known project hash with read success
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ status: 'ready', phase: 'idle' }),
    );

    await watchCallback('change', path.join('hash-abc', 'status.json'));
    expect(metrics.filesProcessed).toBe(1);

    // Trigger a second change before debounce timer fires (to test debounceResets)
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ status: 'running', phase: 'busy' }),
    );
    await watchCallback('change', path.join('hash-abc', 'status.json'));
    expect(metrics.debounceResets).toBe(1);

    // Trigger another file read failure (gracefully handled)
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('File locked'));
    await watchCallback('change', path.join('hash-abc', 'status.json'));

    // Wait for the debounce timer (150ms) to fire
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'client.status_update',
      payload: { status: 'running', phase: 'busy' },
    });
    expect(metrics.broadcastsSent).toBe(1);

    // Test disposal: should unlisten, flush pending, clear timers, close watcher
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ status: 'flushed', phase: 'final' }),
    );
    await watchCallback('change', path.join('hash-abc', 'status.json'));

    dispose?.();
    expect(closeWatcher).toHaveBeenCalled();
    expect(metrics.watcherActive).toBe(false);
    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'client.status_update',
      payload: { status: 'flushed', phase: 'final' },
    });
  });

  it('handles errors during watcher start gracefully', async () => {
    const fs = await import('node:fs/promises');
    const { registerSetupEventsStatusWatcher } = await import(
      '../src/server/setup-events-status-watcher.js'
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error('Permission denied'));

    const dispose = registerSetupEventsStatusWatcher({
      wpaths: {
        projectStatus: 'status.json',
        globalRoot: '/some/dir',
      } as never,
      clients: new Map(),
      broadcast: vi.fn(),
      on: vi.fn(),
      isDisposed: () => false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('setup_events.status_watcher_start_failed'),
    );
    consoleError.mockRestore();

    dispose?.();
  });

  it('aborts watcher setup if disposed before mkdir finishes', async () => {
    const { watch: fsWatch } = await import('node:fs');
    const fs = await import('node:fs/promises');
    const { registerSetupEventsStatusWatcher } = await import(
      '../src/server/setup-events-status-watcher.js'
    );

    let disposed = false;
    vi.mocked(fs.mkdir).mockImplementation(async () => {
      disposed = true;
    });

    registerSetupEventsStatusWatcher({
      wpaths: {
        projectStatus: 'status.json',
        globalRoot: '/some/dir',
      } as never,
      clients: new Map(),
      broadcast: vi.fn(),
      on: vi.fn(),
      isDisposed: () => disposed,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fsWatch).not.toHaveBeenCalled();
  });
});
