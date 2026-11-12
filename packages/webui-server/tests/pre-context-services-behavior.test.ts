import { getResolvedSandboxConfig, resetSandboxPolicy } from '@wrongstack/core/sandbox';
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
    createMcpControlTool: vi.fn(() => ({ name: 'mcp_control' })),
    createMcpUseTool: vi.fn(() => ({ name: 'mcp_use' })),
    createSessionBranchTool: vi.fn(() => ({ name: 'session_branch' })),
    createSessionRenameTool: vi.fn(() => ({ name: 'session_rename' })),
    registerCanonicalHostTools: vi.fn(),
    resolveProviderModelMetadata: vi.fn(),
    resolveSetupProvider: vi.fn(),
    seedContextMeta: vi.fn(),
    setMeta: vi.fn(),
    systemPromptBuild: vi.fn(),
    mcpRegistryOptions: [] as Record<string, unknown>[],
    elicitViaUserInput: vi.fn(),
    builderOptions: [] as Record<string, unknown>[],
    hostSections: {
      planPath: () => 'host-plan',
      contributors: [async () => []],
      domainGlossary: { list: async () => [] },
    },
    createHostSystemPromptSections: vi.fn(),
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
    constructor(readonly options: Record<string, unknown>) {
      mocks.builderOptions.push(options);
    }
    build = mocks.systemPromptBuild;
  },
  providerToolsForVariant: (registry: { listForProvider(): unknown }) => registry.listForProvider(),
}));
vi.mock('@wrongstack/coordination', () => ({
  getSharedProjectMailbox: vi.fn(() => ({ getAgentStatuses: mocks.getAgentStatuses })),
  makeFleetStatusTool: vi.fn(() => ({ name: 'fleet' })),
  makeMailboxTool: vi.fn(() => ({ name: 'mailbox' })),
  makeMailInboxTool: vi.fn(() => ({ name: 'mail_inbox' })),
  makeMailSendTool: vi.fn(() => ({ name: 'mail_send' })),
  makeSessionNoteTool: vi.fn(() => ({ name: 'session_note' })),
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
vi.mock('@wrongstack/contracts/kernel', () => ({
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
    listForProvider = vi.fn(() => []);
    registerDefault = vi.fn();
    exposeToProvider = vi.fn();
  },
}));
vi.mock('@wrongstack/core/skills', () => ({ SkillInstaller: class SkillInstallerMock {} }));
vi.mock('@wrongstack/tools/management', () => ({
  createMcpControlTool: mocks.createMcpControlTool,
  createMcpUseTool: mocks.createMcpUseTool,
  createSessionBranchTool: mocks.createSessionBranchTool,
  createSessionRenameTool: mocks.createSessionRenameTool,
  SESSION_BRANCH_TOOL_NAME: 'session_branch',
  SESSION_RENAME_TOOL_NAME: 'session_rename',
}));
vi.mock('@wrongstack/core/storage', () => ({
  AnnotationsStore: class AnnotationsStoreMock {},
  attachScoutToolLearning: vi.fn(() => () => undefined),
  DefaultSessionReader: class DefaultSessionReaderMock {},
  DefaultSessionStore: class DefaultSessionStoreMock {},
  getSessionRegistry: vi.fn(),
  PromptUsageStore: class PromptUsageStoreMock {},
  seedScoutLearnedTools: vi.fn(() => []),
}));
vi.mock('@wrongstack/contracts/types', () => ({
  DEFAULT_SESSION_PRUNE_DAYS: 30,
  normalizeTokenSavingTier: vi.fn((value) => value),
  // The tier is resolved ONCE here and handed to both the tool registry and
  // the prompt builder, so the mock has to expose the resolver the module
  // actually calls.
  resolveTokenSavingTier: vi.fn((value) => value),
  resolveContextWindowPolicy: vi.fn(() => ({ id: 'balanced', maxMessages: 100 })),
}));
vi.mock('@wrongstack/core/utils', () => ({
  configureChildEnvGitIdentity: mocks.configureChildEnvGitIdentity,
  sessionScopedPath: vi.fn((directory, sessionId, suffix) => `${directory}/${sessionId}${suffix}`),
  toErrorMessage: vi.fn((error) => (error instanceof Error ? error.message : String(error))),
}));
vi.mock('@wrongstack/mcp', () => ({
  elicitViaUserInput: mocks.elicitViaUserInput,
  createVaultBackedMcpAuthorizationProviderFactory: vi.fn(() => vi.fn()),
  MCPAuthorizationManager: class MCPAuthorizationManagerMock {},
  MCPRegistry: class MCPRegistryMock {
    constructor(options: Record<string, unknown>) {
      mocks.mcpRegistryOptions.push(options);
    }
    start = vi.fn();
  },
  MCPVaultTokenStore: class MCPVaultTokenStoreMock {},
}));
vi.mock('@wrongstack/providers', () => ({
  setStreamTimeoutDefaults: vi.fn(),
  buildProviderFactoriesFromRegistry: mocks.buildProviderFactoriesFromRegistry,
  installCatalogModelOutputLimits: mocks.installCatalogModelOutputLimits,
}));
vi.mock('@wrongstack/runtime', () => ({ createDefaultContainer: mocks.createDefaultContainer }));
// Its own coverage: cli/tests/system-prompt-host-sections-parity.test.ts.
vi.mock('@wrongstack/runtime/system-prompt-contributors', () => ({
  createHostSystemPromptSections: mocks.createHostSystemPromptSections,
}));
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
// Covered in standalone-acp-leader.test.ts; the ACP leader loads the real acp/fleet packages.
const registerAcpLeader = vi.hoisted(() => vi.fn());
vi.mock('../src/server/standalone-acp-leader.js', () => ({
  registerStandaloneAcpLeaderProvider: registerAcpLeader,
}));
vi.mock('../src/server/standalone-session-identity.js', () => ({
  createStandaloneSessionIdentityLifecycle: mocks.createStandaloneSessionIdentityLifecycle,
}));

import { createPreContextServices } from '../src/server/pre-context-services.js';

describe('createPreContextServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mcpRegistryOptions.length = 0;
    mocks.builderOptions.length = 0;
    mocks.createHostSystemPromptSections.mockReturnValue(mocks.hostSections);
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
      registerDefault: vi.fn(),
      exposeToProvider: vi.fn(),
    };
    const session = { id: 'session-1' };
    const sessionStore = {
      create: vi.fn().mockResolvedValue(session),
      prune: vi.fn(),
      rename: vi.fn().mockResolvedValue(undefined),
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
      tools: {
        exec: { danger: { enabled: false } },
        sandbox: { mode: 'enforced', tier: 'read-only' },
      },
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
    const elicitation = mocks.mcpRegistryOptions[0]?.['elicitationHandler'];
    expect(typeof elicitation).toBe('function');
    const request = {
      server: 'owned-server',
      requester: { requestUserInput: vi.fn() },
      signal: new AbortController().signal,
    };
    mocks.elicitViaUserInput.mockResolvedValueOnce({ action: 'decline' });
    await expect((elicitation as (request: unknown) => Promise<unknown>)(request)).resolves.toEqual(
      { action: 'decline' },
    );
    expect(mocks.elicitViaUserInput).toHaveBeenCalledWith(request);
    expect(mocks.registerCanonicalHostTools).not.toHaveBeenCalled();
    expect(mocks.configureExecPolicy).toHaveBeenCalledWith(config.tools.exec);
    expect(mocks.configureDangerBypass).toHaveBeenCalledWith(config.tools.exec.danger);
    // The configured sandbox policy reaches the exec choke point.
    expect(getResolvedSandboxConfig()).toMatchObject({ mode: 'enforced', tier: 'read-only' });
    resetSandboxPolicy();
    expect(mocks.configureChildEnvGitIdentity).toHaveBeenCalledWith(config.git.identity);
    expect(sessionStore.create).toHaveBeenCalledWith({
      id: '',
      title: '',
      model: 'gpt-5.6',
      provider: 'openai',
    });
    expect(touchProject).toHaveBeenCalledWith('D:/repo', 'D:/repo/src');
    // The ACP leader (`provider: "acp"`) is in the registry before the boot provider resolves.
    expect(registerAcpLeader).toHaveBeenCalledOnce();
    expect(registerAcpLeader).toHaveBeenCalledBefore(mocks.resolveSetupProvider);
    const setupInput = mocks.resolveSetupProvider.mock.calls[0]?.[0] as {
      providerRegistry: unknown;
    };
    expect(registerAcpLeader).toHaveBeenCalledWith(setupInput.providerRegistry, config);
    // session_rename renames through the host's session store.
    expect(toolRegistry.registerDefault).toHaveBeenCalledWith({ name: 'session_rename' });
    const renameOpts = (mocks.createSessionRenameTool.mock.calls as unknown[][])[0]?.[0] as {
      rename: (id: string, name: string) => Promise<unknown>;
    };
    await renameOpts.rename('session-1', 'Named');
    expect(sessionStore.rename).toHaveBeenCalledWith('session-1', 'Named');
    expect(mocks.systemPromptBuild).toHaveBeenCalledWith({
      cwd: 'D:/repo',
      projectRoot: 'D:/repo',
      tools: [{ name: 'read_file' }],
      catalogTools: [{ name: 'read_file' }],
      provider: 'openai',
      model: 'gpt-5.6',
      onlineAgents: [{ agentId: 'worker-1', status: 'online' }],
    });
    // CLI parity: the boot builder carries the host-owned sections (plan, autonomy block,
    // WrongTrace digest, Atlas brief, glossary) from the assembly the CLI binds.
    expect(mocks.builderOptions[0]).toMatchObject(mocks.hostSections);
    const sectionsInput = mocks.createHostSystemPromptSections.mock.calls[0]?.[0] as {
      getSessionId(): string | undefined;
    };
    expect(sectionsInput).toMatchObject({
      projectSessionsDir: 'D:/repo/.wstack/sessions',
      projectRoot: 'D:/repo',
      memoryStore: mocks.memoryStore,
      tokenSavingMode: 'balanced',
    });
    expect(sectionsInput.getSessionId()).toBe('session-1');
    expect(mocks.setMeta).toHaveBeenCalledWith(
      'plan.path',
      'D:/repo/.wstack/sessions/session-1.plan.json',
    );
    // The boot session's agent is the leader: leader-only paths (background delegation
    // results, mailbox) skip an agent whose id reads 'unknown'.
    expect(
      (result.context as unknown as { options: Record<string, unknown> }).options,
    ).toMatchObject({ agentId: 'leader', agentName: 'Leader Agent' });
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

  it('keeps the full mailbox capability set when it owns the tool registry', async () => {
    await createPreContextServices({
      config: {
        provider: 'openai',
        model: 'gpt-5.6',
        providers: {},
        features: {
          memory: false,
          mcp: false,
          skills: false,
          prompts: false,
          tokenSavingMode: 'minimal',
        },
        tools: { exec: { danger: { enabled: false } } },
        context: { mode: 'balanced' },
      },
      wpaths: {
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
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      opts: {
        services: {
          modelsRegistry: { refresh: vi.fn() },
          events: { setLogger: vi.fn() },
          configStore: mocks.configStore,
          session: { create: vi.fn().mockResolvedValue({ id: 'session-2' }), prune: vi.fn() },
        },
      },
      vault: {},
      globalConfigPath: 'D:/global/config.json',
      projectRoot: 'D:/repo',
      workingDir: 'D:/repo',
      needsProvider: false,
      vectorMemoryStore: {} as never,
      touchProject: vi.fn(),
    } as never);

    expect(mocks.registerCanonicalHostTools).toHaveBeenCalledWith(
      expect.objectContaining({
        vectorMemory: { store: expect.anything() },
        coordinationTools: expect.arrayContaining([
          expect.objectContaining({ name: 'session_note' }),
        ]),
      }),
    );
    expect(mocks.createMcpControlTool).toHaveBeenCalledOnce();
    expect(mocks.createMcpUseTool).toHaveBeenCalledOnce();
  });
});
