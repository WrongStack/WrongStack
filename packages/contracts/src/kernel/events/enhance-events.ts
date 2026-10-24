import type { Usage } from '../../types/provider.js';

/** A completed refiner pass whose token usage was reported. */
export interface EnhanceUsageEvent {
  providerId: string;
  model: string;
  usage: Usage;
  /** 1 = initial pass, 2 = the single corrective pass. */
  pass: number;
  kind: 'initial' | 'corrective';
}

/** How a refine call ended. Mirrors `EnhanceOutcome` from execution. */
export interface EnhanceOutcomeEvent {
  providerId?: string | undefined;
  model?: string | undefined;
  /** Failure reason text (goal-path enrichment; absent on success). */
  reason?: string | undefined;
  /**
   * Refiner failure kind — `'timeout' | 'empty' | 'provider_error'` — when
   * the result is a failure (goal-path enrichment).
   */
  failureKind?: string | undefined;
  result: 'success' | 'timeout' | 'provider_error' | 'empty' | 'cancelled';
  /** Total refiner passes (1 = clean; 2 = corrective pass used). */
  passes: number;
  /** Responses that failed the bilingual contract and required a corrective pass. */
  parseRejections: number;
  durationMs: number;
}

/**
 * Events for prompt refinement ("enhance"). The refiner runs OUTSIDE the
 * agent loop, so its token spend never flows through the normal response
 * pipeline — `enhance.usage` is the hook every cost consumer uses, and
 * `enhance.outcome` carries attempts, parse rejections, and corrective-pass
 * counts for metrics.
 */
export interface EnhanceEventMap {
  'enhance.usage': EnhanceUsageEvent;
  'enhance.outcome': EnhanceOutcomeEvent;
}
