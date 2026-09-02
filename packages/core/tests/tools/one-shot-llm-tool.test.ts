import { describe, expect, it, vi } from 'vitest';
import { createOneShotLLMTool, ONE_SHOT_LLM_TOOL_NAME } from '../../src/tools/one-shot-llm-tool.js';
import { FallbackProfileManager } from '../../src/core/fallback-profile-manager.js';
import type { Provider, Request } from '../../src/types/provider.js';

function fakeProvider(id: string): Provider {
  return {
    id,
    capabilities: {
      maxContext: 128_000,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false,
    },
    complete: vi.fn(async (_req: Request) => ({
      model: id,
      content: [{ type: 'text', text: `response from ${id}` }],
      stopReason: 'end_turn',
      usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0 },
    })),
    stream: vi.fn(),
  };
}

function makeFakeConfig(overrides?: Record<string, unknown>) {
  return {
    provider: 'test',
    model: 'test-model',
    fallbackAuto: false,
    ...overrides,
  } as never;
}

describe('createOneShotLLMTool', () => {
  it('has the correct tool name', () => {
    const tool = createOneShotLLMTool({
      buildProvider: async () => fakeProvider('test'),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
    });
    expect(tool.name).toBe(ONE_SHOT_LLM_TOOL_NAME);
    expect(tool.name).toBe('llm');
  });

  it('returns an error when no model/providerId and no defaults configured', async () => {
    const tool = createOneShotLLMTool({
      buildProvider: async () => fakeProvider('test'),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
    });

    const result = await tool.execute({ system: 'hello', userPrompt: 'world' }, {} as never, {
      signal: new AbortController().signal,
    });

    expect(result.text).toBe('');
    expect(result.error).toContain('provide `model`');
    expect(result.error).toContain('providerId');
  });

  it('produces a response when model and providerId are provided explicitly', async () => {
    const tool = createOneShotLLMTool({
      buildProvider: async (pid) => fakeProvider(pid),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
    });

    const result = await tool.execute(
      { system: 'test', userPrompt: 'hello', model: 'my-model', providerId: 'my-provider' },
      {} as never,
      { signal: new AbortController().signal },
    );

    expect(result.text).toContain('response from my-provider');
    expect(result.model).toBe('my-provider');
    expect(result.provider).toBe('my-provider');
  });

  it('uses defaultProvider/defaultModel when caller omits them', async () => {
    const tool = createOneShotLLMTool({
      buildProvider: async (pid) => fakeProvider(pid),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
    });

    const result = await tool.execute({ system: 'test', userPrompt: 'hello' }, {} as never, {
      signal: new AbortController().signal,
    });

    expect(result.text).toContain('response from default-prov');
    expect(result.provider).toBe('default-prov');
  });

  it('forwards the tool executor signal when input has no explicit signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const provider = fakeProvider('default-prov');
    provider.complete = vi.fn(async (_request, opts) => {
      observedSignal = opts.signal;
      return {
        model: 'default-model',
        content: [{ type: 'text', text: 'ok' }],
      };
    });
    const tool = createOneShotLLMTool({
      buildProvider: async () => provider,
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
    });
    const controller = new AbortController();

    await tool.execute({ system: 'test', userPrompt: 'hello' }, {} as never, {
      signal: controller.signal,
    });

    expect(observedSignal).toBeDefined();
    expect(observedSignal).not.toBe(controller.signal);
    controller.abort();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('declares safe meta-tool metadata and a locked-down schema', () => {
    const tool = createOneShotLLMTool({
      buildProvider: async () => fakeProvider('test'),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
    });
    // Consistent with council-tool.ts: read-only meta tool.
    expect(tool.category).toBe('meta');
    expect(tool.riskTier).toBe('safe');
    expect(tool.maxOutputBytes).toBe(262_144);
    // Unknown input keys must be rejected at schema level.
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('validate() rejects calls with neither userPrompt nor messages', () => {
    const tool = createOneShotLLMTool({
      buildProvider: async () => fakeProvider('test'),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
      defaultProvider: 'p',
      defaultModel: 'm',
    });
    expect(tool.validate?.({ system: 'only a system prompt' })).toEqual([
      expect.stringContaining('userPrompt'),
    ]);
    expect(tool.validate?.({ userPrompt: '   ' })).toHaveLength(1);
    expect(tool.validate?.({ messages: [] })).toHaveLength(1);
    expect(tool.validate?.({ userPrompt: 'hi' })).toEqual([]);
    expect(tool.validate?.({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([]);
  });

  it('forwards the modelRouter so matrix picks override the defaults by role', async () => {
    const tool = createOneShotLLMTool({
      buildProvider: async (pid) => fakeProvider(pid),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
      modelRouter: {
        pickForTask: () => ({ provider: 'routed-prov', model: 'routed-model', fromMatrix: true }),
      } as never,
    });

    const result = await tool.execute({ userPrompt: 'hello', role: 'critic' }, {} as never, {
      signal: new AbortController().signal,
    });

    expect(result.provider).toBe('routed-prov');
  });

  it('forwards the statusTracker so llm calls record provider health', async () => {
    const statusTracker = {
      isAvailable: vi.fn(() => true),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const tool = createOneShotLLMTool({
      buildProvider: async (pid) => fakeProvider(pid),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
      statusTracker: statusTracker as never,
    });

    await tool.execute({ userPrompt: 'hello' }, {} as never, {
      signal: new AbortController().signal,
    });

    expect(statusTracker.recordSuccess).toHaveBeenCalledWith('default-prov', 'default-model');
  });

  it('clamps an absurd timeoutMs without failing the call', async () => {
    const tool = createOneShotLLMTool({
      buildProvider: async (pid) => fakeProvider(pid),
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
    });

    const result = await tool.execute({ userPrompt: 'hello', timeoutMs: 10_000_000 }, {} as never, {
      signal: new AbortController().signal,
    });

    expect(result.error).toBeUndefined();
    expect(result.text).toContain('response from default-prov');
  });

  it('composes an explicit input signal with the tool executor signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const provider = fakeProvider('default-prov');
    provider.complete = vi.fn(async (_request, opts) => {
      observedSignal = opts.signal;
      return {
        model: 'default-model',
        content: [{ type: 'text', text: 'ok' }],
      };
    });
    const tool = createOneShotLLMTool({
      buildProvider: async () => provider,
      getConfig: () => makeFakeConfig(),
      fallbackProfileManager: new FallbackProfileManager(makeFakeConfig()),
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
    });
    const inputController = new AbortController();
    const executorController = new AbortController();

    await tool.execute(
      { system: 'test', userPrompt: 'hello', signal: inputController.signal },
      {} as never,
      { signal: executorController.signal },
    );

    expect(observedSignal).toBeDefined();
    expect(observedSignal).not.toBe(inputController.signal);
    expect(observedSignal).not.toBe(executorController.signal);
    executorController.abort();
    expect(observedSignal?.aborted).toBe(true);
  });
});
