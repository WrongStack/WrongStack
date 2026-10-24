/**
 * The vector backend is opt-in. When `@huggingface/transformers` is absent
 * (always, in the standalone binary) every embed throws, so boot must not
 * build a store — otherwise the `vector_memory_*` tools are registered and
 * the model's first `vector_memory_search` call fails.
 */

import type { MemoryPort } from '@wrongstack/contracts/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ installed: false }));

vi.mock('@wrongstack/vector-memory', () => ({
  TransformersEmbeddingProvider: vi.fn(
    class {
      isInstalled() {
        return backend.installed;
      }
    },
  ),
  VectorMemoryStore: vi.fn(class {}),
  startFirstBootSageSync: vi.fn().mockResolvedValue({ synced: false }),
  subscribeVectorMemoryToSage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  sweepStaleSageMirrors: vi.fn().mockResolvedValue(undefined),
  wrapMemoryPortWithVectorRecall: vi.fn((mem: MemoryPort) => ({ ...mem, wrapped: true })),
}));

import { VectorMemoryStore } from '@wrongstack/vector-memory';
import { setupVectorMemory } from '../../src/wiring/vector-memory-setup.js';

function run() {
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const memoryStore = {} as MemoryPort;
  const teardownHandlers: Array<() => void> = [];
  return {
    logger,
    memoryStore,
    teardownHandlers,
    result: setupVectorMemory({
      projectRoot: 'D:/root',
      flags: {},
      logger,
      memoryStore,
      teardownHandlers,
    }),
  };
}

describe('setupVectorMemory — opt-in backend gate', () => {
  beforeEach(() => {
    vi.mocked(VectorMemoryStore).mockClear();
  });

  it('builds no store and leaves SAGE unwrapped when the backend is not installed', async () => {
    backend.installed = false;
    const { logger, memoryStore, teardownHandlers, result } = run();
    const out = await result;
    expect(out.vectorMemoryStore).toBeUndefined();
    expect(out.memoryStore).toBe(memoryStore);
    expect(VectorMemoryStore).not.toHaveBeenCalled();
    expect(teardownHandlers).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('builds the store when the backend is installed', async () => {
    backend.installed = true;
    const { memoryStore, result } = run();
    const out = await result;
    expect(out.vectorMemoryStore).toBeDefined();
    expect(out.memoryStore).not.toBe(memoryStore);
  });
});
