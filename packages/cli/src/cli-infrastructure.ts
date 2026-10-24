import { TOKENS } from '@wrongstack/contracts/kernel';
import type { SystemPromptBuilder } from '@wrongstack/contracts/types';
import { providerToolsForVariant } from '@wrongstack/core/agent';
import { registerJevTools } from '@wrongstack/tools/management';
import { wireEventWiring } from './boot/event-wiring.js';
import { loadOnlineAgentsForPrompt } from './cli-main-helpers.js';
import { CLI_VERSION } from './version.js';
import { setupMetrics } from './wiring/metrics.js';
import { setupTeardownRegistrar } from './wiring/teardown-registrar.js';
export async function setupCliInfrastructure(inputs: {
  flags: Record<string, string | boolean>;
  wpaths: import('@wrongstack/core/utils').WstackPaths;
  events: import('@wrongstack/contracts/kernel').EventBus;
  logger: import('@wrongstack/core/infrastructure').DefaultLogger;
  getConfig: () => import('@wrongstack/contracts/types').Config;
  teardownHandlers: (() => void)[];
  vectorMemoryStore: import('@wrongstack/vector-memory').VectorMemoryStore | undefined;
  renderer: import('./renderer.js').TerminalRenderer;
  sessionRef: { current: import('@wrongstack/contracts/types').SessionWriter | undefined };
  activeMode: import('@wrongstack/contracts/types').Mode | null;
  toolRegistry: import('@wrongstack/core/registry').ToolRegistry;
  configStore: import('@wrongstack/contracts/types').ConfigStore;
  container: import('@wrongstack/contracts/kernel').Container;
  cwd: string;
  projectRoot: string;
  provider: import('@wrongstack/contracts/types').Provider;
}) {
  const {
    flags,
    wpaths,
    events,
    logger,
    getConfig,
    teardownHandlers,
    vectorMemoryStore,
    renderer,
    sessionRef,
    activeMode,
    toolRegistry,
    configStore,
    container,
    cwd,
    projectRoot,
    provider,
  } = inputs;

  const { metricsSink, healthRegistry, metricsStatus, tracer } = setupMetrics({
    flags,
    wpaths,
    events,
    logger,
    config: { provider: getConfig().provider, model: getConfig().model },
    observability: {
      config: getConfig().observability,
      serviceVersion: CLI_VERSION,
      teardownHandlers,
    },
  });

  const { tuiOwnsScreen, evOn } = setupTeardownRegistrar({
    flags,
    events,
    logger,
    teardownHandlers,
    vectorMemoryStore,
  });

  const eventWiring = wireEventWiring({
    evOn,
    events,
    renderer,
    getProvider: () => getConfig().provider,
    getModel: () => getConfig().model,
    getSessionId: () => sessionRef.current?.id ?? '',
    projectSlug: wpaths.projectSlug,
    getActiveModeId: () => activeMode?.id ?? 'off',
    tuiOwnsScreen,
  });

  teardownHandlers.push(registerJevTools(toolRegistry, configStore));
  const promptBuilder = container.resolve(TOKENS.SystemPromptBuilder) as SystemPromptBuilder;
  const onlineAgents = await loadOnlineAgentsForPrompt(
    wpaths.projectDir,
    flags['simpleui'] === true,
  );

  const systemPrompt = await promptBuilder.build({
    cwd,
    projectRoot,
    tools: providerToolsForVariant(
      toolRegistry,
      getConfig().systemPrompt?.variant,
      undefined,
      provider,
    ),
    catalogTools: toolRegistry.list(),
    provider: getConfig().provider,
    model: getConfig().model,
    onlineAgents,
  });
  return {
    metricsSink,
    healthRegistry,
    metricsStatus,
    tracer,
    tuiOwnsScreen,
    evOn,
    eventWiring,
    promptBuilder,
    onlineAgents,
    systemPrompt,
  };
}
