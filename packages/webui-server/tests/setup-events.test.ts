import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import type { SessionEventBridge } from '@wrongstack/core/storage';
import { describe, expect, it, vi } from 'vitest';
import { setupEvents } from '../src/server/setup-events.js';

describe('setupEvents session scoping', () => {
  it('forwards passive Chimera report notices to every browser surface', () => {
    const events = new EventBus();
    const broadcast = vi.fn();
    const dispose = setupEvents({
      events,
      broadcast,
      clients: new Map(),
      config: {},
      context: {
        session: { id: 'session-live' },
        todos: [],
        state: { onChange: vi.fn(), revision: 0 },
      } as unknown as Context,
      pendingConfirms: new Map(),
    });

    events.emitCustom('chimera.report_available', {
      sessionId: 'session-live',
      reportId: 'report-1',
      message: '🦂 Chimera report ready. No follow-up started.',
    });

    expect(broadcast).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({
        type: 'chimera.report_available',
        payload: expect.objectContaining({ reportId: 'report-1' }),
      }),
    );
    dispose();
  });

  it('only appends audit events for the active session', () => {
    const events = new EventBus();
    const append = vi.fn(async (_event: unknown) => {});
    const dispose = setupEvents({
      events,
      broadcast: () => {},
      clients: new Map(),
      config: {},
      context: {
        session: { id: '2026-06-29/sess_active' },
        todos: [],
        state: { onChange: vi.fn(), revision: 0 },
      } as unknown as Context,
      pendingConfirms: new Map(),
      sessionBridge: { append } as unknown as SessionEventBridge,
    });

    events.emit('provider.retry', {
      sessionId: '2026-06-29/sess_other',
      providerId: 'openai',
      attempt: 1,
      delayMs: 100,
      status: 429,
      description: 'rate limited',
    });
    events.emit('provider.retry', {
      sessionId: '2026-06-29/sess_active',
      providerId: 'openai',
      attempt: 2,
      delayMs: 200,
      status: 429,
      description: 'rate limited again',
      errorBody: {
        type: 'rate_limit_exceeded',
        message: 'rate limited again',
        raw: '{"type":"error"}',
      },
    });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      type: 'provider_retry',
      attempt: 2,
      errorBody: {
        type: 'rate_limit_exceeded',
        message: 'rate limited again',
        raw: '{"type":"error"}',
      },
    });
    dispose();
  });

  it('broadcasts attributed tool targets and raw filesystem events to CodeMap', () => {
    const events = new EventBus();
    const broadcast = vi.fn();
    const projectRoot = path.resolve('D:/repo');
    const dispose = setupEvents({
      events,
      broadcast,
      clients: new Map(),
      config: {},
      context: {
        projectRoot,
        session: { id: 'session-live' },
        todos: [],
        state: { onChange: vi.fn(), revision: 0 },
      } as unknown as Context,
      pendingConfirms: new Map(),
    });

    events.emit('tool.started', {
      sessionId: 'session-live',
      traceId: 'trace-live',
      agentId: 'agent-live',
      agentName: 'IMPLEMENTER',
      id: 'tool-live',
      name: 'read',
      input: { path: 'src/agent.ts', offset: 12, limit: 4 },
    });
    events.emit('file.activity', {
      filePath: path.join(projectRoot, 'src/agent.ts'),
      operation: 'edit',
      phase: 'changed',
      source: 'watcher',
      at: 123,
    });
    events.emit('tool.progress', {
      sessionId: 'session-live',
      traceId: 'trace-live',
      agentId: 'agent-live',
      agentName: 'IMPLEMENTER',
      id: 'tool-live',
      name: 'read',
      event: {
        type: 'file_changed',
        path: 'src/generated.ts',
        operation: 'write',
        line: 9,
      },
    });
    events.emit('subagent.tool_started', {
      sessionId: 'session-live',
      agentSessionId: 'session-worker',
      subagentId: 'worker-1',
      agentName: 'WORKER ONE',
      id: 'worker-tool-1',
      name: 'edit',
      input: { path: 'src/worker.ts' },
    });

    expect(broadcast).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({
        type: 'tool.started',
        payload: expect.objectContaining({
          sessionId: 'session-live',
          traceId: 'trace-live',
          agentId: 'agent-live',
          agentName: 'IMPLEMENTER',
          fileTargets: [
            {
              filePath: path.join(projectRoot, 'src/agent.ts'),
              operation: 'read',
              line: 12,
              endLine: 15,
            },
          ],
        }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({
        type: 'codemap.file_event',
        payload: expect.objectContaining({ source: 'watcher', at: 123 }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({
        type: 'tool.progress',
        payload: expect.objectContaining({
          traceId: 'trace-live',
          agentId: 'agent-live',
          event: expect.objectContaining({
            type: 'file_changed',
            path: path.join(projectRoot, 'src/generated.ts'),
            operation: 'write',
            line: 9,
          }),
        }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.any(Map),
      expect.objectContaining({
        type: 'codemap.tool_started',
        payload: expect.objectContaining({
          sessionId: 'session-worker',
          parentSessionId: 'session-live',
          agentId: 'worker-1',
          agentName: 'WORKER ONE',
          id: 'worker-tool-1',
          fileTargets: [
            expect.objectContaining({
              filePath: path.join(projectRoot, 'src/worker.ts'),
              operation: 'edit',
            }),
          ],
        }),
      }),
      // Delivered to the PARENT tab. `payload.sessionId` names the subagent's
      // own session so CodeMap can attribute the node, but no tab subscribes
      // to a subagent session — routing on it dropped the event at the wire.
      'session-live',
    );
    dispose();
  });
});

describe('setupEvents worklist board pairing', () => {
  /** The root context's board belongs to whichever tab is foreground; the
   *  event's board belongs to the session that produced the event. The two
   *  diverge the moment a second tab is open — broadcasting root's board
   *  under the event's session id is how one tab's worklist showed another
   *  tab's todos mid-update. */
  const ROOT_BOARD = [{ id: 'r1', content: 'root board', status: 'pending' as const }];
  const B_BOARD = [{ id: 'b1', content: 'tab B board', status: 'in_progress' as const }];

  function hostContext(): Context {
    return {
      session: { id: 'sess-a' },
      todos: ROOT_BOARD,
      sideEffects: [],
      meta: {},
    } as unknown as Context;
  }

  const todosFrames = (
    broadcast: ReturnType<typeof vi.fn>,
  ): Array<{ payload: { sessionId?: string; todos?: unknown[] } }> =>
    broadcast.mock.calls
      .map(([, msg]) => msg as { type: string; payload: { sessionId?: string; todos?: unknown[] } })
      .filter((msg) => msg.type === 'todos.updated');

  it("a foreign session's todo event broadcasts THAT session's board", () => {
    const events = new EventBus();
    const broadcast = vi.fn();
    const dispose = setupEvents({
      events,
      broadcast,
      clients: new Map(),
      config: {},
      context: hostContext(),
      pendingConfirms: new Map(),
      sessionContext: (id) =>
        id === 'sess-b'
          ? ({ session: { id: 'sess-b' }, todos: B_BOARD, sideEffects: [], meta: {} } as unknown as Context)
          : undefined,
    });
    try {
      events.emit('tool.executed', {
        sessionId: 'sess-b',
        id: 't1',
        name: 'todo',
        ok: true,
        durationMs: 1,
      });
      const frames = todosFrames(broadcast);
      expect(frames).toHaveLength(1);
      expect(frames[0].payload.sessionId).toBe('sess-b');
      expect(frames[0].payload.todos).toEqual(B_BOARD);
    } finally {
      dispose();
    }
  });

  it('an unresolvable foreign session broadcasts no board at all', () => {
    const events = new EventBus();
    const broadcast = vi.fn();
    const dispose = setupEvents({
      events,
      broadcast,
      clients: new Map(),
      config: {},
      context: hostContext(),
      pendingConfirms: new Map(),
    });
    try {
      events.emit('tool.executed', {
        sessionId: 'sess-b',
        id: 't1',
        name: 'todo',
        ok: true,
        durationMs: 1,
      });
      expect(todosFrames(broadcast)).toEqual([]);
      // The event itself is honest data and still goes out.
      expect(
        broadcast.mock.calls.some(([, msg]) => (msg as { type: string }).type === 'tool.executed'),
      ).toBe(true);
    } finally {
      dispose();
    }
  });

  it("the root session's own event keeps the root board", () => {
    const events = new EventBus();
    const broadcast = vi.fn();
    const dispose = setupEvents({
      events,
      broadcast,
      clients: new Map(),
      config: {},
      context: hostContext(),
      pendingConfirms: new Map(),
      sessionContext: () => undefined,
    });
    try {
      events.emit('tool.executed', {
        sessionId: 'sess-a',
        id: 't1',
        name: 'todo',
        ok: true,
        durationMs: 1,
      });
      const frames = todosFrames(broadcast);
      expect(frames).toHaveLength(1);
      expect(frames[0].payload.sessionId).toBe('sess-a');
      expect(frames[0].payload.todos).toEqual(ROOT_BOARD);
    } finally {
      dispose();
    }
  });
});
