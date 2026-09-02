import { describe, expect, it, vi } from 'vitest';

/**
 * The two hosts must wire the SAME session-aware seams.
 *
 * `createSessionHandlers` and `createConversationOperations` are shared bodies.
 * The standalone server (`buildRoutes`) and the CLI-embedded host
 * (`createEmbeddedMessageRouter`) each hand them a different options object,
 * and for a long time a fix for "answer the tab that asked" was wired into
 * whichever host the person was looking at. Every one of these was found that
 * way, one ghost at a time:
 *
 *   - `isRunActive` was overridden with a zero-arg function, so one running tab
 *     made every session look busy and `session.delete` refused forever;
 *   - `onSessionsUndisplayed` was wired only on the CLI host, so on the
 *     standalone server a closed tab's unanswerable permission prompt wedged
 *     its run for good;
 *   - `withSessionTransition` and `getMaxIterations` were wired only on the
 *     standalone server, so on the CLI host turn setup raced session swaps and
 *     every tab inherited the leader's iteration ceiling.
 *
 * Finding these one at a time does not converge. This test compares the seams
 * themselves: when a session-aware option appears on one host, it has to appear
 * on the other, or be listed below with the reason it cannot.
 *
 * It deliberately checks PRESENCE, not behaviour — the behaviour of each seam
 * is pinned by its own test. What this catches is the wiring going in on one
 * side only, which is the failure mode that actually recurs.
 *
 * HALF OF A PAIR. This file lives in webui-server, which cannot import the CLI,
 * so the embedded side is exercised through the ADAPTER with a fully-populated
 * context: it proves the adapter forwards what it is given, not that the CLI
 * host gives it. The other half —
 * `packages/cli/tests/webui-server/route-context-seams.test.ts` — asserts the
 * contexts that host actually builds. Both are needed; either alone has a blind
 * spot the other covers.
 */

const captured = vi.hoisted(() => ({
  session: [] as Array<Record<string, unknown>>,
  conversation: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/server/session-handlers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/session-handlers.js')>();
  return {
    ...actual,
    createSessionHandlers: vi.fn((options: Record<string, unknown>) => {
      captured.session.push(options);
      return {} as never;
    }),
  };
});

vi.mock('../src/server/conversation-operations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/conversation-operations.js')>();
  return {
    ...actual,
    createConversationOperations: vi.fn((options: Record<string, unknown>) => {
      captured.conversation.push(options);
      return {} as never;
    }),
  };
});

vi.mock('@wrongstack/providers', () => ({ makeProviderFromConfig: vi.fn() }));

import { createEmbeddedMessageRouter } from '../src/server/embedded-message-router.js';
import { createMessageDispatcher } from '../src/server/message-dispatcher.js';
import { buildRoutes } from '../src/server/routes.js';

/**
 * Options whose whole purpose is "serve the session that asked". A host that
 * omits one does not fail loudly — it silently answers for the leader, which
 * is the tab the user is least likely to be looking at.
 */
const SESSION_AWARE_SEAMS = {
  session: [
    'clients',
    'isRunActive',
    'abortActiveRun',
    'isSessionLive',
    'onSessionsUndisplayed',
    'getAgent',
    'withSessionTransition',
  ],
  conversation: [
    'getAgent',
    'hasSession',
    'runControl',
    'getMaxIterations',
    'withSessionTransition',
  ],
} as const;

/**
 * Seams one host genuinely cannot supply. Empty on purpose: every entry is a
 * documented hole, so adding one should take an argument, not a shrug.
 */
const KNOWN_ASYMMETRIES: Record<string, string> = {};

function proxied(base: Record<string, unknown>, fallback: unknown) {
  return new Proxy(base, { get: (target, prop) => Reflect.get(target, prop) ?? fallback });
}

function buildStandalone(): void {
  const fallback = vi.fn();
  const state = proxied(
    {
      getConfig: vi.fn(() => ({ provider: 'p', model: 'm', providers: {} })),
      getClients: vi.fn(() => new Map()),
      getProjectRoot: vi.fn(() => '/repo'),
      getModelCapabilities: vi.fn(() => ({})),
    },
    fallback,
  );
  const deps = proxied(
    {
      context: { meta: {}, session: { id: 'sess-1' }, runModelTransition: vi.fn() },
      pendingConfirms: new Map(),
      wpaths: { globalRoot: '/global', projectSessions: '/sessions' },
      providerRegistry: { has: vi.fn(() => false), create: vi.fn() },
      logger: { warn: vi.fn(), level: 'info' },
      toolRegistry: { list: vi.fn(() => []) },
    },
    {},
  );
  const cb = new Proxy({}, { get: () => vi.fn() });
  const routes = buildRoutes(state as never, deps as never, cb as never);
  // The standalone host's conversation routes are built by the DISPATCHER, not
  // by buildRoutes — so the comparison has to reach both entry points or it
  // silently reports the whole conversation body as "missing".
  createMessageDispatcher({
    state: proxied(
      {
        getSession: vi.fn(() => ({ id: 'sess-1' })),
        getClients: vi.fn(() => new Map()),
        getProjectRoot: vi.fn(() => '/repo'),
        getConfig: vi.fn(() => ({ provider: 'p', model: 'm' })),
        withSessionTransition: <T>(operation: () => Promise<T>) => operation(),
      },
      fallback,
    ) as never,
    deps: deps as never,
    routes: routes as never,
    promptsCtx: { promptLoader: {}, promptUsage: {} },
    codebaseIndexing: { onFileWritten: vi.fn() },
    runLock: proxied(
      {
        get: vi.fn(() => null),
        set: vi.fn(),
        has: vi.fn(() => false),
        hasAny: vi.fn(() => false),
        delete: vi.fn(),
        sessionIds: vi.fn(() => []),
      },
      fallback,
    ) as never,
    pendingConfirms: new Map(),
  });
}

function buildEmbedded(): void {
  const send = vi.fn();
  const agent: unknown = {
    ctx: {
      projectRoot: '/repo',
      provider: { id: 'p' },
      model: 'm',
      todos: [],
      meta: {},
      session: { id: 'sess-1' },
      tools: [],
      state: { replaceTodos: vi.fn() },
    },
  };
  const stub = { handleMessage: vi.fn(async () => undefined) };
  createEmbeddedMessageRouter({
    trustBoundary: { authorize: vi.fn(async () => ({ allowed: true, reason: '' })) },
    opts: { agent, projectRoot: '/repo', profileConfigPath: '/config.json' },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(function (this: unknown) {
        return this;
      }),
    },
    send,
    sendResult: vi.fn(),
    sessionPayload: (payload: Record<string, unknown>) => ({ ...payload, sessionId: 'sess-1' }),
    currentSessionId: () => 'sess-1',
    shutdown: vi.fn(),
    providerCtx: {
      providerStore: {},
      broadcast: vi.fn(),
      send,
      modelsRegistry: {},
      log: {},
      hasActiveModel: () => false,
    },
    brainCtx: { brain: null, broadcast: vi.fn(), send },
    introspectionCtx: { getProjectRoot: () => '/repo', send, agent, getConfig: () => undefined },
    skillsCtx: { getSkillsContext: () => ({}), send },
    promptsCtx: { getPromptsContext: () => ({}), send },
    designCtx: { getDesignContext: () => ({}), send },
    agentConfigCtx: {
      agent,
      memoryStore: null,
      modelsRegistry: {},
      getConfig: () => undefined,
      loadSavedProviders: vi.fn(async () => ({})),
      send,
      broadcast: vi.fn(),
      log: {},
      modeStore: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      buildSessionStart: vi.fn(async () => ({})),
    },
    prefsCtx: { getPrefs: vi.fn(async () => ({})), setPref: vi.fn(async () => undefined), send },
    projectCtx: {
      getProjectRoot: () => '/repo',
      send,
      opts: { agent, projectRoot: '/repo', profileConfigPath: '/config.json' },
    },
    sessionCtx: {
      getSessionHistory: vi.fn(async () => []),
      saveSession: vi.fn(async () => undefined),
      send,
      clients: new Map(),
      abortControllers: new Map(),
      buildSessionStart: vi.fn(async () => ({})),
      opts: { agent, projectRoot: '/repo' },
      getAgent: () => agent,
      peekAgent: () => agent,
      isSessionLive: () => true,
      onSessionsUndisplayed: vi.fn(),
      abortActiveRun: vi.fn(),
      isRunActive: () => false,
    },
    conversationCtx: {
      agent,
      abortControllers: new Map(),
      pendingConfirms: new Map(),
      send,
      broadcast: vi.fn(),
      getAgent: () => agent,
      peekAgent: () => agent,
    },
    mailboxRoutes: {},
    goalHandler: stub,
    specsHandler: stub,
    sddBoardHandler: stub,
    sddWizardHandler: stub,
    worktreeHandler: stub,
    terminalHandler: stub,
    kanbanHostRoutes: {},
  } as never);
}

describe('host seam parity — standalone vs CLI-embedded', () => {
  it('wires the same session-aware seams into both shared bodies', () => {
    captured.session.length = 0;
    captured.conversation.length = 0;

    buildStandalone();
    const standalone = {
      session: captured.session.at(-1) ?? {},
      conversation: captured.conversation.at(-1) ?? {},
    };

    captured.session.length = 0;
    captured.conversation.length = 0;

    buildEmbedded();
    const embedded = {
      session: captured.session.at(-1) ?? {},
      conversation: captured.conversation.at(-1) ?? {},
    };

    // Both hosts must actually have reached the shared bodies, or the whole
    // comparison below is vacuous.
    expect(Object.keys(standalone.session).length).toBeGreaterThan(0);
    expect(Object.keys(embedded.conversation).length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [body, seams] of Object.entries(SESSION_AWARE_SEAMS)) {
      const left = standalone[body as keyof typeof standalone];
      const right = embedded[body as keyof typeof embedded];
      for (const seam of seams) {
        const key = `${body}.${seam}`;
        if (KNOWN_ASYMMETRIES[key]) continue;
        if (left[seam] === undefined) missing.push(`standalone is missing ${key}`);
        if (right[seam] === undefined) missing.push(`CLI-embedded is missing ${key}`);
      }
    }

    expect(missing).toEqual([]);
  });
});
