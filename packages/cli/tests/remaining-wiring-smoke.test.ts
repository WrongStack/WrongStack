import { describe, expect, it, vi } from 'vitest';
import { ensureDirectorAndAnnounce } from '../src/wiring/director-announcement.js';
import { setupSessionRuntime } from '../src/wiring/session-runtime.js';
import { createFleetCommandHandlers } from '../src/wiring/fleet-command-handlers.js';
import { createSddHandlers } from '../src/wiring/sdd-handlers.js';
import { createSessionCommandHandlers } from '../src/wiring/session-command-handlers.js';

describe('remaining CLI wiring boundaries', () => {
  it('creates SDD handlers and reports the no-session parallel-run guard', async () => {
    const handlers = createSddHandlers({
      wpaths: {},
      projectRoot: 'D:/repo',
      events: {},
      sessionRef: { current: undefined },
      session: { id: 'session' },
      renderer: {},
      multiAgentHost: {},
      config: {},
      brain: undefined,
      agent: {},
      sddRunRegistry: {},
      getSddRuntimeState: vi.fn().mockResolvedValue({
        tracker: null,
        builder: null,
        graphId: null,
      }),
    });

    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining([
        'onSddParallelRun',
        'onSddParallelStop',
        'onSddRetryAllFailed',
        'onSddSplitTask',
        'onSddCleanWorktrees',
        'onSddRollback',
        'onSddDestroy',
      ]),
    );
    await expect(handlers['onSddParallelRun']?.()).resolves.toContain('No active SDD session');
  });

  it('adapts fleet spawn, wait, status, and unavailable-director operations', async () => {
    const multiAgentHost = {
      spawn: vi.fn().mockResolvedValue({ subagentId: 'agent-1', taskId: 'task-1' }),
      spawnAndWait: vi.fn().mockResolvedValue({
        status: 'success',
        result: 'done',
        durationMs: 1_500,
        iterations: 2,
        toolCalls: 3,
      }),
      status: vi.fn().mockReturnValue({ live: [], completed: [], pending: [] }),
      ensureDirector: vi.fn().mockResolvedValue(null),
    };
    const handlers = createFleetCommandHandlers({
      multiAgentHost: multiAgentHost as never,
      getDirector: () => null,
      events: {} as never,
      getSessionId: () => 'session',
      fleetRoot: 'D:/fleet',
    });

    await expect(
      handlers.onSpawn?.('test', { provider: 'openai', model: 'model', name: 'tester' }),
    ).resolves.toContain('agent-1');
    await expect(handlers.onSpawnAndWait?.('test')).resolves.toContain('success');
    expect(handlers.onAgents?.()).toBe('');
    expect(handlers.onFleetStatus?.()).toBeNull();
    expect(handlers.onFleetUsage?.()).toBeNull();
    await expect(handlers.onFleetKill?.()).resolves.toBe(0);
    await expect(handlers.onFleetTerminate?.('missing')).resolves.toBe(false);
    await expect(handlers.onFleetSpawn?.('custom')).rejects.toMatchObject({
      code: 'AGENT_RUN_FAILED',
    });
    await expect(handlers.onDirector?.()).resolves.toBe('Director is not available.');
  });

  it('updates session context, suggestions, prediction, and MCP projections', () => {
    let config = {
      provider: 'openai',
      nextPrediction: false,
      tools: { disabledTools: [] },
    };
    let nextPredict = false;
    let suggestions = ['local'];
    const mcpRegistry = {
      describe: vi
        .fn()
        .mockReturnValue([{ name: 'server', state: 'connected', enabled: true, toolCount: 2 }]),
    };
    const context = {
      model: 'model',
      meta: {},
      session: { id: 'session' },
      provider: { capabilities: { maxContext: 100 } },
    };
    const input = {
      getConfig: () => config,
      setConfig: vi.fn((next) => {
        config = next;
      }),
      configStore: { update: vi.fn() },
      profileConfigPath: 'D:/config.json',
      context,
      effectiveMaxContext: { current: 100 },
      autoCompactor: { setMaxContext: vi.fn() },
      events: { emit: vi.fn() },
      setEventMaxContext: vi.fn(),
      mcpRegistry,
      onYolo: vi.fn(),
      getNextPredict: () => nextPredict,
      setNextPredict: (enabled: boolean) => {
        nextPredict = enabled;
      },
      getCurrentSuggestions: () => suggestions,
      setCurrentSuggestions: (next: string[]) => {
        suggestions = next;
      },
      teardownHandlers: [],
      multiAgentHost: {},
      logger: { warn: vi.fn() },
      projectRoot: 'D:/repo',
      flags: {},
      tokenCounter: { total: () => ({ input: 0, output: 0 }) },
      errorRing: [],
      toolRegistry: {},
      stats: {},
    };
    const handlers = createSessionCommandHandlers(input as never);

    expect(handlers.onContextLimit?.(200)).toBe(200);
    expect(context.provider.capabilities.maxContext).toBe(200);
    expect(handlers.onNextPredict?.(true)).toBe(true);
    expect(nextPredict).toBe(true);
    expect(handlers.onSuggestions?.(['one', 'two'])).toEqual(['one', 'two']);
    expect(suggestions).toEqual(['one', 'two']);
    expect(handlers.mcpStatus?.()).toEqual([
      { name: 'server', state: 'connected', enabled: true, toolCount: 2 },
    ]);
  });

  it('announces running without Director when Director is disabled', async () => {
    const multiAgentHost = {
      ensureDirector: vi.fn().mockResolvedValue(null),
    };
    const infoLines: string[] = [];
    const renderer = { writeInfo: (msg: string) => infoLines.push(msg) };
    const toolRegistry = { register: vi.fn() };

    const director = await ensureDirectorAndAnnounce({
      multiAgentHost: multiAgentHost as never,
      priorFleetState: undefined,
      renderer,
      toolRegistry: toolRegistry as never,
      flags: {},
      fleetRoot: 'D:/fleet',
      manifestPath: 'D:/manifest',
      sharedScratchpadPath: 'D:/scratchpad',
      subagentSessionsRoot: 'D:/subagents',
    });

    expect(director).toBeNull();
    expect(infoLines).toContain('Running without Director — fleet orchestration tools disabled.');
  });

  it('configures and announces Director in terminal and browser surfaces', async () => {
    const mockDirector = {
      setCheckpointState: vi.fn(),
      tools: vi.fn().mockReturnValue([{ name: 'fleet_tool' }]),
    };
    const multiAgentHost = {
      ensureDirector: vi.fn().mockResolvedValue(mockDirector),
      budgetView: vi.fn().mockReturnValue({
        usedSpawns: 2,
        maxSpawns: 10,
        remainingSpawns: Number.POSITIVE_INFINITY,
        maxConcurrent: 3,
        ceilingMismatch: true,
        checkpointMaxSpawns: 5,
      }),
    };
    const infoLines: string[] = [];
    const renderer = { writeInfo: (msg: string) => infoLines.push(msg) };
    const toolRegistry = { register: vi.fn() };

    // Terminal surface with prior fleet state
    const director = await ensureDirectorAndAnnounce({
      multiAgentHost: multiAgentHost as never,
      priorFleetState: { roles: {} } as never,
      renderer,
      toolRegistry: toolRegistry as never,
      flags: {},
      fleetRoot: 'D:/fleet',
      manifestPath: 'D:/manifest',
      sharedScratchpadPath: 'D:/scratchpad',
      subagentSessionsRoot: 'D:/subagents',
    });

    expect(director).toBe(mockDirector);
    expect(mockDirector.setCheckpointState).toHaveBeenCalledWith({ roles: {} });
    expect(toolRegistry.register).toHaveBeenCalledWith({ name: 'fleet_tool' });
    expect(infoLines.some((l) => l.includes('fleet root → D:/fleet'))).toBe(true);
    expect(infoLines.some((l) => l.includes('checkpoint maxSpawns was 5'))).toBe(true);

    // Browser surface
    infoLines.length = 0;
    await ensureDirectorAndAnnounce({
      multiAgentHost: multiAgentHost as never,
      priorFleetState: undefined,
      renderer,
      toolRegistry: toolRegistry as never,
      flags: { webui: true },
      fleetRoot: 'D:/fleet',
      manifestPath: 'D:/manifest',
      sharedScratchpadPath: 'D:/scratchpad',
      subagentSessionsRoot: 'D:/subagents',
    });
    expect(
      infoLines.some((l) => l.includes('Director mode enabled') && l.includes('→ D:/fleet')),
    ).toBe(true);
  });

  it('wires session runtime, manages reasoning configs and pipeline warnings', async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const evOn = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    });
    const warnLines: string[] = [];
    const logger = { warn: (msg: string) => warnLines.push(msg) };
    const governanceHandle = { installToolBoundary: vi.fn() };
    const modelsRegistry = {
      getModel: vi.fn().mockImplementation(async (p: string) => {
        if (p === 'fail') throw new Error('fail');
        return { capabilities: { reasoningConfig: { default: 'always_on' } } };
      }),
    };

    const runtime = setupSessionRuntime({
      evOn,
      events: { on: evOn, emit: vi.fn() } as never,
      config: { provider: 'test-prov', model: 'test-mod' } as never,
      context: { session: { id: 'sess' } } as never,
      session: { id: 'sess' } as never,
      sessionRef: { current: { id: 'sess' } } as never,
      wpaths: { globalRoot: 'D:/root', projectSlug: 'proj' } as never,
      projectRoot: 'D:/repo',
      renderer: { writeInfo: vi.fn(), writeError: vi.fn() } as never,
      tuiOwnsScreen: false,
      tokenCounter: { total: () => ({ input: 0, output: 0 }) } as never,
      modelsRegistry: modelsRegistry as never,
      configStore: { get: () => ({ modelRuntime: { reasoning: { mode: 'off' } } }) } as never,
      provider: { capabilities: {} as never },
      logger: logger as never,
      governanceHandle: governanceHandle as never,
    });

    expect(governanceHandle.installToolBoundary).toHaveBeenCalledWith(runtime.pipelines);
    expect(runtime.errorRing).toBeDefined();
    expect(runtime.sessionBridge).toBeDefined();
    expect(runtime.stats).toBeDefined();
    expect(typeof runtime.disposeChronicle).toBe('function');

    // Wait a tick for initial refreshActiveReasoningConfig
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.getActiveReasoningConfig()).toEqual({ default: 'always_on' });

    // Exercise pipeline request middleware and warning logging + dedup
    await runtime.pipelines.request.run({ messages: [] } as never);
    expect(warnLines.length).toBe(1);
    await runtime.pipelines.request.run({ messages: [] } as never);
    expect(warnLines.length).toBe(1);

    // Test failing provider
    await runtime.refreshActiveReasoningConfig('fail', 'fail');
    expect(runtime.getActiveReasoningConfig()).toBeUndefined();
  });
});
