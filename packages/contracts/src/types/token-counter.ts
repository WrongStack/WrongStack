import type { Usage } from './provider.js';

export interface ProviderCacheStats {
  provider: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead / complete prompt context for this provider. Clamped to [0, 1]. */
  hitRatio: number;
  /**
   * Tokens written into the cache by this provider, split by TTL when the
   * upstream exposes the breakdown. Anthropic-family providers (incl.
   * MiniMax on the Anthropic surface) emit `cache_creation` with a 5-min
   * and a 1-hour sub-bucket; OpenAI-family gateways emit a single
   * aggregate and leave these undefined.
   */
  cacheWrite5m?: number | undefined;
  cacheWrite1h?: number | undefined;
}

export interface LastRequestCacheStats {
  /** Uncached prompt tokens of that request. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead / that request's complete prompt. Clamped to [0, 1]. */
  hitRatio: number;
}

export interface CacheStats {
  /** Tokens served from cache (cheaper). */
  readTokens: number;
  /** Tokens written into the cache (more expensive than input on first hit). */
  writeTokens: number;
  /**
   * 5-minute cache-write tokens for providers that expose the TTL split
   * (Anthropic family). Undefined when the provider only emits an aggregate.
   */
  cacheWrite5m?: number | undefined;
  /**
   * 1-hour cache-write tokens for providers that expose the TTL split
   * (Anthropic family). Undefined when the provider only emits an aggregate.
   */
  cacheWrite1h?: number | undefined;
  /**
   * SESSION-CUMULATIVE hit ratio: cacheRead / total prompt context, summed over
   * every request. It carries the unavoidable cold first request forever, so it
   * reads low early and lags any change — use `last` for "is the cache working
   * right now". Clamped to [0, 1].
   */
  hitRatio: number;
  /**
   * The most recent provider-reported request on its own. Undefined until the
   * first response. `/compact`'s token estimate never lands here.
   */
  last?: LastRequestCacheStats | undefined;
  /**
   * USD saved by cache reads: cacheRead tokens billed at the cache-read rate
   * instead of the full input rate, summed across the session. 0 when pricing
   * is unknown or nothing was cached. Cache-write premiums are NOT subtracted —
   * this is the gross read discount, the figure users recognize as "saved".
   */
  savedUsd: number;
  /** Session totals split by routed provider, most cache-read tokens first. */
  providers?: ProviderCacheStats[] | undefined;
}

export interface TokenCounter {
  account(usage: Usage, model?: string, providerId?: string): void | undefined;
  /** Optional live session binding used by token.accounted events. */
  setSessionId?(sessionId: string | (() => string | undefined) | undefined): void;
  /**
   * Disjoint token counts from the most recently-accounted request. Sum
   * input + cacheRead + cacheWrite for per-request context pressure tracking
   * (e.g. status bar ctx bar) — tokenCounter.total() is cumulative across all
   * requests and cannot be compared meaningfully against a per-request
   * maxContext ceiling.
   */
  currentRequestTokens(): { input: number; cacheRead: number; cacheWrite: number };
  /**
   * Override the last-request token snapshot. Used by slash commands like
   * /compact that modify ctx.messages without making an API request —
   * after calling this, the TUI/REPL context bar reflects the new size.
   */
  setCurrentRequestTokens(input: number, cacheRead?: number, cacheWrite?: number): void;
  total(): Usage;
  estimateCost(): { input: number; output: number; total: number; currency: 'USD' };
  cacheStats(): CacheStats;
  reset(): void;
}
