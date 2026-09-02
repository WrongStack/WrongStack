import { fallbackProfileChain, parseModelRef } from '@wrongstack/core/agent';
import { resolveTier } from '@wrongstack/core/coordination';
import type { Config } from '@wrongstack/core/types';

interface KanbanDispatchRouteInput {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  fallbackProfile?: string | undefined;
  /**
   * Named cost level for this task. A board stores the INTENT ("run this
   * cheaply") rather than a model id, so a task queued last week still routes
   * correctly after the tier config changes.
   */
  tier?: string | undefined;
  /** Roster role, used to route through the tier table when no tier is named. */
  role?: string | undefined;
}

interface KanbanDispatchRoute {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** The tier that actually resolved, for the run record and the board UI. */
  tier?: string | undefined;
}

/**
 * Resolve a Kanban task's execution route into a concrete provider/model plus
 * failover chain.
 *
 * Precedence, most to least specific:
 *   1. an explicit provider/model pinned on the task,
 *   2. a named fallback profile (chain[0] becomes the primary),
 *   3. a named tier (or the tier routing table, when a role is known),
 *   4. the session leader's model (everything left undefined).
 *
 * The tier step sits BELOW an explicit profile on purpose: a board that already
 * names a chain has made the more specific statement, and a tier must not
 * quietly overrule it.
 */
export function resolveKanbanDispatchRoute(
  config: Config,
  spawnOpts?: KanbanDispatchRouteInput | undefined,
): KanbanDispatchRoute {
  let provider = spawnOpts?.provider;
  let model = spawnOpts?.model;
  let fallbackModels = spawnOpts?.fallbackModels;
  let tier: string | undefined;

  if (spawnOpts?.fallbackProfile) {
    const chain = fallbackProfileChain(config, spawnOpts.fallbackProfile);
    const primary = chain[0] ? parseModelRef(chain[0]) : undefined;
    if (primary?.model) {
      provider = primary.provider ?? config.provider;
      model = primary.model;
      fallbackModels = spawnOpts.fallbackModels ?? chain.slice(1);
    }
  } else if (spawnOpts?.tier || spawnOpts?.role) {
    const resolved = resolveTier(config, {
      ...(spawnOpts.tier ? { tier: spawnOpts.tier } : {}),
      ...(spawnOpts.role ? { role: spawnOpts.role } : {}),
    });
    if (resolved?.model) {
      tier = resolved.tier;
      provider = provider ?? resolved.provider ?? config.provider;
      model = model ?? resolved.model;
      fallbackModels = fallbackModels ?? resolved.fallbackModels?.slice() ?? undefined;
    }
  }

  return { provider, model, fallbackModels, ...(tier ? { tier } : {}) };
}
