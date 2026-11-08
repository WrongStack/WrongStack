import type { Config, OneShotOrchestratorOptions, Provider } from '@wrongstack/contracts/types';
import type { FallbackProfileManager } from '@wrongstack/core/agent';
import { CouncilOrchestrator, OneShotOrchestrator } from '@wrongstack/core/execution';
import type { PluginAPIInit } from '@wrongstack/core/plugin';
// One implementation of the live router and the Council registries: the
// `llm` / `council` tools and plugin `api.llm` route the same way.
import { buildCouncilRegistries, createLiveModelRouter } from '../provider-utility-tools.js';

export interface PluginLlmOptions {
  /** The host session's provider and model at plugin setup. */
  provider: Provider;
  model: string;
  /** The live provider / model, after a model switch. */
  getProvider: () => Provider;
  getModel: () => string;
  /** Builds the provider a plugin names (`opts.provider`, `extensions.<name>.llm.provider`). */
  createProvider: (name: string) => Provider;
  getConfig: () => Config;
  /** One-shot calls: provider for a route target / fallback entry. */
  buildProvider: OneShotOrchestratorOptions['buildProvider'];
  fallbackProfileManager: OneShotOrchestratorOptions['fallbackProfileManager'];
  statusTracker?: OneShotOrchestratorOptions['statusTracker'];
  logger?: OneShotOrchestratorOptions['logger'];
  /**
   * Routes plugin completions through the agent's provider extension chain
   * (`prompt-firewall` credential redaction, `llm-cache`, `model-router`, the
   * token budgeter all live on `wrapProviderRunner`). Without it `api.llm`
   * reaches the provider with none of them.
   */
  wrapProviderCall?: OneShotOrchestratorOptions['wrapProviderCall'];
}

/**
 * `api.llm` for every host: the shared One Shot runtime (role routing from the
 * live model matrix, fallback profiles, provider health) and a Council over it.
 */
export function createPluginLlm(options: PluginLlmOptions): NonNullable<PluginAPIInit['llm']> {
  const oneShot = new OneShotOrchestrator({
    buildProvider: options.buildProvider,
    getConfig: options.getConfig,
    fallbackProfileManager: options.fallbackProfileManager,
    statusTracker: options.statusTracker,
    modelRouter: createLiveModelRouter(options.getConfig),
    logger: options.logger,
    wrapProviderCall: options.wrapProviderCall,
  });
  const council = new CouncilOrchestrator({
    caller: oneShot,
    fallbackProfileManager: options.fallbackProfileManager as FallbackProfileManager,
    ...buildCouncilRegistries(options.getConfig().tools?.council),
  });
  return {
    provider: options.provider,
    model: options.model,
    getProvider: options.getProvider,
    getModel: options.getModel,
    createProvider: options.createProvider,
    oneShot: (input) => oneShot.call(input),
    council: (question) => council.ask(question),
  };
}
