import { TOKENS } from '@wrongstack/contracts/kernel';
import { isRestrictedMode, withRestrictedTools } from './boot/restricted-mode.js';
import { isSafeMode } from './boot/safe-mode.js';
import { resolveToolRestriction } from './boot/tool-restriction-flags.js';
import { setupCliInfrastructure } from './cli-infrastructure.js';
import { setupCliPromptAndTools } from './wiring/cli-prompt-and-tools-setup.js';
import { registerCliManagementTools } from './wiring/management-tools.js';

interface SetupInitialCliToolsInput {
  container: import('@wrongstack/contracts/kernel').Container;
  flags: Record<string, string | boolean>;
  renderer: import('./renderer.js').TerminalRenderer;
  modeStore: import('@wrongstack/contracts/types').ModeStore;
  memoryStore: import('@wrongstack/contracts/types').MemoryPort;
  modeId: string;
  modePrompt: string;
  modelCapabilitiesRef: {
    current: import('./boot/system-prompt.js').ModelCapabilities | undefined;
  };
  getConfig: () => import('@wrongstack/contracts/types').Config;
  wpaths: import('@wrongstack/core/utils').WstackPaths;
  projectRoot: string;
  events: import('@wrongstack/contracts/kernel').EventBus;
  vectorMemoryStore: import('@wrongstack/vector-memory').VectorMemoryStore | undefined;
  configStore: import('@wrongstack/contracts/types').ConfigStore;
  profileConfigPath: string;
  modelsRegistry: import('@wrongstack/contracts/types').ModelsRegistry;
  logger: import('@wrongstack/core/infrastructure').DefaultLogger;
  teardownHandlers: (() => void)[];
  activeMode: import('@wrongstack/contracts/types').Mode | null;
  cwd: string;
  provider: import('@wrongstack/contracts/types').Provider;
}

export async function setupInitialCliTools({
  container,
  flags,
  renderer,
  modeStore,
  memoryStore,
  modeId,
  modePrompt,
  modelCapabilitiesRef,
  getConfig,
  wpaths,
  projectRoot,
  events,
  vectorMemoryStore,
  configStore,
  profileConfigPath,
  modelsRegistry,
  logger,
  teardownHandlers,
  activeMode,
  cwd,
  provider,
}: SetupInitialCliToolsInput) {
  const config = getConfig();

  const skillLoader = container.resolve(TOKENS.SkillLoader);
  const promptLoader = container.resolve(TOKENS.PromptLoader);
  const sessionRef: { current: import('@wrongstack/contracts/types').SessionWriter | undefined } = {
    current: undefined,
  };
  const autonomyModeRef: {
    current: import('./services/autonomy-mode.js').AutonomyMode;
  } = { current: 'off' };

  const { toolRegistry } = await setupCliPromptAndTools({
    appendedInstructions:
      typeof flags['append-system-prompt'] === 'string' ? flags['append-system-prompt'] : undefined,
    toolRestriction: withRestrictedTools(resolveToolRestriction(flags), isRestrictedMode(flags)),
    safeMode: isSafeMode(flags),
    warn: (message) => renderer.writeWarning(message),
    container,
    modeStore,
    memoryStore,
    skillLoader,
    sessionRef,
    autonomyModeRef,
    modeId,
    modePrompt,
    modelCapabilitiesRef,
    config,
    wpaths,
    projectRoot,
    events,
    vectorMemoryStore,
  });

  const stdinInteractive = process.stdin.isTTY;
  const hookRunnerRef: {
    current: import('@wrongstack/tools/management').PluginManagerHookRunner | null;
  } = { current: null };
  const switchProviderAndModelRef: {
    current: ((providerId: string, modelId: string) => Promise<string | null>) | null;
  } = { current: null };
  registerCliManagementTools({
    toolRegistry,
    configStore,
    profileConfigPath,
    stdinInteractive,
    events,
    modelsRegistry,
    getHookRunner: () => hookRunnerRef.current,
    getSwitchProviderAndModel: () => switchProviderAndModelRef.current,
  });
  const {
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
  } = await setupCliInfrastructure({
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
  });
  return {
    skillLoader,
    promptLoader,
    sessionRef,
    autonomyModeRef,
    toolRegistry,
    hookRunnerRef,
    switchProviderAndModelRef,
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
