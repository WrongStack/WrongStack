import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleWorklistMessage, type WorklistContext } from '@wrongstack/webui-server';

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

  it('validates plan.template_use payload and rejects bad input', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    await handleWorklistMessage(ctx, ws, { type: 'plan.template_use', payload: {} });
    // Invalid payload → operation error result, no plan broadcast.
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
