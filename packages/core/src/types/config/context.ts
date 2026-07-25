import type { ContextWindowModeId } from '../context-window.js';

export interface ContextConfig {
  /** Context-window policy mode. Controls compaction thresholds and preservation depth. */
  mode?: ContextWindowModeId | undefined;
  warnThreshold: number;
  softThreshold: number;
  hardThreshold: number;
  /** Enable automatic compaction when thresholds are crossed (default: true). */
  autoCompact?: boolean | undefined;
  /**
   * Model used for LLM-assisted summarization in IntelligentCompactor.
   * Falls back to the main model when omitted.
   */
  summarizerModel?: string | undefined;
  /**
   * Override the effective context window size (in tokens). Use this when
   * you want the compactor to trigger earlier than the provider's actual
   * maxContext. Defaults to the provider's reported maxContext.
   */
  effectiveMaxContext?: number | undefined;
  maxSessionTokens?: number | undefined;
  maxDailyTokens?: number | undefined;
  preserveK: number;
  eliseThreshold: number;
  /** Compactor strategy: 'hybrid' (default, fast rules), 'intelligent' (LLM summarization), 'selective' (LLM-driven selection). */
  strategy?: 'hybrid' | 'intelligent' | 'selective' | undefined;
  /** Enable LLM-driven selective compaction (default: false for backward compat). */
  llmSelector?: boolean | undefined;
}

/**
 * Runtime configuration for the process circuit breaker (the one owned by the
 * ProcessRegistry that gates `bash`/`exec`). Toggle via `/settings breaker`.
 *
 * The breaker itself is a low-level primitive (`packages/tools/.../circuit-breaker.ts`)
 * that is on by default; this section controls whether the registry actually
 * participates in it and how it auto-recovers.
 */
export interface CircuitBreakerRuntimeConfig {
  /**
   * Enable circuit-breaker protection. When false (the default), the breaker
   * is bypassed — `bash`/`exec` calls always proceed regardless of failure
   * history. When true, the breaker trips on repeated failures / slow calls /
   * bursts and blocks further calls until it recovers.
   */
  enabled?: boolean | undefined;
  /**
   * When the breaker trips, automatically kill all tracked processes AND
   * reset the breaker to closed after this delay (ms). 0 = disabled (manual
   * recovery only via `/kill reset`). Only effective when `enabled` is true.
   * While armed, the statusline shows a live countdown to the kill/reset.
   */
  autoKillResetMs?: number | undefined;
}

/**
 * Adaptive concurrency controller configuration. When enabled, the controller
 * automatically adjusts `maxConcurrent` based on rate-limit (429) errors:
 * - On 429: halves `maxConcurrent` (floor at 1)
 * - On sustained success (no 429 for `recoveryIntervalMs`): increases `maxConcurrent` by 1
 */
export interface AdaptiveConcurrencyConfig {
  /** Enable adaptive concurrency. Default: false (disabled). */
  enabled?: boolean | undefined;
  /**
   * Minimum concurrency floor. The controller never drops below this.
   * Default: 1.
   */
  minConcurrent?: number | undefined;
  /**
   * Maximum concurrency ceiling. The controller never exceeds this.
   * Default: 16 (matches MultiAgentCoordinator default).
   */
  maxConcurrent?: number | undefined;
  /**
   * Multiplicative decrease factor when a 429 is hit.
   * `newConcurrency = floor(currentConcurrency * decreaseFactor)`.
   * Default: 0.5 (halves concurrency).
   */
  decreaseFactor?: number | undefined;
  /**
   * Number of consecutive successful requests before increasing concurrency by 1.
   * Default: 10.
   */
  successThreshold?: number | undefined;
  /**
   * How often (ms) to check for recovery and bump concurrency.
   * Default: 30_000 (30 seconds).
   */
  recoveryIntervalMs?: number | undefined;
}
