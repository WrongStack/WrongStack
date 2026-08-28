/** Registers provider-neutral one-shot, council, and context-summary tools. */

import type { FallbackProfileManager } from '@wrongstack/core/agent';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import {
  type CouncilPersonaRegistry,
  type CouncilProfileRegistry,
  createCouncilPersonaRegistry,
  createCouncilProfileRegistry,
  OneShotOrchestrator,
} from '@wrongstack/core/execution';
import { createContextManagerTool } from '@wrongstack/core/infrastructure';
import { ModelRouter } from '@wrongstack/core/models';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { createCouncilTool, createOneShotLLMTool } from '@wrongstack/core/tools';
import type {
  Config,
  CouncilProfileConfig,
  CouncilToolConfig,
  OneShotModelRouter,
  Provider,
} from '@wrongstack/core/types';

interface ProviderUtilityToolsInput {
  toolRegistry: ToolRegistry;
  buildProvider: (providerId: string) => Provider;
  getConfig: () => Config;
  fallbackProfileManager: FallbackProfileManager;
  statusTracker: ProviderModelStatusTracker;
  wrapProviderCall: NonNullable<
    import('@wrongstack/core/types').OneShotOrchestratorOptions['wrapProviderCall']
  >;
  compactor: NonNullable<Parameters<typeof createContextManagerTool>[0]>['compactor'];
}

export async function adoptResumedProvider(input: {
  resumedProvider?: string | undefined;
  resumedModel?: string | undefined;
  getConfig: () => Config;
  switchProviderAndModel: (providerId: string, modelId: string) => Promise<string | null>;
  logger: { warn(message: string): void };
}): Promise<void> {
  if (!input.resumedProvider && !input.resumedModel) return;
  const config = input.getConfig();
  const provider = input.resumedProvider?.trim() || config.provider;
  const model = input.resumedModel?.trim() || config.model;
  if (provider === config.provider && model === config.model) return;
  const error = await input.switchProviderAndModel(provider, model);
  if (error) {
    const current = input.getConfig();
    input.logger.warn(
      `Resume: could not switch to the session's model ${provider}/${model} (${error}); continuing with ${current.provider}/${current.model}.`,
    );
  }
}

/**
 * A router that reads the LIVE config on every pick.
 *
 * `ModelRouter` snapshots `modelMatrix` and the provider list at construction,
 * but `/setmodel` and credential edits change both mid-session. Rebuilding per
 * call keeps role routing consistent with what the user last configured; the
 * router itself does no I/O, so this is a plain object construction.
 */
export function createLiveModelRouter(getConfig: () => Config): OneShotModelRouter {
  return {
    pickForTask(role, description) {
      const config = getConfig();
      const router = new ModelRouter({
        ...(config.modelMatrix ? { matrix: config.modelMatrix } : {}),
        config: {
          provider: config.provider,
          model: config.model,
          ...(config.providers ? { providers: config.providers } : {}),
        },
      });
      return router.pickForTask(role, description);
    },
  };
}

/**
 * Build the Council tool's persona/profile registries from configuration.
 *
 * `createCouncilPersonaRegistry` / `createCouncilProfileRegistry` shipped from
 * day one but no host ever called them, so the tool was pinned to the built-in
 * lenses and panels with no way to add either. A malformed entry must not take
 * the whole tool registration down with it — a bad panel definition degrades to
 * the built-ins and is reported, exactly like an unresolvable Brain pool entry.
 */
export function buildCouncilRegistries(cfg: CouncilToolConfig | undefined): {
  personas?: CouncilPersonaRegistry | undefined;
  profiles?: CouncilProfileRegistry | undefined;
  defaultProfile?: string | undefined;
  maxConcurrency?: number | undefined;
} {
  const base = {
    ...(cfg?.defaultProfile ? { defaultProfile: cfg.defaultProfile } : {}),
    ...(cfg?.maxConcurrency !== undefined ? { maxConcurrency: cfg.maxConcurrency } : {}),
  };
  if (!cfg?.personas?.length && !cfg?.profiles?.length) return base;
  try {
    const personas = createCouncilPersonaRegistry(cfg.personas ?? []);
    const profiles = createCouncilProfileRegistry(
      (cfg.profiles ?? []) as CouncilProfileConfig[],
      personas,
    );
    return { ...base, personas, profiles };
  } catch (error) {
    console.warn(
      `Council tool: ignoring tools.council personas/profiles — ${
        error instanceof Error ? error.message : String(error)
      }. Falling back to the built-in lenses and panels.`,
    );
    return base;
  }
}

export function registerProviderUtilityTools(input: ProviderUtilityToolsInput): void {
  const config = input.getConfig();
  const llmTool = createOneShotLLMTool({
    buildProvider: input.buildProvider,
    getConfig: input.getConfig,
    fallbackProfileManager: input.fallbackProfileManager,
    defaultProvider: config.provider,
    defaultModel: config.model,
    // Same live router the council gets below. Without it the `role` input
    // was inert (the orchestrator's pickForTask path no-ops), and without the
    // tracker no llm-tool call ever recorded provider health, so blocked
    // entries were neither skipped nor reported for this tool's traffic.
    modelRouter: createLiveModelRouter(input.getConfig),
    statusTracker: input.statusTracker,
    wrapProviderCall: input.wrapProviderCall,
  });
  registerOrOverride(input.toolRegistry, 'llm', llmTool);

  const councilOrchestrator = new OneShotOrchestrator({
    buildProvider: input.buildProvider,
    getConfig: input.getConfig,
    fallbackProfileManager: input.fallbackProfileManager,
    statusTracker: input.statusTracker,
    // Council profiles route each seat by ROLE ('planner', 'critic',
    // 'analyst', 'security-reviewer'…) rather than pinning models. Without a
    // router those hints were inert: every seat fell through to the session
    // provider/model, so a three-seat panel asked one model three times and
    // reported a distinctness warning on every single call.
    modelRouter: createLiveModelRouter(input.getConfig),
    wrapProviderCall: input.wrapProviderCall,
  });
  registerOrOverride(
    input.toolRegistry,
    'council',
    createCouncilTool({
      caller: councilOrchestrator,
      fallbackProfileManager: input.fallbackProfileManager,
      ...buildCouncilRegistries(config.tools?.council),
    }),
  );

  try {
    const summarizer = new OneShotOrchestrator({
      buildProvider: input.buildProvider,
      getConfig: input.getConfig,
      fallbackProfileManager: input.fallbackProfileManager,
      statusTracker: input.statusTracker,
      wrapProviderCall: input.wrapProviderCall,
    });
    input.toolRegistry.override(
      'context_manager',
      createContextManagerTool({
        compactor: input.compactor,
        summarizer: async (messages) => {
          const result = await summarizer.call({
            system: 'Summarize concisely. Keep decisions and key facts.',
            messages,
            model: 'deepseek-chat',
            maxTokens: 1024,
            timeoutMs: 30_000,
          });
          return result.text || '(summary unavailable)';
        },
      }),
    );
  } catch {
    // Best-effort optional enhancement.
  }
}

function registerOrOverride(
  registry: ToolRegistry,
  name: string,
  tool: Parameters<ToolRegistry['register']>[0],
): void {
  try {
    registry.register(tool);
  } catch {
    registry.override(name, tool);
  }
}
