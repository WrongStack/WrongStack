import type { UserInputPayload } from '@wrongstack/core/agent';
import { FallbackProfileManager } from '@wrongstack/core/agent';
import { Container, TOKENS } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import {
  type Config,
  type Provider,
  ProviderError,
  type SessionWriter,
  type SubagentConfig,
  type Tool,
} from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  abortLightSubagent,
  makeLightSubagentFactory as createLightSubagentFactory,
} from '../src/index.js';

type TestAgentFactory = (
  config: Partial<SubagentConfig>,
) => ReturnType<ReturnType<typeof createLightSubagentFactory>>;

function makeLightSubagentFactory(
  ...args: Parameters<typeof createLightSubagentFactory>
): TestAgentFactory {
  return createLightSubagentFactory(...args) as TestAgentFactory;
}

const reasoningCaps = {
  default: 'enabled',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'],
  preserveThinking: 'optional',
} as const;

const noopProvider: Provider = {
  id: 'noop',
  capabilities: { streaming: false, tools: true, vision: false, reasoning: false },
  async complete() {
    return {
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: 'noop',
    };
  },
  async *stream() {
    yield {
      type: 'response',
      response: {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        model: 'noop',
      },
    };
  },
};

function providerFor(id: string): Provider {
  return {
    ...noopProvider,
    id,
    async complete() {
      return {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        model: id,
      };
    },
  };
}

const readTool: Tool = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object', properties: {} },
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  async execute() {
    return 'ok';
  },
};
const writeTool: Tool = {
  name: 'write',
  description: 'write',
  inputSchema: { type: 'object', properties: {} },
  permission: 'auto',
  mutating: true,
  capabilities: ['fs.write'],
  async execute() {
    return 'ok';
  },
};

function stubLogger(): unknown {
  const l: Record<string, unknown> = {};
  for (const m of ['debug', 'info', 'warn', 'error', 'trace', 'fatal']) l[m] = () => {};
  l.child = () => l;
  return l;
}

function sessionShim(): SessionWriter {
  return {
    id: 'parent',
    transcriptPath: '/tmp/parent.jsonl',
    traceId: 'parent-trace',
    get pendingToolUses() {
      return [];
    },
    append: () => {},
    appendBatch: () => {},
    flush: () => {},
    close: async () => {},
    recordFileChange: () => {},
    recordSideEffect: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  } satisfies SessionWriter;
}

function makeDeps(providerRegistered = true, configOverride: Partial<Config> = {}) {
  const config = {
    version: 1,
    provider: 'noop',
    model: 'noop',
    providers: { noop: { type: 'noop' } },
    features: {},
    tools: {},
    ...configOverride,
  } as never as Config;

  const container = new Container();
  container.bind(TOKENS.Logger, () => stubLogger() as never);
  container.bind(TOKENS.ConfigStore, () => new DefaultConfigStore(config));
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(
    TOKENS.TokenCounter,
    () =>
      ({
        count: () => 0,
        countMessages: () => 0,
        add: () => {},
        total: () => ({ input: 0, output: 0 }),
        estimateCost: () => ({ total: 0 }),
        reset: () => {},
      }) as never,
  );
  container.bind(
    TOKENS.SystemPromptBuilder,
    () =>
      ({
        build: async () => [{ type: 'text', text: 'system' }],
      }) as never,
  );

  const providerRegistry = new ProviderRegistry();
  if (providerRegistered) {
    for (const type of ['noop', 'alt', 'openai', 'anthropic']) {
      providerRegistry.register({ type, create: () => providerFor(type) });
    }
  }

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readTool);
  toolRegistry.register(writeTool);

  return {
    container,
    providerRegistry,
    toolRegistry,
    session: sessionShim(),
    projectRoot: '/proj',
    modelsRegistry: {
      getModel: async () => ({
        capabilities: { reasoningConfig: reasoningCaps },
      }),
    } as never,
  };
}

describe('makeLightSubagentFactory', () => {
  it('builds a fresh isolated Agent with its own EventBus', async () => {
    const factory = makeLightSubagentFactory(makeDeps());
    const a = await factory({ id: 's1', role: 'executor' });
    const b = await factory({ id: 's2', role: 'executor' });
    expect(a.agent).toBeDefined();
    expect(a.events).toBeDefined();
    // Isolation: each subagent gets a distinct bus + context.
    expect(a.events).not.toBe(b.events);
    expect(a.agent).not.toBe(b.agent);
  });

  it('installs an opt-in trusted tool boundary on each isolated pipeline', async () => {
    const installToolBoundary = vi.fn(
      (pipelines: import('@wrongstack/core/agent').AgentPipelines) => {
        pipelines.toolCall.prepend({
          name: 'TrustedTestBoundary',
          async handler(payload, next) {
            return next(payload);
          },
        });
      },
    );
    const factory = makeLightSubagentFactory({ ...makeDeps(), installToolBoundary });
    const built = await factory({ id: 'governed-light' });

    expect(installToolBoundary).toHaveBeenCalledOnce();
    expect(installToolBoundary).toHaveBeenCalledWith(built.agent.pipelines);
    expect(built.agent.pipelines.toolCall.list()[0]).toBe('TrustedTestBoundary');
  });

  it('honours per-task cwd (worktree isolation)', async () => {
    const factory = makeLightSubagentFactory(makeDeps());
    const r = await factory({ id: 's1', cwd: '/proj/.wt/task-1' });
    expect(r.agent.ctx.cwd).toBe('/proj/.wt/task-1');
  });

  it('defaults cwd to the deps cwd/projectRoot when unset', async () => {
    const factory = makeLightSubagentFactory(makeDeps());
    const r = await factory({ id: 's1' });
    expect(r.agent.ctx.cwd).toBe('/proj');
  });

  it('prefers the dependency cwd when the task does not pin one', async () => {
    const deps = { ...makeDeps(), cwd: '/proj/default-worktree' };
    const r = await makeLightSubagentFactory(deps)({ id: 's1' });
    expect(r.agent.ctx.cwd).toBe('/proj/default-worktree');
  });

  it('scopes tools to the SubagentConfig allowlist (isolated registry)', async () => {
    const deps = makeDeps();
    const factory = makeLightSubagentFactory(deps);
    const r = await factory({ id: 's1', tools: ['read'] });
    const names = r.agent.tools.list().map((t) => t.name);
    expect(names).toEqual(['read']);
    // The shared parent registry is untouched.
    expect(
      deps.toolRegistry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['read', 'write']);
  });

  it('throws a clear error when the provider is not registered', async () => {
    const factory = makeLightSubagentFactory(makeDeps(false));
    await expect(factory({ id: 's1' })).rejects.toThrow(/No provider factory registered/);
  });

  it('falls back to the configured provider when an explicit target is unavailable', async () => {
    const r = await makeLightSubagentFactory(makeDeps())({
      id: 's1',
      provider: 'missing',
      model: 'missing-model',
    });
    expect(r.agent.ctx.provider.id).toBe('noop');
    expect(r.agent.ctx.model).toBe('noop');
  });

  it('builds a provider from legacy top-level credentials when no provider block exists', async () => {
    const deps = makeDeps(true, {
      providers: undefined,
      apiKey: 'legacy-key',
      baseUrl: 'https://example.test',
    } as never);
    const r = await makeLightSubagentFactory(deps)({ id: 's1' });
    expect(r.agent.ctx.provider.id).toBe('noop');
  });

  it('forwards traceId between the subagent session shim and the parent writer', async () => {
    const deps = makeDeps();
    const factory = makeLightSubagentFactory(deps);
    const r = await factory({ id: 's1' });
    expect(r.agent.ctx.session.traceId).toBe('parent-trace');
    r.agent.ctx.session.traceId = 'child-trace';
    expect(deps.session.traceId).toBe('child-trace');
  });

  it('forwards only append lifecycle calls through the guarded session shim', async () => {
    const parent = sessionShim();
    parent.append = vi.fn();
    parent.appendBatch = vi.fn();
    parent.flush = vi.fn();
    const deps = { ...makeDeps(), session: parent };
    const r = await makeLightSubagentFactory(deps)({ id: 's1' });
    const child = r.agent.ctx.session;
    const event = { type: 'message', timestamp: new Date().toISOString() } as never;

    expect(child.pendingToolUses).toEqual([]);
    child.append(event);
    child.appendBatch([event]);
    child.flush();
    await child.close();
    child.recordFileChange({
      path: '/tmp/a',
      action: 'modified',
      before: 'before',
      after: 'after',
    });
    child.recordSideEffect({
      toolUseId: 'tool-1',
      toolName: 'noop',
      input: {},
      risk: 'fs.write',
    });
    await child.writeCheckpoint(1, 'preview');
    await child.writeFileSnapshot(1, []);
    await expect(child.truncateToCheckpoint(1)).resolves.toBe(0);
    await child.clearSession();
    await child.writeInFlightMarker('coverage');
    await child.clearInFlightMarker('clean');

    expect(parent.append).toHaveBeenCalledWith(event);
    expect(parent.appendBatch).toHaveBeenCalledWith([event]);
    expect(parent.flush).toHaveBeenCalledOnce();
  });

  it('aborts its private signal and tolerates agents without a stored controller', async () => {
    const r = await makeLightSubagentFactory(makeDeps())({ id: 's1' });
    expect(r.agent.ctx.signal.aborted).toBe(false);
    abortLightSubagent(r.agent);
    expect(r.agent.ctx.signal.aborted).toBe(true);
    abortLightSubagent(r.agent);

    abortLightSubagent({ ctx: { meta: {} } } as never);
  });

  it('supports prompt, capability, tool-limit, root restriction, and generated-name overrides', async () => {
    const deps = makeDeps(true, {
      features: { allowOutsideProjectRoot: false },
      tools: {
        restrictToProjectRoot: true,
        iterationTimeoutMs: 321,
        perIterationOutputCapBytes: 654,
      },
    } as never);
    const r = await makeLightSubagentFactory(deps)({
      tools: [],
      allowedCapabilities: [],
      systemPromptOverride: 'extra worker rule',
    } as never);

    expect(r.agent.ctx.agentName).toMatch(/^sub_[0-9a-f-]{8}$/);
    expect(r.agent.ctx.systemPrompt.at(-1)).toEqual({
      type: 'text',
      text: 'extra worker rule',
    });
    expect(r.agent.ctx.meta.agentRole).toBeUndefined();
    expect(r.agent.tools.list()).toHaveLength(2);
    expect(r.agent.ctx.allowOutsideProjectRoot).toBe(false);
  });

  it('uses a shared fallback manager without attaching another config watcher', async () => {
    const deps = makeDeps();
    const configStore = deps.container.resolve(TOKENS.ConfigStore);
    const manager = new FallbackProfileManager(configStore.get() as Config);
    deps.container.bind(TOKENS.FallbackProfileManager, () => manager);
    const watch = vi.spyOn(configStore, 'watch');

    await makeLightSubagentFactory(deps)({ id: 's1' });
    expect(watch).not.toHaveBeenCalled();
  });

  it('reloads its private fallback manager when configuration changes', () => {
    const deps = makeDeps();
    const configStore = deps.container.resolve(TOKENS.ConfigStore);
    const watch = vi.spyOn(configStore, 'watch');
    makeLightSubagentFactory(deps);

    expect(watch).toHaveBeenCalledOnce();
    expect(() => configStore.update({ model: 'updated-model' })).not.toThrow();
  });

  it('resolves the models registry from the container and tolerates lookup errors', async () => {
    const deps = makeDeps();
    deps.modelsRegistry = undefined as never;
    const getModel = vi.fn().mockRejectedValue('catalog offline');
    deps.container.bind(TOKENS.ModelsRegistry, () => ({ getModel }) as never);

    const r = await makeLightSubagentFactory(deps)({ id: 's1' });
    expect(getModel).toHaveBeenCalledWith('noop', 'noop');
    expect(r.agent).toBeDefined();
  });

  it('works without any models registry', async () => {
    const deps = makeDeps();
    deps.modelsRegistry = undefined as never;
    const r = await makeLightSubagentFactory(deps)({ id: 's1' });
    expect(r.agent).toBeDefined();
  });

  it('applies role-specific reasoning runtime from the model matrix', async () => {
    const deps = makeDeps(true, {
      modelRuntime: { reasoning: { mode: 'auto', effort: 'high' } },
      modelMatrix: {
        executor: { modelRuntime: { reasoning: { effort: 'low' } } },
      },
    } as never);
    const factory = makeLightSubagentFactory(deps);
    const r = await factory({ id: 's1', role: 'executor' });

    const req = await r.agent.pipelines.request.run({ model: 'noop' } as never);

    expect(req.reasoning).toEqual({ effort: 'low' });
  });

  it('diversifies reviewer away from the implementation lane when no reviewer route is pinned', async () => {
    const deps = makeDeps(true, {
      provider: 'anthropic',
      model: 'anthropic-test-model',
      providers: {
        anthropic: {
          type: 'anthropic',
          apiKey: 'sk-ant',
          models: ['anthropic-test-model'],
        },
        openai: {
          type: 'openai',
          apiKey: 'sk-oai',
          models: ['gpt-5'],
        },
      },
      modelMatrix: {
        '*': { provider: 'anthropic', model: 'anthropic-test-model' },
      },
    } as never);
    const factory = makeLightSubagentFactory(deps);
    const r = await factory({ id: 's1', role: 'reviewer' });

    expect(r.agent.ctx.model).toBe('gpt-5');
    expect(r.agent.ctx.provider.id).toBe('openai');
  });

  it('preserves an explicit reviewer model route', async () => {
    const deps = makeDeps(true, {
      provider: 'anthropic',
      model: 'anthropic-test-model',
      providers: {
        anthropic: {
          type: 'anthropic',
          apiKey: 'sk-ant',
          models: ['anthropic-test-model'],
        },
        openai: {
          type: 'openai',
          apiKey: 'sk-oai',
          models: ['gpt-5'],
        },
      },
      modelMatrix: {
        reviewer: { provider: 'anthropic', model: 'anthropic-test-model' },
      },
    } as never);
    const factory = makeLightSubagentFactory(deps);
    const r = await factory({ id: 's1', role: 'reviewer' });

    expect(r.agent.ctx.model).toBe('anthropic-test-model');
    expect(r.agent.ctx.provider.id).toBe('anthropic');
  });

  // ── fallback must not drift the worker onto the leader's model ──────────
  // getConfig() must pin provider/model to the worker's target so the
  // extension restores the worker, never the leader, after any hop.
  it('restores a worker to its OWN model after a hop, never the leaders', async () => {
    // Pin `now` so the 60s primary cooldown does NOT short-circuit `beforeRun`
    // — we want the half-open probe to actually read `cfg.provider`/`cfg.model`.
    // The mock advances by 70 s on every call: `markPrimaryFailure` fires first
    // (during the hop) and sets `primaryBlockedUntil = now + 60 s`; the next
    // `now()` (during `runBeforeRun`) must clear that gate so the restore path
    // actually runs.
    const deps = makeDeps(true, {
      provider: 'noop',
      model: 'leader-m',
      providers: { noop: { type: 'noop' }, alt: { type: 'alt' } },
    } as never);
    let mockNow = 1000;
    (deps as typeof deps & { now?: () => number }).now = () => {
      mockNow += 70_000;
      return mockNow;
    };
    const factory = makeLightSubagentFactory(deps);
    const r = await factory({
      id: 's1',
      provider: 'alt',
      model: 'worker-m',
      fallbackModels: ['noop/backup-m'],
    } as never);

    expect(r.agent.ctx.model).toBe('worker-m');

    // Drive one hop: the worker's own model fails with a capacity error, so
    // the chain runs and lands on some other candidate.
    let call = 0;
    const runner = r.agent.extensions.wrapProviderRunner(async () => {
      call += 1;
      if (call === 1) throw new ProviderError('rate limited', 429, true, 'alt');
      return {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        // Return ctx.model (post-hop target), not request.model: the wrapper
        // rebinds request.model internally to the fallback it selected.
        model: r.agent.ctx.model,
      } as never;
    });
    await runner(r.agent.ctx as never, { model: 'worker-m', messages: [] } as never);

    // The chain must land on the worker's OWN configured fallback. When the
    // extension was handed the leader's config, `primaryTarget` put the
    // leader's pair in the chain AHEAD of the explicit `fallbackModels`, so
    // this landed on 'leader-m' instead.
    expect(r.agent.ctx.model).toBe('backup-m');
    expect(r.agent.ctx.provider.id).toBe('noop');

    // beforeRun is the half-open probe back to the primary. With `now` pinned
    // past the cooldown, it ACTUALLY reads `cfg.provider`/`cfg.model` and
    // restores them — those must be the WORKER's pinned pair (`worker-m`/`alt`),
    // never the leader's (`leader-m`/`noop`). This is the independent regression
    // check for the worker-vs-leader-pin bug.
    await r.agent.extensions.runBeforeRun(
      r.agent.ctx as never,
      { content: [], text: '', ctx: r.agent.ctx } as unknown as UserInputPayload,
    );
    expect(r.agent.ctx.model).toBe('worker-m');
    expect(r.agent.ctx.provider.id).toBe('alt');
  });
});
