import { TOKENS } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setupMetrics: vi.fn(),
  setupTeardownRegistrar: vi.fn(),
  wireEventWiring: vi.fn(),
  registerJevTools: vi.fn(),
  providerToolsForVariant: vi.fn(),
  loadOnlineAgentsForPrompt: vi.fn(),
}));

vi.mock('@wrongstack/core/agent', () => ({
  providerToolsForVariant: mocks.providerToolsForVariant,
}));
vi.mock('@wrongstack/tools/management', () => ({ registerJevTools: mocks.registerJevTools }));
vi.mock('../src/wiring/metrics.js', () => ({ setupMetrics: mocks.setupMetrics }));
vi.mock('../src/wiring/teardown-registrar.js', () => ({
  setupTeardownRegistrar: mocks.setupTeardownRegistrar,
}));
vi.mock('../src/boot/event-wiring.js', () => ({ wireEventWiring: mocks.wireEventWiring }));
vi.mock('../src/cli-main-helpers.js', () => ({
  loadOnlineAgentsForPrompt: mocks.loadOnlineAgentsForPrompt,
}));

import { setupCliInfrastructure } from '../src/cli-infrastructure.js';
import { CLI_VERSION } from '../src/version.js';

type Inputs = Parameters<typeof setupCliInfrastructure>[0];
type EventWiringInputs = Parameters<
  typeof import('../src/boot/event-wiring.js').wireEventWiring
>[0];

beforeEach(() => vi.resetAllMocks());

function harness() {
  let config = {
    version: 1,
    provider: 'fixture-provider',
    model: 'fixture-model',
    systemPrompt: { variant: 'lite' },
    observability: { otlp: { enabled: false } },
  } as Config;
  const metrics = {
    metricsSink: {},
    healthRegistry: {},
    metricsStatus: { enabled: false },
    tracer: {},
  };
  const registrar = { tuiOwnsScreen: true, evOn: vi.fn() };
  const eventWiring = { setEffectiveMaxContext: vi.fn() };
  const disposeJevTools = vi.fn();
  const build = vi.fn().mockResolvedValue('fixture system prompt');
  const promptBuilder = { build };
  const onlineAgents = [{ agentId: 'online-worker' }];
  const providerTools = [{ name: 'provider-tool' }];
  const catalogTools = [...providerTools, { name: 'catalog-only-tool' }];
  const resolve = vi.fn().mockReturnValue(promptBuilder);
  const inputs: Inputs = {
    flags: { tui: true },
    wpaths: {
      projectDir: '/fixture/.wrongstack',
      projectSlug: 'fixture-project',
    } as Inputs['wpaths'],
    events: {} as Inputs['events'],
    logger: {} as Inputs['logger'],
    getConfig: () => config,
    teardownHandlers: [],
    vectorMemoryStore: undefined,
    renderer: { write: vi.fn() } as unknown as Inputs['renderer'],
    sessionRef: { current: undefined },
    activeMode: null,
    toolRegistry: { list: vi.fn(() => catalogTools) } as unknown as Inputs['toolRegistry'],
    configStore: {} as Inputs['configStore'],
    container: { resolve } as unknown as Inputs['container'],
    cwd: '/fixture/project/src',
    projectRoot: '/fixture/project',
    provider: { id: 'fixture-provider' } as Inputs['provider'],
  };
  mocks.setupMetrics.mockReturnValue(metrics);
  mocks.setupTeardownRegistrar.mockReturnValue(registrar);
  mocks.wireEventWiring.mockReturnValue(eventWiring);
  mocks.registerJevTools.mockReturnValue(disposeJevTools);
  mocks.loadOnlineAgentsForPrompt.mockResolvedValue(onlineAgents);
  mocks.providerToolsForVariant.mockReturnValue(providerTools);
  return {
    inputs,
    metrics,
    registrar,
    eventWiring,
    disposeJevTools,
    build,
    promptBuilder,
    onlineAgents,
    providerTools,
    catalogTools,
    resolve,
    setConfig: (next: Config) => {
      config = next;
    },
  };
}

describe('setupCliInfrastructure', () => {
  it('builds the prompt with provider-visible tools, the full catalog, and online agents', async () => {
    const h = harness();
    const result = await setupCliInfrastructure(h.inputs);

    expect(mocks.setupMetrics).toHaveBeenCalledWith({
      flags: h.inputs.flags,
      wpaths: h.inputs.wpaths,
      events: h.inputs.events,
      logger: h.inputs.logger,
      config: { provider: 'fixture-provider', model: 'fixture-model' },
      observability: {
        config: h.inputs.getConfig().observability,
        serviceVersion: CLI_VERSION,
        teardownHandlers: h.inputs.teardownHandlers,
      },
    });
    expect(mocks.setupTeardownRegistrar).toHaveBeenCalledWith({
      flags: h.inputs.flags,
      events: h.inputs.events,
      logger: h.inputs.logger,
      teardownHandlers: h.inputs.teardownHandlers,
      vectorMemoryStore: undefined,
    });
    expect(mocks.registerJevTools).toHaveBeenCalledWith(
      h.inputs.toolRegistry,
      h.inputs.configStore,
    );
    expect(h.inputs.teardownHandlers).toEqual([h.disposeJevTools]);
    h.inputs.teardownHandlers[0]?.();
    expect(h.disposeJevTools).toHaveBeenCalledOnce();
    expect(h.resolve).toHaveBeenCalledWith(TOKENS.SystemPromptBuilder);
    expect(mocks.providerToolsForVariant).toHaveBeenCalledWith(
      h.inputs.toolRegistry,
      'lite',
      undefined,
      h.inputs.provider,
    );
    expect(h.build).toHaveBeenCalledWith({
      cwd: h.inputs.cwd,
      projectRoot: h.inputs.projectRoot,
      tools: h.providerTools,
      catalogTools: h.catalogTools,
      provider: 'fixture-provider',
      model: 'fixture-model',
      onlineAgents: h.onlineAgents,
    });
    expect(result).toEqual({
      ...h.metrics,
      ...h.registrar,
      eventWiring: h.eventWiring,
      promptBuilder: h.promptBuilder,
      onlineAgents: h.onlineAgents,
      systemPrompt: 'fixture system prompt',
    });
  });

  it('keeps event provider, model, and session getters live and supplies startup defaults', async () => {
    const h = harness();
    await setupCliInfrastructure(h.inputs);
    const wiring = mocks.wireEventWiring.mock.calls[0]![0] as EventWiringInputs;
    expect(wiring).toMatchObject({
      evOn: h.registrar.evOn,
      events: h.inputs.events,
      renderer: h.inputs.renderer,
      projectSlug: 'fixture-project',
      tuiOwnsScreen: true,
    });
    expect(wiring.getSessionId()).toBe('');
    expect(wiring.getActiveModeId()).toBe('off');
    h.setConfig({ ...h.inputs.getConfig(), provider: 'next-provider', model: 'next-model' });
    h.inputs.sessionRef.current = { id: 'next-session' } as Inputs['sessionRef']['current'];
    expect(wiring.getProvider()).toBe('next-provider');
    expect(wiring.getModel()).toBe('next-model');
    expect(wiring.getSessionId()).toBe('next-session');
  });

  it.each([true, false, 'true'] as const)(
    'skips online-agent discovery only for the boolean SimpleUI flag (%s)',
    async (simpleui) => {
      const h = harness();
      h.inputs.flags['simpleui'] = simpleui;
      h.inputs.activeMode = { id: 'plan' } as Inputs['activeMode'];
      h.setConfig({ ...h.inputs.getConfig(), systemPrompt: undefined });
      await setupCliInfrastructure(h.inputs);
      expect(mocks.loadOnlineAgentsForPrompt).toHaveBeenCalledWith(
        h.inputs.wpaths.projectDir,
        simpleui === true,
      );
      expect(mocks.providerToolsForVariant).toHaveBeenCalledWith(
        h.inputs.toolRegistry,
        undefined,
        undefined,
        h.inputs.provider,
      );
      const wiring = mocks.wireEventWiring.mock.calls[0]![0] as EventWiringInputs;
      expect(wiring.getActiveModeId()).toBe('plan');
    },
  );

  it('propagates prompt build failure while retaining the registered tool disposer', async () => {
    const h = harness();
    h.build.mockRejectedValueOnce(new Error('prompt unavailable'));
    await expect(setupCliInfrastructure(h.inputs)).rejects.toThrow('prompt unavailable');
    expect(h.inputs.teardownHandlers).toContain(h.disposeJevTools);
  });
});
