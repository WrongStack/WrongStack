import { describe, expect, it, vi } from 'vitest';
import { createOneShotLLMTool, ONE_SHOT_LLM_TOOL_NAME } from '../../src/tools/one-shot-llm-tool.js';
import type { Provider, Request } from '../../src/types/provider.js';

function fakeProvider(id: string): Provider {
  return {
    id,
    capabilities: { maxContext: 128_000, supportsTools: true, supportsVision: false, supportsReasoning: false },
    complete: vi.fn(async (_req: Request) => ({
      model: id,
      content: [{ type: 'text', text: `response from ${id}` }],
      stopReason: 'end_turn',
      usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0 },
    })),
    stream: vi.fn(),
  };
}

describe('createOneShotLLMTool', () => {
  it('has the correct tool name', () => {
    const tool = createOneShotLLMTool({
      buildProvider: async () => fakeProvider('test'),
      getConfig: () => ({ provider: 'test', model: 'test-model' }) as never,
    });
    expect(tool.name).toBe(ONE_SHOT_LLM_TOOL_NAME);
    expect(tool.name).toBe('llm');
  });

  it('returns an error when no model/providerId and no defaults configured', async () => {
    const tool = createOneShotLLMTool({
      buildProvider: async () => fakeProvider('test'),
      getConfig: () => ({ provider: 'test', model: 'test-model' }) as never,
    });

    const result = await tool.execute({ system: 'hello', userPrompt: 'world' }, {} as never, { signal: new AbortController().signal });

    expect(result.text).toBe('');
    expect(result.error).toContain('provide `model`');
    expect(result.error).toContain('providerId');
  });

  it('produces a response when model and providerId are provided explicitly', async () => {
    const tool = createOneShotLLMTool({
      buildProvider: async (pid) => fakeProvider(pid),
      getConfig: () => ({ provider: 'cfg', model: 'cfg-model' }) as never,
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
      getConfig: () => ({ provider: 'cfg', model: 'cfg-model' }) as never,
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
    });

    const result = await tool.execute(
      { system: 'test', userPrompt: 'hello' },
      {} as never,
      { signal: new AbortController().signal },
    );

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
      getConfig: () => ({ provider: 'cfg', model: 'cfg-model' }) as never,
      defaultProvider: 'default-prov',
      defaultModel: 'default-model',
    });
    const controller = new AbortController();

    await tool.execute(
      { system: 'test', userPrompt: 'hello' },
      {} as never,
      { signal: controller.signal },
    );

    expect(observedSignal).toBeDefined();
    expect(observedSignal).not.toBe(controller.signal);
    controller.abort();
    expect(observedSignal?.aborted).toBe(true);
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
      getConfig: () => ({ provider: 'cfg', model: 'cfg-model' }) as never,
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
