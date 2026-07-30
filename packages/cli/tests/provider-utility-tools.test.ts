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

vi.mock('@wrongstack/core/execution', () => ({
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
