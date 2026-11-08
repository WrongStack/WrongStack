import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteDeps } from '../src/execute-deps.js';
import { installExecutionChimeraHandlers } from '../src/execution-chimera-handlers.js';
import { createExecutionSessionCallbacks } from '../src/execution-session-callbacks.js';
import { runExecutionWebui } from '../src/execution-webui.js';

const mocks = vi.hoisted(() => ({
  fallbackChain: vi.fn(() => []),
  ladder: vi.fn(() => ['reviewer']),
  evidence: vi.fn(async () => undefined),
  review: vi.fn(),
  specialist: vi.fn(),
  cascade: vi.fn(),
  selectSessions: vi.fn(),
  liveSessions: vi.fn(),
  worktrees: vi.fn(),
  dispatch: vi.fn(),
  dispose: vi.fn(),
  wakeOptions: vi.fn(),
}));

vi.mock('@wrongstack/core/agent', () => ({ effectiveFallbackChain: mocks.fallbackChain }));
vi.mock('@wrongstack/builtin-plugins', () => ({ updateReviewReportEvidence: mocks.evidence }));
vi.mock('@wrongstack/worktree', () => ({ listGitWorktrees: mocks.worktrees }));
vi.mock('@wrongstack/coordination', async () => ({
  // The gauge's budget arithmetic is the real one: the test checks what the WebUI receives.
  fleetBudgetFromDirector: (
    await vi.importActual<typeof import('@wrongstack/coordination')>('@wrongstack/coordination')
  ).fleetBudgetFromDirector,
  LeaderAutoWakeController: class {
    constructor(options: unknown) {
      mocks.wakeOptions(options);
    }
    dispose = mocks.dispose;
  },
}));
vi.mock('../src/chimera-reviewer-policy.js', () => ({ buildMutatingAgentLadder: mocks.ladder }));
vi.mock('../src/execution-chimera-review.js', () => ({
  installChimeraReviewHandler: mocks.review,
}));
vi.mock('../src/execution-specialist-trigger.js', () => ({
  installSpecialistTriggerHandler: mocks.specialist,
}));
vi.mock('../src/execution-chimera-cascade.js', () => ({
  installChimeraCascadeHandler: mocks.cascade,
}));
vi.mock('../src/boot/tui-session-stub-enrich.js', () => ({
  selectPickerSessions: mocks.selectSessions,
}));
vi.mock('../src/boot/tui-live-sessions.js', () => ({ getLiveSessions: mocks.liveSessions }));
vi.mock('../src/boot/dispatch-webui.js', () => ({ runWebUIDispatch: mocks.dispatch }));
vi.mock('../src/execution-kanban-dispatch.js', () => ({
  createKanbanDispatchHandler: () => ({}),
}));
vi.mock('../src/hq-fleet-control.js', () => ({ createHqFleetControl: () => ({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectSessions.mockResolvedValue([]);
  mocks.liveSessions.mockResolvedValue([]);
  mocks.worktrees.mockResolvedValue([]);
  mocks.dispatch.mockResolvedValue(7);
});

describe('execution adapters', () => {
  it('joins work from all Chimera handlers and persists cascade evidence into the owning project', async () => {
    const result = installExecutionChimeraHandlers({
      core: {
        events: {},
        agent: {},
        config: { provider: 'test', model: 'model' },
        wpaths: { projectDir: 'project-state' },
      },
      session: { session: { id: 'session' }, mailbox: {} },
      fleet: { director: {} },
      provider: { statusTracker: {} },
    } as unknown as ExecuteDeps);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    for (const handler of [mocks.review, mocks.specialist, mocks.cascade]) {
      const options = handler.mock.calls[0]![0] as {
        trackWork(work: Promise<void>): void;
        teardownHandlers: Array<() => void>;
      };
      expect(options.teardownHandlers).toBe(result.chimeraTeardowns);
      options.trackWork(pending);
    }
    expect(result.chimeraWork.size).toBe(3);
    const cascade = mocks.cascade.mock.calls[0]![0] as {
      getPendingWork(): Promise<void> | undefined;
      buildLadder(): unknown;
      persistEvidence(reportId: string, status: string, checks: unknown[]): Promise<void>;
    };
    expect(cascade.buildLadder()).toEqual(['reviewer']);
    expect(mocks.ladder).toHaveBeenCalledWith({
      profileChain: [],
      session: { provider: 'test', model: 'model' },
    });
    const joined = cascade.getPendingWork();
    expect(joined).toBeDefined();
    finish();
    await joined;
    expect(result.chimeraWork.size).toBe(0);
    await cascade.persistEvidence('report', 'verified', []);
    expect(mocks.evidence).toHaveBeenCalledWith('report', 'project-state', 'verified', []);
  });

  it('tags live foreign sessions and worktrees without marking the current session foreign', async () => {
    mocks.selectSessions.mockResolvedValue([
      { id: 'current', messageCount: 1 },
      { id: 'foreign', messageCount: 2, checkout: 'D:/other-checkout' },
    ]);
    mocks.liveSessions.mockResolvedValue([
      { sessionId: 'current', pid: 10 },
      { sessionId: 'foreign', pid: 20, clientType: 'webui' },
    ]);
    mocks.worktrees.mockResolvedValue([
      { root: 'D:/other-checkout', branch: 'feature', current: false },
    ]);
    const worktreeSessions = new Map();
    worktreeSessions.set('old', { root: 'old', name: 'old' });
    const callbacks = createExecutionSessionCallbacks({
      state: {
        activeSessionStore: { list: vi.fn() },
        wpaths: { projectSessions: 'sessions' },
        projectRoot: 'D:/repo',
      },
      agent: { ctx: { session: { id: 'current' } } },
      session: { id: 'boot-session' },
      worktreeSessions,
    } as never);
    const entries = await callbacks.listSessions(5);
    expect(mocks.selectSessions).toHaveBeenCalledWith(expect.any(Function), 'sessions', 5);
    expect(entries[0]).toMatchObject({ id: 'current', isCurrent: true });
    expect(entries[0]).not.toHaveProperty('live');
    expect(entries[1]).toMatchObject({
      id: 'foreign',
      isCurrent: false,
      live: { pid: 20, clientType: 'webui' },
      worktree: { root: 'D:/other-checkout', name: 'other-checkout', branch: 'feature' },
    });
    expect(worktreeSessions.has('old')).toBe(false);
    expect(worktreeSessions.get('foreign')).toEqual(entries[1]!.worktree);
  });

  it('keeps listing available when the live-session registry fails and forks before the selected prompt', async () => {
    mocks.selectSessions.mockResolvedValue([{ id: 'saved' }]);
    mocks.liveSessions.mockRejectedValue(new Error('registry unavailable'));
    const fork = vi.fn(async () => ({ id: 'forked' }));
    const callbacks = createExecutionSessionCallbacks({
      state: {
        activeSessionStore: { list: vi.fn(), fork },
        wpaths: { projectSessions: 'sessions' },
        projectRoot: 'D:/repo',
      },
      agent: { ctx: {} },
      session: { id: 'current' },
      worktreeSessions: new Map(),
    } as never);
    await expect(callbacks.listSessions()).resolves.toMatchObject([{ id: 'saved' }]);
    await expect(callbacks.forkSession('saved', 3)).resolves.toEqual({ id: 'forked' });
    expect(fork).toHaveBeenCalledWith('saved', {
      checkpointPromptIndex: 3,
      beforeCheckpointPrompt: true,
    });
  });

  it('returns no sessions and rejects forking when the active store is unavailable', async () => {
    const callbacks = createExecutionSessionCallbacks({
      state: {},
      agent: { ctx: {} },
      session: { id: 'current' },
      worktreeSessions: new Map(),
    } as never);
    await expect(callbacks.listSessions()).resolves.toEqual([]);
    await expect(callbacks.forkSession('saved', 0)).rejects.toThrow('cannot fork');
  });

  it.each([false, true])('disposes WebUI auto-wake after dispatch (failed: %s)', async (failed) => {
    if (failed) mocks.dispatch.mockRejectedValueOnce(new Error('dispatch failed'));
    const terminateSession = vi.fn();
    const releaseSessionHelpers = vi.fn();
    const director = {
      terminateSession,
      maxSpawns: 10,
      spawnCount: 3,
      status: () => ({
        subagents: [{ status: 'running' }, { status: 'idle' }, { status: 'done' }],
      }),
    };
    const configStore = { get: () => ({ fleet: { delegate: { enabled: true } } }) };
    const result = runExecutionWebui({
      core: {
        config: {},
        configStore,
        wpaths: { profileConfig: (name: string) => `profiles/${name}` },
      },
      session: {},
      provider: {},
      ui: {},
      fleet: { getDirector: () => director, releaseSessionHelpers },
      controllers: {},
    } as unknown as ExecuteDeps);
    if (failed) await expect(result).rejects.toThrow('dispatch failed');
    else await expect(result).resolves.toBe(7);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    const dispatch = mocks.dispatch.mock.calls[0]![0] as {
      stopSessionFleet(sessionId: string): void;
      getFleetBudget(): unknown;
      onSessionRetired: typeof releaseSessionHelpers;
    };
    dispatch.stopSessionFleet('selected');
    expect(terminateSession).toHaveBeenCalledWith('selected');
    expect(dispatch.onSessionRetired).toBe(releaseSessionHelpers);
    expect(dispatch.getFleetBudget()).toEqual({
      maxSpawns: 10,
      usedSpawns: 3,
      remainingSpawns: 7,
      activeAgents: 2,
    });
    const wake = mocks.wakeOptions.mock.calls[0]![0] as { config(): unknown };
    expect(wake.config()).toEqual({ enabled: true });
  });
});
