/**
 * useChipStalenessGuard — detects when a statusline chip fails to refresh,
 * diagnoses the root cause, and forces a re-render to recover.
 *
 * Root causes detected:
 * 1. `animation_frozen` — the agent is running/streaming but the spinner
 *    phase hasn't advanced within the expected interval.
 * 2. `data_source_stale` — a chip that should be receiving updates (based
 *    on agent state) hasn't changed its data fingerprint within the
 *    staleness threshold.
 * 3. `subscription_dropped` — the token/cost counter stopped emitting
 *    events while the agent is actively streaming.
 *
 * The hook is intentionally lightweight: it runs a single setInterval at
 * STALENESS_CHECK_INTERVAL_MS and compares lightweight fingerprints
 * (string hashes of key props) against their last-seen values. When
 * staleness is detected, it bumps a counter that the StatusBar uses as a
 * `key` fragment to force a full re-render of the chip rail.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

type ChipStalenessRootCause =
  | 'animation_frozen'
  | 'data_source_stale'
  | 'subscription_dropped';

export interface ChipStalenessDiagnosis {
  /** Which chip category is stale. */
  chip: string;
  /** The diagnosed root cause. */
  rootCause: ChipStalenessRootCause;
  /** How long (ms) since the chip last updated. */
  staleForMs: number;
  /** Timestamp when staleness was first detected. */
  detectedAt: number;
}

interface ChipStalenessGuardState {
  /** Bumped every time a forced re-render is triggered. Use as a key fragment. */
  renderNonce: number;
  /** Current staleness diagnoses (empty = all healthy). */
  diagnoses: ChipStalenessDiagnosis[];
  /** Total number of staleness recoveries since mount. */
  recoveryCount: number;
}

interface UseChipStalenessGuardOptions {
  /** Agent run state — determines which chips SHOULD be updating. */
  agentState: 'idle' | 'running' | 'streaming' | 'aborting';
  /** Current spinner phase index (advances every SPINNER_INTERVAL_MS while active). */
  spinnerPhase: number;
  /** Token usage fingerprint — changes when new token events arrive. */
  tokenFingerprint: string;
  /** Context usage ratio (0..1) — changes as context grows. */
  contextRatio: number | undefined;
  /** Whether the token counter event subscription is active. */
  tokenSubscriptionActive: boolean;
  /**
   * Staleness threshold in ms. If a chip that should be updating hasn't
   * changed within this window, it's flagged. Default: 15_000 (15s).
   */
  stalenessThresholdMs?: number;
  /**
   * Check interval in ms. How often the guard polls for staleness.
   * Default: 10_000 (10s).
   */
  checkIntervalMs?: number;
  /**
   * Maximum recoveries before the guard backs off (prevents infinite
   * re-render loops if the root cause is unfixable). Default: 5.
   */
  maxRecoveries?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_STALENESS_THRESHOLD_MS = 15_000;
const DEFAULT_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_MAX_RECOVERIES = 5;

/**
 * The spinner advances every SPINNER_INTERVAL_MS (1000ms — see
 * status-bar.tsx). If it hasn't advanced within 3× that interval while the
 * agent is active, it's frozen. The threshold MUST stay above the actual
 * spinner interval: an earlier 750ms threshold (based on an assumed 250ms
 * tick) was shorter than one real tick, so every 10s check while streaming
 * diagnosed a healthy spinner as frozen and remounted the whole chip rail —
 * a guaranteed visible flicker, five times per session.
 */
const SPINNER_EXPECTED_INTERVAL_MS = 1_000;
const SPINNER_FROZEN_THRESHOLD_MS = SPINNER_EXPECTED_INTERVAL_MS * 3;

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useChipStalenessGuard(opts: UseChipStalenessGuardOptions): ChipStalenessGuardState {
  const {
    agentState,
    spinnerPhase,
    tokenFingerprint,
    contextRatio,
    tokenSubscriptionActive,
    stalenessThresholdMs = DEFAULT_STALENESS_THRESHOLD_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    maxRecoveries = DEFAULT_MAX_RECOVERIES,
  } = opts;

  const [renderNonce, setRenderNonce] = useState(0);
  const [diagnoses, setDiagnoses] = useState<ChipStalenessDiagnosis[]>([]);
  const recoveryCountRef = useRef(0);
  const [recoveryCount, setRecoveryCount] = useState(0);

  // Track last-seen values and timestamps for staleness detection.
  const lastSpinnerPhaseRef = useRef(spinnerPhase);
  const lastSpinnerChangeAtRef = useRef(Date.now());
  const lastTokenFingerprintRef = useRef(tokenFingerprint);
  const lastTokenChangeAtRef = useRef(Date.now());
  const lastContextRatioRef = useRef(contextRatio);
  const lastContextChangeAtRef = useRef(Date.now());

  // Update last-seen refs when values change.
  useEffect(() => {
    if (spinnerPhase !== lastSpinnerPhaseRef.current) {
      lastSpinnerPhaseRef.current = spinnerPhase;
      lastSpinnerChangeAtRef.current = Date.now();
    }
  }, [spinnerPhase]);

  useEffect(() => {
    if (tokenFingerprint !== lastTokenFingerprintRef.current) {
      lastTokenFingerprintRef.current = tokenFingerprint;
      lastTokenChangeAtRef.current = Date.now();
    }
  }, [tokenFingerprint]);

  useEffect(() => {
    if (contextRatio !== lastContextRatioRef.current) {
      lastContextRatioRef.current = contextRatio;
      lastContextChangeAtRef.current = Date.now();
    }
  }, [contextRatio]);

  // The periodic staleness check.
  const runCheck = useCallback(() => {
    // Back off if we've already recovered too many times.
    if (recoveryCountRef.current >= maxRecoveries) return;

    const now = Date.now();
    const isActive = agentState === 'running' || agentState === 'streaming';
    const newDiagnoses: ChipStalenessDiagnosis[] = [];

    // 1. Animation frozen — spinner should advance while active.
    if (isActive) {
      const spinnerStaleFor = now - lastSpinnerChangeAtRef.current;
      if (spinnerStaleFor > SPINNER_FROZEN_THRESHOLD_MS) {
        newDiagnoses.push({
          chip: 'state',
          rootCause: 'animation_frozen',
          staleForMs: spinnerStaleFor,
          detectedAt: now,
        });
      }
    }

    // 2. Token subscription dropped — should receive events while streaming.
    if (agentState === 'streaming' && tokenSubscriptionActive) {
      const tokenStaleFor = now - lastTokenChangeAtRef.current;
      if (tokenStaleFor > stalenessThresholdMs) {
        newDiagnoses.push({
          chip: 'tokens',
          rootCause: 'subscription_dropped',
          staleForMs: tokenStaleFor,
          detectedAt: now,
        });
      }
    }

    // 3. Data source stale — context ratio should grow while running.
    if (isActive && lastContextRatioRef.current != null) {
      const contextStaleFor = now - lastContextChangeAtRef.current;
      // Only flag if context has been completely static for a long time
      // while the agent is actively working. Use 2× threshold to avoid
      // false positives during short tool calls.
      if (contextStaleFor > stalenessThresholdMs * 2) {
        newDiagnoses.push({
          chip: 'context',
          rootCause: 'data_source_stale',
          staleForMs: contextStaleFor,
          detectedAt: now,
        });
      }
    }

    if (newDiagnoses.length > 0) {
      setDiagnoses(newDiagnoses);
      recoveryCountRef.current += 1;
      setRecoveryCount(recoveryCountRef.current);
      // Force a re-render by bumping the nonce.
      setRenderNonce((n) => n + 1);
    } else {
      // Clear stale diagnoses when everything is healthy.
      setDiagnoses((prev) => (prev.length > 0 ? [] : prev));
    }
  }, [agentState, tokenSubscriptionActive, stalenessThresholdMs, maxRecoveries]);

  useEffect(() => {
    const interval = setInterval(runCheck, checkIntervalMs);
    return () => clearInterval(interval);
  }, [runCheck, checkIntervalMs]);

  return { renderNonce, diagnoses, recoveryCount };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute a lightweight fingerprint string for token usage data.
 * Used to detect when token events stop arriving.
 *
 * Intentionally covers only input, output, and cost — the primary token
 * counters that change on every streaming event. Cache stats (`cacheStats`)
 * are excluded because they update on a different cadence (prompt-cache
 * lookups) and including them would add noise without improving
 * subscription-drop detection.
 */
export function computeTokenFingerprint(
  input: number | undefined,
  output: number | undefined,
  cost: number | undefined,
): string {
  return `${input ?? 0}:${output ?? 0}:${cost != null ? cost.toFixed(4) : '0'}`;
}

/**
 * Format a staleness diagnosis into a human-readable debug string.
 * Useful for the /statusline detail panel or debug logging.
 */
export function formatDiagnosis(d: ChipStalenessDiagnosis): string {
  const secs = Math.round(d.staleForMs / 1000);
  const causeLabel: Record<ChipStalenessRootCause, string> = {
    animation_frozen: 'animation timer stopped',
    data_source_stale: 'data source not emitting',
    subscription_dropped: 'event subscription dropped',
  };
  return `[${d.chip}] stale ${secs}s — ${causeLabel[d.rootCause]}`;
}
