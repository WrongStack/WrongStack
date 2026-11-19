import { describe, expect, it, vi } from 'vitest';
import {
  createHqCommandDispatcher,
  type HqCommandController,
} from '../src/hq-host/command-controller.js';

describe('createHqCommandDispatcher payload and field validation', () => {
  it('rejects non-object payloads and invalid kanban/spawn arguments before invoking controller handlers', async () => {
    const spawnAgent = vi.fn(async () => 'sub-1');
    const kanbanTransition = vi.fn(async () => 'ok');
    const kanbanAssign = vi.fn(async () => 'ok');
    const kanbanDispatch = vi.fn(async () => 'ok');

    const controller: HqCommandController = {
      interruptLeader: () => true,
      sessionTag: () => 'tag',
      allowRunCommand: () => false,
      spawnAgent,
      kanbanTransition,
      kanbanAssign,
      kanbanDispatch,
    };

    const dispatch = createHqCommandDispatcher(controller);

    for (const bad of [
      { commandId: '1', type: 'abort', payload: null },
      { commandId: '2', type: 'abort', payload: 'bad' },
      { commandId: '3', type: 'abort', payload: [] },
      { commandId: '4', type: 'spawn', payload: { role: '   ' } },
      { commandId: '5', type: 'spawn', payload: { role: 'coder', maxIterations: -1 } },
      { commandId: '6', type: 'spawn', payload: { role: 'coder', maxIterations: 1.5 } },
      {
        commandId: '7',
        type: 'kanban-transition',
        payload: { boardId: 123, taskId: 't1', to: 'done' },
      },
      {
        commandId: '8',
        type: 'kanban-transition',
        payload: { boardId: 'b1', taskId: 't1', to: 'invalid-stage' },
      },
      {
        commandId: '9',
        type: 'kanban-assign',
        payload: { boardId: 'b1', taskId: 't1', agentId: null, assignee: 'a' },
      },
      {
        commandId: '10',
        type: 'kanban-dispatch',
        payload: { boardId: 'b1', taskId: 't1', comment: 42 },
      },
    ]) {
      const res = await dispatch(bad);
      expect(res.status).toBe('rejected');
    }

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(kanbanTransition).not.toHaveBeenCalled();
    expect(kanbanAssign).not.toHaveBeenCalled();
    expect(kanbanDispatch).not.toHaveBeenCalled();

    const ok = await dispatch({
      commandId: 'ok-1',
      type: 'kanban-transition',
      payload: { boardId: 'b1', taskId: 't1', to: 'review' },
    });
    expect(ok.status).toBe('completed');
    expect(kanbanTransition).toHaveBeenCalledWith({
      boardId: 'b1',
      taskId: 't1',
      to: 'review',
      comment: '',
    });
  });
});
