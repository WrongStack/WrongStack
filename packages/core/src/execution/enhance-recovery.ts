/**
 * Shared recovery policy for prompt refinement ("enhance") across every
 * surface — TUI, CLI-hosted WebUI, and the standalone WebUI server. Keeping the
 * timeout escalation and fallback-model resolution here means all three surfaces
 * apply the SAME rule: a slow first attempt (a `timeout` failure) is retried
 * once with a longer window before the user is asked, and the one-key "retry
 * with another model" offer resolves to the same model everywhere.
 *
 * Pure + framework-free so it can be unit-tested in isolation and imported by
 * both the React TUI and the Node WebSocket servers.
 */

import {
  effectiveFallbackChain,
  normalizeModelRef,
  parseModelRef,
} from '../core/fallback-model.js';
import type { Config } from '../types/config.js';

/** Default first-attempt refine window (mirrors `enhanceUserPrompt`'s default). */
export const ENHANCE_BASE_TIMEOUT_MS = 90_000;

/** Floor for a retry window — a retry only helps if it's meaningfully longer. */
export const ENHANCE_MIN_RETRY_TIMEOUT_MS = 180_000;

/**
 * Timeout to use for a retry after a first attempt timed out. Prefers an
 * explicit `enhanceRetryTimeoutMs` config override; otherwise doubles the base
 * window, floored at {@link ENHANCE_MIN_RETRY_TIMEOUT_MS} so the "extra time"
 * is always a real increase over the (already generous) default.
 */
export function nextEnhanceTimeout(
  baseMs: number,
  config?: { enhanceRetryTimeoutMs?: number | undefined } | undefined,
): number {
  const configured = config?.enhanceRetryTimeoutMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    // Never let an override shorten the window below the base attempt.
    return Math.max(configured, baseMs);
  }
  return Math.max(baseMs * 2, ENHANCE_MIN_RETRY_TIMEOUT_MS);
}

/**
 * The `provider/model` ref offered as the one-key "retry with another model"
 * action on a refine failure, or `undefined` when nothing usable is available.
 * Prefers an explicit `enhanceFallbackModel`; otherwise reuses the first entry
 * of the agent's existing effective fallback chain (so a user who already
 * configured `fallbackModels` / has a smart-default chain gets a sensible
 * offer with zero extra config). Always normalized to `provider/model`.
 */
export function resolveEnhanceFallbackRef(config: Config): string | undefined {
  // The active model just failed, so it must never be offered as its own
  // fallback — normalize both sides and compare.
  const current = config.provider
    ? normalizeModelRef(`${config.provider}/${config.model ?? ''}`, config.provider)
    : undefined;
  const usable = (ref: string): string | undefined => {
    if (!parseModelRef(ref).model) return undefined;
    const normalized = normalizeModelRef(ref, config.provider);
    return normalized === current ? undefined : normalized;
  };

  const explicit = config.autonomy?.enhanceFallbackModel?.trim();
  if (explicit) {
    const usableExplicit = usable(explicit);
    if (usableExplicit) return usableExplicit;
    // An explicit ref equal to the active model falls through to the chain
    // rather than offering the model that just failed.
  }
  for (const ref of effectiveFallbackChain(config)) {
    const usableRef = usable(ref);
    if (usableRef) return usableRef;
  }
  return undefined;
}
