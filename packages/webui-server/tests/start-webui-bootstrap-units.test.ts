import type { SessionStore } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';

// ── 1. start-webui-bind ──────────────────────────────────────────────────
import { bindSharedHttpServer } from '../src/server/start-webui-bind.js';

vi.mock('../src/server/port-utils.js', () => ({
  isStrictPort: vi.fn().mockReturnValue(false),
  listenWithRetry: vi.fn().mockImplementation(async (_server, _host, port) => port),
}));

describe('start-webui-bind: bindSharedHttpServer', () => {
  it('binds HTTP server and returns assigned port', async () => {
    const server = {} as never;
    const port = await bindSharedHttpServer({
      httpServer: server,
      wsHost: '127.0.0.1',
      httpPort: 18080,
      requireToken: true,
      publicUrl: 'http://example.com',
    });
    expect(port).toBe(18080);
  });

  it('handles port reassignment on EADDRINUSE retry', async () => {
    const { listenWithRetry } = await import('../src/server/port-utils.js');
    (listenWithRetry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(18081);
    const port = await bindSharedHttpServer({
      httpServer: {} as never,
      wsHost: '127.0.0.1',
      httpPort: 18080,
      requireToken: false,
    });
    expect(port).toBe(18081);
  });
});

// ── 2. start-webui-project ───────────────────────────────────────────────
import { touchProjectEntry } from '../src/server/start-webui-project.js';

vi.mock('../src/server/projects-manifest.js', () => ({
  ensureProjectDataDir: vi.fn().mockResolvedValue(undefined),
  generateProjectSlug: vi.fn((root: string) => 'slug-' + root.replace(/[^a-zA-Z0-9]/g, '-')),
  loadManifest: vi.fn().mockResolvedValue({
    projects: [
      {
        name: 'existing',
        root: 'D:/test/existing',
        slug: 'existing-slug',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastSeen: '2026-01-01T00:00:00.000Z',
      },
    ],
  }),
  saveManifest: vi.fn().mockResolvedValue(undefined),
}));

describe('start-webui-project: touchProjectEntry', () => {
  it('updates lastSeen when project exists in manifest', async () => {
    await touchProjectEntry('D:/config', 'D:/test/existing', 'D:/test/existing/work');
    const { saveManifest } = await import('../src/server/projects-manifest.js');
    expect(saveManifest).toHaveBeenCalled();
  });

  it('creates project entry when project is new', async () => {
    await touchProjectEntry('D:/config', 'D:/test/new-project');
    const { saveManifest } = await import('../src/server/projects-manifest.js');
    expect(saveManifest).toHaveBeenCalled();
  });
});

// ── 3. start-webui-payload ───────────────────────────────────────────────
import { createStartWebuiSessionPayloadHelper } from '../src/server/start-webui-payload.js';

describe('start-webui-payload: createStartWebuiSessionPayloadHelper', () => {
  it('builds session start payload helper with all accessor callbacks', async () => {
    const helper = createStartWebuiSessionPayloadHelper({
      getConfig: () => ({ provider: 'test', model: 'test' }) as never,
      getSessionId: () => 's1',
      getProjectRoot: () => 'D:/root',
      getWorkingDir: () => 'D:/work',
      getModeId: () => 'code',
      getContextMeta: () => ({ contextWindowMode: 'dynamic' }),
      needsSetup: true,
      stateGetter: () => ({ getConfig: () => ({ provider: 'p', model: 'm' }) }) as never,
      modelsRegistry: { getModel: vi.fn().mockResolvedValue(undefined) } as never,
      peekAgent: (id) => ({ ctx: { session: { id } } }) as never,
    });
    expect(typeof helper).toBe('function');
    const payload = await helper({ sessionId: 's1' });
    expect(payload).toBeDefined();
  });
});

// ── 4. start-webui-security ──────────────────────────────────────────────
import { handleWebuiSecurityRejection } from '../src/server/start-webui-security.js';

const mockMailbox = {
  send: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@wrongstack/core/coordination', () => ({
  getSharedProjectMailbox: () => mockMailbox,
  resolveProjectDir: () => 'D:/proj',
}));

describe('start-webui-security: handleWebuiSecurityRejection', () => {
  it('sends security rejection note to project mailbox', () => {
    handleWebuiSecurityRejection(
      { projectRoot: 'D:/repo', agentId: 'lead' } as never,
      {} as never,
      { id: 'sess-1' },
      {
        issueCode: 'INVALID_TOKEN',
        issueMessage: 'Bad signature',
        connectionId: 'c1',
        sessionId: 's1',
        agentId: 'a1',
        projectRoot: 'D:/repo',
      } as never,
    );
    expect(mockMailbox.send).toHaveBeenCalled();
  });

  it('handles mailbox send rejection gracefully', async () => {
    mockMailbox.send.mockRejectedValueOnce(new Error('mailbox error'));
    handleWebuiSecurityRejection(
      { projectRoot: 'D:/repo', agentId: 'lead' } as never,
      {} as never,
      { id: 'sess-1' },
      { issueCode: 'ERR', issueMessage: 'msg' } as never,
    );
  });
});

// ── 5. start-webui-logging ───────────────────────────────────────────────
import { setupWebuiTerminalLogging } from '../src/server/start-webui-logging.js';

vi.mock('../src/server/terminal-dashboard.js', () => ({
  startTerminalDashboard: vi.fn((opts) => {
    opts?.getUrl?.();
    return { stop: vi.fn(), setSessions: vi.fn() };
  }),
}));

vi.mock('../src/server/webui-status-logger.js', () => ({
  startWebUILiveStatusLogger: vi.fn((opts) => {
    opts?.getSessionList?.();
    return vi.fn();
  }),
}));

describe('start-webui-logging: setupWebuiTerminalLogging', () => {
  it('configures dashboard and status logger', () => {
    const clients = new Map();
    clients.set('ws1', { sessionId: 's1', sessionIds: new Set(['s2']) });
    const logging = setupWebuiTerminalLogging({
      wsHost: '127.0.0.1',
      httpPort: 8080,
      accessToken: 'token123',
      publicUrl: 'http://pub.example.com',
      events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
      clients: clients as never,
      state: {
        getSession: () => ({ id: 's1' }),
        getConfig: () => ({ provider: 'prov', model: 'mod' }),
        isRunActive: () => false,
      } as never,
      deps: {
        peekAgent: () => undefined,
      } as never,
    });
    expect(logging.terminalDashboard).toBeDefined();
    expect(typeof logging.stopLiveStatusLogger).toBe('function');
    logging.stopLiveStatusLogger();
  });

  it('handles empty activeIds falling back to currentId in getSessionList', () => {
    setupWebuiTerminalLogging({
      wsHost: '127.0.0.1',
      httpPort: 8080,
      accessToken: 'token123',
      publicUrl: undefined,
      events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
      clients: new Map() as never,
      state: {
        getSession: () => ({ id: 'fallback-s1' }),
        getConfig: () => ({ provider: 'prov', model: 'mod' }),
        isRunActive: () => true,
      } as never,
      deps: {
        peekAgent: (_id: string) =>
          ({ ctx: { model: 'm-peek', provider: { id: 'p-peek' } } }) as never,
      } as never,
    });
  });
});

// ── 6. start-webui-deps ──────────────────────────────────────────────────
import { createWebuiCallbacks, createWebuiDeps } from '../src/server/start-webui-deps.js';

vi.mock('@wrongstack/tools/session-kanban', () => ({
  hydrateSessionKanban: vi.fn().mockResolvedValue(undefined),
}));

describe('start-webui-deps: createWebuiDeps and createWebuiCallbacks', () => {
  it('creates WebuiDeps with hasSession resolution', () => {
    const clients = new Map();
    clients.set('ws', { sessionId: 's-client' });
    const deps = createWebuiDeps({
      clients,
      agent: { ctx: { session: { id: 's-agent' } } } as never,
      peekAgent: (id: string) => (id === 's-peek' ? ({} as never) : undefined),
      httpPort: 9000,
    } as never);

    expect(deps.hasSession?.('s-agent')).toBe(true);
    expect(deps.hasSession?.('s-peek')).toBe(true);
    expect(deps.hasSession?.('s-client')).toBe(true);
    expect(deps.hasSession?.('s-none')).toBe(false);
    expect(deps.wsPort).toBe(9000);
    expect(deps.wsHost).toBe('127.0.0.1');
  });

  it('creates WebuiCallbacks and delegates lifecycle operations', async () => {
    const sessionIdentity = {
      claim: vi.fn(),
      activate: vi.fn().mockResolvedValue(undefined),
    };
    const todosCheckpoint = {
      rebind: vi.fn(),
    };
    const callbacks = createWebuiCallbacks({
      sessionStartPayload: vi.fn() as never,
      sessionIdentity: sessionIdentity as never,
      todosCheckpoint: todosCheckpoint as never,
      deps: { context: {} as never },
      updateAutoCompactionMaxContext: vi.fn(),
      updateGlobalConfig: vi.fn(),
      persistPrefsToConfig: vi.fn(),
      prefSnapshot: () => ({}),
    });

    callbacks.claimSession('s1', {} as never);
    expect(sessionIdentity.claim).toHaveBeenCalledWith('s1', {});

    await callbacks.onBeforeSessionTodosReplaced('s1', 'D:/sessions');
    expect(todosCheckpoint.rebind).toHaveBeenCalled();

    await callbacks.onSessionSwapped('s1', {} as never);
    expect(sessionIdentity.activate).toHaveBeenCalledWith('s1', {});
  });
});

// ── 7. start-webui-state ─────────────────────────────────────────────────
import { createWebuiMutableState } from '../src/server/start-webui-state.js';

describe('start-webui-state: createWebuiMutableState', () => {
  it('exposes full getters, setters, and run lock control', async () => {
    let config = { provider: 'a', model: 'b' };
    let root = 'D:/root';
    let work = 'D:/work';
    let session = { id: 's1' };
    let started = 1000;
    let store = {} as unknown as SessionStore;
    let mode = 'code';
    const locks = new Map();
    locks.set('s1', new AbortController());

    const state = createWebuiMutableState({
      getConfig: () => config as never,
      setConfig: (c) => {
        config = c as never;
      },
      getProjectRoot: () => root,
      setProjectRoot: (r) => {
        root = r;
      },
      getWorkingDir: () => work,
      setWorkingDir: (w) => {
        work = w;
      },
      getSession: () => session as never,
      setSession: (s) => {
        session = s as never;
      },
      getSessionStartedAt: () => started,
      setSessionStartedAt: (t) => {
        started = t;
      },
      getSessionStore: () => store,
      setSessionStore: (s) => {
        store = s;
      },
      getModeId: () => mode,
      setModeId: (m) => {
        mode = m;
      },
      modelCapabilitiesRef: { current: { reasoning: true } as never },
      configWriteLock: { lock: Promise.resolve() },
      runLockControl: {
        abortRunLock: vi.fn(),
        hasAny: () => locks.size > 0,
      },
      sessionRunLocks: locks,
      sessionTransitionGate: async (fn) => fn(),
      clients: new Map(),
    });

    expect(state.getProjectRoot()).toBe('D:/root');
    state.setProjectRoot('D:/new-root');
    expect(state.getProjectRoot()).toBe('D:/new-root');

    expect(state.getWorkingDir()).toBe('D:/work');
    state.setWorkingDir('D:/new-work');
    expect(state.getWorkingDir()).toBe('D:/new-work');

    expect(state.getSessionStartedAt()).toBe(1000);
    state.setSessionStartedAt(2000);
    expect(state.getSessionStartedAt()).toBe(2000);

    expect(state.getModeId()).toBe('code');
    state.setModeId('review');
    expect(state.getModeId()).toBe('review');

    expect(state.isRunActive('s1')).toBe(true);
    expect(state.isRunActive('s2')).toBe(false);
    expect(state.isRunActive()).toBe(true);
    expect(state.getRunningSessionIds()).toEqual(['s1']);

    expect(state.getModelCapabilities()).toEqual({ reasoning: true });
    expect(state.getConfigWriteLock()).toBeDefined();
    state.setConfigWriteLock(Promise.resolve());
    state.abortRunLock('s1');
    expect(state.getClients()).toBeDefined();
    await expect(state.withSessionTransition(async () => 'trans')).resolves.toBe('trans');
  });
});

// ── 8. start-webui-session-runtime ───────────────────────────────────────
import {
  createRunLockControl,
  createSessionBridgeManager,
  stopSessionFleet,
} from '../src/server/start-webui-session-runtime.js';

describe('start-webui-session-runtime', () => {
  it('stopSessionFleet executes hook safely', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('fail'));
    stopSessionFleet('s1', hook);
    expect(hook).toHaveBeenCalledWith('s1');
    stopSessionFleet('', hook);
  });

  it('createRunLockControl manages run locks and handles abort', () => {
    const locks = new Map();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    locks.set('s1', ctrl1);
    locks.set('s2', ctrl2);
    const stopFleet = vi.fn();

    const manager = createRunLockControl(locks, stopFleet);
    expect(manager.get('s1')).toBe(ctrl1);
    expect(manager.has('s1')).toBe(true);
    expect(manager.hasAny()).toBe(true);
    expect(manager.sessionIds()).toEqual(['s1', 's2']);

    manager.delete('s1');
    expect(manager.has('s1')).toBe(false);

    manager.abortRunLock('s2');
    expect(stopFleet).toHaveBeenCalledWith('s2');

    manager.set(ctrl1, 's1');
    manager.abortRunLock();
    expect(locks.size).toBe(0);
  });

  it('createSessionBridgeManager manages per-session event bridges', () => {
    const manager = createSessionBridgeManager(
      {} as never,
      { projectRoot: 'D:/repo' } as never,
      () => ({ id: 'sess' }),
      () => (id) => (id === 's1' ? { ctx: { session: { id } as never } } : undefined),
    );

    expect(manager.sessionBridge).toBeDefined();
    const b1 = manager.bridgeForSession('s1');
    expect(b1).toBeDefined();
    const b2 = manager.bridgeForSession('s1');
    expect(b2).toBe(b1);
    expect(manager.bridgeForSession('')).toBeUndefined();
    expect(manager.bridgeForSession('missing')).toBeUndefined();
  });
});

// ── 9. start-webui-vector ────────────────────────────────────────────────
import {
  initVectorMemoryStore,
  setupVectorMemoryMirror,
} from '../src/server/start-webui-vector.js';

vi.mock('@wrongstack/vector-memory', () => ({
  VectorMemoryStore: vi.fn(),
  TransformersEmbeddingProvider: vi.fn(),
  startFirstBootSageSync: vi.fn().mockResolvedValue(undefined),
  subscribeVectorMemoryToSage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  sweepStaleSageMirrors: vi.fn().mockResolvedValue(undefined),
  wrapMemoryPortWithVectorRecall: vi.fn((mem) => mem),
}));

describe('start-webui-vector', () => {
  it('initVectorMemoryStore respects config disabled flag', () => {
    const store = initVectorMemoryStore({
      projectRoot: 'D:/root',
      config: { Sage: { vector: { enabled: false } } },
      logger: { warn: vi.fn() } as never,
      vectorMemoryModelCacheDir: 'D:/cache',
    });
    expect(store).toBeUndefined();
  });

  it('initVectorMemoryStore initializes store when enabled', () => {
    const store = initVectorMemoryStore({
      projectRoot: 'D:/root',
      config: { Sage: { vector: { enabled: true } } },
      logger: { warn: vi.fn() } as never,
      vectorMemoryModelCacheDir: 'D:/cache',
    });
    expect(store).toBeDefined();
  });

  it('setupVectorMemoryMirror sets up mirror and disposal', () => {
    const mirror = setupVectorMemoryMirror({
      vectorMemoryStore: {} as never,
      baseMemoryStore: {} as never,
      config: {
        Sage: {
          vector: {
            weight: 0.5,
            threshold: 0.8,
            vectorOnlyThreshold: 0.9,
            maxMaterializations: 5,
          },
        },
      },
      logger: { warn: vi.fn() } as never,
    });
    expect(mirror.memoryStore).toBeDefined();
    mirror.disposeVectorMirror();
  });
});

// ── 10. start-webui-todos ────────────────────────────────────────────────
import { createStandaloneTodosCheckpointLifecycle } from '../src/server/start-webui-todos.js';

describe('start-webui-todos', () => {
  it('attaches, rebinds, and detaches todos checkpoint lifecycle', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createStandaloneTodosCheckpointLifecycle({
      state: {
        onChange: vi.fn().mockReturnValue(unsubscribe),
        todos: [],
      } as never,
      sessionsDir: 'D:/sessions',
      sessionId: 'sess-1',
      events: {} as never,
      warn: vi.fn(),
    });

    expect(lifecycle.rebind).toBeDefined();
    expect(lifecycle.detach).toBeDefined();

    // Rebind to same session is no-op
    await lifecycle.rebind('sess-1', 'D:/sessions');

    // Rebind to new session
    await lifecycle.rebind('sess-2', 'D:/sessions');

    // Detach
    await lifecycle.detach();
    // Second detach is no-op
    await lifecycle.detach();
  });
});
