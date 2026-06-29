import type { Usage } from './provider.js';

export interface CacheStats {
  /** Tokens served from cache (cheaper). */
  readTokens: number;
  /** Tokens written into the cache (more expensive than input on first hit). */
  writeTokens: number;
  /** Hit ratio: cacheRead / (cacheRead + input). 0 when nothing cached. */
  hitRatio: number;
}

export interface TokenCounter {
  account(usage: Usage, model?: string): void | undefined;
  /**
   * Tokens from the most recently-accounted request (input + cacheRead).
   * Use this for per-request context pressure tracking (e.g. status bar
   * ctx bar) — tokenCounter.total() is cumulative across all requests
   * and cannot be compared meaningfully against a per-request maxContext
   * ceiling.
   */
  currentRequestTokens(): { input: number; cacheRead: number };
  /**
   * Override the last-request token snapshot. Used by slash commands like
   * /compact that modify ctx.messages without making an API request —
   * after calling this, the TUI/REPL context bar reflects the new size.
   */
  setCurrentRequestTokens(input: number, cacheRead?: number): void;
  total(): Usage;
  estimateCost(): { input: number; output: number; total: number; currency: 'USD' };
  cacheStats(): CacheStats;
  reset(): void;
}
