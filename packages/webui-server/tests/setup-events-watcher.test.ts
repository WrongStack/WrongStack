import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { statusProjectHashFromWatchFilename } from '@wrongstack/webui-server';

describe('setup-events status watcher filename filtering', () => {
  const projectsDir = path.join('C:', 'Users', 'dev', '.wrongstack', 'projects');

  it('extracts the project hash from relative status.json paths', () => {
    expect(
      statusProjectHashFromWatchFilename(projectsDir, path.join('abc123', 'status.json')),
    ).toBe('abc123');
    expect(statusProjectHashFromWatchFilename(projectsDir, 'abc123\\status.json')).toBe('abc123');
  });

  it('extracts the project hash from absolute status.json paths', () => {
    const file = path.join(projectsDir, 'def456', 'status.json');
    expect(statusProjectHashFromWatchFilename(projectsDir, file)).toBe('def456');
  });

  it('ignores non-status files and similarly named files', () => {
    expect(
      statusProjectHashFromWatchFilename(projectsDir, path.join('abc123', 'session.jsonl')),
    ).toBeNull();
    expect(
      statusProjectHashFromWatchFilename(projectsDir, path.join('abc123', 'my-status.json')),
    ).toBeNull();
    expect(statusProjectHashFromWatchFilename(projectsDir, 'status.json')).toBeNull();
  });
});

describe('setup-events watcher metrics and options', () => {
  const originalEnv = process.env['WRONGSTACK_WEBUI_WATCHER_STATS'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['WRONGSTACK_WEBUI_WATCHER_STATS'] = originalEnv;
    } else {
      delete process.env['WRONGSTACK_WEBUI_WATCHER_STATS'];
    }
  });

  it('evaluates shouldLogWatcherStats accurately', async () => {
    const { shouldLogWatcherStats } = await import('../src/server/setup-events-watcher.js');

    for (const val of ['1', 'true', 'yes', 'on', ' TRUE ', 'On ']) {
      process.env['WRONGSTACK_WEBUI_WATCHER_STATS'] = val;
      expect(shouldLogWatcherStats()).toBe(true);
    }

    for (const val of ['0', 'false', 'no', 'off', 'anything_else', '']) {
      process.env['WRONGSTACK_WEBUI_WATCHER_STATS'] = val;
      expect(shouldLogWatcherStats()).toBe(false);
    }

    delete process.env['WRONGSTACK_WEBUI_WATCHER_STATS'];
    expect(shouldLogWatcherStats()).toBe(false);
  });

  it('creates and initializes default metrics', async () => {
    const {
      createDefaultFileWatcherMetrics,
      initializeFileWatcherMetrics,
      averageFileWatcherDebounceDelay,
    } = await import('../src/server/setup-events-watcher.js');

    const metrics = createDefaultFileWatcherMetrics();
    expect(metrics).toEqual({
      fileChangesDetected: 0,
      filesProcessed: 0,
      broadcastsSent: 0,
      debounceResets: 0,
      totalDebounceDelayMs: 0,
      activeProjects: 0,
      averageDebounceDelayMs: 0,
      watcherActive: false,
    });

    metrics.broadcastsSent = 5;
    metrics.totalDebounceDelayMs = 150;
    expect(averageFileWatcherDebounceDelay(metrics)).toBe(30);

    expect(averageFileWatcherDebounceDelay(undefined)).toBe(0);
    expect(averageFileWatcherDebounceDelay({ ...metrics, broadcastsSent: 0 })).toBe(0);

    initializeFileWatcherMetrics(metrics);
    expect(metrics.watcherActive).toBe(true);
    expect(metrics.broadcastsSent).toBe(0);
  });

  it('logs file watcher metrics when enabled and skips when disabled', async () => {
    const { logFileWatcherMetrics, createDefaultFileWatcherMetrics } = await import(
      '../src/server/setup-events-watcher.js'
    );
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // When disabled
    process.env['WRONGSTACK_WEBUI_WATCHER_STATS'] = '0';
    const metrics = createDefaultFileWatcherMetrics();
    metrics.broadcastsSent = 2;
    metrics.totalDebounceDelayMs = 200;
    logFileWatcherMetrics(metrics);
    expect(consoleSpy).not.toHaveBeenCalled();

    // When undefined
    logFileWatcherMetrics(undefined);
    expect(consoleSpy).not.toHaveBeenCalled();

    // When enabled
    process.env['WRONGSTACK_WEBUI_WATCHER_STATS'] = 'true';
    logFileWatcherMetrics(metrics);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[setup-events] File watcher stats: 2 broadcasts'),
    );
    expect(metrics.averageDebounceDelayMs).toBe(100);

    consoleSpy.mockRestore();
  });
});

