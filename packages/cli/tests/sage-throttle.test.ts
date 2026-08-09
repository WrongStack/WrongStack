import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAutoHygieneThrottleForTesting, setupSage } from '../src/wiring/sage.js';

// Minimal mock types matching SageWiringDeps
interface MockDeps {
  config: Record<string, unknown>;
  pipelines: {
    toolCall: { use: ReturnType<typeof vi.fn> };
    request: { use: ReturnType<typeof vi.fn> };
  };
  memoryStore: Record<string, unknown>;
  logger: { debug: ReturnType<typeof vi.fn> };
  events: { emit: ReturnType<typeof vi.fn> };
  getSessionId?: () => string | undefined;
}

function makeMockDeps(hygieneFn: () => Promise<unknown>): MockDeps {
  const memoryStore: Record<string, unknown> = {
    retrieveForPath: vi.fn(),
    searchSage: vi.fn(),
    flushPendingCounters: vi.fn(),
    hygiene: hygieneFn,
  };
  memoryStore.getCapability = vi.fn(() => memoryStore);
  return {
    config: {
      features: { memory: true },
      Sage: {
        enabled: true,
        hygiene: { autoAfterSession: true },
      },
    },
    pipelines: {
      toolCall: { use: vi.fn() },
      request: { use: vi.fn() },
    },
    memoryStore,
    logger: { debug: vi.fn() },
    events: { emit: vi.fn() },
  };
}

describe('auto-hygiene throttle', () => {
  beforeEach(() => {
    _resetAutoHygieneThrottleForTesting();
  });

  afterEach(() => {
    _resetAutoHygieneThrottleForTesting();
  });

  it('runs hygiene on first teardown, skips on second within the interval', async () => {
    const hygieneSpy = vi.fn().mockResolvedValue(undefined);
    const deps = makeMockDeps(hygieneSpy);
    const teardown = setupSage(deps as never);

    // First teardown — should call hygiene.
    await teardown();
    expect(hygieneSpy).toHaveBeenCalledTimes(1);

    // Second teardown — should be throttled (within 1 hour).
    await teardown();
    expect(hygieneSpy).toHaveBeenCalledTimes(1); // still 1, not 2

    // The debug log should mention the throttle.
    expect(deps.logger.debug).toHaveBeenCalledWith(expect.stringContaining('auto-hygiene skipped'));
  });

  it('calls flushPendingCounters even when hygiene is throttled (defensive: real batching hook is deferred — see R3b)', async () => {
    const hygieneSpy = vi.fn().mockResolvedValue(undefined);
    const flushSpy = vi.fn().mockResolvedValue(undefined);
    const deps = makeMockDeps(hygieneSpy);
    (deps.memoryStore as Record<string, unknown>).flushPendingCounters = flushSpy;
    const teardown = setupSage(deps as never);

    // First teardown — both flush + hygiene called.
    await teardown();
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(hygieneSpy).toHaveBeenCalledTimes(1);

    // Second teardown — flush still called, hygiene throttled. This
    // contract preserves the hook surface so a future real
    // counter-batching implementation (R3b) will be drained correctly
    // even on throttled teardowns. The current in-memory and IPC
    // implementations make the flush a no-op.
    await teardown();
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect(hygieneSpy).toHaveBeenCalledTimes(1);
  });

  it('does not run hygiene when autoAfterSession is false', async () => {
    const hygieneSpy = vi.fn().mockResolvedValue(undefined);
    const deps = makeMockDeps(hygieneSpy);
    // Override: autoAfterSession disabled
    (deps.config as Record<string, Record<string, unknown>>).Sage = {
      hygiene: { autoAfterSession: false },
    };
    const teardown = setupSage(deps as never);

    await teardown();
    expect(hygieneSpy).not.toHaveBeenCalled();
  });
});
