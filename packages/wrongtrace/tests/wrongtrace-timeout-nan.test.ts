import { describe, expect, it } from 'vitest';
import { discover } from '../src/discovery.js';

describe('discover non-finite timeoutMs guard', () => {
  it('falls back to 1000ms default when timeoutMs is NaN', async () => {
    let seenMs: number | undefined;
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      seenMs = ms;
      return origSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout;
    try {
      await discover({
        timeoutMs: Number.NaN,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
      });
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(seenMs).toBe(1000);
  });
});
