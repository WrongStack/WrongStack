import { resolve } from 'node:path';
import type { Plugin, PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: fs.watch,
}));

import cron from '../src/cron/index.js';
import watcher from '../src/file-watcher/index.js';

const cleanup: Array<() => unknown> = [];
let callbacks: Array<(event: string, filename: string) => void>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  callbacks = [];
  fs.watch
    .mockReset()
    .mockImplementation(
      (_path: string, _options: unknown, callback: (typeof callbacks)[number]) => {
        callbacks.push(callback);
        return { close: vi.fn(), on: vi.fn() };
      },
    );
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.useRealTimers();
});
function host(plugin: Plugin) {
  const tools = new Map<string, Tool>();
  let beforeIteration!: (ctx: unknown, index: number) => Promise<void>;
  const emit = vi.fn();
  const append = vi.fn(async () => {});
  const api = {
    config: { extensions: { 'file-watcher': { debounceMs: 10 } } },
    tools: { register: (tool: Tool) => tools.set(tool.name, tool) },
    extensions: {
      register: (extension: { beforeIteration: typeof beforeIteration }) => {
        beforeIteration = extension.beforeIteration;
        return () => {};
      },
    },
    log: { info() {}, warn() {}, debug() {} },
    metrics: { counter() {}, gauge() {}, histogram() {} },
    emitCustom: emit,
    session: { append },
  } as unknown as PluginAPI;
  plugin.setup(api);
  cleanup.push(() => plugin.teardown?.(api));
  return {
    api,
    emit,
    append,
    beforeIteration,
    call(name: string, input: unknown = {}, context: unknown = {}) {
      return tools
        .get(name)!
        .execute(input, context as never, { signal: new AbortController().signal }) as Promise<
        Record<string, unknown>
      >;
    },
  };
}
const profiles = [
  [cron, 'cron_schedule', 'cron_list', { name: 'job', intervalMs: 1000, action: 'check' }],
  [watcher, 'watch_start', 'watch_list', { paths: ['.'] }],
] as const;
describe('background plugin lifecycle', () => {
  it('opens filesystem watches in the calling project', async () => {
    const loaded = host(watcher);
    const root = resolve('.temp_files/watch-project');
    await loaded.call('watch_start', { paths: ['src'] }, { projectRoot: root });
    expect(fs.watch.mock.calls[0]![0]).toBe(resolve(root, 'src'));
  });
  it.each(profiles)(
    '%s isolates jobs and watches between hosts',
    async (plugin, start, list, input) => {
      const first = host(plugin);
      await first.call(start, input);
      const second = host(plugin);
      await second.call(start, input);
      await plugin.teardown?.(first.api);
      expect(await second.call(list)).toMatchObject({ count: 1 });
      expect(await first.call(list)).toMatchObject({ count: 0 });
    },
  );
  it.each(profiles)(
    '%s rejects stale start tools after disposal',
    async (plugin, start, _list, input) => {
      const loaded = host(plugin);
      await plugin.teardown?.(loaded.api);
      await expect(loaded.call(start, input)).rejects.toThrow();
    },
  );
  it('ignores a queued filesystem callback arriving after watch_stop', async () => {
    const loaded = host(watcher);
    const result = await loaded.call('watch_start', { paths: ['.'] });
    await loaded.call('watch_stop', { watch_id: result.watch_id });
    callbacks[0]!('change', 'late.txt');
    await vi.advanceTimersByTimeAsync(50);
    expect(loaded.emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not emit a due job after cancellation during the journal write', async () => {
    const loaded = host(cron);
    let finish!: () => void;
    loaded.append.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await loaded.call('cron_schedule', { name: 'job', intervalMs: 1000, action: 'check' });
    vi.setSystemTime(2000);
    const pending = loaded.beforeIteration({}, 0);
    await loaded.call('cron_cancel', { name: 'job' });
    finish();
    await pending;
    expect(loaded.emit.mock.calls.some(([event]) => event === 'cron:job_due')).toBe(false);
  });
  it('does not deliver the same overdue job to overlapping iteration hooks', async () => {
    const loaded = host(cron);
    let finish!: () => void;
    loaded.append.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await loaded.call('cron_schedule', { name: 'job', intervalMs: 1000, action: 'check' });
    vi.setSystemTime(2000);
    const first = loaded.beforeIteration({}, 0);
    const second = loaded.beforeIteration({}, 1);
    expect(loaded.append).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(loaded.emit.mock.calls.filter(([event]) => event === 'cron:job_due')).toHaveLength(1);
  });
});
