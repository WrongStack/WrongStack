/**
 * Provider-neutral one-shot, council, image and context-summary tools.
 *
 * One registration for every host. The CLI (`cli-main-boot.ts`) and the
 * standalone engine behind WebUI/desktop (`webui-server`'s
 * `standalone-provider-tools.ts`) both call `registerProviderUtilityTools`, so
 * `llm`, `council` and `image_generate` reach the model with the same routing,
 * health tracking, provider-runner chain and config gates on either surface.
 * Before this lived here the standalone host never registered them: desktop's
 * generated-images card had nothing to show and the model had no `council`.
 */

import type {
  Config,
  CouncilProfileConfig,
  CouncilToolConfig,
  ModelsRegistry,
  OneShotModelRouter,
  OneShotOrchestratorOptions,
  Provider,
  ResolvedProvider,
} from '@wrongstack/contracts/types';
import type { FallbackProfileManager } from '@wrongstack/core/agent';
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
import { toErrorMessage } from '@wrongstack/core/utils';
import { createImageGenerateTool, imageTargetsFromCatalog } from '@wrongstack/tools';
import { createCouncilTool, createOneShotLLMTool } from '@wrongstack/tools/management';

/** The tools `registerProviderUtilityTools` owns (`context_manager` is only upgraded). */
export const PROVIDER_UTILITY_TOOL_NAMES = ['llm', 'council', 'image_generate'] as const;

export interface ProviderUtilityToolsInput {
  toolRegistry: ToolRegistry;
  buildProvider: (providerId: string) => Provider;
  getConfig: () => Config;
  fallbackProfileManager: FallbackProfileManager;
  /** Provider/model health. Without it no call these tools make records or skips a blocked entry. */
  statusTracker?: OneShotOrchestratorOptions['statusTracker'];
  wrapProviderCall: NonNullable<OneShotOrchestratorOptions['wrapProviderCall']>;
  compactor: NonNullable<Parameters<typeof createContextManagerTool>[0]>['compactor'];
  /** Catalog the image tool reads image models from. */
  modelsRegistry: Pick<ModelsRegistry, 'getProvider'>;
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
      `Council tool: ignoring tools.council personas/profiles — ${toErrorMessage(
        error,
      )}. Falling back to the built-in lenses and panels.`,
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
  registerOrOverride(input.toolRegistry, 'llm', llmTool, config);

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
    config,
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
    config,
  );

  try {
    const summarizer = new OneShotOrchestrator({
      buildProvider: input.buildProvider,
      getConfig: input.getConfig,
      fallbackProfileManager: input.fallbackProfileManager,
      statusTracker: input.statusTracker,
      wrapProviderCall: input.wrapProviderCall,
    });
    // `override`, never `register`: a host that left `context_manager` out
    // (disabled, or never registered) keeps it out — override throws then.
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

/**
 * Register, or replace an earlier owner's tool of the same name — then apply
 * `tools.disabledTools`. These tools arrive after the host's canonical
 * registration already applied that list, and `ToolRegistry.disable()` ignores
 * names that were not registered yet, so without this an operator who turned
 * `llm` off still had it offered.
 */
function registerOrOverride(
  registry: ToolRegistry,
  name: string,
  tool: Parameters<ToolRegistry['register']>[0],
  config: Config,
): void {
  try {
    registry.register(tool);
  } catch {
    registry.override(name, tool);
  }
  if (config.tools?.disabledTools?.includes(name)) {
    registry.disable(name);
    const meta = config.tools.disabledToolMeta?.[name];
    if (meta) registry.applyDisabledMeta({ [name]: meta });
  }
}
