import { parse, resolve } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, expect, it, vi } from 'vitest';
import { setupWebUICodebaseIndexing } from '../src/server/codebase-indexing.js';

type WatchEvent = { eventType: 'rename' | 'change'; filename: string };
const watcher = vi.hoisted(() => ({
  access: vi.fn(),
  enqueue: vi.fn(),
  listener: undefined as ((event: WatchEvent) => void) | undefined,
}));
vi.mock('node:fs', () => ({ promises: { access: watcher.access } }));
vi.mock('@wrongstack/core/utils', () => ({
  DEFAULT_WALK_IGNORE_SET: new Set(),
  watchProjectTree: (_root: string, listener: (event: WatchEvent) => void) => {
    watcher.listener = listener;
    return { close() {} };
  },
}));
vi.mock('@wrongstack/tools', () => ({
  cancelPendingReindexes: vi.fn(),
  enqueueReindex: watcher.enqueue,
  ensureCodebaseIndexServer: async () => {},
  isIndexableFile: (file: string) => file.endsWith('.ts'),
  onIndexStateChange: () => () => {},
  runStartupIndex: vi.fn(),
  setIndexServiceMode: vi.fn(),
  shutdownCodebaseIndexHost: vi.fn(),
}));
vi.mock('../src/server/codemap-cache.js', () => ({ clearCodemapGraphCache: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  watcher.access.mockReset();
  watcher.enqueue.mockClear();
});

function start(projectRoot = resolve('webui-watcher-fixture'), indexOnEdit = false) {
  const events = new EventBus();
  const seen: string[] = [];
  events.on('file.activity', (event) => seen.push(event.operation));
  const debug = vi.fn();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const owner = setupWebUICodebaseIndexing({
    config: indexOnEdit
      ? { indexing: { onSessionStart: false, onEdit: true, watchExternal: false } }
      : {},
    context: { meta: {} } as never,
    projectRoot,
    logger: { debug } as never,
    events,
  });
  const emit = (eventType: WatchEvent['eventType'], at: number) => {
    now.mockReturnValue(at);
    watcher.listener!({ eventType, filename: 'project.ts' });
  };
  const deferAccess = () => {
    const gate = Promise.withResolvers<void>();
    let waiting = false;
    watcher.access.mockImplementationOnce(() => {
      waiting = true;
      return gate.promise;
    });
    return {
      missing() {
        if (waiting) gate.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        else gate.resolve();
      },
    };
  };
  return { owner, seen, emit, deferAccess, debug };
}

it('publishes a deletion immediately after an edit of the same file', async () => {
  const { owner, seen, emit, deferAccess } = start();
  try {
    emit('change', 1_000);
    const deletion = deferAccess();
    emit('rename', 1_010);
    deletion.missing();
    await Promise.resolve();

    expect(seen).toEqual(['edit', 'delete']);
  } finally {
    owner.dispose();
  }
});

it('keeps the newer edit when an older deletion probe completes late', async () => {
  const { owner, seen, emit, deferAccess } = start();
  try {
    const deletion = deferAccess();
    emit('rename', 1_000);
    expect(watcher.access).toHaveBeenCalledOnce();
    emit('change', 1_010);
    deletion.missing();
    await Promise.resolve();

    expect(seen).toEqual(['edit']);
  } finally {
    owner.dispose();
  }
});

it('accepts watcher events and reindexes editor saves when the project is a filesystem root', () => {
  const root = parse(resolve('webui-watcher-fixture')).root;
  const { owner, seen, emit } = start(root, true);
  try {
    emit('change', 1_000);
    owner.onFileWritten('project.ts');

    expect({
      operations: seen,
      reindexes: watcher.enqueue.mock.calls.map(([request]) => request.files),
    }).toEqual({ operations: ['edit', 'write'], reindexes: [[resolve(root, 'project.ts')]] });
  } finally {
    owner.dispose();
  }
});

it.each(['EACCES', 'EPERM'])(
  'does not report a deletion when the access probe returns %s',
  async (code) => {
    const { owner, seen, emit, debug } = start();
    try {
      watcher.access.mockRejectedValueOnce(
        Object.assign(new Error('cannot inspect path'), { code }),
      );
      emit('rename', 1_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(seen).toEqual([]);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('cannot inspect path'));
    } finally {
      owner.dispose();
    }
  },
);
