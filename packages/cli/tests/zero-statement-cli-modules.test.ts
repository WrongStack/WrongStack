import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startSharedHeapWatchdog: vi.fn(),
  stopHeapWatchdog: vi.fn(),
  makeProviderFromConfig: vi.fn(),
  rankModels: vi.fn(),
  requiresSage: vi.fn(() => ({ message: 'requires SAGE' })),
  bindSystemPromptBuilder: vi.fn(),
  registerBuiltinTools: vi.fn(),
  createDomainGlossaryAdapter: vi.fn(() => ({ glossary: true })),
  refreshDomainTermsMirror: vi.fn(async () => undefined),
  createCommandHostAdapters: vi.fn(() => ({ hostAdapter: true })),
  createEternalCommandHandlers: vi.fn(() => ({ eternalHandler: true })),
  createFleetCommandHandlers: vi.fn(() => ({ fleetHandler: true })),
  createSddHandlers: vi.fn(() => ({ sddHandler: true })),
  createSessionCommandHandlers: vi.fn(() => ({ sessionHandler: true })),
  buildCommandHostSlashCommands: vi.fn(() => [{ name: 'one' }, { name: 'two' }]),
  setupCliGovernance: vi.fn(async () => ({ close: vi.fn() })),
  configureSimpleUiRuntimeContext: vi.fn(),
  createAuthPanelHost: vi.fn(() => ({ auth: true })),
  createPickableProvidersLoader: vi.fn(() => vi.fn()),
  createRuntimeControllerDeps: vi.fn(() => ({ controllers: true })),
  createRuntimeLifecycleDeps: vi.fn(() => ({ lifecycles: true })),
  createRuntimePickerDeps: vi.fn(() => ({ picker: true })),
  toExecuteDeps: vi.fn((value: unknown) => value),
  execute: vi.fn(async () => 7),
}));

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return { ...actual, startSharedHeapWatchdog: mocks.startSharedHeapWatchdog };
});
vi.mock('@wrongstack/core/registry', () => ({
  ToolRegistry: class FakeToolRegistry {},
}));
vi.mock('@wrongstack/providers', () => ({
  makeProviderFromConfig: mocks.makeProviderFromConfig,
}));
vi.mock('../src/slash-commands/memory-formatters.js', () => ({
  requiresSage: mocks.requiresSage,
}));
vi.mock('../src/subcommands/handlers/modeldiag-profiles.js', () => ({
  EVAL_CATEGORIES: ['coding'],
  EVAL_TASKS: { coding: { label: 'Code', prompt: 'Write code.' } },
  fmtMs: (ms: number) => `${ms}ms`,
  rankModels: mocks.rankModels,
  roleCat: (role: string) => (role === 'coding' ? 'coding' : 'general'),
  scoreBar: (score: number) => String(score),
}));
vi.mock('../src/boot/system-prompt-builder.js', () => ({
  bindSystemPromptBuilder: mocks.bindSystemPromptBuilder,
}));
vi.mock('../src/boot/tool-registry.js', () => ({
  registerBuiltinTools: mocks.registerBuiltinTools,
}));
vi.mock('../src/wiring/domain-glossary.js', () => ({
  createDomainGlossaryAdapter: mocks.createDomainGlossaryAdapter,
}));
vi.mock('../src/wiring/domain-terms-mirror.js', () => ({
  refreshDomainTermsMirror: mocks.refreshDomainTermsMirror,
}));
vi.mock('../src/wiring/command-host-adapters.js', () => ({
  createCommandHostAdapters: mocks.createCommandHostAdapters,
}));
vi.mock('../src/wiring/eternal-command-handlers.js', () => ({
  createEternalCommandHandlers: mocks.createEternalCommandHandlers,
}));
vi.mock('../src/wiring/fleet-command-handlers.js', () => ({
  createFleetCommandHandlers: mocks.createFleetCommandHandlers,
}));
vi.mock('../src/wiring/sdd-handlers.js', () => ({ createSddHandlers: mocks.createSddHandlers }));
vi.mock('../src/wiring/session-command-handlers.js', () => ({
  createSessionCommandHandlers: mocks.createSessionCommandHandlers,
}));
vi.mock('../src/wiring/slash-commands.js', () => ({
  buildCommandHostSlashCommands: mocks.buildCommandHostSlashCommands,
}));
vi.mock('../src/cli-main-helpers.js', () => ({
  createPickableProvidersLoader: mocks.createPickableProvidersLoader,
  getSddRuntimeStateForCli: vi.fn(),
  setupCliGovernance: mocks.setupCliGovernance,
}));
vi.mock('../src/boot/simpleui-full-auto.js', () => ({
  configureSimpleUiRuntimeContext: mocks.configureSimpleUiRuntimeContext,
}));
vi.mock('../src/auth-menu/panel-service.js', () => ({
  createAuthPanelHost: mocks.createAuthPanelHost,
}));
vi.mock('../src/wiring/runtime-controller-deps.js', () => ({
  createRuntimeControllerDeps: mocks.createRuntimeControllerDeps,
}));
vi.mock('../src/wiring/runtime-lifecycle-deps.js', () => ({
  createRuntimeLifecycleDeps: mocks.createRuntimeLifecycleDeps,
}));
vi.mock('../src/wiring/runtime-picker-deps.js', () => ({
  createRuntimePickerDeps: mocks.createRuntimePickerDeps,
}));
vi.mock('../src/wiring/to-execute-deps.js', () => ({ toExecuteDeps: mocks.toExecuteDeps }));
vi.mock('../src/execution.js', () => ({ execute: mocks.execute }));

import { runReplEternalLoop } from '../src/repl-eternal-loop.js';
import { runGatherCommand } from '../src/slash-commands/memory-gather.js';
import { runModeldiagBench } from '../src/subcommands/handlers/modeldiag-bench.js';
import {
  createProviderForId,
  runModeldiagEval,
} from '../src/subcommands/handlers/modeldiag-eval.js';
import { runCliExecution } from '../src/wiring/cli-execute-builder.js';
import { setupCliPromptAndTools } from '../src/wiring/cli-prompt-and-tools-setup.js';
import { setupCliSlashCommands } from '../src/wiring/cli-slash-commands-setup.js';
import { setupCliHeapWatchdog } from '../src/wiring/heap-watchdog-setup.js';
import { setupReplayAndGovernance } from '../src/wiring/replay-governance-setup.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startSharedHeapWatchdog.mockReturnValue(mocks.stopHeapWatchdog);
  mocks.rankModels.mockReturnValue([]);
});

describe('formerly zero-statement CLI modules', () => {
  it('executes the inactive eternal-loop branch', async () => {
    const result = await runReplEternalLoop({ getAutonomy: () => 'auto' } as never, vi.fn());
    expect(result).toBe(false);
  });

  it('executes memory gather backend guarding', async () => {
    await expect(runGatherCommand(null, [])).resolves.toEqual({ message: 'requires SAGE' });
    expect(mocks.requiresSage).toHaveBeenCalledWith('gather');
  });

  it('executes modeldiag bench usage and eval validation', async () => {
    const renderer = { write: vi.fn() };
    await expect(
      runModeldiagBench(['bench'], { renderer } as never, [], { provider: 'openai' }, () => false),
    ).resolves.toBe(0);
    await expect(
      runModeldiagEval(
        ['eval', 'not-a-category'],
        { renderer } as never,
        [],
        { provider: 'openai' },
        () => false,
      ),
    ).resolves.toBe(1);
    expect(renderer.write).toHaveBeenCalled();

    mocks.makeProviderFromConfig.mockReturnValue({ id: 'openai' });
    expect(createProviderForId('openai', { apiKey: 'key' })).toEqual({ id: 'openai' });
  });

  it.each([['setupCliHeapWatchdog', setupCliHeapWatchdog]])(
    'starts and registers cleanup for %s',
    (_name, start) => {
      const teardownHandlers: Array<() => void> = [];
      start({
        flags: { webui: true },
        tuiOwnsScreen: false,
        context: { session: { id: 'session-1' }, state: { messages: [{ _estTokens: 3 }] } },
        hqPublisherRef: {},
        brainMailbox: {
          getHqSnapshotStats: () => ({
            inFlight: false,
            pending: false,
            timerScheduled: false,
            eventInFlight: false,
            pendingEvents: 0,
            coalescedEvents: 0,
            droppedEvents: 0,
          }),
        },
        teardownHandlers,
      } as never);

      const watchdogOptions = mocks.startSharedHeapWatchdog.mock.calls.at(-1)?.[0] as {
        collectStats(): Record<string, unknown>;
      };
      expect(watchdogOptions.collectStats()).toMatchObject({
        surface: 'webui',
        sessionId: 'session-1',
        messages: 1,
        messageEstimatedTokens: 3,
      });
      expect(teardownHandlers).toHaveLength(1);
      teardownHandlers[0]?.();
      expect(mocks.stopHeapWatchdog).toHaveBeenCalled();
    },
  );

  it('binds prompt construction, mirrors terms, and registers built-in tools', async () => {
    const container = { resolve: vi.fn(() => ({ compact: true })) };
    const result = await setupCliPromptAndTools({
      container,
      modeStore: {},
      memoryStore: {},
      skillLoader: {},
      sessionRef: { current: undefined },
      autonomyModeRef: { current: 'auto' },
      modeId: 'default',
      modelCapabilitiesRef: { current: {} },
      config: { features: { skills: true, tokenSavingMode: false }, skills: {} },
      wpaths: {},
      projectRoot: 'D:/repo',
      events: {},
    } as never);

    expect(result.toolRegistry).toBeDefined();
    expect(mocks.bindSystemPromptBuilder).toHaveBeenCalledOnce();
    expect(mocks.refreshDomainTermsMirror).toHaveBeenCalledWith({
      projectRoot: 'D:/repo',
    });
    expect(mocks.registerBuiltinTools).toHaveBeenCalledOnce();
  });

  it('builds and registers CLI slash commands', () => {
    const register = vi.fn();
    setupCliSlashCommands({
      slashRegistry: { register },
      container: { resolve: vi.fn(() => ({})) },
      config: { model: 'model' },
      context: {},
      sessionRef: { current: undefined },
      session: { id: 'session' },
      effectiveMaxContextRef: { current: 100 },
      eventWiring: { setEffectiveMaxContext: vi.fn() },
      getCurrentHiddenItems: () => [],
      secretInputController: { readSecret: vi.fn(), readText: vi.fn() },
      goalHost: {
        onGoalStart: vi.fn(),
        onGoalPause: vi.fn(),
        onGoalResume: vi.fn(),
        onGoalStop: vi.fn(),
        getGoalRunner: vi.fn(),
        onGoalMoveTask: vi.fn(),
        onGoalAssignTask: vi.fn(),
        onGoalAddTask: vi.fn(),
        onGoalRetryTask: vi.fn(),
        onWorktree: vi.fn(),
      },
    } as never);

    expect(register).toHaveBeenCalledTimes(2);
    expect(mocks.buildCommandHostSlashCommands).toHaveBeenCalledOnce();
  });

  it('sets up governance and optional trace context without replay', async () => {
    const memoryStore = { withTraceId: vi.fn() };
    const context = { meta: {} };
    const result = await setupReplayAndGovernance({
      flags: {},
      container: {},
      wpaths: { projectSlug: 'repo' },
      projectRoot: 'D:/repo',
      session: { id: 'session' },
      sessionRef: { current: undefined },
      logger: {},
      events: {},
      planPath: 'D:/repo/plan.md',
      sessionStore: {},
      context,
      traceId: 'trace-1',
      memoryStore,
    } as never);

    expect(result.governanceHandle).toBeDefined();
    expect(mocks.setupCliGovernance).toHaveBeenCalledOnce();
    expect(mocks.configureSimpleUiRuntimeContext).toHaveBeenCalledWith(context.meta, {});
    expect(memoryStore.withTraceId).toHaveBeenCalledWith('trace-1');
  });

  it('assembles execute dependencies and always disposes memory', async () => {
    const dispose = vi.fn();
    const params = {
      config: { features: { skills: false, prompts: false } },
      configRef: { current: { providers: {} } },
      wpaths: {},
      projectRoot: 'D:/repo',
      flags: {},
      positional: [],
      sessResult: { restoredMessages: [], restoredToolCalls: [], restoredEvents: [] },
      memoryStore: { dispose },
      multiAgentHost: { makeSubagentFactory: vi.fn(() => vi.fn()) },
      context: { provider: { id: 'openai' }, model: 'model', toolRegistry: {} },
      effectiveMaxContextRef: { current: 100 },
      sessionRef: { current: undefined },
      session: { id: 'session' },
      modelsRegistry: { getModel: vi.fn() },
      logger: { warn: vi.fn() },
      container: { resolve: vi.fn(() => ({})) },
      setConfig: vi.fn(),
      getCurrentSuggestions: vi.fn(),
      setCurrentSuggestions: vi.fn(),
    };

    await expect(runCliExecution(params as never)).resolves.toBe(7);
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.toExecuteDeps).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
