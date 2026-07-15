import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message, SessionStore, SessionWriter, WstackPaths } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSession } from '../src/wiring/session.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wiring-session-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
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
    append: vi.fn(),
    finalize: vi.fn(),
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
} as never;

const onRecovery = vi.fn().mockResolvedValue('skip');

describe('setupSession', () => {
  it('creates a fresh session when no recovery and no resume', async () => {
    const sessionStore = makeSessionStore();
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
      flags: { 'no-recovery': true },
      onRecovery,
    });
    expect(sessionStore.create).toHaveBeenCalled();
    expect(result.session.id).toBe('sess-new');
    expect(result.sessionRef.current?.id).toBe('sess-new');
    expect(result.restoredMessages).toEqual([]);
    expect(result.context).toBeDefined();
    expect(result.attachments).toBeDefined();
    expect(result.queueStore).toBeDefined();
    expect(result.recoveryLock).toBeDefined();
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
      onRecovery,
    });
    expect(sessionStore.resume).toHaveBeenCalledWith('resumed-1');
    expect(result.session.id).toBe('resumed-1');
    expect(result.restoredMessages).toEqual([restoredMsg]);
    expect(renderer.writeInfo).toHaveBeenCalledWith(
      expect.stringContaining('Resumed session resumed-1'),
    );
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
        onRecovery,
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
      onRecovery,
    });
    expect(renderer.writeInfo).toHaveBeenCalledWith(expect.stringContaining('Restored 2 todos'));
    expect(result.context.state.todos.length).toBe(2);
  });

  it('survives missing todos checkpoint silently', async () => {
    const renderer = makeRenderer();
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
      onRecovery,
    });
    // No "Restored X todos" message — but the function should have completed.
    expect(renderer.writeError).not.toHaveBeenCalled();
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
      onRecovery,
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
      onRecovery,
    });
    expect(renderer.writeInfo).toHaveBeenCalledWith(
      expect.stringMatching(/Plan: 3 items \(2 open, 1 done\)/),
    );
  });
});
