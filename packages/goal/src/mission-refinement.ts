import type { Config } from '@wrongstack/contracts/types/config/root';
import type { Provider, Usage } from '@wrongstack/contracts/types/provider';
import type { EnhanceFailureKind } from '@wrongstack/core/execution';
import { resolveRefinerTargetSpecs } from '@wrongstack/core/execution';
import { toErrorMessage } from '@wrongstack/core/utils';
import { readBundledInstructionText, renderInstructionTemplate } from '@wrongstack/core/utils';

export interface RefinedMission {
  refinedGoal: string;
  deliverables: string[];
}

export interface MissionRefinerTarget {
  provider: Provider;
  model: string;
}

/**
 * Resolve the configured refiner profile/model against available providers.
 * Delegates the config decision to the shared `resolveRefinerTargetSpec`, so
 * goal refinement applies the SAME precedence (named refiner fallback profile
 * over explicit provider/model) as prompt refinement. There is deliberately
 * no `favoriteModels` gate here: the old gate silently made a configured
 * refiner inert for goal refinement whenever the model was neither favorited
 * nor active, while prompt refinement honored the same configuration — the
 * divergence the shared spec resolver removes.
 */
export function resolveRefinerTarget(
  cfg: Config,
  createProvider: ((providerId: string) => Provider | undefined) | undefined,
  activeProviderId: string,
  activeModel: string,
): MissionRefinerTarget | undefined {
  if (!createProvider) return undefined;
  // Scan the ordered candidates, skipping entries whose provider cannot be
  // built (a broken early profile entry must not disable a valid later one).
  for (const spec of resolveRefinerTargetSpecs(cfg)) {
    const provider = createProvider(spec.providerId ?? activeProviderId);
    if (!provider) continue;
    return { provider, model: spec.model ?? activeModel };
  }
  return undefined;
}

/** Prompt and parser shared by terminal and browser mission entry points. */
export function buildGoalRefinementPrompt(rawGoal: string): string {
  return renderInstructionTemplate(readBundledInstructionText('cli/goal-refiner.md'), { rawGoal });
}

export function parseGoalRefinement(text: string, fallbackGoal: string): RefinedMission | null {
  const refinedMatch = text.match(/REFINED_GOAL:\s*\n?([\s\S]*?)(?=\nDELIVERABLES:|$)/i);
  const deliverablesMatch = text.match(/DELIVERABLES:\s*\n([\s\S]*?)$/i);
  if (!refinedMatch && !deliverablesMatch) return null;
  const refinedGoal = refinedMatch?.[1]?.trim() || fallbackGoal;
  const deliverables = (deliverablesMatch?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^[\s-]*[-*]\s*/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('REFINED_GOAL'));
  return {
    refinedGoal,
    deliverables:
      deliverables.length > 0 ? deliverables : refineGoalHeuristic(refinedGoal).deliverables,
  };
}

/** Optional behavior for {@link refineGoalWithProvider}; every field is optional. */
export interface RefineGoalProviderOptions {
  /**
   * Parent abort signal (user cancel / shutdown). A cancelled call returns
   * null SILENTLY — no `onError` — matching `enhanceUserPrompt`'s contract.
   */
  signal?: AbortSignal | undefined;
  /** Hard cap on the refiner call. Default 30_000 (the historical value). */
  timeoutMs?: number | undefined;
  /**
   * Called with a short reason and a machine-readable `kind` when the call
   * fails: `timeout` (deadline hit), `empty` (no text, or text without the
   * REFINED_GOAL/DELIVERABLES markers), or `provider_error`. NOT called when
   * the caller cancels via `signal`.
   */
  onError?: ((reason: string, kind?: EnhanceFailureKind) => void) | undefined;
  /**
   * Called once per completed provider call with the reported token usage —
   * mission refinement runs OUTSIDE the agent loop, so this is the only way
   * its spend reaches a host's cost pipeline (the same role as
   * `enhanceUserPrompt`'s onUsage). Absent, usage is not reported.
   */
  onUsage?: ((usage: Usage, source: { providerId: string; model: string }) => void) | undefined;
  /**
   * Terminal-disposition telemetry — fired exactly once per call on every
   * path out (success, timeout, provider_error, empty, cancelled). Mirrors
   * `enhanceUserPrompt`'s onOutcome so goal-refinement telemetry aligns
   * with the prompt-refine surface.
   */
  onOutcome?: ((outcome: RefineGoalOutcome) => void) | undefined;
}

/** Terminal disposition of one goal-refinement call — mirrors the
 * prompt-enhancer outcome shape; a goal refine is a single pass. */
export interface RefineGoalOutcome {
  result: 'success' | 'timeout' | 'provider_error' | 'empty' | 'cancelled';
  durationMs: number;
}

/**
 * A bounded, tool-free provider call for mission refinement. Never throws —
 * failures are reported through `opts.onError` using the same
 * `EnhanceFailureKind` taxonomy as prompt refinement, and surface as a `null`
 * result the caller's fallback tier can absorb.
 */
export async function refineGoalWithProvider(
  rawGoal: string,
  provider: Provider,
  model: string,
  opts?: RefineGoalProviderOptions | undefined,
): Promise<RefinedMission | null> {
  // The call gets its own deadline window; the parent signal (if any) cancels
  // immediately regardless of the remaining budget. Mirrors the per-pass
  // timer structure of `enhanceUserPrompt` so both refiners classify
  // timeouts identically.
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new Error('goal refiner timeout')), timeoutMs);
  const signal = opts?.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
  // Observer exceptions must not escape the never-throws contract, nor
  // re-enter the catch block below and double-notify as provider_error.
  const notify = (reason: string, kind?: EnhanceFailureKind): void => {
    try {
      opts?.onError?.(reason, kind);
    } catch {
      // Swallowed by design: the observer is diagnostics, not control flow.
    }
  };
  // Same isolation for the usage observer: a throwing cost-pipeline hook must
  // not discard a successful mission or masquerade as provider_error.
  const reportUsage = (usage: Usage | undefined): void => {
    if (!usage) return;
    try {
      opts?.onUsage?.(usage, { providerId: provider.id, model });
    } catch {
      // Swallowed by design: the observer is telemetry, not control flow.
    }
  };
  const startedAt = Date.now();
  // Terminal-disposition telemetry — fired exactly once, on every path out.
  const reportOutcome = (result: RefineGoalOutcome['result']): void => {
    try {
      opts?.onOutcome?.({ result, durationMs: Date.now() - startedAt });
    } catch {
      // Swallowed by design: the observer is telemetry, not control flow.
    }
  };
  try {
    const response = await provider.complete(
      {
        model,
        system: [{ type: 'text', text: buildGoalRefinementPrompt(rawGoal) }],
        messages: [{ role: 'user', content: 'Produce the refined goal.' }],
      },
      { signal },
    );
    // Burned tokens are real regardless of what happens to the parse or the
    // cancel handling below — report them first (mission refinement runs
    // outside the agent loop; this is its cost-pipeline hook).
    reportUsage(response.usage);
    // An abort may surface as a RESOLVED empty/partial response (SDKs that
    // swallow the rejection). Parent cancel → silent; a fired deadline →
    // `timeout`, identical to the catch-path classification.
    if (timer.signal.aborted) {
      // A fired deadline wins the race against a same-tick parent cancel —
      // the refine WAS too slow, and cost attribution must see the timeout.
      notify(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
      reportOutcome('timeout');
      return null;
    }
    if (opts?.signal?.aborted) {
      reportOutcome('cancelled');
      return null;
    }
    const text = extractRefinementText(response);
    if (!text) {
      notify('refiner returned no text', 'empty');
      reportOutcome('empty');
      return null;
    }
    const mission = parseGoalRefinement(text, rawGoal);
    if (!mission) {
      notify('refiner response was missing REFINED_GOAL/DELIVERABLES sections', 'empty');
      reportOutcome('empty');
      return null;
    }
    reportOutcome('success');
    return mission;
  } catch (err) {
    // Caller-initiated cancel → stay silent (the fallback tier takes over) —
    // but a fired deadline wins the classification race (see above).
    if (timer.signal.aborted) {
      notify(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
      reportOutcome('timeout');
      return null;
    }
    if (opts?.signal?.aborted) {
      reportOutcome('cancelled');
      return null;
    }
    notify(toErrorMessage(err), 'provider_error');
    reportOutcome('provider_error');
    return null;
  } finally {
    timer.abort();
    clearTimeout(timeout);
  }
}

function extractRefinementText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as Record<string, unknown>;
  if (Array.isArray(value.content)) {
    const text = (value.content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    return text || null;
  }
  if (Array.isArray(value.choices)) {
    const choice = value.choices[0] as { message?: { content?: string } } | undefined;
    return choice?.message?.content ?? null;
  }
  return typeof value.text === 'string' ? value.text : null;
}

/** Fallback refinement shared by terminal and browser mission entry points. */
export function refineGoalHeuristic(rawGoal: string): {
  refinedGoal: string;
  deliverables: string[];
} {
  const refinedGoal = rawGoal.trim();
  const deliverables = refinedGoal
    .split(/[.;]\s*/)
    .map((line) => line.trim())
    .filter((line) =>
      /\b(add|build|create|fix|implement|refactor|write|remove|update|migrate|set up|configure|deploy|test|document)\b/i.test(
        line,
      ),
    );
  return {
    refinedGoal,
    deliverables: deliverables.length > 0 ? deliverables : [refinedGoal],
  };
}
