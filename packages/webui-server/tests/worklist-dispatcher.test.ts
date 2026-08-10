import { handleWorklistMessage, type WorklistContext } from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

function createMockWs() {
  const ws = {
    readyState: 1,
    sent: [] as Array<{ type: string; payload?: Record<string, unknown>; message?: string }>,
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
  } as never as WebSocket & {
    sent: Array<{ type: string; payload?: Record<string, unknown>; message?: string }>;
  };
  return ws;
}

function makeCtx(): WorklistContext {
  const _ws = createMockWs();
  return {
    context: {
      todos: [{ id: 't1', content: 'do thing', status: 'pending' } as never],
      meta: {},
      session: { id: 's1' },
    },
    send: (w, m) => (w as never as { send: (d: string) => void }).send(JSON.stringify(m)),
    broadcast: vi.fn(),
  };
}

describe('handleWorklistMessage dispatcher', () => {
  it('routes todos.get to the todos handler', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    await handleWorklistMessage(ctx, ws, { type: 'todos.get' });
    expect(ws.sent[0]?.type).toBe('todos.updated');
    expect(ws.sent[0]?.payload?.todos).toHaveLength(1);
  });

  it('routes todo status changes through the canonical mutator and broadcasts its projection', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    const canonical = [
      {
        id: 't1',
        content: 'do thing',
        status: 'completed' as const,
        kanbanBoardId: 'board-1',
        kanbanTaskId: 'task-1',
      },
    ];
    ctx.context.todos = [
      {
        id: 't1',
        content: 'do thing',
        status: 'pending',
        kanbanBoardId: 'board-1',
        kanbanTaskId: 'task-1',
      },
    ];
    ctx.mutateTodos = vi.fn(async () => ({ todos: canonical }));

    await handleWorklistMessage(ctx, ws, {
      type: 'todo.update',
      payload: { id: 't1', status: 'completed' },
    });

    expect(ctx.mutateTodos).toHaveBeenCalledOnce();
    expect(ctx.broadcast).toHaveBeenCalledWith({
      type: 'todos.updated',
      payload: { sessionId: 's1', todos: canonical },
    });
    expect(ws.sent[0]?.payload?.success).toBe(true);
  });

  it('does not remove a Todo row owned by a real Kanban task', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    ctx.context.todos = [
      {
        id: 't1',
        content: 'do thing',
        status: 'pending',
        kanbanBoardId: 'board-1',
        kanbanTaskId: 'task-1',
      },
    ];
    ctx.mutateTodos = vi.fn(async (todos) => ({ todos }));

    await handleWorklistMessage(ctx, ws, { type: 'todos.remove', payload: { id: 't1' } });

    expect(ctx.mutateTodos).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ws.sent[0]?.payload?.success).toBe(false);
    expect(ws.sent[0]?.payload?.message).toContain('task projections');
  });

  it('rejects malformed todo updates without throwing or mutating state', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    ctx.mutateTodos = vi.fn(async (todos) => ({ todos }));

    await handleWorklistMessage(ctx, ws, {
      type: 'todo.update',
      payload: { id: 't1', status: 'exploded' },
    });

    expect(ctx.mutateTodos).not.toHaveBeenCalled();
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ws.sent[0]?.payload?.success).toBe(false);
  });

  it('contains canonical mutation failures at the websocket boundary', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    ctx.mutateTodos = vi.fn(async () => {
      throw new Error('Kanban daemon unavailable');
    });

    await handleWorklistMessage(ctx, ws, {
      type: 'todo.update',
      payload: { id: 't1', status: 'completed' },
    });

    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ws.sent[0]?.payload).toMatchObject({
      success: false,
      message: 'Kanban daemon unavailable',
    });
  });

  it('routes task status through the canonical mutator and contains dependency rejection', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    ctx.context.meta['task.path'] = 'tasks.json';
    ctx.mutateTaskStatus = vi.fn(async () => ({
      ok: false,
      message: 'Task cannot be in_progress before dependencies complete.',
    }));

    await handleWorklistMessage(ctx, ws, {
      type: 'task.update',
      payload: { id: 'dependent', status: 'in_progress' },
    });

    expect(ctx.mutateTaskStatus).toHaveBeenCalledWith('dependent', 'in_progress');
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ws.sent[0]?.payload).toMatchObject({ success: false });
  });

  it('routes plan status through the canonical mutator', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    ctx.context.meta['plan.path'] = 'plan.json';
    ctx.mutatePlan = vi.fn(async () => ({ ok: false, message: 'projection rejected' }));

    await handleWorklistMessage(ctx, ws, {
      type: 'plan.item.update',
      payload: { target: 'step-1', status: 'done' },
    });

    expect(ctx.mutatePlan).toHaveBeenCalledWith({
      action: 'status',
      target: 'step-1',
      status: 'done',
    });
    expect(ctx.broadcast).not.toHaveBeenCalled();
    expect(ws.sent[0]?.payload).toMatchObject({ success: false });
  });

  it('validates plan.template_use payload and rejects bad input', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    await handleWorklistMessage(ctx, ws, { type: 'plan.template_use', payload: {} });
    // Invalid payload → error result, no plan broadcast.
    expect(ws.sent[0]?.type).toBe('key.operation_result');
    expect(ws.sent[0]?.payload?.success).toBe(false);
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it('is a no-op for an unrelated message type', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    await handleWorklistMessage(ctx, ws, { type: 'not.a.worklist.type' });
    expect(ws.sent).toHaveLength(0);
  });
});
