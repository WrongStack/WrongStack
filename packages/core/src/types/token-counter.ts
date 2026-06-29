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
  /** Optional live session binding used by token.accounted events. */
  setSessionId?(sessionId: string | (() => string | undefined) | undefined): void;
  /**
   * Tokens from the most recently-accounted request (input + cacheRead).
   * Use this for per-request context pressure tracking (e.g. status bar
   * ctx bar) — tokenCounter.total() is cumulative across all requests
   * and cannot be compared meaningfully against a per-request maxContext
   * ceiling.
   */
  currentRequestTokens(): { input: number; cacheRead: number };
  total(): Usage;
  estimateCost(): { input: number; output: number; total: number; currency: 'USD' };
  cacheStats(): CacheStats;
  reset(): void;
}
