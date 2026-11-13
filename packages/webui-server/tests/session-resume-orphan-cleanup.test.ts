import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { createSessionHandlers } from '../src/server/session-handlers.js';

/**
 * A resume whose ORPHAN CLEANUP fails.
 *
 * `finalizeSession` closes the session the tab is leaving. It runs inside the
 * resume, but it is cleanup, not part of the resume: when it throws (a journal
 * IO error, a closed handle), the resumed session is already on its way in
 * and the tab still needs its `session.start`. Failing the whole request left
 * the tab desynced — no transcript, no session id, a spinner that never
 * stops — over a cleanup error it could have ignored.
 */

const ws = {} as WebSocket;

type Writer = {
  id: string;
  startedAt: string;
  append: () => Promise<void>;
  close: () => Promise<void>;
};

const writer = (id: string, startedAt = '2026-01-01T00:00:00.000Z'): Writer => ({
  id,
  startedAt,
  append: async () => undefined,
  close: async () => undefined,
});

function harness(options?: {
  /** Test hook: the session being left throws when it is finalized. */
  failFinalize?: boolean;
}) {
  const bootWriter = writer('sess_boot');
  if (options?.failFinalize) {
    // A closed journal handle: `append` throws synchronously, so the
    // `.catch()` the finalizer chains onto it never gets a promise to attach
    // to and the error escapes the finalizer itself.
    bootWriter.append = () => {
      throw new Error('journal handle is closed');
    };
  }
  const contexts = new Map<string, Record<string, unknown>>();
  const mkCtx = (id: string) => {
    const ctx = {
      session: writer(id),
      lastRequestTokens: 7,
      state: {
        messages: [{ role: 'user', content: `transcript of ${id}` }],
        todos: [],
        replaceMessages: vi.fn(),
        replaceTodos: vi.fn(),
        setMeta: vi.fn(),
        deleteMeta: vi.fn(),
      },
      readFiles: new Set<string>(),
      fileMtimes: new Map<string, number>(),
      messages: [{ role: 'user', content: `transcript of ${id}` }],
      provider: { id: 'p' },
      flushConversationJournal: vi.fn(async () => undefined),
      clearMemoryEvidence: vi.fn(),
    };
    contexts.set(id, ctx as unknown as Record<string, unknown>);
    return ctx;
  };
  const rootCtx = mkCtx('sess_boot');
  rootCtx.session = bootWriter;

  const sent: Array<{ type: string; payload: unknown }> = [];
  let current: Writer = bootWriter;

  const handlers = createSessionHandlers({
    config: { model: 'm', provider: 'p' },
    context: rootCtx as never,
    tokenCounter: { account: vi.fn(), total: () => ({}), reset: vi.fn() } as never,
    getProjectRoot: () => '/repo',
    getSession: () => current as never,
    setSession: (next) => {
      current = next as never;
    },
    getSessionStore: () =>
      ({
        resolveId: async (id: string) => id,
        resume: async (id: string) => ({
          writer: writer(id, '2026-07-25T10:00:00.000Z'),
          data: { messages: [], events: [], usage: undefined },
        }),
        list: async () => [],
      }) as never,
    isSessionLive: (id) => contexts.has(id),
    isRunActive: () => false,
    getAgent: (id) => ({ ctx: contexts.get(id ?? '') ?? rootCtx }) as never,
    sessionStartPayload: async (overrides) => ({ ...overrides }) as never,
    sendMessage: (_ws, message) => sent.push(message),
    broadcastMessage: (message) => sent.push(message),
  });

  return { handlers, sent, currentId: () => current.id };
}

describe('a resume whose orphan cleanup fails', () => {
  it('still sends session.start and reports success', async () => {
    const h = harness({ failFinalize: true });

    await h.handlers.resumeSession(ws, { type: 'session.resume', payload: { id: 'sess_cold' } });

    // The tab gets its session — the resumed one, not the failed-over one.
    const start = h.sent.find((m) => m.type === 'session.start');
    expect(start?.payload).toMatchObject({ sessionId: 'sess_cold' });
    // And the client is told the resume worked.
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect((res?.payload as { success?: boolean } | undefined)?.success).toBe(true);
    // The runtime moved onto the resumed session.
    expect(h.currentId()).toBe('sess_cold');
  });
});
