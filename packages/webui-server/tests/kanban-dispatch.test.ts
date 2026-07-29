import type { WebSocket } from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleKanbanTaskDispatch, type KanbanTaskDispatcher } from '../src/server/kanban-dispatch.js';

const mockStore = vi.hoisted(() => ({
  getBoard: vi.fn(),
  assignTask: vi.fn(),
  updateTaskAssignment: vi.fn(),
  transitionTask: vi.fn(),
  finalizeTaskCompletion: vi.fn(),
  reconcileBoard: vi.fn(),
  listBoards: vi.fn(),
}));

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
      },
    ],
  };
}

describe('handleKanbanTaskDispatch daemon store integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.getBoard.mockResolvedValue(managedBoard('todo'));
    mockStore.assignTask.mockResolvedValue(managedBoard('todo'));
    mockStore.updateTaskAssignment.mockImplementation(async (_boardId: string, _taskId: string, patch: { status?: string }) => {
      if (patch.status === 'running') return managedBoard('todo');
      if (patch.status === 'completed') return managedBoard('running');
      return managedBoard('todo');
    });
    mockStore.transitionTask.mockImplementation(async (_boardId: string, _taskId: string, input: { to: 'running' | 'review' }) => ({
      board: managedBoard(input.to),
    }));
    mockStore.finalizeTaskCompletion.mockResolvedValue({ gate: { report: null } });
    mockStore.reconcileBoard.mockResolvedValue({ board: managedBoard('review') });
    mockStore.listBoards.mockResolvedValue([managedBoard('review')]);
  });

  it('accepts WebUI assignment metadata without assignee and auto-transitions Todo to Running through the store', async () => {
    const ws = mockWs();
    const dispatchTask = vi.fn<KanbanTaskDispatcher>().mockResolvedValue(
      'Spawned subagent sub-1 (test-provider / test-model) for task run-1.',
    );

    await handleKanbanTaskDispatch(
      ws,
      { boardId: 'board-1', taskId: 'task-1', agentId: 'agent-1', name: 'WebUI Worker' },
      { projectRoot: '/tmp/project', dispatchTask },
    );

    expect(mockStore.assignTask).toHaveBeenCalledWith(
      'board-1',
      'task-1',
      expect.objectContaining({
        agentId: 'agent-1',
        name: 'WebUI Worker',
        status: 'queued',
        leaseId: expect.any(String),
      }),
      expect.any(Object),
    );
    expect(mockStore.transitionTask).toHaveBeenCalledWith(
      'board-1',
      'task-1',
      expect.objectContaining({ to: 'running', actor: 'kanban-agent', comment: 'Work started.' }),
    );
    expect(ws.sent).toContainEqual(
      expect.objectContaining({
        type: 'kanban.task.dispatch',
        payload: expect.objectContaining({ success: true }),
      }),
    );
  });

  it('auto-transitions Running to Review when the dispatched worker completes', async () => {
    const ws = mockWs();
    let onDone:
      | NonNullable<NonNullable<Parameters<KanbanTaskDispatcher>[1]>['onDone']>
      | undefined;
    const dispatchTask = vi.fn<KanbanTaskDispatcher>().mockImplementation(async (_description, opts) => {
      onDone = opts?.onDone;
      return 'Spawned subagent sub-1 (test-provider / test-model) for task run-1.';
    });

    await handleKanbanTaskDispatch(
      ws,
      { boardId: 'board-1', taskId: 'task-1', agentId: 'agent-1', name: 'WebUI Worker' },
      { projectRoot: '/tmp/project', dispatchTask, broadcast: vi.fn() },
    );
    expect(onDone).toBeTypeOf('function');

    await onDone?.({ status: 'completed', result: 'Implementation complete.' });

    expect(mockStore.updateTaskAssignment).toHaveBeenCalledWith(
      'board-1',
      'task-1',
      expect.objectContaining({ status: 'completed', lastResult: 'Implementation complete.' }),
      expect.objectContaining({ expectedLeaseId: expect.any(String) }),
    );
    expect(mockStore.transitionTask).toHaveBeenCalledWith(
      'board-1',
      'task-1',
      expect.objectContaining({
        to: 'review',
        actor: 'kanban-agent',
        comment: 'Implementation complete.',
        attachment: expect.objectContaining({ url: 'kanban://task/task-1/result' }),
      }),
    );
  });
});
