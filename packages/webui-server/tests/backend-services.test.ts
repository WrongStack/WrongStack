import { beforeEach, describe, expect, it, vi } from 'vitest';

// Heavy mocking: backend-services constructs ~20 core modules.
// We mock the constructor-level imports so the factory body runs.
vi.mock('@wrongstack/core/agent', () => ({
  Agent: class FakeAgent {
    ctx: any;
    extensions = { register: vi.fn() };
    constructor(opts: any) {
      this.ctx = opts.context;
    }
  },
}));

vi.mock('@wrongstack/core/coordination', () => ({
  BrainDecisionLedger: class {
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    failureStreakFor = vi.fn(() => 0);
    digestFor = vi.fn(() => undefined);
  },
  BrainMonitor: class {
    start = vi.fn();
    reconfigure = vi.fn();
  },
  CollaborationBus: class {
    onInjectionConsumed = vi.fn(() => () => undefined);
  },
  collabInjectMiddleware: vi.fn(() => ({ name: 'collab-inject', handler: vi.fn() })),
  collabPauseMiddleware: vi.fn(() => ({ name: 'collab-pause', handler: vi.fn() })),
  EscalationRoutingBrainArbiter: class {},
  getSharedProjectMailbox: vi.fn(() => ({ send: vi.fn(async () => undefined) })),
  mailboxSessionTag: vi.fn(() => 'tag'),
  ObservableBrainArbiter: class {},
}));

vi.mock('@wrongstack/core/execution', () => ({
  AutoCompactionMiddleware: class {
    handler = vi.fn(() => vi.fn());
    setMaxContext = vi.fn();
    setEnabled = vi.fn();
  },
  createBrainRuntime: vi.fn(() => ({
    arbiter: { decide: vi.fn() },
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

vi.mock('@wrongstack/core/design', () => ({ installDesignStudioMiddleware: vi.fn() }));

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
vi.mock('../src/server/model-catalog.js', () => ({
  resolveProviderModelMetadata: vi.fn(async () => null),
}));

import { createStrategyCompactor } from '@wrongstack/core/execution';
import { TOKENS } from '@wrongstack/core/kernel';
import { makeLightSubagentFactory } from '@wrongstack/runtime';
import { createAgentServices } from '../src/server/backend-services.js';

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
  beforeEach(() => {
    vi.clearAllMocks();
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
  // desktop app and the standalone server without `context_manager` — the model
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
    services.disposeRealtimeHandlers();
  });

  it('updateAutoCompactionMaxContext runs without throwing', async () => {
    const services = await createAgentServices(makeInput());
    await expect(
      services.updateAutoCompactionMaxContext(
        { id: 'openai', capabilities: { maxContext: 200000 } } as any,
        'openai',
        { type: 'openai' },
      ),
    ).resolves.toBeUndefined();
  });

  it('brainLedger getter returns undefined when disabled', async () => {
    const services = await createAgentServices(makeInput());
    expect(services.brainLedger).toBeUndefined();
  });
});
