/**
 * LIFO teardown-ordering regression for `setupTeardownRegistrar`
 * (packages/cli/src/wiring/teardown-registrar.ts).
 *
 * The Chimera cli-extraction review flagged this contract as untested:
 * the vector-memory store-`close()` handler is pushed AFTER the registrar
 * wraps the teardown chain — deliberately, so that on LIFO teardown
 * `close()` runs BEFORE the mirror-dispose handler that the setup phase
 * (vector-memory-setup.ts) pushed earlier. In the original cli-main.ts
 * layout the store-close push sat at line 170, after the mirror-dispose
 * push at line 168. Moving the store-close registration back into the
 * setup phase (a plausible "tidying" refactor) would invert the shutdown
 * sequence — the mirror would dispose into a store that is already
 * closed. This suite pins the order.
 */
import { describe, expect, it, vi } from 'vitest';
import type { createTeardownEventRegistrar } from '../src/cli-main-helpers.js';
import { setupTeardownRegistrar } from '../src/wiring/teardown-registrar.js';

function storeWithOrder(order: string[]) {
  return {
    close: vi.fn(() => order.push('store-closed')),
  } as unknown as Parameters<typeof setupTeardownRegistrar>[0]['vectorMemoryStore'];
}

describe('setupTeardownRegistrar LIFO ordering (Chimera cli-extraction follow-up)', () => {
  it('pushes store.close AFTER the registrar so LIFO teardown closes before the mirror dispose', () => {
    const order: string[] = [];
    const teardownHandlers: Array<() => void> = [];
    // The setup phase (vector-memory-setup.ts) pushes the mirror-dispose
    // BEFORE this registrar runs — reproduced verbatim here.
    teardownHandlers.push(() => order.push('mirror-dispose'));
    const events = { on: vi.fn(), off: vi.fn() };

    const { evOn } = setupTeardownRegistrar({
      flags: {},
      events: events as Parameters<typeof createTeardownEventRegistrar>[0],
      logger: { debug: vi.fn() },
      teardownHandlers,
      vectorMemoryStore: storeWithOrder(order),
    });

    // An event subscription registered through the registrar appends its
    // disposer AFTER the store-close push (the registrar wraps first, the
    // store-close is pushed second — so LIFO runs close, then unsubs).
    evOn('some-event', vi.fn());
    expect(teardownHandlers.length).toBe(3);

    // LIFO teardown, exactly as cli-main runs it (reverse iteration).
    for (let i = teardownHandlers.length - 1; i >= 0; i--) teardownHandlers[i]?.();
    expect(order).toEqual(['store-closed', 'mirror-dispose']);
  });

  it('a throwing store.close does not abort the teardown chain', () => {
    const order: string[] = [];
    const teardownHandlers: Array<() => void> = [() => order.push('mirror-dispose')];
    const store = storeWithOrder(order);
    store.close = vi.fn(() => {
      throw new Error('already closed');
    });
    const debug = vi.fn();

    setupTeardownRegistrar({
      flags: {},
      events: { on: vi.fn(), off: vi.fn() } as Parameters<typeof createTeardownEventRegistrar>[0],
      logger: { debug },
      teardownHandlers,
      vectorMemoryStore: store,
    });

    for (let i = teardownHandlers.length - 1; i >= 0; i--) teardownHandlers[i]?.();
    expect(order).toEqual(['mirror-dispose']); // earlier handlers still ran
    expect(debug).toHaveBeenCalledWith('vector memory close failed: already closed');
  });

  it('without a store, only the registrar chain exists (no phantom handler)', () => {
    const teardownHandlers: Array<() => void> = [];
    const { evOn, tuiOwnsScreen } = setupTeardownRegistrar({
      flags: { tui: true },
      events: { on: vi.fn(), off: vi.fn() } as Parameters<typeof createTeardownEventRegistrar>[0],
      logger: {},
      teardownHandlers,
      vectorMemoryStore: undefined,
    });
    expect(tuiOwnsScreen).toBe(true); // tui && !no-tui
    evOn('e', vi.fn());
    expect(teardownHandlers.length).toBe(1); // just the event disposer
    expect(() => teardownHandlers[0]?.()).not.toThrow();
  });
});
