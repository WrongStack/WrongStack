import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsm = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('node:fs', async (o) => ({ ...(await o()), watch: fsm.watch }));

const idx = vi.hoisted(() => ({ enqueueReindex: vi.fn() }));
vi.mock('@wrongstack/tools/codebase-index', () => ({ enqueueReindex: idx.enqueueReindex }));

import fileWatcherPlugin from '../src/file-watcher';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

type WatchCb = (event: string, filename: string | null) => void;
let lastCb: WatchCb | undefined;
let errorHandler: ((err: unknown) => void) | undefined;

function fakeWatcher() {
  return {
    close: vi.fn(),
    on: vi.fn((ev: string, fn: (err: unknown) => void) => {
      if (ev === 'error') errorHandler = fn;
    }),
  };
}

let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};
let metrics: {
  counter: ReturnType<typeof vi.fn>;
  gauge: ReturnType<typeof vi.fn>;
  histogram: ReturnType<typeof vi.fn>;
};
let emitCustom: ReturnType<typeof vi.fn>;

function setup(fw: Record<string, unknown> = { debounceMs: 100 }): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  metrics = { counter: vi.fn(), gauge: vi.fn(), histogram: vi.fn() };
  emitCustom = vi.fn();
  const api = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: { 'file-watcher': fw } },
    log,
    metrics,
    emitCustom,
  };
  fileWatcherPlugin.setup(api as never);
  return tools;
}

beforeEach(() => {
  fsm.watch.mockReset();
  idx.enqueueReindex.mockReset();
  lastCb = undefined;
  errorHandler = undefined;
  fsm.watch.mockImplementation((_dir: string, _opts: unknown, cb: WatchCb) => {
    lastCb = cb;
    return fakeWatcher();
  });
});

afterEach(() => {
  vi.useRealTimers();
  // Clean module-level state so timers don't leak between tests.
  fileWatcherPlugin.teardown?.({ log: { info: vi.fn() } } as never);
});

describe('watch_start', () => {
  it('rejects non-array paths', async () => {
    const tools = setup();
    const res = await tools.watch_start!.execute({ paths: 'not-array' });
    expect(res).toMatchObject({ ok: false, watch_id: null });
  });

  it('rejects an empty paths array', async () => {
    const tools = setup();
    const res = await tools.watch_start!.execute({ paths: [] });
    expect(res.error).toMatch(/at least one path/);
  });

  it('starts watching and returns a watch id', async () => {
    const tools = setup();
    const res = await tools.watch_start!.execute({ paths: ['src', 'lib'] });
    expect(res.ok).toBe(true);
    expect(typeof res.watch_id).toBe('string');
    expect(res.recursive).toBe(true);
    expect(fsm.watch).toHaveBeenCalledTimes(2);
    expect(metrics.gauge).toHaveBeenCalledWith('active_watches', 1);
  });

  it('accepts explicit events and recursive=false', async () => {
    const tools = setup();
    const res = await tools.watch_start!.execute({
      paths: ['x'],
      events: ['change'],
      recursive: false,
    });
    expect(res.events).toEqual(['change']);
    expect(res.recursive).toBe(false);
  });

  it('logs a warning when fs.watch throws', async () => {
    fsm.watch.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const tools = setup();
    const res = await tools.watch_start!.execute({ paths: ['bad'] });
    expect(res.ok).toBe(true); // start still succeeds; the watch just isn't active
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not watch/));
  });

  it('emits a debounced change event when the watcher fires', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 100 });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'a.txt');
    await vi.advanceTimersByTimeAsync(100);
    expect(emitCustom).toHaveBeenCalledWith(
      'file-watcher:changed',
      expect.objectContaining({
        path: 'src/a.txt',
        event: 'change',
        filename: 'a.txt',
      }),
    );
    expect(metrics.counter).toHaveBeenCalledWith('file_change', 1, { event: 'change' });
  });

  it('labels an undefined event type as "unknown"', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 50 });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!(undefined as never as string, 'a.txt');
    await vi.advanceTimersByTimeAsync(50);
    expect(metrics.counter).toHaveBeenCalledWith('file_change', 1, { event: 'unknown' });
  });

  it('ignores watcher callbacks with no filename', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 50 });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', null);
    await vi.advanceTimersByTimeAsync(50);
    expect(emitCustom).not.toHaveBeenCalled();
  });

  it('coalesces rapid events for the same key (debounce)', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 100 });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'a.txt');
    await vi.advanceTimersByTimeAsync(40);
    lastCb!('change', 'a.txt'); // resets the timer
    await vi.advanceTimersByTimeAsync(100);
    expect(emitCustom).toHaveBeenCalledTimes(1);
  });

  it('forwards watcher error events to the log', async () => {
    const tools = setup();
    await tools.watch_start!.execute({ paths: ['src'] });
    errorHandler!(new Error('watch broke'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/error on src/));
  });

  it('schedules a reindex for indexable files when autoIndex is on', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 50, autoIndex: true, indexProjectRoot: 'proj' });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'mod.ts');
    await vi.advanceTimersByTimeAsync(50); // change debounce → emit + schedule index debounce
    await vi.advanceTimersByTimeAsync(50); // index debounce → enqueueReindex
    expect(idx.enqueueReindex).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: 'proj',
        files: ['src/mod.ts'],
      }),
    );
    expect(metrics.counter).toHaveBeenCalledWith('index_file', 1);
  });

  it('falls back to the watched dir when indexProjectRoot is outside the project root', async () => {
    vi.useFakeTimers();
    const tools = setup({
      debounceMs: 50,
      autoIndex: true,
      indexProjectRoot: process.platform === 'win32' ? 'C:\\elsewhere' : '/etc',
    });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'mod.ts');
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(idx.enqueueReindex).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: 'src', files: ['src/mod.ts'] }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/indexProjectRoot is outside the project root/),
      expect.objectContaining({ indexProjectRoot: expect.any(String) }),
    );
  });

  it('rejects watch_start when any path is outside the project root', async () => {
    const tools = setup();
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    const res = await tools.watch_start!.execute({ paths: ['src', outside] });
    expect(res.ok).toBe(false);
    expect(res.rejectedOutsideProject).toBe(true);
    expect(res.error).toMatch(/outside the project root/);
    expect((res as { watch_id: string | null }).watch_id).toBeNull();
  });

  it('does not reindex non-indexable files', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 50, autoIndex: true });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'notes.md');
    await vi.advanceTimersByTimeAsync(100);
    expect(idx.enqueueReindex).not.toHaveBeenCalled();
  });

  it('logs a warning when the reindex enqueue fails', async () => {
    vi.useFakeTimers();
    idx.enqueueReindex.mockImplementation(() => {
      throw new Error('index down');
    });
    const tools = setup({ debounceMs: 50, autoIndex: true });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'mod.ts');
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/auto-index failed/));
  });

  it('logs via the enqueueReindex onError callback', async () => {
    vi.useFakeTimers();
    idx.enqueueReindex.mockImplementation((opts: { onError: (e: unknown) => void }) => {
      opts.onError(new Error('indexer crashed'));
    });
    const tools = setup({ debounceMs: 50, autoIndex: true });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'mod.ts');
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/auto-index failed for src\/mod\.ts/),
    );
  });

  it('falls back to the watched dir as index root when none configured', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 50, autoIndex: true }); // no indexProjectRoot
    await tools.watch_start!.execute({ paths: ['srcdir'] });
    lastCb!('change', 'mod.ts');
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(idx.enqueueReindex).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: 'srcdir' }),
    );
  });
});

describe('watch_stop', () => {
  it('stops an active watch', async () => {
    const tools = setup();
    const started = await tools.watch_start!.execute({ paths: ['src'] });
    const res = await tools.watch_stop!.execute({ watch_id: started.watch_id as string });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/Stopped watch/);
  });

  it('errors for an unknown watch id', async () => {
    const tools = setup();
    const res = await tools.watch_stop!.execute({ watch_id: 'missing' });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/No active watch/);
  });

  it('tolerates a watcher whose close() throws', async () => {
    fsm.watch.mockImplementation(() => ({
      close: () => {
        throw new Error('already closed');
      },
      on: vi.fn(),
    }));
    const tools = setup();
    const started = await tools.watch_start!.execute({ paths: ['src'] });
    const res = await tools.watch_stop!.execute({ watch_id: started.watch_id as string });
    expect(res.ok).toBe(true);
  });
});

describe('watch_list', () => {
  it('lists active watches with metadata', async () => {
    const tools = setup();
    await tools.watch_start!.execute({ paths: ['a'] });
    await tools.watch_start!.execute({ paths: ['b', 'c'] });
    const res = await tools.watch_list!.execute({});
    expect(res.count).toBe(2);
    const watches = res.watches as Array<{ paths: string[]; age: string }>;
    expect(watches[0]!.age).toMatch(/ms$/);
  });

  it('returns an empty list when nothing is watched', async () => {
    const tools = setup();
    const res = await tools.watch_list!.execute({});
    expect(res).toMatchObject({ count: 0, watches: [] });
  });
});

describe('lifecycle', () => {
  it('re-init on setup closes leftover watches', async () => {
    const tools = setup();
    const started = await tools.watch_start!.execute({ paths: ['src'] });
    expect(started.ok).toBe(true);
    // A second setup() must clear the previous watch (idempotent re-init).
    const tools2 = setup();
    const res = await tools2.watch_list!.execute({});
    expect(res.count).toBe(0);
  });

  it('teardown closes watches and clears timers', async () => {
    const tools = setup();
    await tools.watch_start!.execute({ paths: ['src'] });
    const teardownLog = { info: vi.fn() };
    fileWatcherPlugin.teardown?.({ log: teardownLog } as never);
    expect(teardownLog.info).toHaveBeenCalledWith(
      'file-watcher: teardown complete',
      expect.anything(),
    );
    const res = await tools.watch_list!.execute({});
    expect(res.count).toBe(0);
  });

  it('clears pending debounce timers on re-init and on teardown', async () => {
    vi.useFakeTimers();
    const tools = setup({ debounceMs: 1000 });
    await tools.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'x.txt'); // schedules a pending (un-fired) debounce timer
    // Re-init must clear the pending timer (the clear loop in setup).
    const tools2 = setup({ debounceMs: 1000 });
    await tools2.watch_start!.execute({ paths: ['src'] });
    lastCb!('change', 'y.txt'); // another pending timer → cleared by afterEach teardown
    expect(emitCustom).not.toHaveBeenCalled(); // neither timer fired
  });
});
