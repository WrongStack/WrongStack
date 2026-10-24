import type { BrainConfig } from '@wrongstack/contracts/types/config';

/** Preserve edit order and convert host writer failures into the runtime result contract. */
export function createBrainPersistenceQueue(persist?: (config: BrainConfig) => Promise<void>) {
  let queue: Promise<unknown> = Promise.resolve();
  return (config: BrainConfig): Promise<{ ok: boolean; error?: string }> => {
    if (!persist) return Promise.resolve({ ok: true });
    // Config is captured by the caller at apply time, never read after waiting.
    const result = queue
      .then(() => persist(config))
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    queue = result;
    return result;
  };
}
