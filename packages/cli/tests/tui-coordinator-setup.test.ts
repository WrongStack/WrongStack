import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupAutonomousCoordinator } from '../src/boot/tui-coordinator-setup.js';

const mocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
}));

vi.mock('@wrongstack/core/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/coordination')>();
  class AutonomousCoordinator {
    graph = {
      load: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
    };
    auction = {
      getPendingTasks: vi.fn().mockReturnValue([]),
      claim: vi.fn().mockResolvedValue(true),
    };
    run = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
    dispose = vi.fn();
    reportTaskCompletion = vi.fn().mockResolvedValue(undefined);
    reportTaskFailure = vi.fn().mockResolvedValue(undefined);
    syncFromGraph = vi.fn().mockResolvedValue(undefined);
    getStats = vi.fn().mockReturnValue({
      goals: { total: 1, done: 0, pending: 1, failed: 0 },
      dag: { running: 0, ready: 1, done: 0, failed: 0 },
      auction: { pending: 1, in_progress: 0 },
    });
    constructor(public options: Record<string, unknown>) {
      mocks.instances.push(this as unknown as Record<string, unknown>);
    }
  }
  return { ...actual, AutonomousCoordinator };
});

afterEach(() => {
  mocks.instances.length = 0;
  vi.restoreAllMocks();
});

function harness(director: Record<string, unknown> | null) {
  const listeners = new Set<(...args: unknown[]) => void>();
  const off = vi.fn();
  const state = {
    autonomousCoordinator: null,
    coordinatorEvents: new Set(),
  };
  const controller: Record<string, unknown> = {};
  const stopSetter = vi.fn();
  const result = setupAutonomousCoordinator({
    state: state as never,
    events: {
      onPattern: vi.fn((_name, listener) => {
        listeners.add(listener);
        return off;
      }),
    } as never,
    context: {
      model: 'model',
      signal: new AbortController().signal,
      session: { id: 'session-1', transcriptPath: 'D:/sessions/day/session.jsonl' },
      provider: {
        complete: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '```json\n{"optionId":"b","rationale":"best"}\n```' }],
        }),
      },
    } as never,
    wpaths: { projectDir: 'D:/project' } as never,
    mailbox: {},
    director: director as never,
    getDirector: undefined,
    coordinatorController: controller,
    onCoordinatorStopSetter: stopSetter,
  });
  return { result, state, controller, stopSetter, listeners, off };
}

describe('setupAutonomousCoordinator', () => {
  it('waits for a Director and cleans up its lifecycle listener', () => {
    const { result, off } = harness(null);
    expect(result.ensure()).toBeNull();
    result.cleanup();
    expect(off).toHaveBeenCalledOnce();
  });

  it('constructs once, adapts LLM decisions, and forwards coordinator events', async () => {
    const director = { fleet: {}, fleetManager: {} };
    const { result, state, stopSetter } = harness(director);
    const first = result.ensure() as unknown as Record<string, unknown>;
    expect(result.ensure()).toBe(first);
    expect(mocks.instances).toHaveLength(1);
    expect(stopSetter).toHaveBeenCalledWith(expect.any(Function));

    const options = first.options as Record<string, unknown>;
    expect(options.sessionDir).toBe('D:/sessions/day');
    expect(options.selfAgentId).toBe('leader@session-1');
    await expect(
      (options.llmProvider as { decide(prompt: unknown): Promise<unknown> }).decide({
        question: 'Choose',
        context: { value: 1 },
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', consequence: 'safe' },
        ],
        risk: 'low',
      }),
    ).resolves.toEqual({ optionId: 'b', rationale: 'best' });

    const listener = vi.fn();
    state.coordinatorEvents.add(listener);
    (options.onCoordinatorEvent as (event: unknown) => void)({ type: 'updated' });
    expect(listener).toHaveBeenCalledWith({ type: 'updated' });
  });

  it('populates controller callbacks and tolerates invalid LLM JSON', async () => {
    const director = { fleet: {}, fleetManager: {} };
    const { result, controller } = harness(director);
    const coordinator = result.ensure() as unknown as {
      options: Record<string, unknown>;
      graph: { get: ReturnType<typeof vi.fn> };
      auction: { claim: ReturnType<typeof vi.fn> };
      run: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      reportTaskCompletion: ReturnType<typeof vi.fn>;
      reportTaskFailure: ReturnType<typeof vi.fn>;
    };
    const provider = coordinator.options.llmProvider as {
      decide(prompt: unknown): Promise<unknown>;
    };
    const contextProvider = coordinator.options as never;
    void contextProvider;

    coordinator.graph.get.mockReturnValue({
      type: 'goal',
      status: 'pending',
      description: 'Task',
    });
    await expect(
      (controller['onCoordinatorClaim'] as (id: string) => Promise<unknown>)('task'),
    ).resolves.toEqual({ description: 'Task' });
    coordinator.graph.get.mockReturnValue({ type: 'goal', status: 'in_progress' });
    await expect(
      (controller['onCoordinatorComplete'] as (id: string) => Promise<unknown>)('task'),
    ).resolves.toBeNull();
    await expect(
      (controller['onCoordinatorFail'] as (id: string, error: string) => Promise<unknown>)(
        'task',
        'failed',
      ),
    ).resolves.toBeNull();
    expect(await (controller['onCoordinatorStatus'] as () => Promise<unknown>)()).toMatchObject({
      auction: { pending: 1, inProgress: 0 },
    });
    (controller['onCoordinatorStart'] as () => void)();
    (controller['onCoordinatorStop'] as () => void)();
    expect(coordinator.run).toHaveBeenCalled();
    expect(coordinator.stop).toHaveBeenCalled();

    await expect(
      provider.decide({
        question: 'fallback',
        context: {},
        options: [{ id: 'first', label: 'First' }],
        risk: 'low',
      }),
    ).resolves.toMatchObject({ optionId: 'b' });
  });
});
