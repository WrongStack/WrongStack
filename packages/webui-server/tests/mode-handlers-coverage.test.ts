import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  build: vi.fn(),
  createModeRouteHandlers: vi.fn(),
  DefaultSystemPromptBuilder: vi.fn(),
  resolveWstackPaths: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@wrongstack/core/agent', () => ({
  DefaultSystemPromptBuilder: mocks.DefaultSystemPromptBuilder,
}));
vi.mock('@wrongstack/core/utils', () => ({ resolveWstackPaths: mocks.resolveWstackPaths }));
vi.mock('../src/server/mode-routes.js', () => ({
  createModeRouteHandlers: mocks.createModeRouteHandlers,
}));
vi.mock('../src/server/ws-utils.js', () => ({
  broadcast: mocks.broadcast,
  send: mocks.send,
}));

import { createModeHandlers } from '../src/server/mode-handlers.js';

/**
 * `Config['features']` is a required, non-optional key, so every config stub has
 * to carry one. These tests only exercise `features.tokenSavingMode` being
 * absent, so the flags stay off.
 */
const features = {
  mcp: false,
  plugins: false,
  memory: false,
  modelsRegistry: false,
  skills: false,
};

describe('createModeHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWstackPaths.mockReturnValue({
      globalInstructions: 'D:\\global\\instructions',
      inProjectInstructions: 'D:\\repo\\.wstack\\instructions',
    });
    mocks.build.mockResolvedValue('rebuilt system prompt');
    mocks.DefaultSystemPromptBuilder.mockImplementation(function MockSystemPromptBuilder() {
      return { build: mocks.build };
    });
    mocks.createModeRouteHandlers.mockImplementation((options) => ({ options }));
  });

  it('rebuilds the prompt from live config and broadcasts the switched session', async () => {
    const modeStore = {
      getMode: vi.fn().mockResolvedValue({ id: 'review', prompt: 'Review carefully' }),
    };
    const liveConfig = {
      provider: 'openai',
      model: 'gpt-5.6',
      systemPrompt: { variant: 'pro' as const },
      features,
    };
    const sessionStartPayload = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      mode: 'review',
    });
    // A real Context always carries a meta bag — the mode is stamped on it so
    // the session reports the mode ITS tab is running.
    const context = { session: { id: 'session-1' }, systemPrompt: 'old prompt', meta: {} };
    const toolRegistry = {
      list: vi.fn(() => [{ name: 'read_file' }]),
      listForProvider: vi.fn(() => [{ name: 'read_file' }]),
    };

    const handlers = createModeHandlers({
      modeStore: modeStore as never,
      memoryStore: {} as never,
      skillLoader: {} as never,
      modelCapabilities: { vision: true } as never,
      context: context as never,
      toolRegistry: toolRegistry as never,
      config: { provider: 'stale', model: 'stale', features },
      getConfig: () => liveConfig,
      projectRoot: 'D:\\repo',
      globalRoot: 'D:\\global',
      clients: new Map(),
      setModeId: vi.fn(),
      sessionStartPayload: sessionStartPayload as never,
    });

    const routeOptions = mocks.createModeRouteHandlers.mock.calls[0]?.[0];
    expect(handlers).toEqual({ options: routeOptions });
    await routeOptions.afterSwitch('review');

    expect(modeStore.getMode).toHaveBeenCalledWith('review');
    expect(mocks.DefaultSystemPromptBuilder).toHaveBeenCalledWith(
      expect.objectContaining({
        modeId: 'review',
        modePrompt: 'Review carefully',
        injectMemory: false,
        instructionPaths: {
          globalDir: 'D:\\global\\instructions',
          projectDir: 'D:\\repo\\.wstack\\instructions',
          systemVariant: 'pro',
        },
      }),
    );
    expect(mocks.build).toHaveBeenCalledWith({
      cwd: 'D:\\repo',
      projectRoot: 'D:\\repo',
      tools: [{ name: 'read_file' }],
      catalogTools: [{ name: 'read_file' }],
      provider: 'openai',
      model: 'gpt-5.6',
    });
    expect(context.systemPrompt).toBe('rebuilt system prompt');
    expect(mocks.broadcast).toHaveBeenCalledWith(new Map(), {
      type: 'session.start',
      payload: { sessionId: 'session-1', mode: 'review' },
    });
  });

  it('does not look up a custom prompt for default mode', async () => {
    const modeStore = { getMode: vi.fn() };
    createModeHandlers({
      modeStore: modeStore as never,
      memoryStore: {} as never,
      skillLoader: undefined,
      modelCapabilities: {} as never,
      context: { session: {}, systemPrompt: '', meta: {} } as never,
      toolRegistry: { list: () => [], listForProvider: () => [] } as never,
      config: { provider: 'openai', model: 'gpt-5.6', features },
      projectRoot: 'D:\\repo',
      globalRoot: 'D:\\global',
      clients: new Map(),
      setModeId: vi.fn(),
      sessionStartPayload: vi.fn().mockResolvedValue({}) as never,
    });

    await mocks.createModeRouteHandlers.mock.calls[0]?.[0].afterSwitch('default');
    expect(modeStore.getMode).not.toHaveBeenCalled();
    expect(mocks.DefaultSystemPromptBuilder).toHaveBeenCalledWith(
      expect.objectContaining({ modeId: 'default', modePrompt: '' }),
    );
  });
});
