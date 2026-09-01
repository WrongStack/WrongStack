import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message, SessionStore, SessionWriter } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSession } from '../src/wiring/session.js';

/**
 * `setupSession` reaches @wrongstack/tools/session-kanban -> @wrongstack/kanban,
 * which spawns a detached daemon rooted at this temp dir. The daemon outlived
 * the test and kept running against a deleted directory (the `maxRetries` on
 * the rm below is the scar tissue from fighting it).
 */
process.env['WRONGSTACK_KANBAN_SERVER'] = '0';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiring-session-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeWpaths(): WstackPaths {
  return {
    configDir: tmp,
    globalConfig: path.join(tmp, 'config.json'),
    projectDir: tmp,
    projectSessions: tmp,
    globalRoot: tmp,
    logFile: path.join(tmp, 'log.txt'),
    historyFile: path.join(tmp, 'history'),
    modelsCache: path.join(tmp, 'models.json'),
    inProjectAgentsFile: path.join(tmp, 'AGENTS.md'),
    projectMemory: path.join(tmp, 'project-memory.md'),
    globalMemory: path.join(tmp, 'global-memory.md'),
  } as WstackPaths;
}

function makeSessionWriter(id = 'sess-new'): SessionWriter {
  return {
    id,
    append: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
  } as never as SessionWriter;
}

function makeSessionStore(overrides: Partial<SessionStore> = {}): SessionStore {
  return {
    create: vi.fn().mockResolvedValue(makeSessionWriter('sess-new')),
    resume: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    prune: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as never as SessionStore;
}

function makeRenderer() {
  return { writeInfo: vi.fn(), writeError: vi.fn() };
}

const fakeProvider = {
  id: 'p',
  capabilities: { maxContext: 100000 },
} as never;

const fakeTokenCounter = {
  count: vi.fn().mockResolvedValue({ total: 0 }),
  // setupSession credits a resumed session's prior usage through
  // tokenCounter.account(); without this stub the resume path throws
  // TypeError → RESUME_FAILED before any assertion runs.
  account: vi.fn(),
} as never;

describe('setupSession', () => {
  it('always creates a fresh session by default, even with a legacy active.json', async () => {
    const sessionStore = makeSessionStore();
    await fs.writeFile(
      path.join(tmp, 'active.json'),
      JSON.stringify({ v: 1, sessionId: 'old-session', pid: 4242 }),
    );
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore,
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer: makeRenderer(),
      flags: {},
    });
    expect(sessionStore.create).toHaveBeenCalled();
    expect(sessionStore.resume).not.toHaveBeenCalled();
    expect(sessionStore.delete).not.toHaveBeenCalled();
    expect(result.session.id).toBe('sess-new');
    expect(result.sessionRef.current?.id).toBe('sess-new');
    expect(result.restoredMessages).toEqual([]);
    expect(result.context).toBeDefined();
    expect(result.attachments).toBeDefined();
    expect(result.queueStore).toBeDefined();
    const { listBoards } = await import('@wrongstack/kanban');
    const boards = await listBoards(tmp);
    expect(boards).toHaveLength(1);
    expect(boards[0]?.tags).toContain('session:sess-new');
    await result.detachTodosCheckpoint();
  });

  it('resumes when --resume flag provided', async () => {
    const restoredMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    } as Message;
    const sessionStore = makeSessionStore({
      resume: vi.fn().mockResolvedValue({
        writer: makeSessionWriter('resumed-1'),
        data: {
          messages: [restoredMsg],
          metadata: { id: 'resumed-1' },
          usage: { input: 100, output: 50 },
        },
      }),
    });
    const renderer = makeRenderer();
    const claimSession = vi.fn(async () => async () => undefined);
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore,
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer,
      flags: { resume: 'resumed-1' },
      claimSession,
    });
    expect(claimSession).toHaveBeenCalledWith('resumed-1');
    expect(sessionStore.resume).toHaveBeenCalledWith('resumed-1');
    expect(result.session.id).toBe('resumed-1');
    expect(result.restoredMessages).toEqual([restoredMsg]);
    expect(renderer.writeInfo).toHaveBeenCalledWith(
      expect.stringContaining('Resumed session resumed-1'),
    );
  });

  it('does not open an explicitly resumed session when another process owns it', async () => {
    const sessionStore = makeSessionStore();
    const renderer = makeRenderer();
    await expect(
      setupSession({
        config: { model: 'm', provider: 'p' },
        wpaths: makeWpaths(),
        projectRoot: tmp,
        cwd: tmp,
        sessionStore,
        systemPrompt: [],
        provider: fakeProvider,
        tokenCounter: fakeTokenCounter,
        renderer,
        flags: { resume: 'owned-session' },
        claimSession: async () => {
          throw new Error('Session owned-session is already open in another running wstack.');
        },
      }),
    ).rejects.toMatchObject({ message: 'RESUME_FAILED', exitCode: 2 });
    expect(sessionStore.resume).not.toHaveBeenCalled();
    expect(renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('already open in another running wstack'),
    );
  });

  it('surfaces the resumed session model/provider so boot can adopt them', async () => {
    const sessionStore = makeSessionStore({
      resume: vi.fn().mockResolvedValue({
        writer: makeSessionWriter('resumed-mp'),
        data: {
          messages: [],
          metadata: { id: 'resumed-mp', model: 'session-model', provider: 'session-provider' },
          usage: { input: 0, output: 0 },
        },
      }),
    });
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore,
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer: makeRenderer(),
      flags: { resume: 'resumed-mp' },
    });
    expect(result.resumedModel).toBe('session-model');
    expect(result.resumedProvider).toBe('session-provider');
  });

  it('leaves resumed model/provider undefined for a fresh (non-resume) session', async () => {
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore: makeSessionStore(),
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer: makeRenderer(),
      flags: {},
    });
    expect(result.resumedModel).toBeUndefined();
    expect(result.resumedProvider).toBeUndefined();
  });

  it('throws RESUME_FAILED when resume call rejects', async () => {
    const sessionStore = makeSessionStore({
      resume: vi.fn().mockRejectedValue(new Error('not found')),
    });
    const renderer = makeRenderer();
    await expect(
      setupSession({
        config: { model: 'm', provider: 'p' },
        wpaths: makeWpaths(),
        projectRoot: tmp,
        cwd: tmp,
        sessionStore,
        systemPrompt: [],
        provider: fakeProvider,
        tokenCounter: fakeTokenCounter,
        renderer,
        flags: { resume: 'bad-id' },
      }),
    ).rejects.toMatchObject({ message: 'RESUME_FAILED', exitCode: 2 });
    expect(renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('loads todos checkpoint when resuming and file exists', async () => {
    const renderer = makeRenderer();
    const writer = makeSessionWriter('resumed-2');
    const sessionStore = makeSessionStore({
      resume: vi.fn().mockResolvedValue({
        writer,
        data: {
          messages: [],
          metadata: { id: 'resumed-2' },
          usage: { input: 0, output: 0 },
        },
      }),
    });
    // Pre-write the todos checkpoint file at the path setupSession expects.
    const wpaths = makeWpaths();
    const todosPath = path.join(wpaths.projectSessions, 'resumed-2.todos.json');
    await fs.writeFile(
      todosPath,
      JSON.stringify({
        version: 1,
        sessionId: 'resumed-2',
        updatedAt: new Date().toISOString(),
        todos: [
          { id: 't1', content: 'restored task', status: 'pending' },
          { id: 't2', content: 'another', status: 'in_progress' },
        ],
      }),
    );
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths,
      projectRoot: tmp,
      cwd: tmp,
      sessionStore,
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer,
      flags: { resume: 'resumed-2' },
    });
    expect(renderer.writeInfo).toHaveBeenCalledWith(expect.stringContaining('Restored 2 todos'));
    expect(result.context.state.todos.length).toBe(2);
  });

  it('survives missing todos checkpoint silently and emits both telemetry identifiers', async () => {
    const renderer = makeRenderer();
    const events = { emit: vi.fn(), on: vi.fn(() => () => undefined) };
    const sessionStore = makeSessionStore({
      resume: vi.fn().mockResolvedValue({
        writer: makeSessionWriter('resumed-3'),
        data: {
          messages: [],
          metadata: { id: 'resumed-3' },
          usage: { input: 0, output: 0 },
        },
      }),
    });
    await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore,
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer,
      flags: { resume: 'resumed-3' },
      events: events as never,
    });
    // No "Restored X todos" message — but the function should have completed.
    expect(renderer.writeError).not.toHaveBeenCalled();
    // "Silently" is the point of this case: a session that never wrote a todo
    // list is the normal state, not a storage fault. `storage.error` is the
    // alert channel for disk-full/permission faults and is always surfaced at
    // warning level, so the absent checkpoint reports on `storage.read`.
    expect(events.emit).not.toHaveBeenCalledWith('storage.error', expect.anything());
    expect(events.emit).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        sessionId: 'resumed-3',
        traceId: expect.any(String),
        store: 'todos',
        operation: 'load',
        outcome: 'success',
      }),
    );
  });

  it('flushes the old todo checkpoint before rebinding to a new session', async () => {
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore: makeSessionStore(),
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer: makeRenderer(),
      flags: {},
    });

    result.context.state.replaceTodos([
      { id: 'old', content: 'flush to old session', status: 'pending' },
    ]);
    await result.rebindTodosCheckpoint('sess-next');

    const oldCheckpoint = JSON.parse(
      await fs.readFile(path.join(tmp, 'sess-new.todos.json'), 'utf8'),
    ) as { sessionId: string; todos: Array<{ id: string }> };
    expect(oldCheckpoint.sessionId).toBe('sess-new');
    expect(oldCheckpoint.todos).toEqual([expect.objectContaining({ id: 'old' })]);

    result.context.state.replaceTodos([
      { id: 'next', content: 'persist to new session', status: 'pending' },
    ]);
    await result.detachTodosCheckpoint();

    const nextCheckpoint = JSON.parse(
      await fs.readFile(path.join(tmp, 'sess-next.todos.json'), 'utf8'),
    ) as { sessionId: string; todos: Array<{ id: string }> };
    expect(nextCheckpoint.sessionId).toBe('sess-next');
    expect(nextCheckpoint.todos).toEqual([expect.objectContaining({ id: 'next' })]);
  });

  it('does not detach or flush when rebinding the todo checkpoint to the active session', async () => {
    const events = { emit: vi.fn(), on: vi.fn(() => () => undefined) };
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore: makeSessionStore(),
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer: makeRenderer(),
      flags: {},
      events: events as never,
    });

    result.context.state.replaceTodos([
      { id: 'same', content: 'still debounced', status: 'pending' },
    ]);
    await result.rebindTodosCheckpoint('sess-new');

    const todoWrites = events.emit.mock.calls.filter(
      ([event, payload]) =>
        event === 'storage.write' && (payload as { store?: string } | undefined)?.store === 'todos',
    );
    expect(todoWrites).toHaveLength(0);
    await result.detachTodosCheckpoint();
  });

  it('serializes concurrent todo checkpoint rebinds without orphaning a listener', async () => {
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths: makeWpaths(),
      projectRoot: tmp,
      cwd: tmp,
      sessionStore: makeSessionStore(),
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer: makeRenderer(),
      flags: {},
    });

    await Promise.all([
      result.rebindTodosCheckpoint('sess-intermediate'),
      result.rebindTodosCheckpoint('sess-final'),
    ]);
    result.context.state.replaceTodos([
      { id: 'final', content: 'only the final listener persists', status: 'pending' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await result.detachTodosCheckpoint();

    await expect(fs.access(path.join(tmp, 'sess-intermediate.todos.json'))).rejects.toThrow();
    const finalCheckpoint = JSON.parse(
      await fs.readFile(path.join(tmp, 'sess-final.todos.json'), 'utf8'),
    ) as { sessionId: string; todos: Array<{ id: string }> };
    expect(finalCheckpoint.sessionId).toBe('sess-final');
    expect(finalCheckpoint.todos).toEqual([expect.objectContaining({ id: 'final' })]);
  });

  it('surfaces banner when prior fleet state present on resume', async () => {
    const renderer = makeRenderer();
    const sessionStore = makeSessionStore({
      resume: vi.fn().mockResolvedValue({
        writer: makeSessionWriter('resumed-4'),
        data: {
          messages: [],
          metadata: { id: 'resumed-4' },
          usage: { input: 0, output: 0 },
        },
      }),
    });
    const wpaths = makeWpaths();
    const sessDir = path.join(wpaths.projectSessions, 'resumed-4');
    await fs.mkdir(sessDir, { recursive: true });
    await fs.writeFile(
      path.join(sessDir, 'director-state.json'),
      JSON.stringify({
        version: 1,
        directorId: 'd1',
        subagents: [{ id: 's1', status: 'idle' }],
        tasks: [
          { id: 't1', status: 'pending' },
          { id: 't2', status: 'completed' },
        ],
      }),
    );
    const result = await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths,
      projectRoot: tmp,
      cwd: tmp,
      sessionStore,
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer,
      flags: { resume: 'resumed-4' },
    });
    expect(result.priorFleetState).toBeDefined();
    expect(renderer.writeInfo).toHaveBeenCalledWith(expect.stringContaining('Prior fleet state'));
  });

  it('surfaces plan banner when prior plan has items', async () => {
    const renderer = makeRenderer();
    const sessionStore = makeSessionStore({
      resume: vi.fn().mockResolvedValue({
        writer: makeSessionWriter('resumed-5'),
        data: {
          messages: [],
          metadata: { id: 'resumed-5' },
          usage: { input: 0, output: 0 },
        },
      }),
    });
    const wpaths = makeWpaths();
    const planPath = path.join(wpaths.projectSessions, 'resumed-5.plan.json');
    await fs.writeFile(
      planPath,
      JSON.stringify({
        version: 1,
        sessionId: 'resumed-5',
        updatedAt: new Date().toISOString(),
        items: [
          { id: 'p1', title: 'task one', status: 'pending' },
          { id: 'p2', title: 'task two', status: 'done' },
          { id: 'p3', title: 'task three', status: 'in_progress' },
        ],
      }),
    );
    await setupSession({
      config: { model: 'm', provider: 'p' },
      wpaths,
      projectRoot: tmp,
      cwd: tmp,
      sessionStore,
      systemPrompt: [],
      provider: fakeProvider,
      tokenCounter: fakeTokenCounter,
      renderer,
      flags: { resume: 'resumed-5' },
    });
    expect(renderer.writeInfo).toHaveBeenCalledWith(
      expect.stringMatching(/Plan: 3 items \(2 open, 1 done\)/),
    );
  });
});
