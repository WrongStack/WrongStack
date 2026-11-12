import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
const fake = vi.hoisted(() => ({
  enqueue: vi.fn(),
  emit: vi.fn(),
  close: vi.fn(),
  access: vi.fn(),
  callback: undefined as
    | undefined
    | ((event: { eventType: 'rename' | 'change'; filename: string }) => void),
}));
vi.mock('node:fs', () => ({ promises: { access: fake.access } }));
vi.mock('@wrongstack/core/utils', () => ({
  DEFAULT_WALK_IGNORE_SET: new Set(),
  watchProjectTree: (_root: unknown, cb: typeof fake.callback) => {
    fake.callback = cb;
    return { close: fake.close };
  },
}));
vi.mock('@wrongstack/tools', () => ({
  cancelPendingReindexes: vi.fn(),
  enqueueReindex: fake.enqueue,
  ensureCodebaseIndexServer: async () => {},
  isIndexableFile: () => true,
  onIndexStateChange: () => () => {},
  runStartupIndex: async () => ({}),
  setIndexServiceMode: vi.fn(),
  shutdownCodebaseIndexHost: async () => {},
}));
vi.mock('../src/server/codemap-cache.js', () => ({ clearCodemapGraphCache: vi.fn() }));

import { setupWebUICodebaseIndexing } from '../src/server/codebase-indexing.js';

it('drops editor and gated watcher activity after disposal', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const setup = () =>
    setupWebUICodebaseIndexing({
      config: {
        indexing: { onSessionStart: false, onEdit: true, watchExternal: false, debounceMs: 400 },
      },
      context: { meta: {} } as never,
      projectRoot: process.cwd(),
      events: { emit: fake.emit, on: () => () => {} } as never,
      logger: { debug: vi.fn() } as never,
    });
  const control = setup();
  control.onFileWritten('control.ts');
  expect(fake.emit).toHaveBeenCalledOnce();
  expect(fake.enqueue).toHaveBeenCalledOnce();
  control.dispose();
  fake.emit.mockClear();
  fake.enqueue.mockClear();
  let release!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>((r) => {
    entered = r;
  });
  fake.access.mockImplementation(() => {
    entered();
    return new Promise<void>((r) => {
      release = r;
    });
  });
  const owner = setup();
  fake.callback!({ eventType: 'rename', filename: 'pending.ts' });
  await entry;
  owner.dispose();
  owner.onFileWritten('late.ts');
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.emit).not.toHaveBeenCalled();
  expect(fake.enqueue).not.toHaveBeenCalled();
  fake.callback!({ eventType: 'change', filename: 'late-watcher.ts' });
  owner.dispose();
  expect(fake.emit).not.toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalledTimes(2);
  const fresh = setup();
  fresh.onFileWritten('fresh.ts');
  expect(fake.emit).toHaveBeenCalledOnce();
  expect(fake.enqueue).toHaveBeenCalledOnce();
  fresh.dispose();
});
