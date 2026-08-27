import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleKanbanTaskDispatch,
  type KanbanTaskDispatcher,
} from '../src/server/kanban-dispatch.js';

const mockStore = vi.hoisted(() => ({
  getBoard: vi.fn(),
  reserveKanbanDispatch: vi.fn(),
  startKanbanDispatch: vi.fn(),
  completeKanbanDispatch: vi.fn(),
  failKanbanDispatch: vi.fn(),
  reconcileBoard: vi.fn(),
  listBoards: vi.fn(),
}));

const MOCK_LEASE_ID = 'aaaa1111-bbbb-cccc-dddd-eeeeffff0000';

vi.mock('@wrongstack/kanban', async () => {
  const actual = await vi.importActual<typeof import('@wrongstack/kanban')>('@wrongstack/kanban');
  return {
    ...actual,
    getServerKanbanStore: vi.fn(() => mockStore),
  };
});

function mockWs(): WebSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    terminate: vi.fn(),
    close: vi.fn(),
    sent,
  } as never as WebSocket & { sent: unknown[] };
}

function managedBoard(stage: 'todo' | 'running' | 'review' = 'todo') {
  return {
    id: 'board-1',
    title: 'Managed Board',
    lifecycle: {
      mode: 'managed',
      columns: {
        backlog: 'backlog',
        todo: 'todo',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    },
    tasks: [
      {
        id: 'task-1',
        title: 'Do work',
        description: 'Implement the thing',
        priority: 'medium',
        status: stage === 'todo' ? 'ready' : stage === 'running' ? 'in_progress' : 'completed',
        columnId: stage === 'todo' ? 'todo' : stage === 'running' ? 'in-progress' : 'review',
        order: 0,
        lifecycle: {
          currentStage: stage,
          stageEnteredAt: '2026-07-28T00:00:00.000Z',
          history: [],
        },
        assignment: {
          status: stage === 'todo' ? 'queued' : stage === 'running' ? 'running' : 'completed',
          leaseId: MOCK_LEASE_ID,
          agentId: 'agent-1',
          name: 'WebUI Worker',
          provider: 'test-provider',
          model: 'test-model',
        },
      },
    ],
  };
}

describe('handleKanbanTaskDispatch dispatch service integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.getBoard.mockResolvedValue(managedBoard('todo'));
    // reserveKanbanDispatch: return the board/task with a lease.
    mockStore.reserveKanbanDispatch.mockResolvedValue({
      board: managedBoard('todo'),
      task: managedBoard('todo').tasks[0],
      lease: {
        leaseId: MOCK_LEASE_ID,
        claimedAt: '2026-01-01T00:00:00.000Z',
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        leaseExpiresAt: '2026-01-01T00:30:00.000Z',
      },
    });
    // startKanbanDispatch: return the board/task in running stage.
    mockStore.startKanbanDispatch.mockResolvedValue({
      board: managedBoard('running'),
      task: managedBoard('running').tasks[0],
    });
    // completeKanbanDispatch: return the board/task in review stage.
    mockStore.completeKanbanDispatch.mockResolvedValue({
      board: managedBoard('review'),
      task: managedBoard('review').tasks[0],
    });
    mockStore.failKanbanDispatch.mockResolvedValue(managedBoard('todo'));
    mockStore.reconcileBoard.mockResolvedValue({ board: managedBoard('review') });
    mockStore.listBoards.mockResolvedValue([managedBoard('review')]);
  });

  it('reserves via dispatch service, starts dispatch, and reports success', async () => {
    const ws = mockWs();
    const dispatchTask = vi
      .fn<KanbanTaskDispatcher>()
      .mockResolvedValue('Spawned subagent sub-1 (test-provider / test-model) for task run-1.');

    await handleKanbanTaskDispatch(
      ws,
      { boardId: 'board-1', taskId: 'task-1', agentId: 'agent-1', name: 'WebUI Worker' },
      {
        projectRoot: '/tmp/project',
        requestSessionId: '2026-08-26/sess_01TESTWEBUIDISPATCH0000',
        dispatchTask,
      },
    );

    // reserveKanbanDispatch was called with boardId, taskId, and routing metadata.
    expect(mockStore.reserveKanbanDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: 'board-1',
        taskId: 'task-1',
        routing: expect.objectContaining({
          agentId: 'agent-1',
          name: 'WebUI Worker',
        }),
      }),
    );
    // startKanbanDispatch was called with the leaseId from reserve.
    expect(mockStore.startKanbanDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: 'board-1',
        taskId: 'task-1',
        leaseId: MOCK_LEASE_ID,
        actor: 'kanban-agent',
      }),
    );
    expect(ws.sent).toContainEqual(
      expect.objectContaining({
        type: 'kanban.task.dispatch',
        payload: expect.objectContaining({ success: true }),
      }),
    );
  });

  it('completes via dispatch service when the dispatched worker finishes', async () => {
    const ws = mockWs();
    let onDone: NonNullable<NonNullable<Parameters<KanbanTaskDispatcher>[1]>['onDone']> | undefined;
    const dispatchTask = vi
      .fn<KanbanTaskDispatcher>()
      .mockImplementation(async (_description, opts) => {
        onDone = opts?.onDone;
        return 'Spawned subagent sub-1 (test-provider / test-model) for task run-1.';
      });

    await handleKanbanTaskDispatch(
      ws,
      { boardId: 'board-1', taskId: 'task-1', agentId: 'agent-1', name: 'WebUI Worker' },
      {
        projectRoot: '/tmp/project',
        requestSessionId: '2026-08-26/sess_01TESTWEBUIDISPATCH0000',
        dispatchTask,
        broadcast: vi.fn(),
      },
    );
    expect(onDone).toBeTypeOf('function');

    await onDone?.({ status: 'completed', result: 'Implementation complete.' });

    // completeKanbanDispatch was called with the leaseId and result.
    expect(mockStore.completeKanbanDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: 'board-1',
        taskId: 'task-1',
        leaseId: MOCK_LEASE_ID,
        result: 'Implementation complete.',
      }),
    );
    // failKanbanDispatch was NOT called.
    expect(mockStore.failKanbanDispatch).not.toHaveBeenCalled();
  });
});
