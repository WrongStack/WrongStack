/**
 * LIFO teardown-ordering pin for card #7C-2 (chimera finding).
 *
 * The whole point of extracting `setupTeardownRegistrar` is preserving a
 * subtle ordering contract: `setupVectorMemory` pushes the mirror-dispose
 * handler FIRST (its call happens earlier in cli-main), then
 * `setupTeardownRegistrar` pushes `store.close()`. Teardown runs LIFO, so
 * close() executes before mirror-dispose. If someone "tidies" the close
 * push back into setupVectorMemory, the sequence inverts and this test
 * fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { setupTeardownRegistrar } from '../src/wiring/teardown-registrar.js';

describe('setupTeardownRegistrar (card #7C-2 LIFO pin)', () => {
  it('pushes store.close() to teardownHandlers when a vector store is provided', () => {
    const teardownHandlers: Array<() => void> = [];
    const close = vi.fn();
    const vectorMemoryStore = { close } as unknown as Parameters<
      typeof setupTeardownRegistrar
    >[0]['vectorMemoryStore'];

    const result = setupTeardownRegistrar({
      flags: { tui: true },
      events: {} as Parameters<typeof setupTeardownRegistrar>[0]['events'],
      logger: {},
      teardownHandlers,
      vectorMemoryStore,
    });

    expect(teardownHandlers.length).toBe(1);
    expect(result.evOn).toBeTypeOf('function');
    expect(result.tuiOwnsScreen).toBe(true);
    teardownHandlers[0]?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('runs store.close() BEFORE the earlier mirror-dispose on LIFO teardown', () => {
    // Simulate the real cli-main order: setupVectorMemory first (pushes
    // mirror dispose), then setupTeardownRegistrar (pushes store close).
    const order: string[] = [];
    const teardownHandlers: Array<() => void> = [];
    teardownHandlers.push(() => order.push('mirror-dispose')); // from setupVectorMemory

    setupTeardownRegistrar({
      flags: {},
      events: {} as Parameters<typeof setupTeardownRegistrar>[0]['events'],
      logger: {},
      teardownHandlers,
      vectorMemoryStore: {
        close: () => order.push('store-close'),
      } as unknown as Parameters<typeof setupTeardownRegistrar>[0]['vectorMemoryStore'],
    });

    // LIFO: reverse order execution, exactly as runInteractive does.
    for (let i = teardownHandlers.length - 1; i >= 0; i--) teardownHandlers[i]!();

    expect(order).toEqual(['store-close', 'mirror-dispose']);
  });

  it('swallows store.close() failures via logger.debug', () => {
    const teardownHandlers: Array<() => void> = [];
    const debug = vi.fn();
    setupTeardownRegistrar({
      flags: {},
      events: {} as Parameters<typeof setupTeardownRegistrar>[0]['events'],
      logger: { debug },
      teardownHandlers,
      vectorMemoryStore: {
        close: () => {
          throw new Error('wal busy');
        },
      } as unknown as Parameters<typeof setupTeardownRegistrar>[0]['vectorMemoryStore'],
    });

    expect(() => teardownHandlers[0]?.()).not.toThrow();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('wal busy'));
  });

  it('pushes nothing when no vector store exists', () => {
    const teardownHandlers: Array<() => void> = [];
    setupTeardownRegistrar({
      flags: {},
      events: {} as Parameters<typeof setupTeardownRegistrar>[0]['events'],
      logger: {},
      teardownHandlers,
      vectorMemoryStore: undefined,
    });
    expect(teardownHandlers.length).toBe(0);
  });

  it('derives tuiOwnsScreen as false when --no-tui wins', () => {
    const result = setupTeardownRegistrar({
      flags: { tui: true, 'no-tui': true },
      events: {} as Parameters<typeof setupTeardownRegistrar>[0]['events'],
      logger: {},
      teardownHandlers: [],
      vectorMemoryStore: undefined,
    });
    expect(result.tuiOwnsScreen).toBe(false);
  });
});
