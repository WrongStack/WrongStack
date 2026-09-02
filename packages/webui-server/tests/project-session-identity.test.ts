import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

const storageMocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  constructor: vi.fn(),
}));

vi.mock('@wrongstack/core/storage', async (original) => {
  const actual = await original<typeof import('@wrongstack/core/storage')>();
  return {
    ...actual,
    DefaultSessionStore: class {
      constructor(options: unknown) {
        storageMocks.constructor(options);
      }
      create = storageMocks.create;
      delete = storageMocks.delete;
    },
  };
});

import { createProjectHandlers } from '../src/server/project-handlers.js';
import type { SessionIdentityTarget } from '../src/server/standalone-session-identity.js';

function writer(id: string) {
  return {
    id,
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('WebUI project switch session identity', () => {
  let root: string;
  let targetRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-project-identity-'));
    targetRoot = path.join(root, 'target-project');
    await fs.mkdir(targetRoot, { recursive: true });
    storageMocks.create.mockReset();
    storageMocks.delete.mockReset().mockResolvedValue(undefined);
    storageMocks.constructor.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeHarness(
    onSessionSwapped = vi.fn<
      (sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>
    >(async () => undefined),
    onBeforeSessionTodosReplaced = vi.fn<
      (sessionId: string, sessionsDir: string) => void | Promise<void>
    >(async () => undefined),
  ) {
    const old = writer('2026-07-27/sess_old');
    const next = writer('2026-07-27/sess_new');
    storageMocks.create.mockResolvedValue(next);
    let current = old;
    let projectRoot = path.join(root, 'old-project');
    const setProjectRoot = vi.fn((nextRoot: string) => {
      projectRoot = nextRoot;
    });
    const setWorkingDir = vi.fn();
    const setSession = vi.fn((session: typeof old) => {
      current = session;
    });
    const setSessionStore = vi.fn();
    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    const ws = {
      readyState: 1,
      sent: [] as Array<{ type: string; payload: unknown }>,
      send(data: string) {
        this.sent.push(JSON.parse(data) as { type: string; payload: unknown });
      },
    };
    const context = {
      projectRoot,
      cwd: projectRoot,
      workingDir: projectRoot,
      session: old,
      readFiles: new Set<string>(),
      fileMtimes: new Map<string, number>(),
      state: {
        replaceMessages: vi.fn(),
        replaceTodos: vi.fn(),
      },
    };
    const routes = createProjectHandlers({
      globalConfigPath: path.join(root, 'global', 'config.json'),
      wpaths: { globalRoot: path.join(root, 'global') },
      context: context as never,
      tokenCounter: {
        total: vi.fn(() => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })),
        reset: vi.fn(),
      } as never,
      config: { provider: 'test-provider', model: 'test-model' },
      getProjectRoot: () => projectRoot,
      getSession: () => current as never,
      setProjectRoot,
      setWorkingDir,
      setSession: setSession as never,
      setSessionStore,
      abortRunLock: vi.fn(),
      onBeforeSessionTodosReplaced,
      onSessionSwapped,
      allowProjectMutations: true,
      sessionStartPayload: async () => ({ sessionId: current.id }),
      broadcastMessage: (message) => broadcasts.push(message),
    });
    return {
      routes,
      ws: ws as unknown as WebSocket & typeof ws,
      old,
      next,
      current: () => current,
      projectRoot: () => projectRoot,
      context,
      setProjectRoot,
      setWorkingDir,
      setSession,
      setSessionStore,
      broadcasts,
      replaceTodos: context.state.replaceTodos,
      onBeforeSessionTodosReplaced,
    };
  }

  it('publishes the new project identity before swapping the runtime writer', async () => {
    const onSessionSwapped = vi.fn<
      (sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>
    >(async () => undefined);
    const h = makeHarness(onSessionSwapped);

    await h.routes.selectProject(h.ws, {
      type: 'projects.select',
      payload: { root: targetRoot, name: 'Target Project' },
    });

    expect(onSessionSwapped).toHaveBeenCalledWith(
      h.next.id,
      expect.objectContaining({
        projectRoot: targetRoot,
        projectName: 'Target Project',
        workingDir: targetRoot,
      }),
    );
    expect(onSessionSwapped.mock.invocationCallOrder[0]).toBeLessThan(
      h.setSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(h.current()).toBe(h.next);
    expect(h.old.close).toHaveBeenCalledOnce();
  });

  it('rebinds todo persistence before clearing todos for the selected project', async () => {
    const onBeforeSessionTodosReplaced = vi.fn<
      (sessionId: string, sessionsDir: string) => void | Promise<void>
    >(async () => undefined);
    const h = makeHarness(
      vi.fn<(sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>>(
        async () => undefined,
      ),
      onBeforeSessionTodosReplaced,
    );

    await h.routes.selectProject(h.ws, {
      type: 'projects.select',
      payload: { root: targetRoot, name: 'Target Project' },
    });

    expect(onBeforeSessionTodosReplaced).toHaveBeenCalledWith(
      h.next.id,
      expect.stringContaining('sessions'),
    );
    expect(h.replaceTodos).toHaveBeenCalledWith([]);
    const rebindOrder = onBeforeSessionTodosReplaced.mock.invocationCallOrder[0];
    const replaceOrder = h.replaceTodos.mock.invocationCallOrder[0];
    expect(rebindOrder).toBeDefined();
    expect(replaceOrder).toBeDefined();
    expect(rebindOrder as number).toBeLessThan(replaceOrder as number);
  });

  it('rolls identity and todo persistence back when project checkpoint rebinding fails', async () => {
    const onSessionSwapped = vi.fn<
      (sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>
    >(async () => undefined);
    let rebindCalls = 0;
    const onBeforeSessionTodosReplaced = vi.fn<
      (sessionId: string, sessionsDir: string) => void | Promise<void>
    >(async () => {
      rebindCalls++;
      if (rebindCalls === 1) throw new Error('checkpoint unavailable');
    });
    const h = makeHarness(onSessionSwapped, onBeforeSessionTodosReplaced);

    await h.routes.selectProject(h.ws, {
      type: 'projects.select',
      payload: { root: targetRoot, name: 'Target Project' },
    });

    expect(onSessionSwapped.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      h.next.id,
      h.old.id,
    ]);
    expect(onBeforeSessionTodosReplaced.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      h.next.id,
      h.old.id,
    ]);
    expect(h.current()).toBe(h.old);
    expect(h.projectRoot()).toBe(path.join(root, 'old-project'));
    expect(h.context.session).toBe(h.old);
    expect(h.context.projectRoot).toBe(path.join(root, 'old-project'));
    expect(h.setProjectRoot).not.toHaveBeenCalled();
    expect(h.setWorkingDir).not.toHaveBeenCalled();
    expect(h.setSession).not.toHaveBeenCalled();
    expect(h.setSessionStore).not.toHaveBeenCalled();
    expect(h.replaceTodos).not.toHaveBeenCalled();
    expect(h.old.append).not.toHaveBeenCalled();
    expect(h.old.close).not.toHaveBeenCalled();
    expect(h.broadcasts).toEqual([]);
    expect(h.next.close).toHaveBeenCalledOnce();
    expect(storageMocks.delete).toHaveBeenCalledWith(h.next.id);
    expect(h.ws.sent.at(-1)).toMatchObject({
      type: 'projects.selected',
      payload: { message: expect.stringContaining('checkpoint unavailable') },
    });
  });

  it('keeps the old runtime and deletes the fresh writer when identity update fails', async () => {
    const onSessionSwapped = vi.fn<
      (sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>
    >(async () => {
      throw new Error('registry unavailable');
    });
    const h = makeHarness(onSessionSwapped);

    await h.routes.selectProject(h.ws, {
      type: 'projects.select',
      payload: { root: targetRoot, name: 'Target Project' },
    });

    expect(h.current()).toBe(h.old);
    expect(h.old.close).not.toHaveBeenCalled();
    expect(h.next.close).toHaveBeenCalledOnce();
    expect(storageMocks.delete).toHaveBeenCalledWith(h.next.id);
    expect(h.ws.sent.at(-1)).toMatchObject({
      type: 'projects.selected',
      payload: { message: expect.stringContaining('registry unavailable') },
    });
  });
});
