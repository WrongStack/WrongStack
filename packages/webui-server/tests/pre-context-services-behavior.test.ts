import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const memoryStore = { initialize: vi.fn() };
  const configStore = { update: vi.fn() };
  const container = {
    bind: vi.fn(),
    has: vi.fn(() => false),
    override: vi.fn(),
    resolve: vi.fn((token: string) => (token === 'memory' ? memoryStore : configStore)),
  };
  return {
    memoryStore,
    configStore,
    container,
    attachSessionKanbanMirror: vi.fn(),
    buildProviderFactoriesFromRegistry: vi.fn(),
    configureChildEnvGitIdentity: vi.fn(),
    configureDangerBypass: vi.fn(),
    configureExecPolicy: vi.fn(),
    createCustomModeStore: vi.fn(),
    createDefaultContainer: vi.fn(() => container),
    createStandaloneSessionIdentityLifecycle: vi.fn(),
    discoverAndMergeWebuiProviders: vi.fn(),
    getAgentStatuses: vi.fn(),
    hydrateSessionKanban: vi.fn(),
    installCatalogModelOutputLimits: vi.fn(),
    registerCanonicalHostTools: vi.fn(),
    resolveProviderModelMetadata: vi.fn(),
    resolveSetupProvider: vi.fn(),
    seedContextMeta: vi.fn(),
    setMeta: vi.fn(),
    systemPromptBuild: vi.fn(),
  };
});

vi.mock('@wrongstack/core/agent', () => ({
  Context: class ContextMock {
    meta: Record<string, unknown> = {};
    state = { setMeta: mocks.setMeta };
    session: unknown;

    constructor(readonly options: Record<string, unknown>) {
      this.session = options.session;
    }
  },
  DefaultSystemPromptBuilder: class DefaultSystemPromptBuilderMock {
    constructor(readonly options: Record<string, unknown>) {}
    build = mocks.systemPromptBuild;
  },
}));
vi.mock('@wrongstack/core/coordination', () => ({
  getSharedProjectMailbox: vi.fn(() => ({ getAgentStatuses: mocks.getAgentStatuses })),
  makeFleetStatusTool: vi.fn(() => ({ name: 'fleet' })),
  makeMailboxTool: vi.fn(() => ({ name: 'mailbox' })),
  makeMailInboxTool: vi.fn(() => ({ name: 'mail_inbox' })),
  makeMailSendTool: vi.fn(() => ({ name: 'mail_send' })),
}));
vi.mock('@wrongstack/core/execution', () => ({
  DefaultPromptLoader: class DefaultPromptLoaderMock {},
  DefaultSkillLoader: class DefaultSkillLoaderMock {},
}));
vi.mock('@wrongstack/core/infrastructure', () => ({
  DefaultTokenCounter: class DefaultTokenCounterMock {
    constructor(readonly options: Record<string, unknown>) {}
  },
}));
vi.mock('@wrongstack/core/kernel', () => ({
  EventBus: class EventBusMock {
    setLogger = vi.fn();
  },
  TOKENS: { ConfigStore: 'config', MemoryStore: 'memory', SystemPromptBuilder: 'prompt' },
}));
vi.mock('@wrongstack/core/models', () => ({
  DefaultModelsRegistry: class DefaultModelsRegistryMock {},
  DefaultModeStore: class DefaultModeStoreMock {
    getActiveMode = vi.fn().mockResolvedValue({ id: 'review', prompt: 'Review carefully' });
  },
}));
vi.mock('@wrongstack/core/registry', () => ({
  ProviderRegistry: class ProviderRegistryMock {
    factories: unknown[] = [];
    register = vi.fn((factory) => this.factories.push(factory));
    list = vi.fn(() => this.factories);
  },
  ToolRegistry: class ToolRegistryMock {
    list = vi.fn(() => []);
  },
}));
vi.mock('@wrongstack/core/skills', () => ({ SkillInstaller: class SkillInstallerMock {} }));
vi.mock('@wrongstack/core/storage', () => ({
  AnnotationsStore: class AnnotationsStoreMock {},
  DefaultSessionReader: class DefaultSessionReaderMock {},
  DefaultSessionStore: class DefaultSessionStoreMock {},
  getSessionRegistry: vi.fn(),
  PromptUsageStore: class PromptUsageStoreMock {},
}));
vi.mock('@wrongstack/core/types', () => ({
  DEFAULT_SESSION_PRUNE_DAYS: 30,
  normalizeTokenSavingTier: vi.fn((value) => value),
  resolveContextWindowPolicy: vi.fn(() => ({ id: 'balanced', maxMessages: 100 })),
}));
vi.mock('@wrongstack/core/utils', () => ({
  configureChildEnvGitIdentity: mocks.configureChildEnvGitIdentity,
  sessionScopedPath: vi.fn((directory, sessionId, suffix) => `${directory}/${sessionId}${suffix}`),
  toErrorMessage: vi.fn((error) => (error instanceof Error ? error.message : String(error))),
}));
vi.mock('@wrongstack/mcp', () => ({
  createVaultBackedMcpAuthorizationProviderFactory: vi.fn(() => vi.fn()),
  MCPAuthorizationManager: class MCPAuthorizationManagerMock {},
  MCPRegistry: class MCPRegistryMock {
    start = vi.fn();
  },
  MCPVaultTokenStore: class MCPVaultTokenStoreMock {},
}));
vi.mock('@wrongstack/providers', () => ({
  buildProviderFactoriesFromRegistry: mocks.buildProviderFactoriesFromRegistry,
  installCatalogModelOutputLimits: mocks.installCatalogModelOutputLimits,
}));
vi.mock('@wrongstack/runtime', () => ({ createDefaultContainer: mocks.createDefaultContainer }));
vi.mock('@wrongstack/runtime/tool-registration', () => ({
  registerCanonicalHostTools: mocks.registerCanonicalHostTools,
}));
vi.mock('@wrongstack/tools', () => ({
  configureDangerBypass: mocks.configureDangerBypass,
  configureExecPolicy: mocks.configureExecPolicy,
}));
vi.mock('@wrongstack/tools/session-kanban', () => ({
  attachSessionKanbanMirror: mocks.attachSessionKanbanMirror,
  hydrateSessionKanban: mocks.hydrateSessionKanban,
}));
vi.mock('../src/server/context-meta.js', () => ({ seedContextMeta: mocks.seedContextMeta }));
vi.mock('../src/server/custom-context-modes.js', () => ({
  createCustomModeStore: mocks.createCustomModeStore,
}));
vi.mock('../src/server/model-auto-discovery.js', () => ({
  discoverAndMergeWebuiProviders: mocks.discoverAndMergeWebuiProviders,
}));
vi.mock('../src/server/model-catalog.js', () => ({
  resolveProviderModelMetadata: mocks.resolveProviderModelMetadata,
}));
vi.mock('../src/server/setup-screen.js', () => ({
  resolveSetupProvider: mocks.resolveSetupProvider,
}));
vi.mock('../src/server/standalone-session-identity.js', () => ({
  createStandaloneSessionIdentityLifecycle: mocks.createStandaloneSessionIdentityLifecycle,
}));

import { createPreContextServices } from '../src/server/pre-context-services.js';

describe('createPreContextServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memoryStore.initialize.mockResolvedValue(undefined);
    mocks.buildProviderFactoriesFromRegistry.mockResolvedValue([{ id: 'provider-factory' }]);
    mocks.discoverAndMergeWebuiProviders.mockResolvedValue(undefined);
    mocks.installCatalogModelOutputLimits.mockResolvedValue(undefined);
    mocks.getAgentStatuses.mockResolvedValue([{ agentId: 'worker-1', status: 'online' }]);
    mocks.systemPromptBuild.mockResolvedValue('system prompt');
    mocks.resolveProviderModelMetadata.mockResolvedValue({
      capabilities: { maxContext: 128_000, tools: true, vision: true, reasoning: true },
    });
    mocks.resolveSetupProvider.mockReturnValue({
      provider: { id: 'provider' },
      needsSetup: false,
    });
    mocks.createStandaloneSessionIdentityLifecycle.mockResolvedValue({
      statusTracker: { getAgents: () => [] },
    });
    mocks.createCustomModeStore.mockReturnValue({
      load: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(() => [{ id: 'custom', custom: true }]),
    });
  });

  it('composes injected services in discovery order and seeds the live context', async () => {
    const modelsRegistry = { refresh: vi.fn() };
    const events = { setLogger: vi.fn() };
    const toolRegistry = {
      list: vi.fn(() => [{ name: 'read_file' }]),
      listForProvider: vi.fn(() => [{ name: 'read_file' }]),
    };
    const session = { id: 'session-1' };
    const sessionStore = {
      create: vi.fn().mockResolvedValue(session),
      prune: vi.fn(),
    };
    const touchProject = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const config = {
      provider: 'openai',
      model: 'gpt-5.6',
      providers: {},
      features: {
        memory: true,
        mcp: false,
        skills: false,
        prompts: false,
        tokenSavingMode: 'balanced',
      },
      tools: { exec: { danger: { enabled: false } } },
      context: { mode: 'balanced' },
      git: { identity: { name: 'WrongStack', email: 'bot@example.test' } },
    };
    const wpaths = {
      modelsCache: 'D:/global/models.json',
      modelsOverlayCache: 'D:/global/models-overlay.json',
      cacheDir: 'D:/repo/.wstack/cache',
      projectDir: 'D:/repo/.wstack',
      projectRoot: 'D:/repo',
      projectSessions: 'D:/repo/.wstack/sessions',
      globalRoot: 'D:/global',
      projectSlug: 'repo',
      configDir: 'D:/repo/.wstack/config',
      promptUsage: 'D:/repo/.wstack/prompts-usage.json',
      globalInstructions: 'D:/global/instructions',
      inProjectInstructions: 'D:/repo/.wstack/instructions',
    };

    const result = await createPreContextServices({
      config,
      wpaths,
      logger,
      opts: {
        services: {
          modelsRegistry,
          events,
          configStore: mocks.configStore,
          toolRegistry,
          session: sessionStore,
        },
      },
      vault: {},
      globalConfigPath: 'D:/global/config.json',
      projectRoot: 'D:/repo',
      workingDir: 'D:/repo/src',
      needsProvider: false,
      touchProject,
    } as never);

    expect(mocks.discoverAndMergeWebuiProviders).toHaveBeenCalledBefore(
      mocks.installCatalogModelOutputLimits,
    );
    expect(events.setLogger).toHaveBeenCalledWith(logger);
    expect(mocks.memoryStore.initialize).toHaveBeenCalledOnce();
    expect(mocks.registerCanonicalHostTools).not.toHaveBeenCalled();
    expect(mocks.configureExecPolicy).toHaveBeenCalledWith(config.tools.exec);
    expect(mocks.configureDangerBypass).toHaveBeenCalledWith(config.tools.exec.danger);
    expect(mocks.configureChildEnvGitIdentity).toHaveBeenCalledWith(config.git.identity);
    expect(sessionStore.create).toHaveBeenCalledWith({
      id: '',
      title: '',
      model: 'gpt-5.6',
      provider: 'openai',
    });
    expect(touchProject).toHaveBeenCalledWith('D:/repo', 'D:/repo/src');
    expect(mocks.systemPromptBuild).toHaveBeenCalledWith({
      cwd: 'D:/repo',
      projectRoot: 'D:/repo',
      tools: [{ name: 'read_file' }],
      catalogTools: [{ name: 'read_file' }],
      provider: 'openai',
      model: 'gpt-5.6',
      onlineAgents: [{ agentId: 'worker-1', status: 'online' }],
    });
    expect(mocks.setMeta).toHaveBeenCalledWith(
      'plan.path',
      'D:/repo/.wstack/sessions/session-1.plan.json',
    );
    expect(mocks.hydrateSessionKanban).toHaveBeenCalledWith(result.context);
    expect(mocks.attachSessionKanbanMirror).toHaveBeenCalledWith(result.context);
    expect(mocks.seedContextMeta).toHaveBeenCalledWith(config, result.context);
    expect(result).toMatchObject({
      modelsRegistry,
      configStore: mocks.configStore,
      toolRegistry,
      memoryStore: mocks.memoryStore,
      sessionStore,
      session,
      modeId: 'review',
      provider: { id: 'provider' },
      needsSetup: false,
    });
  });
});
