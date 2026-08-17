import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Director,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from '../../src/coordination/director.js';
import {
  makeAskResultTool,
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetTool,
  makeQualityGateTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateAllTool,
  makeTerminateTool,
  makeWorkCompleteTool,
} from '../../src/coordination/director-tools.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';

const dispatchAgentMock = vi.fn();
vi.mock('../../src/coordination/dispatcher.js', () => ({
  dispatchAgent: (...a: unknown[]) => dispatchAgentMock(...a),
}));

type MockDirector = Record<string, ReturnType<typeof vi.fn> | unknown>;

let director: MockDirector;
const asDir = () => director as never as Director;

beforeEach(() => {
  director = {
    id: 'dir1',
    dispatchClassifier: undefined,
    largeAnswerStore: { storeAnswer: vi.fn(), retrieveAnswer: vi.fn() },
    fleetManager: {
      getFleetStats: vi.fn(() => ({ total: 2, running: 1, idle: 1, stopped: 0 })),
      getFleetStatus: vi.fn(() => ({ pending: ['t1'] })),
      snapshot: vi.fn(() => ({ totalCost: 0.5 })),
    },
    fleet: { emit: vi.fn() },
    spawn: vi.fn(async () => 'sub-1'),
    assign: vi.fn(async () => 'task-1'),
    awaitTasks: vi.fn(async () => [{ taskId: 't', status: 'done' }]),
    awaitTasksAny: vi.fn(async () => ({
      completed: [{ taskId: 't', status: 'success' }],
      pending: ['t2'],
    })),
    ask: vi.fn(async () => 'the answer'),
    rollUp: vi.fn(() => 'rolled up'),
    terminate: vi.fn(async () => {}),
    terminateAll: vi.fn(async () => {}),
    status: vi.fn(() => ({ subagents: [{ id: 's1', status: 'running' }] })),
    snapshot: vi.fn(() => ({
      perSubagent: { s1: { iterations: 3, toolCalls: 5, cost: 0.2, lastEventAt: 'ts' } },
    })),
    readSession: vi.fn(async () => ({ lastText: 'hi', stopReason: 'end', toolUses: 1 })),
    spawnCollab: vi.fn(async () => ({
      sessionId: 'cs1',
      overallVerdict: 'approve',
      bugs: [],
      refactorPlans: [],
      evaluations: [],
      summary: 'ok',
    })),
    workComplete: vi.fn(),
  };
  dispatchAgentMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('director tool capabilities', () => {
  it('declares capabilities for subagent permission policy', () => {
    const tools = [
      makeSpawnTool(asDir()),
      makeAssignTool(asDir()),
      makeAwaitTasksTool(asDir()),
      makeAskTool(asDir()),
      makeAskResultTool(asDir()),
      makeRollUpTool(asDir()),
      makeTerminateTool(asDir()),
      makeTerminateAllTool(asDir()),
      makeFleetTool(asDir()),
      makeCollabDebugTool(asDir()),
      makeFleetEmitTool(asDir()),
      makeQualityGateTool(asDir()),
      makeWorkCompleteTool(asDir()),
    ];

    for (const tool of tools) {
      expect(tool.capabilities?.length, tool.name).toBeGreaterThan(0);
    }
    expect(makeTerminateTool(asDir()).capabilities).toContain(ToolCapabilities.SUBAGENT_SPAWN);
    expect(makeFleetTool(asDir()).capabilities).toContain(ToolCapabilities.COORDINATION_FLEET_READ);
  });
});

describe('makeSpawnTool', () => {
  it('spawns from a roster role and applies config overrides', async () => {
    const tool = makeSpawnTool(asDir(), { planner: { name: 'Planner', role: 'planner' } });
    const res = await tool.execute(
      {
        role: 'planner',
        name: 'P2',
        provider: 'openai',
        model: 'gpt-5',
        systemPromptOverride: 'extra',
        maxIterations: 5,
        maxToolCalls: 10,
        maxCostUsd: 1,
        timeoutMs: 1000,
        idleTimeoutMs: 500,
        maxTokens: 2000,
      },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({
      subagentId: 'sub-1',
      name: 'P2',
      provider: 'openai',
      model: 'gpt-5',
    });
    expect(director.spawn).toHaveBeenCalled();
  });

  it('errors on an unknown roster role', async () => {
    const tool = makeSpawnTool(asDir(), { planner: {} as never });
    const res = (await tool.execute({ role: 'nope' }, {} as never, {} as never)) as {
      error: string;
    };
    expect(res.error).toMatch(/unknown role/);
  });

  it('dispatches by description to a matching roster entry', async () => {
    dispatchAgentMock.mockResolvedValue({ role: 'coder', definition: { config: {} } });
    const tool = makeSpawnTool(asDir(), { coder: { name: 'Coder', role: 'coder' } });
    const res = await tool.execute({ description: 'fix the bug' }, {} as never, {} as never);
    expect(res).toMatchObject({ subagentId: 'sub-1' });
  });

  it('dispatches by description to a catalog definition when no roster entry exists', async () => {
    dispatchAgentMock.mockResolvedValue({
      role: 'researcher',
      definition: { config: { name: 'R', provider: 'anthropic', model: 'claude' } },
    });
    const tool = makeSpawnTool(asDir(), {});
    const res = await tool.execute({ description: 'research this' }, {} as never, {} as never);
    expect(res).toMatchObject({ subagentId: 'sub-1', model: 'claude' });
  });

  it('falls back to a name-only config', async () => {
    const tool = makeSpawnTool(asDir());
    await tool.execute({ name: 'bare' }, {} as never, {} as never);
    expect(director.spawn).toHaveBeenCalledWith(expect.objectContaining({ name: 'bare' }));
  });

  it('surfaces spawn, cost, token, and generic errors', async () => {
    const tool = makeSpawnTool(asDir());
    (director.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new FleetSpawnBudgetError('max_spawns', 3, 4),
    );
    expect(
      (await tool.execute({ name: 'x' }, {} as never, {} as never)) as { kind: string },
    ).toMatchObject({ kind: 'max_spawns', limit: 3, observed: 4 });
    (director.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new FleetCostCapError(10, 12),
    );
    expect(
      (await tool.execute({ name: 'x' }, {} as never, {} as never)) as { error: string },
    ).toHaveProperty('error');
    (director.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new FleetTokenCapError(1000, 1200),
    );
    expect(
      (await tool.execute({ name: 'x' }, {} as never, {} as never)) as { kind: string },
    ).toMatchObject({ kind: 'max_tokens', limit: 1000, observed: 1200 });
    (director.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(
      (await tool.execute({ name: 'x' }, {} as never, {} as never)) as { error: string },
    ).toMatchObject({ error: 'boom' });
  });
});

describe('task/ask tools', () => {
  it('assign_task creates a task', async () => {
    const res = await makeAssignTool(asDir()).execute(
      {
        subagentId: 's1',
        description: 'do it',
        scope: 'Fix the flaky login test in packages/core/tests/login.test.ts.',
        outOfScope: ['Do not touch unrelated tests', 'No dependency changes'],
      },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({ taskId: 'task-1', subagentId: 's1' });
    // The boundary is composed into the canonical brief the worker receives.
    const spec = (director.assign as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      description: string;
    };
    expect(spec.description).toContain('do it');
    expect(spec.description).toContain('TASK BOUNDARY');
    expect(spec.description).toContain('Scope (what this task covers):');
    expect(spec.description).toContain('- Do not touch unrelated tests');
  });

  it('assign_task requires an explicit scope', async () => {
    const res = (await makeAssignTool(asDir()).execute(
      { subagentId: 's1', description: 'do it', outOfScope: ['No edits'] },
      {} as never,
      {} as never,
    )) as { ok?: boolean; error?: string; hint?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boundary incomplete[\s\S]*scope/);
    expect(res.hint).toBeTruthy();
    expect(director.assign).not.toHaveBeenCalled();
  });

  it('assign_task rejects placeholder outOfScope entries', async () => {
    const res = (await makeAssignTool(asDir()).execute(
      {
        subagentId: 's1',
        description: 'do it',
        scope: 'Fix the flaky login test in packages/core/tests/login.test.ts.',
        outOfScope: ['none', 'n/a'],
      },
      {} as never,
      {} as never,
    )) as { ok?: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/placeholder/);
    expect(director.assign).not.toHaveBeenCalled();
  });

  it('assign_task schema makes the boundary fields required', () => {
    const schema = makeAssignTool(asDir()).inputSchema as {
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(['subagentId', 'description', 'scope', 'outOfScope']),
    );
    expect(schema.properties?.['outOfScope']?.type).toBe('array');
  });

  it('await_tasks returns results (default all-mode unchanged)', async () => {
    const res = await makeAwaitTasksTool(asDir()).execute(
      { taskIds: ['t'] },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({ results: [{ taskId: 't' }] });
    expect(director.awaitTasksAny as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('await_tasks mode:"any" returns first finisher + pending ids + hint', async () => {
    const res = await makeAwaitTasksTool(asDir()).execute(
      { taskIds: ['t', 't2'], mode: 'any' },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({
      mode: 'any',
      completed: [{ taskId: 't', status: 'success' }],
      pending: ['t2'],
    });
    expect((res as { hint?: string }).hint).toContain('pending');
    expect(director.awaitTasks as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('await_tasks mode:"any" forwards timeoutMs and surfaces timedOut without a hint-worthy result', async () => {
    (director.awaitTasksAny as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      completed: [],
      pending: ['t'],
      timedOut: true,
    });
    const res = await makeAwaitTasksTool(asDir()).execute(
      { taskIds: ['t'], mode: 'any', timeoutMs: 500 },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({ mode: 'any', completed: [], pending: ['t'], timedOut: true });
    expect(director.awaitTasksAny).toHaveBeenCalledWith(['t'], { timeoutMs: 500 });
  });

  it('ask_subagent returns an inline answer', async () => {
    (
      director.largeAnswerStore as { storeAnswer: ReturnType<typeof vi.fn> }
    ).storeAnswer.mockReturnValue({ inline: true, summary: 'short' });
    const res = await makeAskTool(asDir()).execute(
      { subagentId: 's1', question: 'q?' },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({ ok: true, answer: 'short' });
  });

  it('ask_subagent stores a large answer out-of-band', async () => {
    (
      director.largeAnswerStore as { storeAnswer: ReturnType<typeof vi.fn> }
    ).storeAnswer.mockReturnValue({ inline: false, summary: 'sum', key: 'k1' });
    const res = (await makeAskTool(asDir()).execute(
      { subagentId: 's1', question: 'q?' },
      {} as never,
      {} as never,
    )) as { _answerKey: string };
    expect(res._answerKey).toBe('k1');
  });

  it('ask_subagent returns an error on failure', async () => {
    (director.ask as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ask failed'));
    const res = (await makeAskTool(asDir()).execute(
      { subagentId: 's1', question: 'q?' },
      {} as never,
      {} as never,
    )) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  it('ask_result retrieves and reports missing keys', async () => {
    (
      director.largeAnswerStore as { retrieveAnswer: ReturnType<typeof vi.fn> }
    ).retrieveAnswer.mockReturnValueOnce('full value');
    expect(
      await makeAskResultTool(asDir()).execute({ key: 'k1' }, {} as never, {} as never),
    ).toMatchObject({ ok: true, value: 'full value' });
    (
      director.largeAnswerStore as { retrieveAnswer: ReturnType<typeof vi.fn> }
    ).retrieveAnswer.mockReturnValueOnce(undefined);
    expect(
      await makeAskResultTool(asDir()).execute({ key: 'missing' }, {} as never, {} as never),
    ).toMatchObject({ ok: false });
  });

  it('roll_up aggregates results', async () => {
    expect(
      await makeRollUpTool(asDir()).execute({ taskIds: ['a', 'b'] }, {} as never, {} as never),
    ).toMatchObject({ summary: 'rolled up', count: 2 });
  });
});

describe('makeQualityGateTool', () => {
  it('passes only when verifier and reviewer explicitly pass', async () => {
    const tool = makeQualityGateTool(asDir(), {
      reviewer: { name: 'Reviewer', role: 'reviewer' },
      verifier: { name: 'Verifier', role: 'verifier' },
    });
    (director.spawn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('verifier-1')
      .mockResolvedValueOnce('reviewer-1');
    (director.assign as ReturnType<typeof vi.fn>).mockImplementation(async (task) =>
      task.subagentId === 'verifier-1' ? 'verify-task' : 'review-task',
    );
    (director.awaitTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        subagentId: 'verifier-1',
        taskId: 'verify-task',
        status: 'success',
        result: '## Verdict\npass\n\n## Commands Run\npnpm test: ok',
        iterations: 1,
        toolCalls: 1,
        durationMs: 10,
      },
      {
        subagentId: 'reviewer-1',
        taskId: 'review-task',
        status: 'success',
        result: '## Verdict\napprove\n\n## Must Fix\nnone',
        iterations: 1,
        toolCalls: 1,
        durationMs: 10,
      },
    ]);

    const res = await tool.execute({ task: 'ship the feature' }, {} as never, {} as never);

    expect(res).toMatchObject({ verdict: 'pass', passed: true, repairAttemptsUsed: 0 });
    expect(director.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'verifier', worktree: 'auto' }),
    );
    expect(director.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'reviewer', worktree: 'off' }),
    );
  });

  it('feeds failed gate output back to a repair subagent and reruns', async () => {
    const tool = makeQualityGateTool(asDir(), {
      reviewer: { name: 'Reviewer', role: 'reviewer' },
      verifier: { name: 'Verifier', role: 'verifier' },
    });
    (director.spawn as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('verifier-1')
      .mockResolvedValueOnce('reviewer-1')
      .mockResolvedValueOnce('verifier-2')
      .mockResolvedValueOnce('reviewer-2');
    (director.assign as ReturnType<typeof vi.fn>).mockImplementation(async (task) => {
      if (task.subagentId === 'impl-1') return 'repair-task';
      return `${task.subagentId}-task`;
    });
    let gateAttempt = 0;
    (director.awaitTasks as ReturnType<typeof vi.fn>).mockImplementation(
      async (taskIds: string[]) => {
        if (taskIds.includes('repair-task')) {
          return [
            {
              subagentId: 'impl-1',
              taskId: 'repair-task',
              status: 'success',
              result: 'fixed reviewer and verifier findings',
              iterations: 1,
              toolCalls: 1,
              durationMs: 10,
            },
          ];
        }
        gateAttempt += 1;
        const pass = gateAttempt > 1;
        return taskIds.map((taskId) => ({
          subagentId: taskId.includes('verifier')
            ? `verifier-${gateAttempt}`
            : `reviewer-${gateAttempt}`,
          taskId,
          status: 'success',
          result: pass
            ? taskId.includes('verifier')
              ? '## Verdict\npass'
              : '## Verdict\napprove'
            : taskId.includes('verifier')
              ? '## Verdict\nfail\n\n## Failures\npnpm test failed'
              : '## Verdict\nrequest changes\n\n## Must Fix\nsrc/x.ts:1 fix bug',
          iterations: 1,
          toolCalls: 1,
          durationMs: 10,
        }));
      },
    );

    const res = await tool.execute(
      { task: 'fix bug', repairSubagentId: 'impl-1', maxRepairAttempts: 1 },
      {} as never,
      {} as never,
    );

    expect(res).toMatchObject({ verdict: 'pass', passed: true, repairAttemptsUsed: 1 });
    expect(director.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        subagentId: 'impl-1',
        description: expect.stringContaining('Repair the implementation'),
      }),
    );
  });

  it('returns inconclusive when an enabled lane does not explicitly pass', async () => {
    const tool = makeQualityGateTool(asDir(), {
      verifier: { name: 'Verifier', role: 'verifier' },
    });
    (director.spawn as ReturnType<typeof vi.fn>).mockResolvedValueOnce('verifier-1');
    (director.assign as ReturnType<typeof vi.fn>).mockResolvedValueOnce('verify-task');
    (director.awaitTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        subagentId: 'verifier-1',
        taskId: 'verify-task',
        status: 'success',
        result: 'Checks looked okay but no clear verdict.',
        iterations: 1,
        toolCalls: 1,
        durationMs: 10,
      },
    ]);

    const res = await tool.execute({ verifier: true, reviewer: false }, {} as never, {} as never);

    expect(res).toMatchObject({ verdict: 'inconclusive', passed: false });
  });
});

describe('lifecycle/status tools', () => {
  it('terminate and terminate_all', async () => {
    expect(
      await makeTerminateTool(asDir()).execute({ subagentId: 's1' }, {} as never, {} as never),
    ).toMatchObject({ ok: true });
    expect(await makeTerminateAllTool(asDir()).execute({}, {} as never, {} as never)).toMatchObject(
      { ok: true },
    );
    expect(director.terminateAll).toHaveBeenCalled();
  });

  it('fleet action: status — with and without a fleet manager', async () => {
    const res = await makeFleetTool(asDir()).execute(
      { action: 'status' },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({
      action: 'status',
      coordinatorStats: { total: 2 },
      pending: ['t1'],
    });
    director.fleetManager = undefined;
    const res2 = (await makeFleetTool(asDir()).execute(
      { action: 'status' },
      {} as never,
      {} as never,
    )) as { coordinatorStats: unknown };
    expect(res2.coordinatorStats).toBeUndefined();
  });

  it('fleet action: status is the default', async () => {
    const res = await makeFleetTool(asDir()).execute({}, {} as never, {} as never);
    expect(res).toMatchObject({ action: 'status' });
  });

  it('fleet action: usage returns the snapshot', async () => {
    const res = await makeFleetTool(asDir()).execute({ action: 'usage' }, {} as never, {} as never);
    expect(res).toMatchObject({ action: 'usage', perSubagent: expect.any(Object) });
  });

  it('fleet action: session returns a transcript or an error when unavailable', async () => {
    const res = await makeFleetTool(asDir()).execute(
      { action: 'session', subagentId: 's1' },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({ action: 'session', lastText: 'hi' });
    (director.readSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const err = (await makeFleetTool(asDir()).execute(
      { action: 'session', subagentId: 's1' },
      {} as never,
      {} as never,
    )) as { error: string };
    expect(err).toHaveProperty('error');
  });

  it('fleet action: session requires subagentId', async () => {
    const res = (await makeFleetTool(asDir()).execute(
      { action: 'session' },
      {} as never,
      {} as never,
    )) as { error: string };
    expect(res.error).toContain('subagentId is required');
  });

  it('fleet action: health maps per-subagent budget pressure', async () => {
    const res = (await makeFleetTool(asDir()).execute(
      { action: 'health' },
      {} as never,
      {} as never,
    )) as { subagents: Array<{ id: string; budgetPressure: { iterations: number } }> };
    expect(res.subagents[0]).toMatchObject({
      id: 's1',
      budgetPressure: { iterations: 3, toolCalls: 5 },
    });
  });

  it('fleet action: unknown returns an error', async () => {
    const res = (await makeFleetTool(asDir()).execute(
      { action: 'nope' },
      {} as never,
      {} as never,
    )) as { error: string };
    expect(res.error).toContain('unknown action');
  });

  it('fleet_emit validates known payloads and attributes the real caller/task', async () => {
    const result = await makeFleetEmitTool(asDir()).execute(
      {
        type: 'bug.found',
        payload: {
          finding: {
            id: 'bug-1',
            type: 'logic',
            severity: 'high',
            location: { file: 'src/a.ts', line: 7 },
            description: 'Incorrect branch condition.',
          },
        },
      },
      {
        agentId: 'bug-hunter-1',
        meta: { agentRole: 'bug-hunter', subagentTaskId: 'task-1' },
      } as never,
      {} as never,
    );
    expect(result).toMatchObject({ ok: true, event: 'bug.found' });
    expect((director.fleet as { emit: ReturnType<typeof vi.fn> }).emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bug.found',
        subagentId: 'bug-hunter-1',
        taskId: 'task-1',
      }),
    );
  });

  it('fleet_emit rejects malformed known payloads and cross-role spoofing', async () => {
    const tool = makeFleetEmitTool(asDir());
    const malformed = await tool.execute(
      { type: 'bug.found', payload: { finding: { id: 'broken' } } },
      { agentId: 'bug-hunter-1', meta: { agentRole: 'bug-hunter' } } as never,
      {} as never,
    );
    const spoofed = await tool.execute(
      { type: 'bug.found', payload: {} },
      { agentId: 'critic-1', meta: { agentRole: 'critic' } } as never,
      {} as never,
    );

    expect(malformed).toMatchObject({ ok: false });
    expect(spoofed).toMatchObject({ ok: false, error: expect.stringContaining('bug-hunter') });
    expect((director.fleet as { emit: ReturnType<typeof vi.fn> }).emit).not.toHaveBeenCalled();
  });

  it('fleet_emit rejects known collab events when the caller has no role', async () => {
    const result = await makeFleetEmitTool(asDir()).execute(
      {
        type: 'bug.found',
        payload: {
          finding: {
            id: 'bug-1',
            type: 'logic',
            severity: 'medium',
            location: { file: 'src/a.ts', line: 1 },
            description: 'example',
          },
        },
      },
      { agentId: 'unscoped-agent', meta: {} } as never,
      {} as never,
    );

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('unknown') });
    expect((director.fleet as { emit: ReturnType<typeof vi.fn> }).emit).not.toHaveBeenCalled();
  });

  it('legacy contract: work_complete directly signals wind-down', async () => {
    expect(await makeWorkCompleteTool(asDir()).execute({}, {} as never, {} as never)).toMatchObject(
      { ok: true },
    );
    expect(director.workComplete).toHaveBeenCalled();
  });
});

describe('collab_debug tool', () => {
  it('rejects empty targetPaths', async () => {
    expect(
      (await makeCollabDebugTool(asDir()).execute(
        { targetPaths: [] },
        {} as never,
        {} as never,
      )) as { error: string },
    ).toHaveProperty('error');
  });

  it('runs a collaborative debug session', async () => {
    const res = await makeCollabDebugTool(asDir()).execute(
      { targetPaths: ['src/a.ts'], timeoutMs: 1000 },
      {} as never,
      {} as never,
    );
    expect(res).toMatchObject({ sessionId: 'cs1', overallVerdict: 'approve', bugCount: 0 });
  });

  it('reports a failure from spawnCollab', async () => {
    (director.spawnCollab as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('collab boom'),
    );
    expect(
      (await makeCollabDebugTool(asDir()).execute(
        { targetPaths: ['x'] },
        {} as never,
        {} as never,
      )) as { error: string },
    ).toMatchObject({ error: expect.stringContaining('collab boom') });
  });
});
