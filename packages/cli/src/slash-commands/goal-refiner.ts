import type { Provider, Usage } from '@wrongstack/contracts/types';
import type { OneShotOrchestrator } from '@wrongstack/core/execution';
import {
  buildGoalRefinementPrompt,
  parseGoalRefinement,
  type RefinedMission,
  refineGoalHeuristic,
  refineGoalWithProvider,
} from '@wrongstack/goal';

export { refineGoalHeuristic, resolveRefinerTarget } from '@wrongstack/goal';

/**
 * Result of refining a user's raw goal into a clear, actionable mission.
 */
type RefinedGoal = RefinedMission;

/**
 * Options for goal refinement with fallback tiers.
 */
interface GoalRefinerOptions {
  /** Primary provider (usually the session's main LLM). */
  primaryProvider?: Provider | undefined;
  /** Primary model on the primary provider. */
  primaryModel?: string | undefined;
  /**
   * Optional dedicated refiner provider instance (e.g. a cheap/fast
   * provider for refinement). Tried before the primary when set.
   */
  refinerProvider?: Provider | undefined;
  /** Model on the refiner provider. Ignored when `refinerProvider` is unset. */
  refinerModel?: string | undefined;
  /**
   * OneShotOrchestrator for LLM refinement. When set, uses it instead
   * of direct provider.complete() for the LLM call, gaining fallback
   * chain support and cheap-model defaulting.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
  /** Token-usage hook: fired by the serving tier with the reported usage. */
  onUsage?: ((usage: Usage, source: { providerId: string; model: string }) => void) | undefined;
}

/**
 * Refine a raw goal using the best available model/provider, with a
 * four-tier fallback chain:
 *   1. Dedicated refiner provider + refiner model (if both configured)
 *   2. Dedicated refiner model on the primary provider (if model but no provider)
 *   3. Primary provider + primary model (session default)
 *   4. Heuristic (regex-based extraction, no LLM call)
 *
 * Each tier falls through to the next on any failure (timeout, error,
 * parse failure, null result).
 */
export async function refineGoalWithFallback(
  rawGoal: string,
  opts: GoalRefinerOptions,
): Promise<RefinedGoal> {
  // Tier 1: dedicated refiner provider + model
  if (opts.refinerProvider && opts.refinerModel) {
    const result = await refineGoal(
      rawGoal,
      opts.refinerProvider,
      opts.refinerModel,
      undefined,
      opts.onUsage,
    );
    if (result) return result;
  }

  // Tier 2: refiner model on primary provider
  if (opts.refinerModel && opts.primaryProvider) {
    const result = await refineGoal(
      rawGoal,
      opts.primaryProvider,
      opts.refinerModel,
      undefined,
      opts.onUsage,
    );
    if (result) return result;
  }

  // Tier 3: primary provider + model
  if (opts.primaryProvider && opts.primaryModel) {
    const result = await refineGoal(
      rawGoal,
      opts.primaryProvider,
      opts.primaryModel,
      undefined,
      opts.onUsage,
    );
    if (result) return result;
  }

  // Tier 4: heuristic
  return refineGoalHeuristic(rawGoal);
}

/**
 * Prompt the LLM to refine a raw user goal into a concrete mission
 * with unambiguous deliverables. Returns null if no LLM is available
 * or the call fails.
 */
export async function refineGoal(
  rawGoal: string,
  provider: Provider,
  model: string,
  oneShotOrchestrator?: OneShotOrchestrator | undefined,
  onUsage?: ((usage: Usage, source: { providerId: string; model: string }) => void) | undefined,
): Promise<RefinedGoal | null> {
  try {
    if (oneShotOrchestrator) {
      const result = await oneShotOrchestrator.call({
        system: buildGoalRefinementPrompt(rawGoal),
        userPrompt: 'Produce the refined goal.',
        timeoutMs: 30_000,
      });
      if (result.error) return null;
      if (result.tokens) {
        try {
          onUsage?.(
            { input: result.tokens.input, output: result.tokens.output },
            { providerId: result.provider, model: result.model },
          );
        } catch {
          // Swallowed by design: the observer is telemetry, not control flow.
        }
      }
      return result.text ? parseGoalRefinement(result.text, rawGoal) : null;
    }
    return refineGoalWithProvider(rawGoal, provider, model, { onUsage });
  } catch {
    return null;
  }
}
