import type {
  Config,
  CouncilProfileConfig,
  CouncilToolConfig,
  OneShotModelRouter,
  OneShotOrchestratorOptions,
  Provider,
} from '@wrongstack/contracts/types';
import type { FallbackProfileManager } from '@wrongstack/core/agent';
import {
  CouncilOrchestrator,
  type CouncilPersonaRegistry,
  type CouncilProfileRegistry,
  createCouncilPersonaRegistry,
  createCouncilProfileRegistry,
  OneShotOrchestrator,
} from '@wrongstack/core/execution';
import { ModelRouter } from '@wrongstack/core/models';
import type { PluginAPIInit } from '@wrongstack/core/plugin';

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
