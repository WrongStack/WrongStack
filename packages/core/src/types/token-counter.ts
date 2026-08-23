import type { Usage } from './provider.js';

export interface CacheStats {
  /** Tokens served from cache (cheaper). */
  readTokens: number;
  /** Tokens written into the cache (more expensive than input on first hit). */
  writeTokens: number;
  /** Hit ratio: cacheRead / total prompt context. Clamped to [0, 1]. */
  hitRatio: number;
  /**
   * USD saved by cache reads: cacheRead tokens billed at the cache-read rate
   * instead of the full input rate, summed across the session. 0 when pricing
   * is unknown or nothing was cached. Cache-write premiums are NOT subtracted —
   * this is the gross read discount, the figure users recognize as "saved".
   */
  savedUsd: number;
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
