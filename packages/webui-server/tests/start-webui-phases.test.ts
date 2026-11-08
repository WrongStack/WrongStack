import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  boot: vi.fn(),
  proxy: vi.fn(),
  refresh: vi.fn(),
  persisters: vi.fn(),
  mutate: vi.fn(),
  update: vi.fn(),
  preContext: vi.fn(),
  vector: vi.fn(),
  mirror: vi.fn(),
  todos: vi.fn(),
  touch: vi.fn(),
  governance: vi.fn(),
  otlp: vi.fn(),
  wireMetrics: vi.fn(),
  pipelines: vi.fn(),
  agents: vi.fn(),
}));
vi.mock('../src/server/boot.js', () => ({
  bootConfig: mocks.boot,
  patchConfig: (config: object, patch: object) => ({ ...config, ...patch }),
}));
vi.mock('../src/server/proxy-runtime.js', () => ({ bootstrapWrongProxyFromConfig: mocks.proxy }));
vi.mock('@wrongstack/providers', () => ({ hasSubscriptionRefreshTransaction: mocks.refresh }));
vi.mock('../src/server/provider-token-persisters.js', () => ({
  installWebuiProviderPersisters: mocks.persisters,
}));
vi.mock('../src/server/provider-config-io.js', () => ({ mutateSavedProviders: mocks.mutate }));
vi.mock('../src/server/pref-helpers.js', () => ({ updateGlobalConfig: mocks.update }));
vi.mock('../src/server/pre-context-services.js', () => ({
  createPreContextServices: mocks.preContext,
}));
vi.mock('../src/server/start-webui-vector.js', () => ({
  initVectorMemoryStore: mocks.vector,
  setupVectorMemoryMirror: mocks.mirror,
}));
vi.mock('../src/server/start-webui-todos.js', () => ({
  createStandaloneTodosCheckpointLifecycle: mocks.todos,
}));
vi.mock('../src/server/start-webui-project.js', () => ({ touchProjectEntry: mocks.touch }));
vi.mock('../src/server/governance-runtime.js', () => ({ setupWebUiGovernance: mocks.governance }));
vi.mock('@wrongstack/core/observability', () => ({
  startOtlpExport: mocks.otlp,
  wireMetricsToEvents: mocks.wireMetrics,
  InMemoryMetricsSink: class {
    constructor(readonly options: unknown) {}
  },
}));
vi.mock('../src/server/standalone-pipelines.js', () => ({
  createStandaloneAgentPipelines: mocks.pipelines,
}));
vi.mock('../src/server/backend-services.js', () => ({ createAgentServices: mocks.agents }));

import { createStandaloneAgentServices } from '../src/server/start-webui-agent-services.js';
import { prepareWebuiConfig } from '../src/server/start-webui-config.js';
import { createWebuiPreContextPhase } from '../src/server/start-webui-pre-context.js';

const logger = { warn: vi.fn() };
function preContext() {
  return {
    context: { state: {}, meta: {}, provider: { id: 'live' } },
    events: {},
    session: { id: 'first' },
    memoryStore: { id: 'sage' },
  };
}

beforeEach(() => {
  mocks.boot.mockResolvedValue({
    config: { activeProfile: 'work', providers: { test: { models: ['first-model'] } } },
    wpaths: { profileConfig: (name: string) => `${name}.json` },
    vault: { id: 'boot-vault' },
    logger,
  });
  mocks.refresh.mockReturnValue(false);
  mocks.proxy.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.preContext.mockResolvedValue(preContext());
  mocks.vector.mockReturnValue(undefined);
  mocks.todos.mockReturnValue({ dispose: vi.fn() });
  mocks.governance.mockResolvedValue({ installToolBoundary: vi.fn() });
  mocks.otlp.mockReturnValue({ tracer: { id: 'tracer' } });
  mocks.pipelines.mockReturnValue({ id: 'pipelines' });
  mocks.agents.mockResolvedValue({ id: 'agents' });
});

describe('standalone WebUI startup phases', () => {
  it('selects a saved provider and model and writes through the active profile', async () => {
    const result = await prepareWebuiConfig({});
    expect(result.config).toMatchObject({ provider: 'test', model: 'first-model' });
    expect(result.needsProvider).toBe(false);
    expect(result.profileConfigPath).toBe('work.json');
    expect(mocks.proxy).toHaveBeenCalledOnce();
    const mutate = vi.fn();
    await result.updateGlobalConfig(mutate, 'settings');
    expect(mocks.update).toHaveBeenCalledWith(
      result.prefHelperDeps,
      result.configWriteLock,
      mutate,
      'settings',
    );
    mocks.persisters.mock.calls[0]![0].mutate(mutate);
    expect(mocks.mutate).toHaveBeenCalledWith('work.json', result.vault, mutate);
  });

  it('uses an injected vault and preserves an existing refresh transaction', async () => {
    mocks.refresh.mockReturnValue(true);
    const vault = { id: 'injected-vault' };
    const result = await prepareWebuiConfig({ services: { vault } } as unknown as Parameters<
      typeof prepareWebuiConfig
    >[0]);
    expect(result.vault).toBe(vault);
    expect(mocks.persisters).not.toHaveBeenCalled();
  });

  it('keeps SAGE available when the optional vector store is unavailable', async () => {
    const input = {
      config: {},
      wpaths: { projectSessions: 'sessions' },
      logger,
      opts: {},
      vault: {},
      globalConfigPath: 'global.json',
      projectRoot: 'project',
      workingDir: 'working',
      needsProvider: true,
    };
    const result = await createWebuiPreContextPhase(
      input as unknown as Parameters<typeof createWebuiPreContextPhase>[0],
    );
    expect(result.memoryStore).toBe(result.preContext.memoryStore);
    expect(result.vectorMemoryModelCacheDir).toBe(
      path.join('project', '.wrongstack', 'cache', 'transformers-models'),
    );
    expect(mocks.mirror).not.toHaveBeenCalled();
    mocks.preContext.mock.calls[0]![0].touchProject('new-root', 'new-working');
    expect(mocks.touch).toHaveBeenCalledWith('global.json', 'new-root', 'new-working');
    expect(mocks.todos).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'first', sessionsDir: 'sessions' }),
    );
  });

  it('returns the vector-wrapped memory store and its shutdown disposer', async () => {
    const vector = { id: 'vector' },
      memoryStore = { id: 'wrapped' },
      disposeVectorMirror = vi.fn();
    mocks.vector.mockReturnValue(vector);
    mocks.mirror.mockReturnValue({ memoryStore, disposeVectorMirror });
    const result = await createWebuiPreContextPhase({
      config: {},
      wpaths: {},
      logger,
      opts: {},
      projectRoot: 'project',
    } as unknown as Parameters<typeof createWebuiPreContextPhase>[0]);
    expect(result).toMatchObject({ vectorMemoryStore: vector, memoryStore, disposeVectorMirror });
    expect(mocks.preContext.mock.calls[0]![0].vectorMemoryStore).toBe(vector);
  });

  it('uses live session and config readers for governance and agent services', async () => {
    let session = { id: 'first' };
    const capture = vi.fn();
    const locks = new Map<string, AbortController>();
    const updateGlobalConfig = vi.fn(async (mutate: (config: Record<string, unknown>) => void) => {
      const saved: Record<string, unknown> = {};
      mutate(saved);
      expect(saved.brain).toEqual({ enabled: true });
    });
    const input = {
      opts: {},
      config: {},
      getConfig: () => ({ model: 'live-model' }),
      wpaths: { projectSlug: 'project' },
      logger,
      preContext: preContext(),
      memoryStore: {},
      getSession: () => session,
      getSessionStore: () => ({ captureWorkspaceCheckpoint: capture }),
      sessionRunLocks: locks,
      isDisplayed: vi.fn(),
      updateGlobalConfig,
    };
    const result = await createStandaloneAgentServices(
      input as unknown as Parameters<typeof createStandaloneAgentServices>[0],
    );
    expect(result.agentServices).toEqual({ id: 'agents' });
    session = { id: 'second' };
    await mocks.governance.mock.calls[0]![0].captureWorkspaceCheckpoint();
    expect(capture).toHaveBeenCalledWith('second', 0);
    const agents = mocks.agents.mock.calls[0]![0];
    expect(agents.sessionGetter()).toBe(session);
    locks.set('second', new AbortController());
    expect(agents.isRunActive('second')).toBe(true);
    expect(agents.isRunActive('first')).toBe(false);
    await agents.persistBrainConfig({ enabled: true });
    expect(updateGlobalConfig).toHaveBeenCalledWith(expect.any(Function), 'brain.config');
  });

  it('uses a caller-installed tool boundary without constructing governance', async () => {
    const installToolBoundary = vi.fn();
    await createStandaloneAgentServices({
      opts: { installToolBoundary },
      config: {},
      preContext: preContext(),
      wpaths: {},
      logger,
    } as unknown as Parameters<typeof createStandaloneAgentServices>[0]);
    expect(mocks.governance).not.toHaveBeenCalled();
    expect(mocks.agents.mock.calls[0]![0].installToolBoundary).toBe(installToolBoundary);
  });

  it('feeds OTLP metrics from a sink the engine events fill, only when OTLP wants metrics', async () => {
    const exportMetrics = vi.fn();
    mocks.otlp.mockReturnValueOnce({ wantsMetrics: true, exportMetrics, tracer: undefined });
    const base = {
      opts: { installToolBoundary: vi.fn() },
      config: {},
      preContext: preContext(),
      wpaths: {},
      logger,
    } as unknown as Parameters<typeof createStandaloneAgentServices>[0];
    await createStandaloneAgentServices(base);
    const sink = exportMetrics.mock.calls[0]?.[0];
    expect(sink).toMatchObject({ options: { maxSeriesPerMetric: 500 } });
    // The exporter gets the sink before the events are wired into it.
    expect(exportMetrics.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wireMetrics.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.wireMetrics).toHaveBeenCalledWith(base.preContext.events, sink);

    mocks.wireMetrics.mockClear();
    mocks.otlp.mockReturnValueOnce({ wantsMetrics: false, exportMetrics, tracer: undefined });
    await createStandaloneAgentServices(base);
    expect(mocks.wireMetrics).not.toHaveBeenCalled();
  });
});
