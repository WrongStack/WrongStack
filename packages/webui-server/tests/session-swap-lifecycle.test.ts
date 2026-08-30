import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionScopedPath } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { createSessionHandlers } from '../src/server/session-handlers.js';
import { createStandaloneTodosCheckpointLifecycle } from '../src/server/start-webui.js';

describe('standalone WebUI session swap lifecycle', () => {
  let root: string;
  let sessionsDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-webui-session-swap-'));
    sessionsDir = path.join(root, 'canonical-sessions');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finalizes the old writer and re-points sidecars and identity on session.new', async () => {
    const old = writer('2026-07-12/sess_old');
    const next = writer('2026-07-12/sess_new');
    const harness = makeHarness({ root, sessionsDir, current: old, created: next });

    // Retiring the previous session is opt-in via `replaceSessionId`.
    // `payload.sessionId` only says which session the request came FROM — the
    // WebUI stamps it on every message, so treating it as "retire this" made
    // opening a second tab abort and close the first one's session.
    await harness.routes.newSession(harness.ws, {
      type: 'session.new',
      payload: { replaceSessionId: old.id },
    });

    expect(old.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_end' }));
    expect(old.close).toHaveBeenCalledOnce();
    expect(harness.current()).toBe(next);
    expect(harness.context.session).toBe(next);
    expect(harness.context.state.replaceMessages).toHaveBeenLastCalledWith([]);
    expect(harness.context.state.replaceTodos).toHaveBeenLastCalledWith([]);
    expect(harness.context.lastRequestTokens).toBeUndefined();
    expect(harness.context.lastRealInputTokens).toBeUndefined();
    expect(harness.context.state.deleteMeta).toHaveBeenCalledWith('lastRequestTokensAt');
    expect(harness.context.state.deleteMeta).toHaveBeenCalledWith('realAnchorMsgCount');
    expect(harness.claimSession).toHaveBeenCalledWith(next.id);
    expect(harness.onSessionSwapped).toHaveBeenCalledWith(next.id);
    expect(harness.meta.get('plan.path')).toBe(
      sessionScopedPath(sessionsDir, next.id, '.plan.json'),
    );
    expect(harness.meta.get('task.path')).toBe(
      sessionScopedPath(sessionsDir, next.id, '.tasks.json'),
    );
  });

  it('flushes the old todo checkpoint before persisting the new session snapshot', async () => {
    const old = writer('2026-07-12/sess_old');
    const next = writer('2026-07-12/sess_new');
    const oldCheckpointPath = sessionScopedPath(sessionsDir, old.id, '.todos.json');
    const harness = makeHarness({ root, sessionsDir, current: old, created: next });
    const checkpoint = createStandaloneTodosCheckpointLifecycle({
      state: harness.context.state as never,
      sessionsDir,
      sessionId: old.id,
    });
    harness.setOnBeforeSessionTodosReplaced(checkpoint.rebind);

    harness.context.state.replaceTodos([
      { id: 'old', content: 'flush to old session', status: 'pending' },
    ]);
    await harness.routes.newSession(harness.ws, {
      type: 'session.new',
      payload: { sessionId: old.id },
    });
    await checkpoint.detach();

    const oldCheckpoint = JSON.parse(await fs.readFile(oldCheckpointPath, 'utf8')) as {
      sessionId: string;
      todos: Array<{ id: string }>;
    };
    const nextCheckpoint = JSON.parse(
      await fs.readFile(sessionScopedPath(sessionsDir, next.id, '.todos.json'), 'utf8'),
    ) as { sessionId: string; todos: Array<{ id: string }> };
    expect(oldCheckpoint).toMatchObject({ sessionId: old.id, todos: [{ id: 'old' }] });
    expect(nextCheckpoint).toMatchObject({ sessionId: next.id, todos: [] });
  });

  it('reattaches a detached checkpoint when rebound to the same session', async () => {
    const current = writer('2026-07-12/sess_same');
    const harness = makeHarness({ root, sessionsDir, current });
    const checkpoint = createStandaloneTodosCheckpointLifecycle({
      state: harness.context.state as never,
      sessionsDir,
      sessionId: current.id,
    });

    await checkpoint.detach();
    await checkpoint.rebind(current.id, sessionsDir);
    harness.context.state.replaceTodos([
      { id: 'reattached', content: 'persist after reattach', status: 'pending' },
    ]);
    await checkpoint.detach();

    const saved = JSON.parse(
      await fs.readFile(sessionScopedPath(sessionsDir, current.id, '.todos.json'), 'utf8'),
    ) as { sessionId: string; todos: Array<{ id: string }> };
    expect(saved).toMatchObject({ sessionId: current.id, todos: [{ id: 'reattached' }] });
  });

  it('can retry a rebind after the next checkpoint subscription fails', async () => {
    const handlers = new Set<(change: { kind: string; todos: unknown[] }) => void>();
    let subscriptionCount = 0;
    const state = {
      onChange(handler: (change: { kind: string; todos: unknown[] }) => void) {
        subscriptionCount += 1;
        if (subscriptionCount === 2) throw new Error('subscription failed');
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      replaceTodos(todos: unknown[]) {
        for (const handler of handlers) handler({ kind: 'todos_replaced', todos });
      },
    };
    const oldSessionId = '2026-07-12/sess_old';
    const nextSessionId = '2026-07-12/sess_next';
    const checkpoint = createStandaloneTodosCheckpointLifecycle({
      state: state as never,
      sessionsDir,
      sessionId: oldSessionId,
    });

    await expect(checkpoint.rebind(nextSessionId, sessionsDir)).rejects.toThrow(
      'subscription failed',
    );
    await checkpoint.rebind(nextSessionId, sessionsDir);
    state.replaceTodos([{ id: 'retry', content: 'persist after retry', status: 'pending' }]);
    await checkpoint.detach();

    const saved = JSON.parse(
      await fs.readFile(sessionScopedPath(sessionsDir, nextSessionId, '.todos.json'), 'utf8'),
    ) as { sessionId: string; todos: Array<{ id: string }> };
    expect(subscriptionCount).toBe(3);
    expect(saved).toMatchObject({ sessionId: nextSessionId, todos: [{ id: 'retry' }] });
  });

  it('aborts the in-flight run before finalizing the old writer on session.new', async () => {
    // Regression: session.new used to swap the session while a slow provider
    // stream from the previous request was still in flight, so the old run
    // kept streaming/tool-calling in the background of the new session.
    const old = writer('2026-07-12/sess_old');
    const next = writer('2026-07-12/sess_new');
    const abortActiveRun = vi.fn();
    const harness = makeHarness({ root, sessionsDir, current: old, created: next, abortActiveRun });

    await harness.routes.newSession(harness.ws, {
      type: 'session.new',
      payload: { replaceSessionId: old.id },
    });

    expect(abortActiveRun).toHaveBeenCalledOnce();
    // The abort must fire before the old writer is finalized so the run
    // cannot append more events to the old session after session_end.
    const abortOrder = abortActiveRun.mock.invocationCallOrder[0] ?? 0;
    const closeOrder = old.close.mock.invocationCallOrder[0] ?? 0;
    expect(abortOrder).toBeLessThan(closeOrder);
  });

  it('aborts the in-flight run on session.new even when canSwapSessions is false', async () => {
    const old = writer('2026-07-12/sess_static');
    const abortActiveRun = vi.fn();
    const harness = makeHarness({
      root,
      sessionsDir,
      current: old,
      canSwapSessions: () => false,
      abortActiveRun,
    });

    await harness.routes.newSession(harness.ws, {
      type: 'session.new',
      payload: { sessionId: old.id },
    });

    expect(abortActiveRun).toHaveBeenCalledWith(old.id);
    expect(harness.context.state.replaceMessages).toHaveBeenCalledWith([]);
  });

  it('discards a fresh writer when its ownership claim fails', async () => {
    const old = writer('2026-07-12/sess_old');
    const next = writer('2026-07-12/sess_new');
    const claimSession = vi.fn(async () => {
      throw new Error('Session registry ownership update failed: lock remained busy');
    });
    const harness = makeHarness({
      root,
      sessionsDir,
      current: old,
      created: next,
      claimSession,
    });

    await harness.routes.newSession(harness.ws, {
      type: 'session.new',
      payload: { sessionId: old.id },
    });

    expect(harness.current()).toBe(old);
    expect(old.close).not.toHaveBeenCalled();
    expect(next.close).toHaveBeenCalledOnce();
    expect(harness.store.delete).toHaveBeenCalledWith(next.id);
    expect(harness.ws.sent.at(-1)).toMatchObject({
      type: 'key.operation_result',
      payload: { success: false, message: expect.stringContaining('ownership update failed') },
    });
  });

  it('hydrates a resumed writer only after finalizing the previous writer', async () => {
    const old = writer('2026-07-12/sess_old');
    const resumed = writer('2026-07-11/sess_resumed');
    const messages = [{ role: 'user', content: 'restored' }];
    const usage = { input: 12, output: 7, cacheRead: 0, cacheWrite: 0 };
    const harness = makeHarness({
      root,
      sessionsDir,
      current: old,
      resumed,
      resumedMessages: messages,
      resumedUsage: usage,
    });

    await harness.routes.resumeSession(harness.ws, {
      type: 'session.resume',
      payload: { id: resumed.id },
    });

    expect(old.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_end' }));
    expect(old.close).toHaveBeenCalledOnce();
    expect(harness.current()).toBe(resumed);
    expect(harness.context.state.replaceMessages).toHaveBeenLastCalledWith(messages);
    expect(harness.context.state.replaceTodos).toHaveBeenLastCalledWith([]);
    expect(harness.tokenCounter.account).toHaveBeenCalledWith(usage, 'test-model', 'test-provider');
    expect(harness.claimSession).toHaveBeenCalledWith(resumed.id);
    expect(harness.onSessionSwapped).toHaveBeenCalledWith(resumed.id);
    expect(harness.ws.sent.at(-1)).toMatchObject({
      type: 'key.operation_result',
      payload: { success: true },
    });
  });

  it('refuses to resume a session owned by another live surface', async () => {
    const old = writer('2026-07-12/sess_old');
    const resumed = writer('2026-07-11/sess_resumed');
    const claimSession = vi.fn(async () => {
      throw new Error('Session is already open in another running wstack (pid 4242).');
    });
    const harness = makeHarness({ root, sessionsDir, current: old, resumed, claimSession });

    await harness.routes.resumeSession(harness.ws, {
      type: 'session.resume',
      payload: { id: resumed.id },
    });

    expect(harness.store.resume).not.toHaveBeenCalled();
    expect(harness.current()).toBe(old);
    expect(harness.ws.sent.at(-1)).toMatchObject({
      type: 'key.operation_result',
      payload: {
        success: false,
        message: expect.stringContaining('another running wstack'),
      },
    });
  });

  it('serializes concurrent resume requests before either claim can overlap', async () => {
    const old = writer('2026-07-12/sess_old');
    const first = writer('2026-07-11/sess_first');
    const second = writer('2026-07-11/sess_second');
    let releaseFirst!: () => void;
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const claimSession = vi.fn(async (sessionId: string) => {
      if (sessionId === first.id) await firstClaimGate;
      return async () => undefined;
    });
    const harness = makeHarness({ root, sessionsDir, current: old, resumed: first, claimSession });
    harness.store.resume.mockImplementation(async (sessionId: string) => ({
      writer: sessionId === first.id ? first : second,
      data: {
        messages: [],
        events: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    }));

    const firstResume = harness.routes.resumeSession(harness.ws, {
      type: 'session.resume',
      payload: { id: first.id },
    });
    const secondResume = harness.routes.resumeSession(harness.ws, {
      type: 'session.resume',
      payload: { id: second.id },
    });

    await vi.waitFor(() => expect(claimSession).toHaveBeenCalledTimes(1));
    expect(claimSession).toHaveBeenLastCalledWith(first.id);
    releaseFirst();
    await Promise.all([firstResume, secondResume]);

    expect(claimSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([first.id, second.id]);
    expect(harness.current()).toBe(second);
  });

  it('reads checkpoints from canonical date-sharded projectSessions', async () => {
    const current = writer('2026-07-12/sess_checkpoint');
    const harness = makeHarness({ root, sessionsDir, current });
    const sessionFile = sessionScopedPath(sessionsDir, current.id, '.jsonl');
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: 'checkpoint',
        ts: '2026-07-12T00:00:00.000Z',
        promptIndex: 3,
        promptPreview: 'canonical checkpoint',
      })}\n`,
      'utf8',
    );

    await harness.routes.listCheckpoints(harness.ws, {
      type: 'session.checkpoints',
      payload: { sessionId: current.id },
    });

    expect(harness.ws.sent.at(-1)).toMatchObject({
      type: 'session.checkpoints',
      payload: {
        sessionId: current.id,
        checkpoints: [
          expect.objectContaining({
            promptIndex: 3,
            promptPreview: 'canonical checkpoint',
          }),
        ],
      },
    });
  });
});

function writer(id: string) {
  return {
    id,
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    truncateToCheckpoint: vi.fn(async () => undefined),
  };
}

function makeHarness(input: {
  root: string;
  sessionsDir: string;
  current: ReturnType<typeof writer>;
  created?: ReturnType<typeof writer> | undefined;
  resumed?: ReturnType<typeof writer> | undefined;
  resumedMessages?: unknown[] | undefined;
  resumedUsage?: Record<string, number> | undefined;
  canSwapSessions?: (() => boolean) | undefined;
  abortActiveRun?: ((sessionId?: string) => void) | undefined;
  claimSession?: ((sessionId: string) => Promise<() => Promise<void>>) | undefined;
  onBeforeSessionTodosReplaced?:
    | ((sessionId: string, sessionsDir: string) => void | Promise<void>)
    | undefined;
}) {
  let current = input.current;
  const meta = new Map<string, unknown>();
  const stateChangeHandlers = new Set<(change: { kind: string; todos?: unknown[] }) => void>();
  const context = {
    session: current,
    messages: [],
    provider: { id: 'test-provider' },
    lastRequestTokens: 999,
    lastRealInputTokens: 888,
    state: {
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn((todos: unknown[]) => {
        for (const handler of stateChangeHandlers) handler({ kind: 'todos_replaced', todos });
      }),
      onChange: vi.fn((handler: (change: { kind: string; todos?: unknown[] }) => void) => {
        stateChangeHandlers.add(handler);
        return () => stateChangeHandlers.delete(handler);
      }),
      setMeta: vi.fn((key: string, value: unknown) => meta.set(key, value)),
      deleteMeta: vi.fn((key: string) => meta.delete(key)),
    },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
  };
  const tokenCounter = {
    total: vi.fn(() => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })),
    reset: vi.fn(),
    account: vi.fn(),
  };
  const onSessionSwapped = vi.fn(async () => undefined);
  const claimSession = input.claimSession ?? vi.fn(async () => async () => undefined);
  let onBeforeSessionTodosReplaced = input.onBeforeSessionTodosReplaced;
  const ws = {
    readyState: 1,
    sent: [] as Array<{ type: string; payload: unknown }>,
    send(data: string) {
      this.sent.push(JSON.parse(data) as { type: string; payload: unknown });
    },
  };
  const store = {
    create: vi.fn(async (_options: unknown) => input.created),
    delete: vi.fn(async (_sessionId: string) => undefined),
    resume: vi.fn(
      async (
        _sessionId: string,
        onLoadProgress?: (progress: { loadedBytes: number; totalBytes: number }) => void,
      ) => {
        onLoadProgress?.({ loadedBytes: 10, totalBytes: 20 });
        return {
          writer: input.resumed,
          data: {
            messages: input.resumedMessages ?? [],
            events: [],
            usage: input.resumedUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        };
      },
    ),
  };
  const routes = createSessionHandlers({
    config: { provider: 'test-provider', model: 'test-model' },
    clients: new Map(),
    context: context as never,
    toolRegistry: {} as never,
    compactor: {} as never,
    customModeStore: {} as never,
    tokenCounter: tokenCounter as never,
    getProjectRoot: () => input.root,
    getSession: () => current as never,
    getSessionStore: () => store as never,
    sessionsDir: input.sessionsDir,
    setSession: (next) => {
      current = next as typeof current;
    },
    setSessionStartedAt: vi.fn(),
    claimSession,
    onBeforeSessionTodosReplaced: (sessionId, targetDir) =>
      onBeforeSessionTodosReplaced?.(sessionId, targetDir),
    onSessionSwapped,
    ...(input.canSwapSessions ? { canSwapSessions: input.canSwapSessions } : {}),
    abortActiveRun: input.abortActiveRun,
    sessionStartPayload: async () => ({
      sessionId: current.id,
      model: 'test-model',
      provider: 'test-provider',
      maxContext: 100,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      projectName: 'test',
      projectRoot: input.root,
      cwd: input.root,
      mode: 'default',
      contextMode: 'balanced',
    }),
  });

  return {
    routes,
    ws: ws as unknown as WebSocket & typeof ws,
    context,
    tokenCounter,
    store,
    claimSession,
    onSessionSwapped,
    setOnBeforeSessionTodosReplaced: (
      callback: (sessionId: string, targetDir: string) => void | Promise<void>,
    ) => {
      onBeforeSessionTodosReplaced = callback;
    },
    meta,
    current: () => current,
  };
}
