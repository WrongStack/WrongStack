import { describe, expect, it, vi, beforeEach } from 'vitest';
import fileWatcherPlugin from '../src/file-watcher';

const mockApi = {
  tools: {
    register: vi.fn(),
  },
  config: { extensions: {} },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
};

describe('file-watcher plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a default Plugin object', () => {
    expect(fileWatcherPlugin).toBeDefined();
    expect(typeof fileWatcherPlugin).toBe('object');
  });

  it('plugin has correct name', () => {
    expect(fileWatcherPlugin.name).toBe('file-watcher');
  });

  it('registers watch_start tool', () => {
    fileWatcherPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('watch_start');
  });

  it('registers watch_stop tool', () => {
    fileWatcherPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('watch_stop');
  });

  it('registers watch_list tool', () => {
    fileWatcherPlugin.setup(mockApi as any);
    const toolNames = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(toolNames).toContain('watch_list');
  });

  it('watch_start tool has correct schema', () => {
    fileWatcherPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls
      .map(([t]: any[]) => t as any)
      .find((t: any) => t.name === 'watch_start');

    expect(tool).toBeDefined();
    expect(tool?.name).toBe('watch_start');
    expect(tool?.permission).toBe('confirm');
    expect(tool?.mutating).toBe(false);
    expect(tool?.inputSchema.type).toBe('object');
  });

  it('teardown is a function', () => {
    expect(typeof fileWatcherPlugin.teardown).toBe('function');
  });

  it('reports watcher resource health', async () => {
    fileWatcherPlugin.setup(mockApi as any);
    const health = await fileWatcherPlugin.health?.();
    expect(health).toEqual(
      expect.objectContaining({
        ok: true,
        activeWatchGroups: 0,
        filesystemWatchers: 0,
        pendingDebounces: 0,
      }),
    );
  });
});
