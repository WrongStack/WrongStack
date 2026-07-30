import { describe, expect, it, vi } from 'vitest';
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
});
