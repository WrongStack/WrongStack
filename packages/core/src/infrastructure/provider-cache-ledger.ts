import type { EventBus } from '../kernel/events.js';
import { promptCacheHitRatio, type Usage } from '../types/provider.js';

export interface ProviderCacheEntry {
  provider: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead / total prompt context, over the WHOLE session; clamped to [0, 1]. */
  hitRatio: number;
  /**
   * Same ratio for the MOST RECENT request only.
   *
   * The session figure permanently includes the first turn, which can never hit
   * (nothing is cached yet), so a perfectly healthy session still reads low
   * early on and climbs for a long time. That made the cumulative number
   * useless for the question people actually ask — "is caching working *now*,
   * as the context grows?" — and easy to misread as a cache failure. The
   * per-request ratio answers it directly; the two together also show the
   * trend, which is the real diagnosis: a healthy Responses-wire session
   * climbs as the conversation grows, because the cacheable prefix is the
   * conversation. Falling or flat means something is invalidating the prefix.
   */
  lastHitRatio?: number | undefined;
  /** Prompt tokens in the most recent request, for context on `lastHitRatio`. */
  lastPromptTokens?: number | undefined;
  /**
   * The most recent per-request ratios, oldest first (at most
   * {@link RECENT_HIT_RATIO_WINDOW}).
   *
   * A single number cannot answer the question that actually diagnoses a cache
   * — "is it climbing?". On wires whose cacheable prefix IS the conversation,
   * a healthy session's per-request ratio rises as the history grows, because
   * the constant part (the new turn plus the re-sent live-context tail) is
   * amortised over more cached prefix. Flat or falling means something near the
   * front of the prefix is changing every turn, or the backend's entry keeps
   * expiring between turns. Neither is visible in the cumulative figure, which
   * carries the unavoidable first-turn miss forever.
   */
  recentHitRatios?: number[] | undefined;
}

/** How many per-request ratios to retain for the trend. */
export const RECENT_HIT_RATIO_WINDOW = 6;

interface Accum {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The most recent request's own contribution, kept for `lastHitRatio`. */
interface LastRequest {
  cacheRead: number;
  prompt: number;
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
  private readonly lastByProvider = new Map<string, LastRequest>();
  private readonly recentByProvider = new Map<string, number[]>();
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
    // A zero-token delta is a duplicate or out-of-order settle, not a request:
    // recording it would report a 0% "last turn" that never happened.
    const prompt = delta.input + delta.cacheRead + delta.cacheWrite;
    if (prompt > 0) {
      this.lastByProvider.set(key, { cacheRead: delta.cacheRead, prompt });
      const recent = this.recentByProvider.get(key) ?? [];
      recent.push(Math.min(1, delta.cacheRead / prompt));
      if (recent.length > RECENT_HIT_RATIO_WINDOW) recent.shift();
      this.recentByProvider.set(key, recent);
    }
  }

  /** Distinct providers seen this session. */
  providers(): string[] {
    return [...this.byProvider.keys()];
  }

  /** Per-provider cache stats, most-cached first. */
  perProvider(): ProviderCacheEntry[] {
    const out: ProviderCacheEntry[] = [];
    for (const [provider, a] of this.byProvider) {
      const last = this.lastByProvider.get(provider);
      const recent = this.recentByProvider.get(provider);
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
        ...(last
          ? {
              lastHitRatio: Math.min(1, last.cacheRead / last.prompt),
              lastPromptTokens: last.prompt,
            }
          : {}),
        ...(recent && recent.length > 0 ? { recentHitRatios: [...recent] } : {}),
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
