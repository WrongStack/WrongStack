import { fallbackProfileChain, parseModelRef } from '@wrongstack/core/agent';
import type { Config } from '@wrongstack/core/types';

interface KanbanDispatchRouteInput {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  fallbackProfile?: string | undefined;
}

interface KanbanDispatchRoute {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
}

export function resolveKanbanDispatchRoute(
  config: Config,
  spawnOpts?: KanbanDispatchRouteInput | undefined,
): KanbanDispatchRoute {
  let provider = spawnOpts?.provider;
  let model = spawnOpts?.model;
  let fallbackModels = spawnOpts?.fallbackModels;
  if (spawnOpts?.fallbackProfile) {
    const chain = fallbackProfileChain(config, spawnOpts.fallbackProfile);
    const primary = chain[0] ? parseModelRef(chain[0]) : undefined;
    if (primary?.model) {
      provider = primary.provider ?? config.provider;
      model = primary.model;
      fallbackModels = spawnOpts.fallbackModels ?? chain.slice(1);
    }
  }
  return { provider, model, fallbackModels };
}
