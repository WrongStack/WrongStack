import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { createSessionHandlers } from '../src/server/session-handlers.js';

/**
 * The context operations act on the tab that asked for them.
 *
 * Compact, Clear, Repair, Rewind, the context editor and the context-window
 * mode all used to work on `ctx.context` — the shared root, which with four
 * tabs live is whichever session the runtime last activated rather than the
 * one whose button was pressed. Four of the six are destructive: Compact
 * rewrote another tab's conversation, Clear emptied it, Rewind cut it back to
 * an earlier turn. The other two quietly answered with a stranger's numbers.
 */

const ws = {} as WebSocket;

function mkContext(id: string, messageCount: number) {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: 'user',
    content: `${id} message ${i}`,
  }));
  return {
    session: { id, append: async () => undefined, close: async () => undefined },
    // The estimator walks the prompt as blocks.
    systemPrompt: [{ type: 'text', text: `prompt for ${id}` }],
    messages,
    provider: { id: 'p' },
    model: 'm',
    meta: { contextWindowMode: id === 'sess_bg' ? 'lean' : 'balanced' } as Record<string, unknown>,
    lastRequestTokens: 0,
    tokenCounter: { reset: vi.fn(), total: () => ({ input: 0, output: 0 }), account: vi.fn() },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    clearMemoryEvidence: vi.fn(),
    flushConversationJournal: vi.fn(async () => undefined),
    state: {
      messages,
      todos: [],
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn(),
      setMeta: vi.fn(),
      deleteMeta: vi.fn(),
    },
  };
}

function harness() {
  const contexts = {
    sess_front: mkContext('sess_front', 2),
    sess_bg: mkContext('sess_bg', 7),
  };
  // Known ONLY to the non-creating lookup. The creating `getAgent` below
  // falls back to the foreground context for unknown ids — mimicking a
  // leader-fallback registry — so any answer that describes `sess_peek`
  // correctly proves the peek path was taken.
  const sess_peek = mkContext('sess_peek', 3);
  sess_peek.meta['contextWindowMode'] = 'peeked';
  const sent: Array<{ type: string; payload: unknown }> = [];
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  const compacted: string[] = [];

  const handlers = createSessionHandlers({
    config: { model: 'm', provider: 'p' },
    context: contexts.sess_front as never,
    tokenCounter: { account: vi.fn(), total: () => ({}), reset: vi.fn() } as never,
    listTools: () => [],
    getCompactor: () =>
      ({
        compact: async (target: { session?: { id?: string } }) => {
          compacted.push(target.session?.id ?? '?');
          return { before: 100, after: 40 };
        },
      }) as never,
    getCustomModeStore: async () => ({ list: () => [], remove: () => ({ ok: true }) }) as never,
    getProjectRoot: () => '/repo',
    getSession: () => contexts.sess_front.session as never,
    setSession: vi.fn(),
    getSessionStore: () => ({ list: async () => [] }) as never,
    // A multi-session host serves any tab it holds an agent for; without this
    // the session gate refuses every request that names a background tab.
    hasSession: () => true,
    getAgent: (id) =>
      ({
        ctx: contexts[(id ?? 'sess_front') as keyof typeof contexts] ?? contexts.sess_front,
      }) as never,
    // Non-creating twin: answers for every session the registry holds — the
    // same set getAgent's map covers, minus creation — plus the peek-only
    // probe. An unknown id stays unknown, mirroring production registries
    // where peek covers exactly what getAgent can create from.
    peekAgent: (id) => {
      const held = (contexts as Record<string, ReturnType<typeof mkContext>>)[id ?? ''];
      if (held) return { ctx: held } as never;
      return id === 'sess_peek' ? ({ ctx: sess_peek } as never) : undefined;
    },
    sessionStartPayload: async (o) => ({ ...o }) as never,
    sendMessage: (_ws, message) => sent.push(message),
    broadcastMessage: (message) => broadcasts.push(message),
  });

  return { handlers, contexts, sent, broadcasts, compacted };
}

describe('context operations act on the requesting tab', () => {
  it('compacts the named session, not the runtime’s', async () => {
    const h = harness();

    await h.handlers.compactContext(ws, {
      type: 'context.compact',
      payload: { sessionId: 'sess_bg', aggressive: false },
    });

    expect(h.compacted).toEqual(['sess_bg']);
  });

  it('clears the named session and leaves the tab in front alone', async () => {
    const h = harness();

    await h.handlers.clearContext(ws, {
      type: 'context.clear',
      payload: { sessionId: 'sess_bg' },
    });

    expect(h.contexts.sess_bg.state.replaceMessages).toHaveBeenCalledWith([]);
    expect(h.contexts.sess_front.state.replaceMessages).not.toHaveBeenCalled();
    // …including its token counter, which is the session's own.
    expect(h.contexts.sess_bg.tokenCounter.reset).toHaveBeenCalled();
    expect(h.contexts.sess_front.tokenCounter.reset).not.toHaveBeenCalled();
    // The reset announcement is stamped with the session that was CLEARED.
    // Built from the root context it named the foreground session, so the
    // background lane zeroed itself while every tab hydrated the wrong state.
    const reset = h.broadcasts.find((m) => m.type === 'session.start')?.payload as {
      sessionId?: string;
      reset?: boolean;
    };
    expect(reset?.sessionId).toBe('sess_bg');
    expect(reset?.reset).toBe(true);
  });

  it('answers context.debug from the named session and stamps it', async () => {
    const h = harness();

    await h.handlers.debugContext(ws, {
      type: 'context.debug',
      payload: { sessionId: 'sess_bg' },
    });

    const reply = h.sent.find((m) => m.type === 'context.debug')?.payload as {
      sessionId?: string;
      mode?: unknown;
    };
    // Stamped with the ASKING session — the browser filters replies by it, so
    // an answer stamped with the runtime's session was dropped and the panel
    // stayed empty.
    expect(reply?.sessionId).toBe('sess_bg');
    expect(reply?.mode).toBe('lean');
  });

  it('resolves context.debug through the non-creating peek, not getAgent', async () => {
    const h = harness();

    await h.handlers.debugContext(ws, {
      type: 'context.debug',
      payload: { sessionId: 'sess_peek' },
    });

    const reply = h.sent.find((m) => m.type === 'context.debug')?.payload as {
      sessionId?: string;
      mode?: unknown;
    };
    // `sess_peek` is known to peekAgent alone; had the handler gone through
    // the creating getAgent it would have answered with the foreground
    // context's mode ('balanced') under `sess_peek`'s name.
    expect(reply?.sessionId).toBe('sess_peek');
    expect(reply?.mode).toBe('peeked');
  });

  it('refuses context.debug for a session with no live context instead of serving the root', async () => {
    const h = harness();

    await h.handlers.debugContext(ws, {
      type: 'context.debug',
      payload: { sessionId: 'sess_ghost' },
    });

    // No context.debug reply at all: the shared root belongs to whichever
    // session the runtime points at (here the foreground), and serving it
    // stamped with `sess_ghost` is exactly the cross-tab data bleed.
    expect(h.sent.some((m) => m.type === 'context.debug')).toBe(false);
    const error = h.sent.find((m) => m.type === 'error')?.payload as {
      phase?: string;
      requestedSessionId?: unknown;
      sessionId?: string;
      message?: string;
    };
    expect(error?.phase).toBe('context.debug');
    // Stamped for the ASKING tab so the client routes the refusal into
    // that tab's lane rather than into whichever tab is in front.
    expect(error?.sessionId).toBe('sess_ghost');
    expect(error?.message).toContain('not live');
    // requestedSessionId must stay OFF: the webui client swallows
    // requestedSessionId-bearing error frames as session-swap guard
    // noise, and this refusal is not noise.
    expect(error?.requestedSessionId).toBeUndefined();
  });

  it('still serves the runtime’s own current session from the root context', async () => {
    const h = harness();

    await h.handlers.debugContext(ws, {
      type: 'context.debug',
      payload: { sessionId: 'sess_front' },
    });

    // No registry entry for the current session — a single-session host has
    // no per-session agents; the root IS its context and must keep working.
    const reply = h.sent.find((m) => m.type === 'context.debug')?.payload as {
      sessionId?: string;
      mode?: unknown;
    };
    expect(reply?.sessionId).toBe('sess_front');
    expect(reply?.mode).toBe('balanced');
  });

  it('repairs the named session and reports against it', async () => {
    const h = harness();

    await h.handlers.repairContext(ws, {
      type: 'context.repair',
      payload: { sessionId: 'sess_bg' },
    });

    const report = h.broadcasts.find((m) => m.type === 'context.repaired')?.payload as {
      sessionId?: string;
      beforeMessages?: number;
    };
    expect(report?.sessionId).toBe('sess_bg');
    expect(report?.beforeMessages).toBe(7);
  });

  it('switches the context-window mode on the named session only', async () => {
    const h = harness();

    await h.handlers.switchContextMode(ws, {
      type: 'context.mode.switch',
      payload: { sessionId: 'sess_bg', id: 'deep' },
    });

    expect(h.contexts.sess_bg.meta['contextWindowMode']).toBe('deep');
    expect(h.contexts.sess_front.meta['contextWindowMode']).toBe('balanced');
    const changed = h.broadcasts.find((m) => m.type === 'context.mode.changed')?.payload as {
      sessionId?: string;
    };
    expect(changed?.sessionId).toBe('sess_bg');
  });

  it('opens the context editor on the named session and stamps the snapshot', async () => {
    const h = harness();

    await h.handlers.openContextEditor(ws, {
      type: 'context.editor.open',
      payload: { sessionId: 'sess_bg' },
    });

    const snap = h.sent.find((m) => m.type === 'context.editor.snapshot')?.payload as {
      sessionId?: string;
      messages?: unknown[];
    };
    expect(snap?.sessionId).toBe('sess_bg');
    expect(snap?.messages).toHaveLength(7);
  });

  it('answers an empty-history tab with a snapshot, not silence', async () => {
    const empty = mkContext('sess_empty', 0);
    const h = harness();
    (h as { contexts: Record<string, ReturnType<typeof mkContext>> }).contexts.sess_empty = empty;

    await h.handlers.openContextEditor(ws, {
      type: 'context.editor.open',
      payload: { sessionId: 'sess_empty' },
    });

    const snap = h.sent.find((m) => m.type === 'context.editor.snapshot')?.payload as {
      sessionId?: string;
      messages?: unknown[];
      readonlyContext?: { totalTokens?: number };
    };
    // Empty conversation is still a snapshot — system prompt + tools. The
    // overlay used to stay on "Loading context snapshot…" because nothing
    // arrived for a tab with no history.
    expect(snap?.sessionId).toBe('sess_empty');
    expect(snap?.messages).toEqual([]);
    expect(snap?.readonlyContext).toBeDefined();
  });

  it('refuses a foreign context op with a frame the client can route', async () => {
    const h = harness();

    await h.handlers.compactContext(ws, {
      type: 'context.compact',
      payload: { sessionId: 'sess_ghost', aggressive: false },
    });

    const error = h.sent.find((m) => m.type === 'error')?.payload as {
      phase?: string;
      sessionId?: string;
      message?: string;
      requestedSessionId?: unknown;
    };
    expect(error?.phase).toBe('context.compact');
    // Stamped for the ASKING tab so the client routes the refusal to its lane.
    expect(error?.sessionId).toBe('sess_ghost');
    expect(error?.message).toContain('not live');
    // requestedSessionId must stay OFF: the client swallows frames carrying it
    // as swap-guard noise, and this refusal is not noise.
    expect(error?.requestedSessionId).toBeUndefined();
    // And compacted NOTHING — the ghost session has no context here.
    expect(h.compacted).toEqual([]);
  });

  it('lists the modes with the named session’s active one', async () => {
    const h = harness();

    await h.handlers.listContextModes(ws, {
      type: 'context.modes.list',
      payload: { sessionId: 'sess_bg' },
    });

    const list = h.sent.find((m) => m.type === 'context.modes.list')?.payload as {
      activeId?: string;
      sessionId?: string;
    };
    expect(list?.activeId).toBe('lean');
    expect(list?.sessionId).toBe('sess_bg');
  });

  it('refuses to rewind a session this runtime does not hold open', async () => {
    const h = harness();

    await h.handlers.rewindSession(ws, {
      type: 'session.rewind',
      payload: { sessionId: 'sess_elsewhere', checkpointIndex: 1 },
    });

    const answer = h.sent.find((m) => m.type === 'key.operation_result')?.payload as {
      success?: boolean;
      message?: string;
    };
    // Cutting a journal this process does not own leaves the file and the
    // context that is still appending to it out of step.
    expect(answer?.success).toBe(false);
    expect(answer?.message).toContain('not open in this runtime');
  });
});
