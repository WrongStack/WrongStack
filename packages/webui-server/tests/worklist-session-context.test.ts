import { sessionScopedPath } from '@wrongstack/core/utils';
import { describe, expect, it, vi } from 'vitest';
import type { WorklistMessage } from '../src/server/handlers/worklist-handlers.js';
import { createSessionAwareWorklistContext } from '../src/server/worklist-session-context.js';

/**
 * The worklist routes (todos / tasks / plan) must bind to the session the
 * request NAMES, not to whichever session the shared root context happens to
 * point at. Before this factory existed, every tab's panel request was served
 * — and mutated — the foreground session's board, which is how the 2nd menu
 * area showed one shared list across all four tabs.
 */

interface FakeContext {
  todos: Array<{ id: string; content: string; status: string }>;
  meta: Record<string, unknown>;
  session: { id: string } | null;
  state: {
    setMeta?: (key: string, value: unknown) => void;
    replaceTodos: (todos: never[]) => void;
  };
}

const SESSIONS_DIR = '/proj/.wrongstack/sessions';

function fakeContext(sessionId: string, todos: string[] = []): FakeContext {
  const meta: Record<string, unknown> = {};
  return {
    todos: todos.map((content, i) => ({ id: `t${i}`, content, status: 'pending' })),
    meta,
    session: { id: sessionId },
    state: {
      // Mirror the real ConversationState.setMeta, which writes through to
      // ctx.meta — the factory relies on those semantics.
      setMeta: Object.assign(
        vi.fn((key: string, value: unknown) => {
          meta[key] = value;
        }),
      ),
      replaceTodos: vi.fn(),
    },
  };
}

function harness(options?: {
  rootPlanPath?: string;
  agents?: Map<string, FakeContext>;
  peekAgent?: (id: string) => { ctx: FakeContext } | undefined;
}) {
  const root = fakeContext('sess_foreground', ['root-todo']);
  if (options?.rootPlanPath) root.meta['plan.path'] = options.rootPlanPath;
  const agents = options?.agents ?? new Map<string, FakeContext>();
  const peekAgent =
    options?.peekAgent ??
    ((id: string) => {
      const ctx = agents.get(id);
      return ctx ? { ctx } : undefined;
    });
  const getAgent = vi.fn((id?: string) => {
    if (!id) return { ctx: root };
    let ctx = agents.get(id);
    if (!ctx) {
      ctx = fakeContext(id, []);
      agents.set(id, ctx);
    }
    return { ctx };
  });
  const resolve = createSessionAwareWorklistContext({
    rootContext: root as never,
    peekAgent: peekAgent as never,
    getAgent: getAgent as never,
    sessionsDir: '/proj/.wrongstack/sessions',
    send: vi.fn(),
    broadcast: vi.fn(),
  });
  return { root, agents, getAgent, resolve };
}

const msg = (sessionId?: string): WorklistMessage => ({
  type: 'todos.get',
  ...(sessionId ? { payload: { sessionId } } : {}),
});

describe('createSessionAwareWorklistContext', () => {
  it('serves the root context for an untagged request (single-session hosts)', () => {
    const { resolve, root } = harness();
    const ctx = resolve(msg());
    expect(ctx.context.session?.id).toBe('sess_foreground');
    expect(ctx.context.todos).toBe(root.todos);
  });

  it('serves the root context when the request names the root session', () => {
    const { resolve } = harness();
    expect(resolve(msg('sess_foreground')).context.session?.id).toBe('sess_foreground');
  });

  it('binds a request naming a background session to THAT session, not the foreground', () => {
    const agents = new Map([['sess_background', fakeContext('sess_background', ['bg-todo'])]]);
    const { resolve, root } = harness({ agents });

    const ctx = resolve(msg('sess_background'));

    expect(ctx.context.session?.id).toBe('sess_background');
    expect(ctx.context.todos.map((t) => t.content)).toEqual(['bg-todo']);
    // The foreground board must not have been read or touched.
    expect(root.todos.map((t) => t.content)).toEqual(['root-todo']);
  });

  it('re-scopes a stale plan/task path inherited from the root meta', () => {
    const background = fakeContext('sess_background', []);
    // Minted while the root sat on another session: the root's paths were
    // copied verbatim, so the background agent would read/write the
    // foreground session's sidecars.
    background.meta['plan.path'] = sessionScopedPath(SESSIONS_DIR, 'sess_foreground', '.plan.json');
    background.meta['task.path'] = sessionScopedPath(
      SESSIONS_DIR,
      'sess_foreground',
      '.tasks.json',
    );
    const agents = new Map([['sess_background', background]]);
    const { resolve } = harness({ agents });

    resolve(msg('sess_background'));

    expect(background.meta['plan.path']).toBe(
      sessionScopedPath(SESSIONS_DIR, 'sess_background', '.plan.json'),
    );
    expect(background.meta['task.path']).toBe(
      sessionScopedPath(SESSIONS_DIR, 'sess_background', '.tasks.json'),
    );
  });

  it('leaves correct paths untouched (no redundant setMeta writes)', () => {
    const background = fakeContext('sess_background', []);
    background.meta['plan.path'] = sessionScopedPath(SESSIONS_DIR, 'sess_background', '.plan.json');
    background.meta['task.path'] = sessionScopedPath(
      SESSIONS_DIR,
      'sess_background',
      '.tasks.json',
    );
    const agents = new Map([['sess_background', background]]);
    const { resolve } = harness({ agents });

    resolve(msg('sess_background'));

    expect(background.state.setMeta).not.toHaveBeenCalled();
  });

  it('falls back to getAgent (creating the agent) when peekAgent finds none', () => {
    const { resolve, getAgent } = harness({ peekAgent: () => undefined });

    const ctx = resolve(msg('sess_new'));

    expect(getAgent).toHaveBeenCalledWith('sess_new');
    expect(ctx.context.session?.id).toBe('sess_new');
  });

  it('keeps the root context when no agent can be resolved for the id', () => {
    const { resolve } = harness({ peekAgent: () => undefined });
    // getAgent present but returns undefined for unknown ids.
    const guarded = createSessionAwareWorklistContext({
      rootContext: {} as never,
      peekAgent: () => undefined,
      getAgent: () => undefined as never,
      sessionsDir: '/s',
      send: vi.fn(),
      broadcast: vi.fn(),
    });
    void resolve;
    expect(guarded(msg('sess_ghost')).context.session).toBeNull();
  });
});
