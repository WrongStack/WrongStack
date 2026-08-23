import type { EventBus } from '../kernel/events.js';
import { promptCacheHitRatio, type Usage } from '../types/provider.js';

export interface ProviderCacheEntry {
  provider: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead / total prompt context; clamped to [0, 1]. */
  hitRatio: number;
}

interface Accum {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Per-provider prompt-cache accounting for a session. `TokenCounter.cacheStats()`
 * blends every provider into one figure; this splits it so a session that
 * switched providers (fallback, `/model`) can show each provider's real
 * cache-hit ratio.
 *
 * New counters provide an exact per-call `deltaUsage`; older event producers
 * remain compatible through cumulative-snapshot differencing. The explicit
 * delta keeps attribution correct even when asynchronous price lookups settle
 * out of order after a provider switch.
 *
 * **LIFECYCLE WARNING:** The constructor subscribes to `events.on('token.accounted', …)`,
 * creating a permanent listener on the shared EventBus. The **caller MUST invoke
 * `dispose()` on session teardown** (e.g. via the `detachTodosCheckpoint` chain
 * in `packages/cli/src/wiring/session.ts`). Failure to do so leaks the listener
 * across session restarts/resumes — every constructor invocation after the first
 * adds a permanent listener that accumulates unboundedly.
 */
export class ProviderCacheLedger {
  private readonly byProvider = new Map<string, Accum>();
  private last: Accum = { input: 0, cacheRead: 0, cacheWrite: 0 };
  private readonly off: () => void;

  constructor(events: EventBus) {
    this.off = events.on(
      'token.accounted',
      (p: { usage: Usage; deltaUsage?: Usage | undefined; provider?: string | undefined }) => {
        this.record(p.usage, p.provider, p.deltaUsage);
      },
    );
  }

  private record(usage: Usage, provider?: string, deltaUsage?: Usage): void {
    const cur: Accum = {
      input: usage.input,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    };
    // Diff the cumulative snapshot to isolate this request's contribution.
    // Guard against non-monotonic input (a counter reset): treat a decrease as
    // a fresh baseline rather than a negative delta.
    const delta: Accum = deltaUsage
      ? {
          input: deltaUsage.input,
          cacheRead: deltaUsage.cacheRead ?? 0,
          cacheWrite: deltaUsage.cacheWrite ?? 0,
        }
      : {
          input: Math.max(0, cur.input - this.last.input),
          cacheRead: Math.max(0, cur.cacheRead - this.last.cacheRead),
          cacheWrite: Math.max(0, cur.cacheWrite - this.last.cacheWrite),
        };
    this.last = cur;

    const key = provider ?? 'unknown';
    const acc = this.byProvider.get(key) ?? { input: 0, cacheRead: 0, cacheWrite: 0 };
    acc.input += delta.input;
    acc.cacheRead += delta.cacheRead;
    acc.cacheWrite += delta.cacheWrite;
    this.byProvider.set(key, acc);
  }

  /** Distinct providers seen this session. */
  providers(): string[] {
    return [...this.byProvider.keys()];
  }

  /** Per-provider cache stats, most-cached first. */
  perProvider(): ProviderCacheEntry[] {
    const out: ProviderCacheEntry[] = [];
    for (const [provider, a] of this.byProvider) {
      out.push({
        provider,
        input: a.input,
        cacheRead: a.cacheRead,
        cacheWrite: a.cacheWrite,
        hitRatio: promptCacheHitRatio({
          input: a.input,
          output: 0,
          cacheRead: a.cacheRead,
          cacheWrite: a.cacheWrite,
        }),
      });
    }
    return out.sort((x, y) => y.cacheRead - x.cacheRead);
  }

  /**
   * Unsubscribe from the event bus and release the per-session listener.
   *
   * **The caller MUST invoke `dispose()` on session teardown** — see the
   * constructor's lifecycle warning. Failure to call this method leaves a
   * permanent `token.accounted` listener on the shared EventBus that
   * accumulates unboundedly across session restarts/resumes.
   */
  dispose(): void {
    this.off();
  }
}
