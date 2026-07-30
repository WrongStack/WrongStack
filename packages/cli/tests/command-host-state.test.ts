import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupCommandHostState } from '../src/wiring/command-host-state.js';

const mocks = vi.hoisted(() => ({
  abortLeader: vi.fn(),
  createFleetStreamController: vi.fn().mockReturnValue({ fleet: true }),
  createInterruptController: vi.fn(),
  createEnhanceController: vi.fn().mockReturnValue({ enhance: true }),
  createStatuslineConfigDeps: vi.fn().mockReturnValue({ statusline: true }),
  loadStatuslineHiddenItems: vi.fn(),
  createAgentsMonitorController: vi.fn().mockReturnValue({ agents: true }),
  createGoalHost: vi.fn().mockReturnValue({ goal: true }),
  cleanupStaleSddWorktrees: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/wiring/controllers.js', () => ({
  createFleetStreamController: mocks.createFleetStreamController,
  createInterruptController: mocks.createInterruptController,
  createEnhanceController: mocks.createEnhanceController,
  createStatuslineConfigDeps: mocks.createStatuslineConfigDeps,
  loadStatuslineHiddenItems: mocks.loadStatuslineHiddenItems,
  createAgentsMonitorController: mocks.createAgentsMonitorController,
}));
vi.mock('../src/goal-host.js', () => ({ createGoalHost: mocks.createGoalHost }));
vi.mock('@wrongstack/sdd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/sdd')>();
  return { ...actual, cleanupStaleSddWorktrees: mocks.cleanupStaleSddWorktrees };
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.clearAllMocks();
});

function harness(director: Record<string, unknown> | null) {
  let config = { autonomy: {}, yolo: false };
  const saveHiddenItems = vi.fn().mockResolvedValue(undefined);
  mocks.createInterruptController.mockReturnValue({ abortLeader: mocks.abortLeader });
  mocks.loadStatuslineHiddenItems.mockResolvedValue({
    hiddenItems: ['git'],
    saveHiddenItems,
  });
  const hqCommandController: Record<string, unknown> = {};
  const result = {
    getConfig: () => config,
    setConfig: vi.fn((next) => {
      config = next;
    }),
    getDirector: () => director,
    hqCommandController,
    multiAgentHost: {},
    events: {},
    sessionRef: { current: { id: 'resumed' } },
    session: { id: 'startup' },
    paths: {
      projectGoal: 'D:/repo/.wrongstack/goal',
      projectSddBoards: 'D:/repo/.wrongstack/sdd/boards',
    },
    projectRoot: 'D:/repo',
    brain: undefined,
    renderer: { write: vi.fn() },
    reader: {
      readSecret: vi.fn().mockResolvedValue('secret'),
      readLine: vi.fn().mockResolvedValue('text'),
    },
    permissionPolicy: {
      setYolo: vi.fn(),
      getYolo: vi.fn().mockReturnValue(false),
    },
  };
  return {
    result,
    hqCommandController,
    saveHiddenItems,
    get config() {
      return config;
    },
  };
}

describe('setupCommandHostState', () => {
  it('assembles controllers, hidden-item state, goal context, and secret input', async () => {
    const { result, saveHiddenItems } = harness(null);
    const state = await setupCommandHostState(result as never);
    await flush();

    expect(state.statuslineHiddenItems).toEqual(['git']);
    expect(state.getCurrentHiddenItems()).toEqual(['git']);
    state.setStatuslineHiddenItems(['model']);
    expect(state.getCurrentHiddenItems()).toEqual(['model']);
    await state.saveStatuslineHiddenItems(['context']);
    expect(saveHiddenItems).toHaveBeenCalledWith(['context']);
    expect(state.getCurrentHiddenItems()).toEqual(['context']);
    await expect(state.secretInputController.readSecret('token')).resolves.toBe('secret');
    await expect(state.secretInputController.readText('name')).resolves.toBe('text');
    expect(mocks.createGoalHost).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: 'D:/repo',
        getSessionId: expect.any(Function),
      }),
    );
    expect(mocks.cleanupStaleSddWorktrees).toHaveBeenCalled();
  });

  it('wires yolo mutation and fleet management callbacks', async () => {
    const director = {
      status: vi.fn().mockReturnValue({
        subagents: [
          { id: 'running', status: 'running' },
          { id: 'idle', status: 'idle' },
          { id: 'done', status: 'done' },
        ],
      }),
      remove: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('busy')),
      terminate: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue('spawned-id'),
    };
    const { result, hqCommandController } = harness(director);
    const state = await setupCommandHostState(result as never);

    expect(state.setYoloMode()).toBe(false);
    expect(state.setYoloMode(true)).toBe(true);
    expect(result.permissionPolicy.setYolo).toHaveBeenCalledWith(true);
    expect(result.getConfig().yolo).toBe(true);

    (hqCommandController.interruptLeader as () => void)();
    expect(mocks.abortLeader).toHaveBeenCalledOnce();
    await expect((hqCommandController.killFleet as () => Promise<number>)()).resolves.toBe(1);
    await expect(
      (hqCommandController.terminateAgent as (id: string) => Promise<boolean>)('running'),
    ).resolves.toBe(true);
    await expect(
      (
        hqCommandController.spawnAgent as (
          role: string,
          task?: string,
          maxIterations?: number,
        ) => Promise<string>
      )('custom-role', 'cover', 3),
    ).resolves.toBe('spawned-id');
    expect(director.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'custom-role', task: 'cover', maxIterations: 3 }),
    );
  });

  it('returns safe fleet results when no director or director operations fail', async () => {
    const absent = harness(null);
    await setupCommandHostState(absent.result as never);
    await expect((absent.hqCommandController.killFleet as () => Promise<number>)()).resolves.toBe(
      0,
    );
    await expect(
      (absent.hqCommandController.terminateAgent as (id: string) => Promise<boolean>)('id'),
    ).resolves.toBe(false);
    await expect(
      (absent.hqCommandController.spawnAgent as (role: string) => Promise<string>)('role'),
    ).rejects.toMatchObject({ code: 'AGENT_RUN_FAILED' });

    const failing = harness({
      status: () => ({ subagents: [] }),
      terminate: vi.fn().mockRejectedValue('failed'),
      spawn: vi.fn(),
    });
    await setupCommandHostState(failing.result as never);
    await expect(
      (failing.hqCommandController.terminateAgent as (id: string) => Promise<boolean>)('id'),
    ).resolves.toBe(false);
  });
});
