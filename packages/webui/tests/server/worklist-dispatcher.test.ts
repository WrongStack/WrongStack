import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleWorklistMessage,
  type WorklistContext,
} from '../../src/server/handlers/worklist-handlers.js';

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
  const ws = createMockWs();
  return {
    context: {
      todos: [{ id: 't1', content: 'do thing', status: 'pending' } as never],
      meta: {},
      session: { id: 's1' },
      state: undefined,
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
    // Invalid payload → error result, no plan broadcast.
    expect(ws.sent[0]?.type).toBe('error');
    expect(ctx.broadcast).not.toHaveBeenCalled();
  });

  it('is a no-op for an unrelated message type', async () => {
    const ctx = makeCtx();
    const ws = createMockWs();
    await handleWorklistMessage(ctx, ws, { type: 'not.a.worklist.type' });
    expect(ws.sent).toHaveLength(0);
  });
});
