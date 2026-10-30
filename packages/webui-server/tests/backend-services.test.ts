import { beforeEach, describe, expect, it, vi } from 'vitest';

// Heavy mocking: backend-services constructs ~20 core modules.
// We mock the constructor-level imports so the factory body runs.
const brainMonitorOptions = vi.hoisted(
  () =>
    [] as Array<{
      sessionId?: () => string | undefined;
      intervene: (input: { subject: string; body: string; sessionId?: string }) => Promise<void>;
    }>,
);
const brainHostInstances = vi.hoisted(() => ({
  routers: [] as unknown[][],
  traces: [] as any[],
  queues: [] as any[],
  ledgers: [] as any[],
}));

vi.mock('@wrongstack/core/agent', () => ({
  createEventUserInputAwaiter: vi.fn(() => vi.fn(async () => undefined)),
  Agent: class FakeAgent {
    ctx: any;
    extensions = { register: vi.fn() };
    constructor(opts: any) {
      this.ctx = opts.context;
    }
  },
}));
vi.mock('@wrongstack/core/typesafe', () => ({ resolveTypeSafeJudge: vi.fn(() => undefined) }));

vi.mock('@wrongstack/coordination', () => ({
  BrainDecisionLedger: class {
    constructor(public options: any) {
      brainHostInstances.ledgers.push(this);
    }
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    reconfigure = vi.fn();
    failureStreakFor = vi.fn(() => 0);
    digestFor = vi.fn(() => undefined);
  },
  BrainDecisionQueue: class {
    constructor(
      _events: unknown,
      public options: any,
    ) {
      brainHostInstances.queues.push(this);
    }
    dispose = vi.fn();
  },
  BrainTraceRecorder: class {
    constructor(public options: any) {
      brainHostInstances.traces.push(this);
    }
    start = vi.fn();
    stop = vi.fn(async () => undefined);
    reconfigure = vi.fn();
  },
  terminalPolicyDecision: vi.fn(() => ({ type: 'deny', reason: 'terminal' })),
  BrainMonitor: class {
    constructor(options: (typeof brainMonitorOptions)[number]) {
      brainMonitorOptions.push(options);
    }
    start = vi.fn();
    reconfigure = vi.fn();
    stop = vi.fn();
  },
  CollaborationBus: class {
    onInjectionConsumed = vi.fn(() => () => undefined);
  },
  collabInjectMiddleware: vi.fn(() => ({ name: 'collab-inject', handler: vi.fn() })),
  collabPauseMiddleware: vi.fn(() => ({ name: 'collab-pause', handler: vi.fn() })),
  EscalationRoutingBrainArbiter: class {
    constructor(...options: unknown[]) {
      brainHostInstances.routers.push(options);
    }
  },
  getSharedProjectMailbox: vi.fn(() => ({ send: vi.fn(async () => undefined) })),
  mailboxSessionTag: vi.fn(() => 'tag'),
  ObservableBrainArbiter: class {},
}));

// Every AutoCompactionMiddleware the factory builds, so tests can assert what the
// model-switch closure told it (max context, enabled) — the instance is private.
const autoCompactors = vi.hoisted(
  () =>
    [] as Array<{
      initialMaxContext: number;
      setMaxContext: ReturnType<typeof vi.fn>;
      setEnabled: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock('@wrongstack/core/execution', () => ({
  AutoCompactionMiddleware: class {
    handler = vi.fn(() => vi.fn());
    setMaxContext = vi.fn();
    setEnabled = vi.fn();
    initialMaxContext: number;
    constructor(_compactor: unknown, maxContext: number) {
      this.initialMaxContext = maxContext;
      autoCompactors.push(this);
    }
  },
  createBrainRuntime: vi.fn(() => ({
    arbiter: { decide: vi.fn() },
    getMode: vi.fn(() => 'headless'),
    getSnapshot: vi.fn(() => ({ terminalPolicy: 'conservative', decisionLogMaxEntries: 20 })),
    getConfig: vi.fn(() => ({})),
    dispose: vi.fn(),
    getMaxAutoRisk: vi.fn(() => 'medium'),
    apply: vi.fn(() => ({ persisted: Promise.resolve() })),
  })),
  createStrategyCompactor: vi.fn(() => ({ compact: vi.fn() })),
  resolveBrainConfigDefaults: vi.fn(() => ({
    monitor: { enabled: false },
    ledger: { enabled: false },
    fallbackModels: [],
  })),
  ToolExecutor: class {},
}));

vi.mock('@wrongstack/core/design', () => ({
  installDesignStudioMiddleware: vi.fn(),
  installDesignTurnGate: vi.fn(),
}));

vi.mock('@wrongstack/core/storage', () => ({
  SessionMemoryConsolidator: class {},
}));

vi.mock('@wrongstack/sage', () => ({
  createSageToolCallMiddleware: vi.fn(() => ({ name: 'sage-tc', handler: vi.fn() })),
  createSageTurnMiddleware: vi.fn(() => ({ name: 'sage-turn', handler: vi.fn() })),
  getSageRetrieval: vi.fn(() => null),
  getSageService: vi.fn(() => null),
  setupSage: vi.fn(() => vi.fn(async () => undefined)),
}));

vi.mock('@wrongstack/runtime', () => ({ makeLightSubagentFactory: vi.fn(() => vi.fn()) }));

// Mock the WS handler constructors
vi.mock('../src/server/goal-ws-handler.js', () => ({
  GoalWebSocketHandler: class {
    addClient = vi.fn();
    handleMessage = vi.fn(async () => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('../src/server/specs-ws-handler.js', () => ({
  SpecsWebSocketHandler: class {
    handleMessage = vi.fn(async () => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('../src/server/sdd-board-ws-handler.js', () => ({
  SddBoardWebSocketHandler: class {
    handleMessage = vi.fn(async () => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('../src/server/sdd-wizard-ws-handler.js', () => ({
  SddWizardWebSocketHandler: class {
    handleMessage = vi.fn(async () => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('../src/server/sdd-wizard-wiring.js', () => ({ buildSddWizardDeps: vi.fn(() => ({})) }));
vi.mock('../src/server/worktree-ws-handler.js', () => ({
  WorktreeWebSocketHandler: class {
    handleMessage = vi.fn(async () => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('../src/server/terminal-ws-handler.js', () => ({
  TerminalWebSocketHandler: class {
    handleMessage = vi.fn(async () => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('../src/server/collaboration-ws-handler.js', () => ({
  CollaborationWebSocketHandler: class {
    handleMessage = vi.fn(async () => undefined);
    dispose = vi.fn();
  },
}));
vi.mock('../src/server/codebase-indexing.js', () => ({
  setupWebUICodebaseIndexing: vi.fn(() => ({ onFileWritten: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('../src/server/discover-mailbox-bridge.js', () => ({
  discoverMailboxBridgeForWebui: vi.fn(async () => undefined),
}));
// The fallback wiring itself is proven against a real Agent in
// session-agent-fallback-model.test.ts; here only the template call is checked.
vi.mock('../src/server/conversation-fallback.js', () => ({
  installConversationFallback: vi.fn(),
}));
vi.mock('../src/server/model-catalog.js', () => ({
  resolveProviderModelMetadata: vi.fn(async () => null),
}));

import { TOKENS } from '@wrongstack/contracts/kernel';
import { CONTEXT_WINDOW_MODE_PINNED_META_KEY } from '@wrongstack/contracts/types';
import { getSharedProjectMailbox, mailboxSessionTag } from '@wrongstack/coordination';
import { createBrainRuntime, createStrategyCompactor } from '@wrongstack/core/execution';
import { resolveTypeSafeJudge } from '@wrongstack/core/typesafe';
import { makeLightSubagentFactory } from '@wrongstack/runtime';
import { createAgentServices } from '../src/server/backend-services.js';
import { installConversationFallback } from '../src/server/conversation-fallback.js';
import { resolveProviderModelMetadata } from '../src/server/model-catalog.js';

function makeInput(): any {
  return {
    trustBoundary: { authorize: vi.fn(async () => ({ allowed: true })) },
    config: {
      provider: 'openai',
      model: 'gpt-4o',
      providers: {},
      context: { strategy: 'hybrid', autoCompact: true, effectiveMaxContext: 128000 },
      features: { memory: false, memoryConsolidation: false },
      brain: {},
      fallbackModels: [],
      tools: {},
    },
    wpaths: {
      projectDir: '/tmp/proj/.wrongstack',
      projectAutophase: '/tmp/proj/.wrongstack/autophase',
      projectSpecs: '/tmp/proj/.wrongstack/specs',
      projectTaskGraphs: '/tmp/proj/.wrongstack/task-graphs',
      projectSddBoards: '/tmp/proj/.wrongstack/sdd-boards',
      projectSddSession: '/tmp/proj/.wrongstack/sdd-session',
      globalSkills: '/tmp/skills',
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(function (this: any) {
        return this;
      }),
    },
    projectRoot: '/tmp/proj',
    workingDir: '/tmp/proj',
    context: {
      projectRoot: '/tmp/proj',
      cwd: '/tmp/proj',
      provider: { id: 'openai', capabilities: { maxContext: 128000 } },
      model: 'gpt-4o',
      session: { id: 'sess-1' },
      meta: {},
      todos: [],
      tools: [],
      state: { replaceTodos: vi.fn() },
    },
    provider: { id: 'openai', capabilities: { maxContext: 128000, tools: true } },
    container: {
      resolve: vi.fn(() => ({})),
      safeResolve: vi.fn(() => undefined),
      has: vi.fn(() => false),
      bind: vi.fn(),
    },
    // `createAgentServices` registers `context_manager` here (it owns the
    // compactor; the canonical registration in pre-context-services runs
    // before one exists), so the double needs the two registry methods that
    // late registration uses.
    toolRegistry: {
      get: vi.fn(() => undefined),
      registerDefault: vi.fn(),
      exposeToProvider: vi.fn(),
    } as any,
    providerRegistry: { create: vi.fn(() => ({ id: 'openai' })) } as any,
    modelsRegistry: {
      refresh: vi.fn(async () => undefined),
      getModel: vi.fn(async () => undefined),
      getProvider: vi.fn(async () => undefined),
    } as any,
    events: { on: vi.fn(() => () => undefined), emit: vi.fn(), off: vi.fn() } as any,
    mcpRegistry: {} as any,
    memoryStore: { readAll: vi.fn(async () => '') } as any,
    modeStore: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      set: vi.fn(),
      remove: vi.fn(),
    } as any,
    customModeStore: { list: vi.fn(async () => []), get: vi.fn(async () => null) } as any,
    skillLoader: undefined,
    skillInstaller: undefined,
    tokenCounter: { count: vi.fn(() => 0) } as any,
    pipelines: {
      toolCall: { use: vi.fn(), prepend: vi.fn() },
      request: { use: vi.fn() },
      userInput: { use: vi.fn() },
      response: { use: vi.fn() },
      contextWindow: { use: vi.fn() },
    },
    modelCapabilitiesRef: { current: undefined },
    sessionGetter: () => ({ id: 'sess-1' }),
    sessionReader: { read: vi.fn(async () => []) } as any,
    annotationsStore: { add: vi.fn(), list: vi.fn(async () => []) } as any,
  };
}

describe('createAgentServices', () => {
  it('gives the template agent its own fallback-model extension, wired to the live config', async () => {
    const input = makeInput();
    const liveConfig = { ...input.config, model: 'gpt-live' };
    input.getConfig = () => liveConfig;
    vi.mocked(installConversationFallback).mockClear();

    const services = await createAgentServices(input);

    expect(installConversationFallback).toHaveBeenCalledTimes(1);
    const [agent, deps] = vi.mocked(installConversationFallback).mock.calls[0] ?? [];
    expect(agent).toBe(services.agent);
    expect(deps?.getConfig()).toBe(liveConfig);
    expect(deps?.providerRegistry).toBe(input.providerRegistry);
    expect(deps?.container).toBe(input.container);
    expect(deps?.events).toBe(input.events);
    expect(deps?.logger).toBe(input.logger);
  });

  it('resolves the Brain Jev account from the latest host config', async () => {
    const input = makeInput();
    await createAgentServices(input);
    input.config = { ...input.config, typesafe: { enabled: true, judgments: { brain: false } } };
    vi.mocked(createBrainRuntime).mock.calls.at(-1)![0].getSystemOneJudge!();
    expect(resolveTypeSafeJudge).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: input.config, feature: 'brain' }),
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    brainMonitorOptions.length = 0;
    for (const values of Object.values(brainHostInstances)) values.length = 0;
  });

  it('routes live escalation settings and retunes queue ledger and trace on applied config', async () => {
    const services = await createAgentServices(makeInput());
    const runtimeOptions = vi.mocked(createBrainRuntime).mock.calls.at(-1)![0];
    const runtime = services.brainRuntime;
    const router = brainHostInstances.routers.at(-1)!;
    expect(router[1]).toBe(brainHostInstances.queues.at(-1));
    vi.mocked(runtime.getMode).mockReturnValue('interactive');
    vi.mocked(runtime.getSnapshot).mockReturnValue({
      mode: 'interactive',
      terminalPolicy: 'deny-all',
      decisionLogMaxEntries: 3,
    } as never);
    expect((router[2] as () => string)()).toBe('interactive');
    expect((router[3] as () => string)()).toBe('deny-all');
    runtimeOptions.ledger!.setEnabled(true);
    vi.mocked(runtime.getConfig).mockReturnValue({
      trace: { enabled: true, path: '/tmp/brain-first.jsonl', content: 'none' },
    });
    const snapshot = {
      monitor: {},
      humanTimeoutMs: 7,
      decisionLogMaxEntries: 3,
      ledger: { maxMemoryEntries: 12, interventionRetryWindowMs: 9 },
    } as never;
    runtimeOptions.onApplied!(snapshot);
    expect(brainHostInstances.queues.at(-1).options.timeoutMs).toBe(7);
    expect(brainHostInstances.queues.at(-1).options.userInputAwaiter).toBeDefined();
    expect(brainHostInstances.ledgers.at(-1).reconfigure).toHaveBeenCalledWith({
      maxMemoryEntries: 12,
      interventionRetryWindowMs: 9,
    });
    const trace = brainHostInstances.traces.at(-1);
    expect(trace.options).toMatchObject({ filePath: '/tmp/brain-first.jsonl', content: 'none' });
    expect(trace.start).toHaveBeenCalledOnce();
    vi.mocked(runtime.getConfig).mockReturnValue({
      trace: { enabled: true, path: '/tmp/brain-next.jsonl', content: 'redacted' },
    });
    runtimeOptions.onApplied!(snapshot);
    expect(trace.reconfigure).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/brain-next.jsonl', content: 'redacted' }),
    );
    vi.mocked(runtime.getConfig).mockReturnValue({ trace: { enabled: false } });
    runtimeOptions.onApplied!(snapshot);
    expect(trace.stop).toHaveBeenCalledOnce();
    services.disposeRealtimeHandlers();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('does not attribute ownerless monitor events or steers to the foreground tab', async () => {
    const input = makeInput();
    let foreground = 'tab-1';
    input.sessionGetter = () => ({ id: foreground });
    await createAgentServices(input);
    const options = brainMonitorOptions.at(-1);
    const mailbox = vi.mocked(getSharedProjectMailbox).mock.results.at(-1)?.value;

    expect(options?.sessionId).toBeUndefined();
    foreground = 'tab-2';
    await options?.intervene({ subject: 'signal', body: 'guidance' });
    expect(mailbox?.send).not.toHaveBeenCalled();

    await options?.intervene({ subject: 'signal', body: 'guidance', sessionId: 'tab-3' });
    expect(mailboxSessionTag).toHaveBeenCalledWith('tab-3');
    expect(mailbox?.send).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'brain@tag', to: 'leader@tag' }),
    );
  });

  it('installs VIBE protocol middleware on userInput and response pipelines', async () => {
    const input = makeInput();
    await createAgentServices(input);
    const userNames = input.pipelines.userInput.use.mock.calls.map(
      (call: [{ name?: string }]) => call[0]?.name,
    );
    const responseNames = input.pipelines.response.use.mock.calls.map(
      (call: [{ name?: string }]) => call[0]?.name,
    );
    expect(userNames).toContain('VibeProtocolInput');
    expect(responseNames).toContain('VibeProtocolAuditor');
  });

  // The CLI hands `contextTool` to `registerCanonicalHostTools`; this server
  // cannot, because `createPreContextServices` builds the tool registry before
  // `createAgentServices` builds the compactor. That ordering silently left the
  // standalone server without `context_manager` — the model
  // could self-manage its context under `wstack` but nowhere else.
  it('registers context_manager once the compactor exists', async () => {
    const input = makeInput();
    await createAgentServices(input);
    expect(input.toolRegistry.registerDefault).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'context_manager' }),
    );
    expect(input.toolRegistry.exposeToProvider).toHaveBeenCalledWith('context_manager');
  });

  it('honours tools.disabledTools for the late context_manager registration', async () => {
    // `applyDisabled` already ran during the canonical registration, and
    // `ToolRegistry.disable()` ignores names that are not registered yet — so
    // without an explicit check the late registration would resurrect a tool
    // the operator turned off.
    const input = makeInput();
    input.config.tools = { ...(input.config.tools ?? {}), disabledTools: ['context_manager'] };
    await createAgentServices(input);
    expect(input.toolRegistry.registerDefault).not.toHaveBeenCalled();
  });

  it('constructs and returns AgentServices with expected shape', async () => {
    const services = await createAgentServices(makeInput());
    expect(services).toBeDefined();
    expect(services.agent).toBeDefined();
    expect(services.brain).toBeDefined();
    expect(services.toolExecutor).toBeDefined();
    expect(services.goalHandler).toBeDefined();
    expect(services.specsHandler).toBeDefined();
    expect(services.collabHandler).toBeDefined();
    expect(typeof services.disposeRealtimeHandlers).toBe('function');
    expect(typeof services.updateAutoCompactionMaxContext).toBe('function');
    expect(vi.mocked(createStrategyCompactor)).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'hybrid', smart: true }),
    );
  });

  it('installs one trusted boundary and forwards it to light subagents', async () => {
    const input = makeInput();
    const installToolBoundary = vi.fn();
    input.installToolBoundary = installToolBoundary;

    await createAgentServices(input);

    expect(installToolBoundary).toHaveBeenCalledOnce();
    expect(installToolBoundary).toHaveBeenCalledWith(input.pipelines);
    expect(vi.mocked(makeLightSubagentFactory)).toHaveBeenCalledWith(
      expect.objectContaining({ installToolBoundary }),
    );
  });

  it('forwards the shared ProviderModelStatusTracker from the DI container to the light subagent factory', async () => {
    // Regression: a 429 from a subagent's first call must transition the
    // (provider, model) pair to `state: 'blocked'` so the waiting-room
    // view reflects it. The runtime factory accepts `statusTracker` as an
    // optional dep; this test pins the webui-server wiring contract that
    // the container-provided tracker is forwarded (resolved via
    // `safeResolve(TOKENS.ProviderModelStatusTracker)`, mirroring the CLI
    // factory thread at `host-subagent-factory.ts:337`).
    const tracker = { recordFailure: vi.fn(), getBlocked: vi.fn(() => []) } as never;
    const input = makeInput();
    const safeResolve = vi.fn((token: unknown) =>
      token === TOKENS.ProviderModelStatusTracker ? tracker : undefined,
    );
    input.container = { ...input.container, safeResolve };

    await createAgentServices(input);

    expect(safeResolve).toHaveBeenCalledWith(TOKENS.ProviderModelStatusTracker);
    expect(vi.mocked(makeLightSubagentFactory)).toHaveBeenCalledWith(
      expect.objectContaining({ statusTracker: tracker }),
    );
  });

  it('disposeRealtimeHandlers is safe to call', async () => {
    const services = await createAgentServices(makeInput());
    expect(() => services.disposeRealtimeHandlers()).not.toThrow();
  });

  it('disposeRealtimeHandlers is idempotent', async () => {
    const services = await createAgentServices(makeInput());
    services.disposeRealtimeHandlers();
    // `not.toThrow()` alone passed even without the guard: the mocked handlers'
    // dispose() is a no-op, so a second full teardown was invisible. Idempotent
    // means each handler is torn down exactly ONCE.
    expect(() => services.disposeRealtimeHandlers()).not.toThrow();
    expect(services.goalHandler.dispose).toHaveBeenCalledTimes(1);
    expect(services.collabHandler.dispose).toHaveBeenCalledTimes(1);
  });

  describe('updateAutoCompactionMaxContext (model switch)', () => {
    beforeEach(() => {
      autoCompactors.length = 0;
      // The boot-time lookup uses the same mock; default it to "no catalog entry".
      vi.mocked(resolveProviderModelMetadata).mockResolvedValue(undefined);
    });

    function switchedProvider(maxContext: number) {
      return { id: 'openai', capabilities: { maxContext, tools: true } } as any;
    }

    it('prefers the catalog window and propagates it to every consumer', async () => {
      const input = makeInput();
      const services = await createAgentServices(input);
      vi.mocked(resolveProviderModelMetadata).mockResolvedValue({
        capabilities: { maxContext: 1_000_000 },
      } as never);
      const next = switchedProvider(200_000);

      await services.updateAutoCompactionMaxContext(next, 'openai', { type: 'openai' } as never);

      expect(next.capabilities.maxContext).toBe(1_000_000);
      expect(input.context.meta.effectiveMaxContext).toBe(1_000_000);
      expect(input.modelCapabilitiesRef.current).toEqual({
        maxContextTokens: 1_000_000,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
      });
      expect(autoCompactors[0]?.setMaxContext).toHaveBeenCalledWith(1_000_000);
      expect(autoCompactors[0]?.setEnabled).toHaveBeenCalledWith(true);
      expect(input.events.emit).toHaveBeenCalledWith('ctx.max_context', {
        sessionId: 'sess-1',
        providerId: 'openai',
        modelId: 'gpt-4o',
        maxContext: 1_000_000,
      });
    });

    it('falls back to config.context.effectiveMaxContext when the catalog has nothing', async () => {
      const input = makeInput(); // effectiveMaxContext: 128000
      const services = await createAgentServices(input);
      const next = switchedProvider(200_000);
      await services.updateAutoCompactionMaxContext(next, 'openai', { type: 'openai' } as never);
      expect(next.capabilities.maxContext).toBe(128_000);
      expect(autoCompactors[0]?.setMaxContext).toHaveBeenCalledWith(128_000);
    });

    it.each([0, -1])(
      'treats a configured window of %d as unset — like boot and the CLI',
      async (configured) => {
        // Regression: boot fell through to the provider window for 0, but the
        // switch path used `??`, kept the 0, wrote it into the new provider's
        // capabilities and disabled auto-compaction on the next model switch.
        const input = makeInput();
        input.config.context.effectiveMaxContext = configured;
        const services = await createAgentServices(input);
        expect(autoCompactors[0]?.initialMaxContext).toBe(128_000); // boot: provider window

        const next = switchedProvider(200_000);
        await services.updateAutoCompactionMaxContext(next, 'openai', { type: 'openai' } as never);

        expect(next.capabilities.maxContext).toBe(200_000);
        expect(input.context.meta.effectiveMaxContext).toBe(200_000);
        expect(autoCompactors[0]?.setEnabled).toHaveBeenCalledWith(true);
        expect(autoCompactors[0]?.setEnabled).not.toHaveBeenCalledWith(false);
      },
    );

    it('an unknown window (0 everywhere) disables compaction and clears the meta', async () => {
      const input = makeInput();
      input.config.context.effectiveMaxContext = undefined;
      const services = await createAgentServices(input);
      input.context.meta.effectiveMaxContext = 128_000;

      await services.updateAutoCompactionMaxContext(switchedProvider(0), 'openai', {
        type: 'openai',
      } as never);

      expect('effectiveMaxContext' in input.context.meta).toBe(false);
      expect(input.modelCapabilitiesRef.current).toBeUndefined();
      expect(autoCompactors[0]?.setEnabled).toHaveBeenCalledWith(false);
      expect(autoCompactors[0]?.setMaxContext).not.toHaveBeenCalled();
    });

    it('re-resolves the window policy on a switch, but leaves a pinned policy alone', async () => {
      const input = makeInput();
      input.config.context.effectiveMaxContext = undefined;
      const services = await createAgentServices(input);

      await services.updateAutoCompactionMaxContext(switchedProvider(200_000), 'openai', {
        type: 'openai',
      } as never);
      expect(input.context.meta.contextWindowMode).toBe('balanced');

      input.context.meta.contextWindowMode = 'frugal';
      input.context.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] = true;
      await services.updateAutoCompactionMaxContext(switchedProvider(1_000_000), 'openai', {
        type: 'openai',
      } as never);
      expect(input.context.meta.contextWindowMode).toBe('frugal');
    });

    it('skips the models.dev round-trip when the catalog was fetched moments ago', async () => {
      const input = makeInput();
      input.modelsRegistry.ageSeconds = vi.fn(async () => 30);
      const services = await createAgentServices(input);

      await services.updateAutoCompactionMaxContext(switchedProvider(200_000), 'openai', {
        type: 'openai',
      } as never);

      expect(input.modelsRegistry.refresh).not.toHaveBeenCalled();
    });

    it('re-resolves the active window from a catalog change without fetching again', async () => {
      const input = makeInput();
      let onChange: (() => void) | undefined;
      input.modelsRegistry.onCatalogChanged = vi.fn((listener: () => void) => {
        onChange = listener;
        return () => undefined;
      });
      const services = await createAgentServices(input);
      const next = switchedProvider(200_000);
      await services.updateAutoCompactionMaxContext(next, 'openai', { type: 'openai' } as never);
      expect(input.modelsRegistry.refresh).toHaveBeenCalledTimes(1);

      // Boot's background refresh lands with a bigger window for the model.
      vi.mocked(resolveProviderModelMetadata).mockResolvedValue({
        capabilities: { maxContext: 1_000_000 },
      } as never);
      onChange?.();
      await vi.waitFor(() => expect(next.capabilities.maxContext).toBe(1_000_000));

      expect(input.context.meta.effectiveMaxContext).toBe(1_000_000);
      expect(autoCompactors[0]?.setMaxContext).toHaveBeenLastCalledWith(1_000_000);
      // Resolved against the switched-to target, with no second network trip.
      expect(vi.mocked(resolveProviderModelMetadata)).toHaveBeenLastCalledWith(
        input.modelsRegistry,
        'openai',
        'gpt-4o',
        { type: 'openai' },
      );
      expect(input.modelsRegistry.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it('brainLedger getter returns undefined when disabled', async () => {
    const services = await createAgentServices(makeInput());
    expect(services.brainLedger).toBeUndefined();
  });
});
