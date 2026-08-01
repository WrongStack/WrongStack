import { describe, expect, it, vi, beforeEach } from 'vitest';
import { setupPipelines, setupCompaction, createAgent } from '../src/wiring/pipeline.js';
import { Agent } from '@wrongstack/core/agent';
import { AutoCompactionMiddleware } from '@wrongstack/core/execution';
import { Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { DefaultSecretScrubber, DefaultPermissionPolicy } from '@wrongstack/core/security';

vi.mock('@wrongstack/providers', () => ({
  capabilitiesFor: vi.fn(),
}));

const { capabilitiesFor } = (await import('@wrongstack/providers')) as unknown as {
  capabilitiesFor: ReturnType<typeof vi.fn>;
};

function bootContainer(): Container {
  const c = new Container();
  c.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  c.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  c.bind(TOKENS.PermissionPolicy, () => new DefaultPermissionPolicy({ yolo: true, trustFile: '/tmp/test-trust.json' }));
  return c;
}

function fakeContext(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    model: 'm',
    messages: [],
    systemPrompt: [],
    tools: [],
    state: {},
    session: { id: 'test-session' },
    ...overrides,
  } as never;
}

function fakeProvider(maxContext = 100_000) {
  return {
    id: 'p',
    capabilities: { maxContext },
  } as never;
}

function fakeModelsRegistry() {
  return {
    getModel: vi.fn().mockRejectedValue(new Error('model not found in registry')),
  } as never;
}

beforeEach(() => {
  capabilitiesFor.mockReset();
});

describe('setupPipelines', () => {
  it('returns a pipelines object with installed error boundaries', () => {
    const events = new EventBus();
    const logger = new DefaultLogger({ level: 'error' });
    const p = setupPipelines({ events, logger });
    expect(p.request).toBeDefined();
    expect(p.response).toBeDefined();
    expect(p.toolCall).toBeDefined();
    expect(p.contextWindow).toBeDefined();
    expect(p.userInput).toBeDefined();
    expect(p.assistantOutput).toBeDefined();
  });

  it('error boundary rethrows for core middleware', async () => {
    const events = new EventBus();
    const errSpy = vi.spyOn(events, 'emit');
    const p = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    p.request.use({
      name: 'crashy',
      owner: 'core',
      handler: () => {
        throw new Error('boom');
      },
    });
    await expect(p.request.run({} as never)).rejects.toThrow(/boom/);
    expect(errSpy).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ phase: 'pipeline:crashy' }),
    );
  });

  it('error boundary swallows for plugin-owned middleware', async () => {
    const events = new EventBus();
    const p = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    p.response.use({
      name: 'plugin-thing',
      owner: 'some-plugin',
      handler: () => {
        throw new Error('plugin-error');
      },
    });
    // Should NOT reject — swallowed.
    await expect(p.response.run({} as never)).resolves.toBeDefined();
  });
});

describe('setupCompaction', () => {
  it('uses provider.capabilities.maxContext when no override', async () => {
    capabilitiesFor.mockResolvedValue(undefined);
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext(),
      config: {
        context: { warnThreshold: 70, softThreshold: 85, hardThreshold: 95 },
      },
      provider: fakeProvider(50_000),
      pipelines,
    });
    expect(result.effectiveMaxContext).toBe(50_000);
    expect(result.autoCompactor).toBeInstanceOf(AutoCompactionMiddleware);
  });

  it('prefers explicit effectiveMaxContext from config', async () => {
    capabilitiesFor.mockResolvedValue({ maxContext: 200_000 });
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext(),
      config: {
        context: {
          warnThreshold: 70,
          softThreshold: 85,
          hardThreshold: 95,
          effectiveMaxContext: 8_000,
        },
      },
      provider: fakeProvider(),
      pipelines,
    });
    expect(result.effectiveMaxContext).toBe(8_000);
  });

  it('falls back to capabilitiesFor result when present', async () => {
    capabilitiesFor.mockResolvedValue({ maxContext: 150_000 });
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext(),
      config: { context: { warnThreshold: 70, softThreshold: 85, hardThreshold: 95 } },
      provider: fakeProvider(99_000),
      pipelines,
    });
    expect(result.effectiveMaxContext).toBe(150_000);
  });

  it('does not trust catalog maxContext for custom baseUrl providers', async () => {
    capabilitiesFor.mockResolvedValue({ maxContext: 1_050_000 });
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext({ model: 'gpt-5.5' }),
      config: {
        provider: 'openai',
        model: 'gpt-5.5',
        providers: { openai: { type: 'openai', baseUrl: 'http://127.0.0.1:8317/v1' } },
        context: { warnThreshold: 70, softThreshold: 85, hardThreshold: 95 },
      },
      provider: fakeProvider(128_000),
      pipelines,
    });
    expect(result.effectiveMaxContext).toBe(128_000);
    expect(capabilitiesFor).not.toHaveBeenCalled();
  });

  it('trusts catalog maxContext when baseUrl equals the catalog apiBase', async () => {
    // OpenRouter added from the catalog persists its own apiBase as baseUrl —
    // that is NOT a custom proxy, so the published 1M window must still apply.
    capabilitiesFor.mockResolvedValue({ maxContext: 1_000_000 });
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const registry = {
      getModel: vi.fn().mockRejectedValue(new Error('unused')),
      getProvider: vi.fn().mockResolvedValue({ apiBase: 'https://openrouter.ai/api/v1' }),
    } as never;
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: registry,
      context: fakeContext({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free' }),
      config: {
        provider: 'openrouter',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        // baseUrl differs only by a trailing slash — normalization must match.
        providers: {
          openrouter: { type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/' },
        },
        context: { warnThreshold: 70, softThreshold: 85, hardThreshold: 95 },
      },
      provider: fakeProvider(0),
      pipelines,
    });
    expect(result.effectiveMaxContext).toBe(1_000_000);
    expect(capabilitiesFor).toHaveBeenCalled();
  });

  it('allows provider capabilities.maxContext to override custom baseUrl fallback', async () => {
    capabilitiesFor.mockResolvedValue({ maxContext: 1_050_000 });
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext({ model: 'gpt-5.5' }),
      config: {
        provider: 'openai',
        model: 'gpt-5.5',
        providers: {
          openai: {
            type: 'openai',
            baseUrl: 'http://127.0.0.1:8317/v1',
            capabilities: { maxContext: 96_000 },
          } as never,
        },
        context: { warnThreshold: 70, softThreshold: 85, hardThreshold: 95 },
      },
      provider: fakeProvider(128_000),
      pipelines,
    });
    expect(result.effectiveMaxContext).toBe(96_000);
    expect(capabilitiesFor).not.toHaveBeenCalled();
  });

  it('installs auto-compaction but starts disabled when config.context.autoCompact is false', async () => {
    // The middleware is always wired (when the window is known) so /settings can
    // toggle it live; the autoCompact flag only sets the initial enabled state.
    capabilitiesFor.mockResolvedValue(undefined);
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext(),
      config: {
        context: { autoCompact: false, warnThreshold: 70, softThreshold: 85, hardThreshold: 95 },
      },
      provider: fakeProvider(),
      pipelines,
    });
    expect(result.autoCompactor).toBeInstanceOf(AutoCompactionMiddleware);
    expect(result.autoCompactor?.enabled).toBe(false);
  });

  it('starts auto-compaction enabled by default (autoCompact unset)', async () => {
    capabilitiesFor.mockResolvedValue(undefined);
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext(),
      config: { context: { warnThreshold: 70, softThreshold: 85, hardThreshold: 95 } },
      provider: fakeProvider(),
      pipelines,
    });
    expect(result.autoCompactor?.enabled).toBe(true);
  });

  it('survives capabilitiesFor rejection (catches and uses provider caps)', async () => {
    capabilitiesFor.mockRejectedValue(new Error('network'));
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: new DefaultLogger({ level: 'error' }) });
    const result = await setupCompaction({
      compactor: { compact: vi.fn() } as never,
      events,
      modelsRegistry: fakeModelsRegistry(),
      context: fakeContext(),
      config: { context: { warnThreshold: 70, softThreshold: 85, hardThreshold: 95 } },
      provider: fakeProvider(60_000),
      pipelines,
    });
    expect(result.effectiveMaxContext).toBe(60_000);
  });
});

describe('createAgent', () => {
  it('returns an Agent wired with the supplied registries', () => {
    const container = bootContainer();
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: container.resolve(TOKENS.Logger) });
    const tools = new ToolRegistry();
    const providers = new ProviderRegistry();
    const agent = createAgent({
      container,
      tools,
      providers,
      events,
      pipelines,
      context: fakeContext(),
      config: {
        tools: {
          maxIterations: 5,
          iterationTimeoutMs: 10_000,
          defaultExecutionStrategy: 'parallel',
          perIterationOutputCapBytes: 100_000,
        },
      },
      confirmAwaiter: { request: vi.fn() } as never,
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('resolves Renderer from container when registered', () => {
    const container = bootContainer();
    container.bind(TOKENS.Renderer, () => ({ write: vi.fn() }) as never);
    const events = new EventBus();
    const pipelines = setupPipelines({ events, logger: container.resolve(TOKENS.Logger) });
    const agent = createAgent({
      container,
      tools: new ToolRegistry(),
      providers: new ProviderRegistry(),
      events,
      pipelines,
      context: fakeContext(),
      config: {
        tools: {
          maxIterations: 3,
          iterationTimeoutMs: 5_000,
          defaultExecutionStrategy: 'sequential',
          perIterationOutputCapBytes: 50_000,
        },
      },
      confirmAwaiter: { request: vi.fn() } as never,
      permissionPolicy: new DefaultPermissionPolicy({ yolo: true, trustFile: '/tmp/test-trust.json' }),
    });
    expect(agent).toBeInstanceOf(Agent);
  });
});
