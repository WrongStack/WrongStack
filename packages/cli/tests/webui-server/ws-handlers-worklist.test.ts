import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handlePlanGet,
  handlePlanItemUpdate,
  handlePlanTemplateUse,
  handleTasksGet,
  handleTaskUpdate,
  handleTodosClear,
  handleTodosGet,
  handleTodosRemove,
  handleTodoUpdate,
} from '../../src/webui-server/ws-handlers/index.js';
import type { WorklistContext } from '../../src/webui-server/ws-handlers/worklist.js';

/**
 * PR 5d of Issue #30: work-list ws-handler unit tests.
 *
 * Todos run fully in-memory against a fake agent ctx; plan/task handlers
 * round-trip through real temp files (the path comes from
 * ctx.meta['plan.path'] / ['task.path']).
 */

const FAKE_WS = {} as WebSocket;

interface FakeAgent {
  ctx: {
    todos: Array<{ id: string; content: string; status: string; activeForm?: string }>;
    meta: Record<string, unknown>;
    state: { replaceTodos: (next: unknown[]) => void };
  };
}

function makeAgent(initialTodos: FakeAgent['ctx']['todos'] = []): FakeAgent {
  const agent: FakeAgent = {
    ctx: {
      todos: [...initialTodos],
      meta: {},
      state: {
        replaceTodos: (next) => {
          agent.ctx.todos = next as FakeAgent['ctx']['todos'];
        },
      },
    },
  };
  return agent;
}

function makeCtx(agent: FakeAgent): {
  ctx: WorklistContext;
  sent: WsServerMessage[];
  bc: WsServerMessage[];
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const ctx: WorklistContext = {
    agent: agent as never,
    sessionId: 'sess-1',
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
  };
  return { ctx, sent, bc };
}

const result = (sent: WsServerMessage[]) =>
  sent.filter((m) => m.type === 'key.operation_result').at(-1)?.payload as
    | { success: boolean; message: string }
    | undefined;

const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);

let tmpDir = '';
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-pr5d-'));
});
afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('todos', () => {
  const seed = () => [
    { id: 'a', content: 'first', status: 'pending' },
    { id: 'b', content: 'second', status: 'pending' },
  ];

  it('todos.get sends the current list', () => {
    const { ctx, sent } = makeCtx(makeAgent(seed()));
    handleTodosGet(ctx, FAKE_WS);
    expect((lastOf(sent, 'todos.updated')?.payload as { todos: unknown[] }).todos).toHaveLength(2);
  });

  it('todos.clear empties and broadcasts', () => {
    const agent = makeAgent(seed());
    const { ctx, sent, bc } = makeCtx(agent);
    handleTodosClear(ctx, FAKE_WS);
    expect(result(sent)?.success).toBe(true);
    expect(agent.ctx.todos).toEqual([]);
    expect((lastOf(bc, 'todos.updated')?.payload as { todos: unknown[] }).todos).toEqual([]);
  });

  it('todos.remove by id removes the matching todo', () => {
    const agent = makeAgent(seed());
    const { ctx, sent } = makeCtx(agent);
    handleTodosRemove(ctx, FAKE_WS, { id: 'a' });
    expect(result(sent)?.success).toBe(true);
    expect(agent.ctx.todos.map((t) => t.id)).toEqual(['b']);
  });

  it('todos.remove by 1-based index removes the right one', () => {
    const agent = makeAgent(seed());
    const { ctx } = makeCtx(agent);
    handleTodosRemove(ctx, FAKE_WS, { index: 2 });
    expect(agent.ctx.todos.map((t) => t.id)).toEqual(['a']);
  });

  it('todos.remove reports not-found for an unknown id', () => {
    const { ctx, sent } = makeCtx(makeAgent(seed()));
    handleTodosRemove(ctx, FAKE_WS, { id: 'zzz' });
    expect(result(sent)).toMatchObject({ success: false, message: 'Todo not found' });
  });

  it('todo.update changes status + activeForm', () => {
    const agent = makeAgent(seed());
    const { ctx, sent } = makeCtx(agent);
    handleTodoUpdate(ctx, FAKE_WS, { id: 'b', status: 'in_progress', activeForm: 'doing it' });
    expect(result(sent)?.success).toBe(true);
    expect(agent.ctx.todos[1]).toMatchObject({ status: 'in_progress', activeForm: 'doing it' });
  });

  it('todo.update reports not-found for an unknown id', () => {
    const { ctx, sent } = makeCtx(makeAgent(seed()));
    handleTodoUpdate(ctx, FAKE_WS, { id: 'zzz', status: 'completed' });
    expect(result(sent)?.success).toBe(false);
  });
});

describe('plan', () => {
  it('plan.get errors when no plan path is configured', async () => {
    const { ctx, sent } = makeCtx(makeAgent());
    await handlePlanGet(ctx, FAKE_WS);
    const p = lastOf(sent, 'plan.updated')?.payload as { plan: unknown; error?: string };
    expect(p.plan).toBeNull();
    expect(p.error).toContain('not configured');
  });

  it('template_use applies a template, persists, and plan.get reads it back', async () => {
    const agent = makeAgent();
    agent.ctx.meta['plan.path'] = path.join(tmpDir, 'plan.json');
    const { ctx, sent, bc } = makeCtx(agent);

    await handlePlanTemplateUse(ctx, FAKE_WS, 'refactor');
    expect(result(sent)?.success).toBe(true);
    const broadcastPlan = lastOf(bc, 'plan.updated')?.payload as { plan: { items: unknown[] } };
    expect(broadcastPlan.plan.items.length).toBeGreaterThan(0);

    const { ctx: ctx2, sent: sent2 } = makeCtx(agent);
    await handlePlanGet(ctx2, FAKE_WS);
    const got = lastOf(sent2, 'plan.updated')?.payload as { plan: { items: unknown[] } };
    expect(got.plan.items.length).toBe(broadcastPlan.plan.items.length);
  });

  it('template_use rejects an unknown template', async () => {
    const agent = makeAgent();
    agent.ctx.meta['plan.path'] = path.join(tmpDir, 'plan.json');
    const { ctx, sent } = makeCtx(agent);
    await handlePlanTemplateUse(ctx, FAKE_WS, 'definitely-not-a-template');
    expect(result(sent)).toMatchObject({ success: false });
    expect(result(sent)?.message).toContain('Unknown template');
  });

  it('item.update sets a real item status and rejects an unmatched target', async () => {
    const agent = makeAgent();
    agent.ctx.meta['plan.path'] = path.join(tmpDir, 'plan.json');
    const seedCtx = makeCtx(agent);
    await handlePlanTemplateUse(seedCtx.ctx, FAKE_WS, 'refactor');

    // First item's target is "1" (1-based ordinal) in the plan model.
    const upd = makeCtx(agent);
    await handlePlanItemUpdate(upd.ctx, FAKE_WS, { target: '1', status: 'done' });
    expect(result(upd.sent)?.success).toBe(true);

    const miss = makeCtx(agent);
    await handlePlanItemUpdate(miss.ctx, FAKE_WS, { target: '9999', status: 'done' });
    expect(result(miss.sent)?.success).toBe(false);
  });
});

describe('tasks', () => {
  it('tasks.get errors when no task path is configured', async () => {
    const { ctx, sent } = makeCtx(makeAgent());
    await handleTasksGet(ctx, FAKE_WS);
    const p = lastOf(sent, 'tasks.updated')?.payload as { tasks: unknown[]; error?: string };
    expect(p.tasks).toEqual([]);
    expect(p.error).toContain('not configured');
  });

  it('task.update errors when no task path is configured', async () => {
    const { ctx, sent } = makeCtx(makeAgent());
    await handleTaskUpdate(ctx, FAKE_WS, { id: 'x', status: 'completed' });
    expect(result(sent)).toMatchObject({ success: false });
  });
});
