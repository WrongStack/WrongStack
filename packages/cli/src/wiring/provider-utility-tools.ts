/** Registers provider-neutral one-shot, council, and context-summary tools. */

import type {
  Config,
  ModelsRegistry,
  Provider,
  ResolvedProvider,
} from '@wrongstack/contracts/types';
import type { ProviderModelStatusTracker } from '@wrongstack/coordination';
import type { FallbackProfileManager } from '@wrongstack/core/agent';
import { OneShotOrchestrator } from '@wrongstack/core/execution';
import { createContextManagerTool } from '@wrongstack/core/infrastructure';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { buildCouncilRegistries, createLiveModelRouter } from '@wrongstack/runtime/plugin-host';
import { createImageGenerateTool, imageTargetsFromCatalog } from '@wrongstack/tools';
import { createCouncilTool, createOneShotLLMTool } from '@wrongstack/tools/management';

// The live model router and the Council registries moved to
// `@wrongstack/runtime/plugin-host`: plugin `api.llm` uses them on every host.
export { buildCouncilRegistries, createLiveModelRouter };

interface ProviderUtilityToolsInput {
  toolRegistry: ToolRegistry;
  buildProvider: (providerId: string) => Provider;
  getConfig: () => Config;
  fallbackProfileManager: FallbackProfileManager;
  statusTracker: ProviderModelStatusTracker;
  wrapProviderCall: NonNullable<
    import('@wrongstack/contracts/types').OneShotOrchestratorOptions['wrapProviderCall']
  >;
  compactor: NonNullable<Parameters<typeof createContextManagerTool>[0]>['compactor'];
  /** Catalog the image tool reads image models from. */
  modelsRegistry: Pick<ModelsRegistry, 'getProvider'>;
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

  registerOrOverride(
    input.toolRegistry,
    'image_generate',
    createImageGenerateTool({
      buildProvider: input.buildProvider,
      // Read at call time: providers added or switched mid-session count.
      listTargets: async () => {
        const live = input.getConfig();
        const ids = [...new Set([live.provider, ...Object.keys(live.providers ?? {})])];
        const catalog = new Map<string, ResolvedProvider>();
        for (const id of ids) {
          const entry = await input.modelsRegistry.getProvider(id).catch(() => undefined);
          if (entry) catalog.set(id, entry);
        }
        return imageTargetsFromCatalog(ids, catalog);
      },
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
