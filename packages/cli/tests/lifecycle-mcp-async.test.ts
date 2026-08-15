import { MCPRegistry } from '@wrongstack/mcp';
import { describe, expect, it, vi } from 'vitest';
import { setupLifecycleAndPlugins } from '../src/wiring/lifecycle-plugins.js';

vi.mock('@wrongstack/core/coordination', () => ({
  getSharedProjectMailbox: vi.fn().mockReturnValue({}),
}));

vi.mock('../src/wiring/pipeline.js', () => ({
  setupCompaction: vi.fn().mockResolvedValue({
    effectiveMaxContext: 128000,
    autoCompactor: undefined,
  }),
  createAgent: vi.fn().mockReturnValue({
    extensions: { register: vi.fn() },
  }),
}));

vi.mock('../src/wiring/plugins.js', () => ({
  setupPlugins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/wiring/design-studio.js', () => ({
  installDesignStudio: vi.fn(),
}));

describe('Lifecycle MCP Background Initialization', () => {
  it('starts MCP servers asynchronously in the background without blocking lifecycle setup', async () => {
    let mcpStarted = false;
    let resolveMcpStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveMcpStart = () => {
        mcpStarted = true;
        resolve();
      };
    });

    const mockStart = vi.spyOn(MCPRegistry.prototype, 'start').mockImplementation(async () => {
      await startPromise;
    });

    const mockDeps = {
      flags: {},
      config: {
        features: { mcp: true, tokenSavingMode: 'off' },
        mcpServers: {
          testServer: { name: 'testServer', transport: 'stdio', command: 'node', args: [] },
        },
      },
      container: {
        bind: vi.fn(),
        resolve: vi.fn().mockReturnValue({
          use: vi.fn(),
          loadShellHooks: vi.fn(),
        }),
      },
      pipelines: {
        userInput: { use: vi.fn() },
        response: { use: vi.fn() },
        executeTurn: { use: vi.fn() },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      session: { id: 'test-session' },
      sessionBridge: {},
      events: { emit: vi.fn(), on: vi.fn() },
      modelsRegistry: {},
      context: {
        provider: { capabilities: {} },
        meta: { projectRoot: 'D:/test' },
        session: { id: 'test-session' },
      },
      provider: { capabilities: {} },
      modelCapabilitiesRef: { current: undefined },
      reader: {},
      wpaths: {
        projectDir: 'D:/test',
        projectRoot: 'D:/test',
        cacheDir: 'D:/test/cache',
        profileConfig: vi.fn().mockReturnValue('D:/test/profile.json'),
      },
      toolRegistry: { register: vi.fn(), unregister: vi.fn() },
      providerRegistry: {},
      configStore: { get: vi.fn().mockReturnValue({}), watch: vi.fn() },
      eventWiring: { setEffectiveMaxContext: vi.fn() },
      healthRegistry: undefined,
      skillLoader: {},
      promptLoader: {},
      vault: { getSecret: vi.fn(), setSecret: vi.fn() },
      metricsSink: { gauge: vi.fn(), incrementCounter: vi.fn(), recordLatency: vi.fn() },
      renderer: {},
      buildProviderForIdRuntime: vi.fn(),
    };

    // setupLifecycleAndPlugins should return immediately without waiting for startPromise
    const setupPromise = setupLifecycleAndPlugins(mockDeps as never);
    const result = await setupPromise;

    expect(result).toBeDefined();
    expect(mockDeps.pipelines.userInput.use).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'VibeProtocolInput' }),
    );
    expect(mockDeps.pipelines.response.use).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'VibeProtocolAuditor' }),
    );
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ name: 'testServer' }));
    expect(mcpStarted).toBe(false); // Proves setupLifecycle did not block on MCP start!

    // Clean resolve
    resolveMcpStart();
    await startPromise;
    expect(mcpStarted).toBe(true);

    mockStart.mockRestore();
  });
});
