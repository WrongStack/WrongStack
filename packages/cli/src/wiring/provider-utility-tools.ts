/** Registers provider-neutral one-shot, council, and context-summary tools. */
import type { Config, Provider } from '@wrongstack/core/types';
import { createContextManagerTool } from '@wrongstack/core/infrastructure';
import { createCouncilTool, createOneShotLLMTool } from '@wrongstack/core/tools';
import type { FallbackProfileManager } from '@wrongstack/core/agent';
import { OneShotOrchestrator } from '@wrongstack/core/execution';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { ToolRegistry } from '@wrongstack/core/registry';

export interface ProviderUtilityToolsInput {
  toolRegistry: ToolRegistry;
  buildProvider: (providerId: string) => Provider;
  getConfig: () => Config;
  fallbackProfileManager: FallbackProfileManager;
  statusTracker: ProviderModelStatusTracker;
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

export function registerProviderUtilityTools(input: ProviderUtilityToolsInput): void {
  const config = input.getConfig();
  const llmTool = createOneShotLLMTool({
    buildProvider: input.buildProvider,
    getConfig: input.getConfig,
    fallbackProfileManager: input.fallbackProfileManager,
    defaultProvider: config.provider,
    defaultModel: config.model,
  });
  registerOrOverride(input.toolRegistry, 'llm', llmTool);

  const councilOrchestrator = new OneShotOrchestrator({
    buildProvider: input.buildProvider,
    getConfig: input.getConfig,
    fallbackProfileManager: input.fallbackProfileManager,
    statusTracker: input.statusTracker,
  });
  registerOrOverride(
    input.toolRegistry,
    'council',
    createCouncilTool({ caller: councilOrchestrator, fallbackProfileManager: input.fallbackProfileManager }),
  );

  try {
    const summarizer = new OneShotOrchestrator({
      buildProvider: input.buildProvider,
      getConfig: input.getConfig,
      fallbackProfileManager: input.fallbackProfileManager,
      statusTracker: input.statusTracker,
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
