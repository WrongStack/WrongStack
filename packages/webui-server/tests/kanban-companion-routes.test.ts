import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleKanbanCompanionRoute } from '../src/server/kanban-companion-routes.js';
import { handleKanbanRoute } from '../src/server/kanban-routes.js';
import type { WSServerMessage } from '../src/server/types.js';

/**
 * `kanban.companion.get` / `kanban.companion.set` — the WebUI wire contract for
 * the project-wide companion switch. The flag itself (lease, write fences,
 * workspace file) is the Kanban domain's; these tests pin THIS side of the
 * boundary: reply/broadcast shapes, requestId correlation, boolean validation,
 * no-client-path, and the disable side-effect on the host supervisor.
 */
const state = vi.hoisted(() => ({ enabled: true }));
// Partial mock (repo convention, cf. kanban-supervisor-sweep-reopened.test.ts):
// the route graph transitively reads real domain exports at import time, so
// only the two companion-flag bindings this slice consumes are faked here.
vi.mock('@wrongstack/kanban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/kanban')>();
  return {
    ...actual,
    getKanbanCompanionEnabled: vi.fn(async () => state.enabled),
    setKanbanCompanionEnabled: vi.fn(async (_root: string, enabled: boolean) => {
      state.enabled = enabled;
      return enabled;
    }),
  };
});

interface SentMessage {
  type: string;
  payload: { success?: boolean; data?: { enabled?: boolean }; error?: string; requestId?: string };
}

function makeWs(): { ws: WebSocket; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as SentMessage);
    },
  } as unknown as WebSocket;
  return { ws, sent };
}

function makeCtx(supervisor?: { cancelManagement: () => void }) {
  const broadcasts: WSServerMessage[] = [];
  return {
    ctx: {
      projectRoot: '/project',
      broadcast: (message: WSServerMessage) => {
        broadcasts.push(message);
      },
      ...(supervisor ? { supervisor } : {}),
    },
    broadcasts,
  };
}

beforeEach(() => {
  state.enabled = true;
  vi.clearAllMocks();
});

describe('kanban.companion routes', () => {
  it('get answers kanban.companion.status with the flag and echoes the requestId', async () => {
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();
    const handled = await handleKanbanRoute(
      ws,
      { type: 'kanban.companion.get', payload: { requestId: 'r-1' } } as never,
      ctx as never,
    );
    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('kanban.companion.status');
    expect(sent[0]!.payload.success).toBe(true);
    expect(sent[0]!.payload.data).toEqual({ enabled: true });
    expect(sent[0]!.payload.requestId).toBe('r-1');
  });

  it('get omits requestId when the request carried none', async () => {
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();
    await handleKanbanCompanionRoute(ws, 'kanban.companion.get', {}, ctx as never);
    expect(sent[0]!.payload.success).toBe(true);
    expect('requestId' in sent[0]!.payload).toBe(false);
  });

  it('get reflects the current workspace value, whatever it is', async () => {
    state.enabled = false;
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx();
    await handleKanbanCompanionRoute(ws, 'kanban.companion.get', {}, ctx as never);
    expect(sent[0]!.payload.data).toEqual({ enabled: false });
  });

  it('set flips the flag, answers the asker with requestId, and broadcasts the change without one', async () => {
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();
    await handleKanbanCompanionRoute(
      ws,
      'kanban.companion.set',
      { enabled: false, requestId: 'r-2' },
      ctx as never,
    );
    expect(state.enabled).toBe(false);
    expect(sent[0]!.type).toBe('kanban.companion.status');
    expect(sent[0]!.payload).toMatchObject({
      success: true,
      data: { enabled: false },
      requestId: 'r-2',
    });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.type).toBe('kanban.companion.status');
    expect(broadcasts[0]!.payload).toEqual({ success: true, data: { enabled: false } });
  });

  it('set to the unchanged value still broadcasts the authoritative state', async () => {
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();
    await handleKanbanCompanionRoute(ws, 'kanban.companion.set', { enabled: true }, ctx as never);
    expect(sent[0]!.payload.success).toBe(true);
    expect(sent[0]!.payload.data).toEqual({ enabled: true });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.payload).toEqual({ success: true, data: { enabled: true } });
  });

  it('rejects a non-boolean enabled before touching the domain', async () => {
    const { setKanbanCompanionEnabled } = await import('@wrongstack/kanban');
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();
    await handleKanbanCompanionRoute(ws, 'kanban.companion.set', { enabled: 'yes' }, ctx as never);
    expect(sent[0]!.payload.success).toBe(false);
    expect(sent[0]!.payload.error).toContain('boolean');
    expect(state.enabled).toBe(true);
    expect(broadcasts).toHaveLength(0);
    expect(vi.mocked(setKanbanCompanionEnabled)).not.toHaveBeenCalled();
  });

  it('maps a domain failure to success:false and keeps the requestId', async () => {
    const { setKanbanCompanionEnabled } = await import('@wrongstack/kanban');
    vi.mocked(setKanbanCompanionEnabled).mockRejectedValueOnce(new Error('workspace unreadable'));
    const { ws, sent } = makeWs();
    const { ctx, broadcasts } = makeCtx();
    await handleKanbanCompanionRoute(
      ws,
      'kanban.companion.set',
      { enabled: false, requestId: 'r-3' },
      ctx as never,
    );
    expect(sent[0]!.payload.success).toBe(false);
    expect(sent[0]!.payload.error).toContain('workspace unreadable');
    expect(sent[0]!.payload.requestId).toBe('r-3');
    expect(broadcasts).toHaveLength(0);
  });

  it('a disable that reached the flag stops the host supervisor in flight; an enable does not', async () => {
    const cancelManagement = vi.fn();
    const { ws, sent } = makeWs();
    const { ctx } = makeCtx({ cancelManagement });
    await handleKanbanCompanionRoute(ws, 'kanban.companion.set', { enabled: false }, ctx as never);
    expect(cancelManagement).toHaveBeenCalledTimes(1);
    expect(sent[0]!.payload.success).toBe(true);
    await handleKanbanCompanionRoute(ws, 'kanban.companion.set', { enabled: true }, ctx as never);
    expect(cancelManagement).toHaveBeenCalledTimes(1);
  });

  it('lets non-companion types fall through to the rest of the route table', async () => {
    const { ws } = makeWs();
    const { ctx } = makeCtx();
    const handled = await handleKanbanCompanionRoute(
      ws,
      'kanban.task.move',
      { boardId: 'b' },
      ctx as never,
    );
    expect(handled).toBe(false);
  });
});
