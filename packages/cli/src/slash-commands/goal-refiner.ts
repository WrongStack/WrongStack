import {
  readBundledInstructionText,
  renderInstructionTemplate,
  type Config,
  type OneShotOrchestrator,
  type Provider,
} from '@wrongstack/core';

/**
 * Result of refining a user's raw goal into a clear, actionable mission.
 */
export interface RefinedGoal {
  /** Unambiguous, detailed goal statement. */
  refinedGoal: string;
  /** Concrete, verifiable deliverables (one per entry). */
  deliverables: string[];
}

/**
 * Options for goal refinement with fallback tiers.
 */
export interface GoalRefinerOptions {
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
}

// ---------------------------------------------------------------------------
// Built-in provider/model selection for the goal refiner
// ---------------------------------------------------------------------------

/**
 * Resolved refiner target after validating against available providers,
 * favorite models, and the currently active session model.
 * Both `provider` and `model` are defined when a viable dedicated refiner
 * is found; otherwise the caller should use the primary session defaults.
 */
export interface ResolvedRefinerTarget {
  /** Resolved provider instance, ready for `provider.complete()`. */
  provider: Provider;
  /** Resolved model id on that provider. */
  model: string;
}

/**
 * Validate and resolve a dedicated refiner provider+model from the user
 * config. Returns undefined when:
 *   - refinerFallbackProfile resolves to a valid profile entry (tried first)
 *   - Neither refinerProvider nor refinerModel is configured
 *   - The configured provider is unavailable (createProvider returns
 *     undefined, meaning the provider doesn't exist or has no credentials)
 *   - The configured model is not a favorite model AND is not the
 *     currently active session model
 *
 * Precedence (first wins):
 *   1. refinerFallbackProfile → first valid entry from the named profile chain
 *   2. refinerProvider + refinerModel  (both set)
 *   3. refinerModel on the active session provider
 *
 * When only `refinerModel` is set (no provider), the model is used on
 * the active session provider — validated against the same constraints.
 *
 * @param cfg          — live Config from configStore
 * @param createProvider— factory: providerId → Provider | undefined
 * @param activeProviderId — the session's active provider id (config.provider)
 * @param activeModel  — the session's active model (config.model)
 */
export function resolveRefinerTarget(
  cfg: Config,
  createProvider: ((providerId: string) => Provider | undefined) | undefined,
  activeProviderId: string,
  activeModel: string,
): ResolvedRefinerTarget | undefined {
  // ── Tier 1: fallback profile ──
  const refinerFallback = cfg.autonomy?.refinerFallbackProfile;
  if (refinerFallback) {
    const profileChain = cfg.fallbackProfiles?.[refinerFallback];
    if (profileChain?.[0]) {
      const resolved = resolveProfileEntry(profileChain[0], cfg, createProvider, activeProviderId, activeModel);
      if (resolved) return resolved;
    }
  }

  const refinerProviderId = cfg.autonomy?.refinerProvider;
  const refinerModel = cfg.autonomy?.refinerModel;
  if (!refinerProviderId && !refinerModel) return undefined;

  // ── Validate model ──
  // The model must be either a favorite or the active session model.
  // When neither constraint is satisfied the config is likely stale or
  // a typo — skip the dedicated refiner and fall through to the primary.
  const model = refinerModel ?? activeModel;
  const favorites = cfg.favoriteModels ?? [];
  const isFavorite = favorites.length === 0 || favorites.includes(model);
  const isActive = model === activeModel;
  if (!isFavorite && !isActive) return undefined;

  // ── Validate / resolve provider ──
  const targetProviderId = refinerProviderId ?? activeProviderId;
  if (!createProvider) return undefined;
  const provider = createProvider(targetProviderId);
  if (!provider) return undefined;

  return { provider, model };
}

/**
 * Resolve a single fallback-profile entry (a string like "provider/model"
 * or bare "model") into a valid provider+model pair.
 * Returns undefined when the entry cannot be resolved.
 */
function resolveProfileEntry(
  entry: string,
  cfg: Config,
  createProvider: ((providerId: string) => Provider | undefined) | undefined,
  activeProviderId: string,
  activeModel: string,
): ResolvedRefinerTarget | undefined {
  if (!entry || !createProvider) return undefined;
  const slash = entry.indexOf('/');
  let providerId: string;
  let modelId: string;
  if (slash > 0) {
    providerId = entry.slice(0, slash);
    modelId = entry.slice(slash + 1);
  } else {
    providerId = activeProviderId;
    modelId = entry;
  }
  // Validate model against favorites
  const favorites = cfg.favoriteModels ?? [];
  const isFavorite = favorites.length === 0 || favorites.includes(modelId);
  const isActive = modelId === activeModel;
  if (!isFavorite && !isActive) return undefined;
  const provider = createProvider(providerId);
  if (!provider) return undefined;
  return { provider, model: modelId };
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
    const result = await refineGoal(rawGoal, opts.refinerProvider, opts.refinerModel);
    if (result) return result;
  }

  // Tier 2: refiner model on primary provider
  if (opts.refinerModel && opts.primaryProvider) {
    const result = await refineGoal(rawGoal, opts.primaryProvider, opts.refinerModel);
    if (result) return result;
  }

  // Tier 3: primary provider + model
  if (opts.primaryProvider && opts.primaryModel) {
    const result = await refineGoal(rawGoal, opts.primaryProvider, opts.primaryModel);
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
): Promise<RefinedGoal | null> {
  const prompt = buildRefinementPrompt(rawGoal);

  try {
    let raw: string;
    if (oneShotOrchestrator) {
      const result = await oneShotOrchestrator.call({
        system: prompt,
        userPrompt: 'Produce the refined goal.',
        model: 'deepseek-chat',
        maxTokens: 1000,
        timeoutMs: 30_000,
      });
      if (result.error) return null;
      raw = result.text;
    } else {
      const signal = AbortSignal.timeout(30_000);
      const response = await provider.complete(
        {
          model,
          system: [{ type: 'text', text: prompt }],
          messages: [{ role: 'user', content: 'Produce the refined goal.' }],
          maxTokens: 1000,
        },
        { signal },
      );
      raw = extractText(response) ?? '';
    }

    if (!raw) return null;
    return parseRefinement(raw, rawGoal);
  } catch {
    return null;
  }
}

/** Build the refinement prompt. */
function buildRefinementPrompt(rawGoal: string): string {
  return renderInstructionTemplate(readBundledInstructionText('cli/goal-refiner.md'), {
    rawGoal,
  });
}

/** Extract text content from a provider result. */
function extractText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;

  // Anthropic-style: { content: [{ type: 'text', text: '...' }] }
  if (Array.isArray(r.content)) {
    const texts = (r.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
    return texts.join('') || null;
  }

  // OpenAI-style: { choices: [{ message: { content: '...' } }] }
  if (Array.isArray(r.choices)) {
    const choice = r.choices[0] as { message?: { content?: string } } | undefined;
    return choice?.message?.content ?? null;
  }

  // Direct text field
  if (typeof r.text === 'string') return r.text;

  return null;
}

/** Parse the LLM response into a RefinedGoal. */
function parseRefinement(text: string, fallbackGoal: string): RefinedGoal {
  const refinedMatch = text.match(/REFINED_GOAL:\s*\n?([\s\S]*?)(?=\nDELIVERABLES:|$)/i);
  const refinedGoal = refinedMatch?.[1]?.trim() || fallbackGoal;

  const deliverablesMatch = text.match(/DELIVERABLES:\s*\n([\s\S]*?)$/i);
  const deliverablesRaw = deliverablesMatch?.[1] ?? '';

  const deliverables = deliverablesRaw
    .split('\n')
    .map((line) => line.replace(/^[\s-]*[-*]\s*/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('REFINED_GOAL'));

  return {
    refinedGoal,
    deliverables: deliverables.length > 0 ? deliverables : [],
  };
}

/**
 * Heuristic-only refinement — used when no LLM is available.
 * Produces a basic structure from the raw goal.
 */
export function refineGoalHeuristic(rawGoal: string): RefinedGoal {
  const trimmed = rawGoal.trim();
  return {
    refinedGoal: trimmed,
    deliverables: extractHeuristicDeliverables(trimmed),
  };
}

/** Extract deliverable-like phrases from the raw goal text. */
function extractHeuristicDeliverables(goal: string): string[] {
  const deliverables: string[] = [];

  // Look for numbered lists, bullet points, or sentences that describe actions
  const lines = goal.split(/[.;]\s*/);
  for (const line of lines) {
    const cleaned = line.trim();
    if (!cleaned) continue;

    // Detect action-oriented phrases
    if (
      /\b(add|build|create|fix|implement|refactor|write|remove|update|migrate|set up|configure|deploy|test|document)\b/i.test(
        cleaned,
      )
    ) {
      deliverables.push(cleaned);
    }
  }

  // If nothing detected, treat the whole goal as one deliverable
  if (deliverables.length === 0) {
    deliverables.push(goal.trim());
  }

  return deliverables;
}
