/**
 * Teardown-registrar phase (card #7C-2), extracted verbatim from
 * `cli-main.ts` (was lines 164-179).
 *
 * Two concerns that must stay together because of the LIFO teardown
 * contract:
 *
 * 1. `createTeardownEventRegistrar` wraps `events` so event-driven
 *    subscriptions unregister themselves on shutdown (their disposers go
 *    to the same chain).
 * 2. The vector-memory SQLite `close()` teardown is pushed *after* the
 *    registrar — in the original file the store-close push sat at line
 *    170, after the mirror-dispose push at line 168 from the setup
 *    phase, so on LIFO teardown close runs before the mirror dispose.
 *    Keeping this registration inside the same function preserves that
 *    exact ordering; moving it back into the setup phase would invert
 *    the shutdown sequence.
 *
 * `tuiOwnsScreen` is resolved here as well (was line 164): it derives
 * purely from flags and is consumed by the event wiring below.
 */
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import { createTeardownEventRegistrar } from '../cli-main-helpers.js';

export interface TeardownRegistrarArgs {
  flags: { tui?: unknown; 'no-tui'?: unknown };
  events: Parameters<typeof createTeardownEventRegistrar>[0];
  logger: {
    debug?: (message: string) => void;
  };
  teardownHandlers: Array<() => void>;
  vectorMemoryStore: VectorMemoryStore | undefined;
}

export interface TeardownRegistrarResult {
  tuiOwnsScreen: boolean;
  evOn: ReturnType<typeof createTeardownEventRegistrar>;
}

export function setupTeardownRegistrar(args: TeardownRegistrarArgs): TeardownRegistrarResult {
  const { flags, events, logger, teardownHandlers, vectorMemoryStore } = args;

  const tuiOwnsScreen = flags.tui === true && flags['no-tui'] !== true;
  const evOn = createTeardownEventRegistrar(events, teardownHandlers);
  // Close the vector memory SQLite handle on shutdown — keeps the WAL
  // frame file consistent and mirrors the SAGE dispose contract.
  if (vectorMemoryStore) {
    const store = vectorMemoryStore;
    teardownHandlers.push(() => {
      try {
        store.close();
      } catch (error) {
        logger.debug?.(
          `vector memory close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  return { tuiOwnsScreen, evOn };
}
