import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registryList: vi.fn(),
  loadTodosCheckpoint: vi.fn(),
  attachTodosCheckpoint: vi.fn(),
  replaySessionMessages: vi.fn(),
}));

vi.mock('@wrongstack/core/storage', async (original) => {
  const actual = await original<typeof import('@wrongstack/core/storage')>();
  return {
    ...actual,
    SessionRegistry: class {
      list = mocks.registryList;
    },
    loadTodosCheckpoint: mocks.loadTodosCheckpoint,
    attachTodosCheckpoint: mocks.attachTodosCheckpoint,
  };
});

vi.mock('@wrongstack/tui', () => ({
  replaySessionMessages: mocks.replaySessionMessages,
}));

import { resumeSession } from '../src/boot/tui-session-resume.js';

function writer(id: string) {
  return {
    id,
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function harness() {
  const oldWriter = writer('2026-07-27/sess_old');
  const resumedWriter = writer('2026-07-26/sess_resumed');
  const oldMessages = [{ role: 'user', content: 'old' }];
  const resumedMessages = [{ role: 'user', content: 'resumed' }];
  const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 };
  const context = {
    session: oldWriter,
    messages: oldMessages,
    model: 'old-model',
    provider: { id: 'old-provider' },
    traceId: 'trace-test',
    state: {
      replaceMessages: vi.fn((messages: typeof oldMessages) => {
        context.messages = messages;
      }),
      replaceTodos: vi.fn(),
      setMeta: vi.fn(),
    },
    flushConversationJournal: vi.fn(async () => undefined),
  };
  const resumeStore = vi.fn(async () => ({
    writer: resumedWriter,
    data: {
      metadata: {
        id: resumedWriter.id,
        provider: 'resumed-provider',
        model: 'resumed-model',
      },
      messages: resumedMessages,
      events: [],
      usage,
    },
  }));
  const activateSessionIdentity = vi.fn(async (_sessionId: string) => undefined);
  const tokenCounter = {
    total: vi.fn(() => ({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 })),
    reset: vi.fn(),
    account: vi.fn(),
  };
  const state = {
    projectRoot: '/project',
    wpaths: {
      globalConfig: '/global/config.json',
      projectSessions: '/global/projects/project/sessions',
    },
    activeSessionStore: {
      resolveId: vi.fn(async (id: string) => id),
      resume: resumeStore,
    },
    activateSessionIdentity,
    detachActiveTodosCheckpoint: vi.fn(async () => undefined),
    pendingProjectSwitch: null,
    autonomousCoordinator: null,
    coordinatorRun: null,
    coordinatorEvents: new Set(),
  };

  return {
    ctx: {
      state,
      agent: { ctx: context },
      tokenCounter,
      switchProviderAndModel: vi.fn(async () => undefined),
    },
    state,
    context,
    oldWriter,
    resumedWriter,
    oldMessages,
    resumedMessages,
    usage,
    resumeStore,
    activateSessionIdentity,
    tokenCounter,
  };
}

beforeEach(() => {
  mocks.registryList.mockReset().mockResolvedValue([]);
  mocks.loadTodosCheckpoint.mockReset().mockResolvedValue([]);
  mocks.attachTodosCheckpoint.mockReset().mockReturnValue(vi.fn());
  mocks.replaySessionMessages.mockReset().mockReturnValue([{ id: 1, kind: 'user' }]);
});

describe('TUI session resume ownership', () => {
  it('does not open the writer when the ownership claim fails', async () => {
    const h = harness();
    h.activateSessionIdentity.mockRejectedValue(new Error('already open in pid 4242'));

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.toBeNull();

    expect(h.resumeStore).not.toHaveBeenCalled();
    expect(h.context.session).toBe(h.oldWriter);
  });

  it('rolls ownership back when opening the selected writer fails', async () => {
    const h = harness();
    h.resumeStore.mockRejectedValue(new Error('invalid session journal'));

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.toBeNull();

    expect(h.activateSessionIdentity.mock.calls.map(([id]) => id)).toEqual([
      h.resumedWriter.id,
      h.oldWriter.id,
    ]);
    expect(h.context.session).toBe(h.oldWriter);
  });

  it('restores the old writer and closes the opened writer when hydration fails', async () => {
    const h = harness();
    h.context.state.replaceMessages
      .mockImplementationOnce(() => {
        throw new Error('invalid recovered messages');
      })
      .mockImplementationOnce((messages: typeof h.oldMessages) => {
        h.context.messages = messages;
      });

    await expect(resumeSession(h.ctx as never, h.resumedWriter.id)).resolves.toBeNull();

    expect(h.context.session).toBe(h.oldWriter);
    expect(h.context.messages).toEqual(h.oldMessages);
    expect(h.resumedWriter.close).toHaveBeenCalledOnce();
    expect(h.activateSessionIdentity).toHaveBeenLastCalledWith(h.oldWriter.id);
  });

  it('keeps a committed resume usable when journal flush or model restoration fails', async () => {
    const h = harness();
    h.context.flushConversationJournal.mockRejectedValue(new Error('journal unavailable'));
    h.ctx.switchProviderAndModel.mockRejectedValue(new Error('provider unavailable'));

    const result = await resumeSession(h.ctx as never, h.resumedWriter.id);

    expect(result).toEqual({
      entries: [{ id: 1, kind: 'user' }],
      nextId: 2,
      sessionId: h.resumedWriter.id,
    });
    expect(h.context.session).toBe(h.resumedWriter);
    expect(h.tokenCounter.reset).toHaveBeenCalledOnce();
    expect(h.tokenCounter.account).toHaveBeenCalledWith(
      h.usage,
      'resumed-model',
      'resumed-provider',
    );
    expect(h.activateSessionIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.loadTodosCheckpoint).toHaveBeenCalledWith(
      expect.stringContaining('sess_resumed.todos.json'),
      undefined,
      'trace-test',
      h.resumedWriter.id,
    );
  });
});
