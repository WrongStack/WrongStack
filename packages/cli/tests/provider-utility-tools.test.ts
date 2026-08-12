import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createOneShotLLMTool: vi.fn(),
  createCouncilTool: vi.fn(),
  createContextManagerTool: vi.fn(),
  orchestratorOptions: [] as unknown[],
  orchestratorCalls: [] as unknown[],
  orchestratorResults: [] as Array<{ text: string }>,
}));

vi.mock('@wrongstack/core/tools', () => ({
  createOneShotLLMTool: mocks.createOneShotLLMTool,
  createCouncilTool: mocks.createCouncilTool,
}));

vi.mock('@wrongstack/core/infrastructure', () => ({
  createContextManagerTool: mocks.createContextManagerTool,
}));

// Only OneShotOrchestrator is faked. The Council persona/profile registries
// come through untouched: their validation IS the behaviour under test, and a
// stub would just assert that a stub was called.
vi.mock('@wrongstack/core/execution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/execution')>()),
  OneShotOrchestrator: class {
    constructor(options: unknown) {
      mocks.orchestratorOptions.push(options);
    }

    call(options: unknown) {
      mocks.orchestratorCalls.push(options);
      return Promise.resolve(mocks.orchestratorResults.shift() ?? { text: '' });
    }
  },
}));

import {
  adoptResumedProvider,
  registerProviderUtilityTools,
} from '../src/wiring/provider-utility-tools.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orchestratorOptions.length = 0;
  mocks.orchestratorCalls.length = 0;
  mocks.orchestratorResults.length = 0;
  mocks.createOneShotLLMTool.mockReturnValue({ name: 'llm' });
  mocks.createCouncilTool.mockReturnValue({ name: 'council' });
  mocks.createContextManagerTool.mockReturnValue({ name: 'context_manager' });
});

describe('adoptResumedProvider', () => {
  it('does nothing without resumed model state', async () => {
    const getConfig = vi.fn();
    const switchProviderAndModel = vi.fn();

    await adoptResumedProvider({
      getConfig,
      switchProviderAndModel,
      logger: { warn: vi.fn() },
    });

    expect(getConfig).not.toHaveBeenCalled();
    expect(switchProviderAndModel).not.toHaveBeenCalled();
  });

  it('normalizes blanks and avoids switching to the current route', async () => {
    const switchProviderAndModel = vi.fn();
    await adoptResumedProvider({
      resumedProvider: '  ',
      resumedModel: ' model ',
      getConfig: () => ({ provider: 'provider', model: 'model' }) as never,
      switchProviderAndModel,
      logger: { warn: vi.fn() },
    });

    expect(switchProviderAndModel).not.toHaveBeenCalled();
  });

  it('switches to resumed state and logs a fallback when switching fails', async () => {
    const warn = vi.fn();
    const getConfig = vi
      .fn()
      .mockReturnValueOnce({ provider: 'current', model: 'current-model' })
      .mockReturnValueOnce({ provider: 'fallback', model: 'fallback-model' });
    const switchProviderAndModel = vi.fn().mockResolvedValue('unavailable');

    await adoptResumedProvider({
      resumedProvider: ' resumed ',
      resumedModel: ' resumed-model ',
      getConfig,
      switchProviderAndModel,
      logger: { warn },
    });

    expect(switchProviderAndModel).toHaveBeenCalledWith('resumed', 'resumed-model');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "could not switch to the session's model resumed/resumed-model (unavailable)",
      ),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fallback/fallback-model'));
  });

  it('stays silent after a successful switch and fills either missing route half', async () => {
    const warn = vi.fn();
    const switchProviderAndModel = vi.fn().mockResolvedValue(null);
    const base = {
      getConfig: () => ({ provider: 'current', model: 'current-model' }) as never,
      switchProviderAndModel,
      logger: { warn },
    };

    await adoptResumedProvider({ ...base, resumedProvider: 'other' });
    await adoptResumedProvider({ ...base, resumedModel: 'other-model' });

    expect(switchProviderAndModel).toHaveBeenNthCalledWith(1, 'other', 'current-model');
    expect(switchProviderAndModel).toHaveBeenNthCalledWith(2, 'current', 'other-model');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('registerProviderUtilityTools', () => {
  function input(registry: {
    register: ReturnType<typeof vi.fn>;
    override: ReturnType<typeof vi.fn>;
  }) {
    return {
      toolRegistry: registry,
      buildProvider: vi.fn(),
      getConfig: () => ({ provider: 'provider', model: 'model' }) as never,
      fallbackProfileManager: { get: vi.fn() },
      statusTracker: { status: vi.fn() },
      compactor: { compact: vi.fn() },
    };
  }

  it('registers LLM and council tools and installs a working context summarizer', async () => {
    const registry = { register: vi.fn(), override: vi.fn() };
    const deps = input(registry);
    mocks.orchestratorResults.push({ text: 'summary' }, { text: '' });

    registerProviderUtilityTools(deps as never);

    expect(mocks.createOneShotLLMTool).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultProvider: 'provider',
        defaultModel: 'model',
        // Without a router the `role` input is inert, and without the tracker
        // the llm tool's calls never record provider health.
        modelRouter: expect.objectContaining({ pickForTask: expect.any(Function) }),
        statusTracker: deps.statusTracker,
      }),
    );
    expect(registry.register).toHaveBeenNthCalledWith(1, { name: 'llm' });
    expect(registry.register).toHaveBeenNthCalledWith(2, { name: 'council' });
    expect(registry.override).toHaveBeenCalledWith('context_manager', {
      name: 'context_manager',
    });
    expect(mocks.orchestratorOptions).toHaveLength(2);

    const contextOptions = mocks.createContextManagerTool.mock.calls[0]?.[0] as {
      summarizer(messages: unknown[]): Promise<string>;
    };
    await expect(contextOptions.summarizer([{ role: 'user' }])).resolves.toBe('summary');
    await expect(contextOptions.summarizer([])).resolves.toBe('(summary unavailable)');
    expect(mocks.orchestratorCalls[0]).toEqual({
      system: 'Summarize concisely. Keep decisions and key facts.',
      messages: [{ role: 'user' }],
      model: 'deepseek-chat',
      maxTokens: 1024,
      timeoutMs: 30_000,
    });
  });

  it('gives the llm tool a live role router that reads the matrix at pick time', () => {
    // Mirror of the council router: the llm tool's `role` input routes through
    // the same live matrix, and `/setmodel` edits must be visible mid-session.
    const registry = { register: vi.fn(), override: vi.fn() };
    const deps = input(registry);
    let matrix: Record<string, { provider: string; model: string }> = {};
    deps.getConfig = () =>
      ({ provider: 'session-provider', model: 'session-model', modelMatrix: matrix }) as never;

    registerProviderUtilityTools(deps as never);

    const llmOptions = mocks.createOneShotLLMTool.mock.calls[0]?.[0] as {
      modelRouter: { pickForTask(role: string, description: string): { model: string } };
      statusTracker: unknown;
    };
    expect(llmOptions.statusTracker).toBe(deps.statusTracker);
    expect(llmOptions.modelRouter.pickForTask('critic', '').model).toBe('session-model');
    matrix = { critic: { provider: 'anthropic', model: 'late-critic' } };
    expect(llmOptions.modelRouter.pickForTask('critic', '').model).toBe('late-critic');
  });

  it('gives the council orchestrator a live role router', () => {
    // Council profiles route seats by ROLE. Without a router those hints were
    // inert and every seat collapsed onto the session provider/model, so a
    // three-seat panel asked one model three times.
    const registry = { register: vi.fn(), override: vi.fn() };
    const deps = input(registry);
    deps.getConfig = () =>
      ({
        provider: 'session-provider',
        model: 'session-model',
        modelMatrix: { critic: { provider: 'anthropic', model: 'matrix-critic' } },
      }) as never;

    registerProviderUtilityTools(deps as never);

    const councilOptions = mocks.orchestratorOptions[0] as {
      modelRouter?: { pickForTask(role: string, description: string): unknown };
    };
    expect(councilOptions.modelRouter).toBeDefined();
    expect(councilOptions.modelRouter?.pickForTask('critic', '')).toEqual(
      expect.objectContaining({ provider: 'anthropic', model: 'matrix-critic', fromMatrix: true }),
    );
  });

  it('reads the router matrix at pick time, not at wiring time', () => {
    // `/setmodel` edits the matrix mid-session; a router snapshotted at boot
    // would keep routing seats to the models configured at startup.
    const registry = { register: vi.fn(), override: vi.fn() };
    const deps = input(registry);
    let matrix: Record<string, { provider: string; model: string }> = {};
    deps.getConfig = () =>
      ({ provider: 'session-provider', model: 'session-model', modelMatrix: matrix }) as never;

    registerProviderUtilityTools(deps as never);
    const router = (
      mocks.orchestratorOptions[0] as {
        modelRouter: { pickForTask(role: string, description: string): { model: string } };
      }
    ).modelRouter;

    expect(router.pickForTask('critic', '').model).toBe('session-model');
    matrix = { critic: { provider: 'anthropic', model: 'late-critic' } };
    expect(router.pickForTask('critic', '').model).toBe('late-critic');
  });

  it('builds council registries from tools.council', () => {
    // createCouncilPersonaRegistry/createCouncilProfileRegistry shipped from
    // day one but no host ever called them, so the tool was pinned to the
    // built-in lenses and panels with no way to add either.
    const registry = { register: vi.fn(), override: vi.fn() };
    const deps = input(registry);
    deps.getConfig = () =>
      ({
        provider: 'p',
        model: 'm',
        tools: {
          council: {
            defaultProfile: 'latency-panel',
            maxConcurrency: 5,
            personas: [
              {
                id: 'latency-hawk',
                name: 'Latency Hawk',
                description: 'Weighs tail latency above all else.',
                instruction: 'Judge every option by its effect on p99 latency.',
              },
            ],
            profiles: [
              {
                id: 'latency-panel',
                seats: [{ persona: 'latency-hawk' }, { persona: 'skeptic' }],
                judge: false,
              },
            ],
          },
        },
      }) as never;

    registerProviderUtilityTools(deps as never);

    const councilOpts = mocks.createCouncilTool.mock.calls[0]?.[0] as {
      defaultProfile?: string;
      maxConcurrency?: number;
      personas?: { has(id: string): boolean };
      profiles?: { has(id: string): boolean };
    };
    expect(councilOpts.defaultProfile).toBe('latency-panel');
    expect(councilOpts.maxConcurrency).toBe(5);
    expect(councilOpts.personas?.has('latency-hawk')).toBe(true);
    // Built-ins survive alongside the custom lens.
    expect(councilOpts.personas?.has('security')).toBe(true);
    expect(councilOpts.profiles?.has('latency-panel')).toBe(true);
    expect(councilOpts.profiles?.has('balanced')).toBe(true);
  });

  it('falls back to the built-in council registries when tools.council is malformed', () => {
    // A bad panel definition must not take the whole tool registration down —
    // same posture as an unresolvable Brain pool entry.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = { register: vi.fn(), override: vi.fn() };
    const deps = input(registry);
    deps.getConfig = () =>
      ({
        provider: 'p',
        model: 'm',
        tools: {
          council: {
            profiles: [{ id: 'broken', seats: [{ persona: 'no-such-lens' }] }],
          },
        },
      }) as never;

    expect(() => registerProviderUtilityTools(deps as never)).not.toThrow();

    const councilOpts = mocks.createCouncilTool.mock.calls[0]?.[0] as {
      personas?: unknown;
      profiles?: unknown;
    };
    expect(councilOpts.personas).toBeUndefined();
    expect(councilOpts.profiles).toBeUndefined();
    expect(registry.register).toHaveBeenCalledWith({ name: 'council' });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('no-such-lens');
    warn.mockRestore();
  });

  it('leaves the council registries untouched when tools.council is absent', () => {
    const registry = { register: vi.fn(), override: vi.fn() };

    registerProviderUtilityTools(input(registry) as never);

    const councilOpts = mocks.createCouncilTool.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(councilOpts.personas).toBeUndefined();
    expect(councilOpts.profiles).toBeUndefined();
    expect(councilOpts.defaultProfile).toBeUndefined();
  });

  it('overrides pre-registered utility tools', () => {
    const registry = {
      register: vi.fn(() => {
        throw new Error('already registered');
      }),
      override: vi.fn(),
    };

    registerProviderUtilityTools(input(registry) as never);

    expect(registry.override).toHaveBeenCalledWith('llm', { name: 'llm' });
    expect(registry.override).toHaveBeenCalledWith('council', { name: 'council' });
  });

  it('contains optional context-manager installation failures', () => {
    const registry = { register: vi.fn(), override: vi.fn() };
    mocks.createContextManagerTool.mockImplementation(() => {
      throw new Error('context manager unavailable');
    });

    expect(() => registerProviderUtilityTools(input(registry) as never)).not.toThrow();
    expect(registry.override).not.toHaveBeenCalledWith('context_manager', expect.anything());
  });
});
