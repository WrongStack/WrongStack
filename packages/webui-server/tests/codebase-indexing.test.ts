import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@wrongstack/core/kernel';
import type { CircuitSnapshot } from '@wrongstack/tools';

type IndexState = {
  ready: boolean;
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
  lastError: string | null;
  circuit: CircuitSnapshot;
};

const {
  cancelPendingReindexes,
  enqueueReindex,
  ensureCodebaseIndexServer,
  isIndexableFile,
  onIndexStateChange,
  runStartupIndex,
  shutdownCodebaseIndexHost,
  indexStateListeners,
} = vi.hoisted(() => {
  const listeners = new Set<(state: IndexState) => void>();
  return {
    cancelPendingReindexes: vi.fn(),
    enqueueReindex: vi.fn(),
    ensureCodebaseIndexServer: vi.fn(async () => {}),
    isIndexableFile: vi.fn((filePath: string) => filePath.endsWith('.ts')),
    indexStateListeners: listeners,
    onIndexStateChange: vi.fn((listener: (state: IndexState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    runStartupIndex: vi.fn(async () => ({
      filesIndexed: 1,
      symbolsIndexed: 2,
      durationMs: 3,
    })),
    shutdownCodebaseIndexHost: vi.fn(),
  };
});

vi.mock('@wrongstack/tools', () => ({
  cancelPendingReindexes,
  enqueueReindex,
  ensureCodebaseIndexServer,
  isIndexableFile,
  onIndexStateChange,
  indexStateListeners,
  runStartupIndex,
  shutdownCodebaseIndexHost,
}));

vi.mock('../src/server/codemap-cache.js', () => ({
  clearCodemapGraphCache: vi.fn(),
}));

describe('WebUI codebase indexing', () => {
  const projectRoot = path.resolve('D:/repo');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(function child() {
      return this;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    indexStateListeners.clear();
    isIndexableFile.mockImplementation((filePath: string) => filePath.endsWith('.ts'));
  });

  // Import from source so tests exercise the current module (package "exports"
  // still point at a prebuilt dist that may lag local changes).
  async function loadSetup() {
    return import('../src/server/codebase-indexing.js');
  }

  it('starts the startup index when enabled', async () => {
    const { setupWebUICodebaseIndexing } = await loadSetup();
    const signal = new AbortController().signal;
    setupWebUICodebaseIndexing({
      config: {
        indexing: {
          onSessionStart: true,
          onEdit: false,
          watchExternal: false,
          debounceMs: 123,
          indexTimeoutMs: 456,
        },
      },
      context: { signal, meta: { codebaseIndexDir: 'D:/idx' } } as never,
      projectRoot,
      logger: logger as never,
    });

    expect(runStartupIndex).toHaveBeenCalledWith({
      projectRoot,
      indexDir: 'D:/idx',
      signal,
      timeoutMs: 456,
    });
  });

  it('does nothing when indexing config is absent', async () => {
    const { setupWebUICodebaseIndexing } = await loadSetup();
    const controller = setupWebUICodebaseIndexing({
      config: {},
      context: { signal: new AbortController().signal, meta: {} } as never,
      projectRoot,
      logger: logger as never,
    });

    controller.onFileWritten(path.join(projectRoot, 'src/a.ts'));
    controller.dispose();

    expect(runStartupIndex).not.toHaveBeenCalled();
    expect(enqueueReindex).not.toHaveBeenCalled();
    expect(cancelPendingReindexes).not.toHaveBeenCalled();
    expect(shutdownCodebaseIndexHost).not.toHaveBeenCalled();
  });

  it('reindexes WebUI-saved files when onEdit is enabled', async () => {
    const { setupWebUICodebaseIndexing } = await loadSetup();
    const controller = setupWebUICodebaseIndexing({
      config: {
        indexing: {
          onSessionStart: false,
          onEdit: true,
          watchExternal: false,
          debounceMs: 250,
          indexTimeoutMs: 999,
        },
      },
      context: { signal: new AbortController().signal, meta: {} } as never,
      projectRoot,
      logger: logger as never,
    });

    const file = path.join(projectRoot, 'src/user.ts');
    controller.onFileWritten(file);
    controller.onFileWritten(path.join(projectRoot, 'README.md'));
    controller.onFileWritten(path.resolve('D:/outside.ts'));

    expect(enqueueReindex).toHaveBeenCalledOnce();
    expect(enqueueReindex).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot,
        files: [file],
        debounceMs: 250,
        timeoutMs: 999,
      }),
    );
  });

  it('emits an attributed filesystem activity for WebUI editor saves', async () => {
    const { setupWebUICodebaseIndexing } = await loadSetup();
    const events = new EventBus();
    const received: unknown[] = [];
    events.on('file.activity', (event) => received.push(event));
    const controller = setupWebUICodebaseIndexing({
      config: {},
      context: {
        signal: new AbortController().signal,
        meta: {},
        session: { id: 'session-editor' },
      } as never,
      projectRoot,
      logger: logger as never,
      events,
    });
    const file = path.join(projectRoot, 'src/editor.ts');

    controller.onFileWritten(file);
    controller.dispose();

    expect(received).toEqual([
      expect.objectContaining({
        filePath: file,
        operation: 'write',
        phase: 'completed',
        source: 'editor',
        sessionId: 'session-editor',
        agentId: 'webui-editor',
        agentName: 'WebUI Editor',
      }),
    ]);
  });

  it('cleans up pending reindexes and the index host on dispose', async () => {
    const { setupWebUICodebaseIndexing } = await loadSetup();
    const controller = setupWebUICodebaseIndexing({
      config: {
        indexing: {
          onSessionStart: false,
          onEdit: true,
          watchExternal: false,
          debounceMs: 400,
        },
      },
      context: { signal: new AbortController().signal, meta: {} } as never,
      projectRoot,
      logger: logger as never,
    });

    controller.dispose();

    expect(cancelPendingReindexes).toHaveBeenCalledOnce();
    expect(shutdownCodebaseIndexHost).toHaveBeenCalledOnce();
  });

  it('clears the CodeMap graph cache and emits codemap.index_updated when indexing finishes', async () => {
    const { clearCodemapGraphCache } = await import('../src/server/codemap-cache.js');
    const { setupWebUICodebaseIndexing } = await loadSetup();
    const events = new EventBus();
    const received: unknown[] = [];
    events.on('codemap.index_updated', (event) => received.push(event));

    const controller = setupWebUICodebaseIndexing({
      config: {},
      context: { signal: new AbortController().signal, meta: {} } as never,
      projectRoot,
      logger: logger as never,
      events,
    });

    expect(onIndexStateChange).toHaveBeenCalled();
    const idle: IndexState = {
      ready: true,
      indexing: false,
      currentFile: 0,
      totalFiles: 0,
      lastError: null,
      circuit: {
        state: 'closed' as const,
        consecutiveFailures: 0,
        lastFailure: null,
        cooldownRemainingMs: 0,
      },
    };
    const busy = { ...idle, indexing: true, totalFiles: 4, currentFile: 1 };
    for (const listener of indexStateListeners) listener(busy);
    for (const listener of indexStateListeners) listener(idle);

    expect(clearCodemapGraphCache).toHaveBeenCalled();
    expect(received).toEqual([
      expect.objectContaining({
        ready: true,
        reason: 'index_complete',
      }),
    ]);

    controller.dispose();
    expect(indexStateListeners.size).toBe(0);
  });
});
