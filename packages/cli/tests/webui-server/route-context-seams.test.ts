import { describe, expect, it, vi } from 'vitest';
import { createWebuiRouteContexts } from '../../src/webui-server/route-contexts.js';

/**
 * The CLI host's half of the seam contract.
 *
 * `packages/webui-server/tests/host-seam-parity.test.ts` compares what the two
 * hosts hand to the shared bodies — but it lives in webui-server, which cannot
 * import the CLI, so it exercises the embedded ADAPTER with a fully-populated
 * context. That proves the adapter forwards what it is given; it proves nothing
 * about whether this host gives it.
 *
 * That is exactly the gap the last several rounds kept falling into: the CLI
 * host quietly omitted `metaFor`, then `getDisplayedSessionIds`, then
 * `introspectionCtx.getAgent`, and each time the fix existed and simply was not
 * wired here. This test closes the other side: the contexts this host builds
 * must carry the session-aware seams, whatever the adapter would do with them.
 *
 * Presence, not behaviour — each seam's behaviour is pinned by its own test.
 */

/** Seams whose whole purpose is "serve the session that asked". */
const REQUIRED_SEAMS = {
  sessionsCtx: [
    'getAgent',
    'peekAgent',
    'isRunActive',
    'isSessionLive',
    'clients',
    'onSessionsUndisplayed',
  ],
  connectionCtx: ['getAgent', 'peekAgent', 'abortControllers', 'pendingConfirms'],
  introspectionCtx: ['getAgent'],
  prefsCtx: ['metaFor', 'snapshot'],
} as const;

function makeParams() {
  const session = { id: 'sess-leader', append: vi.fn(async () => undefined) };
  const agent = {
    ctx: {
      meta: {},
      session,
      provider: { id: 'p' },
      model: 'm',
      projectRoot: '/repo',
      tools: [],
      container: { safeResolve: vi.fn(() => undefined) },
    },
    tools: { list: vi.fn(() => []) },
  };
  return {
    opts: {
      agent,
      session,
      projectRoot: '/repo',
      appConfig: { provider: 'p', model: 'm' },
      events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
    },
    profileConfigPath: '/config.json',
    profileDir: '/profile',
    globalRoot: '/global',
    sessionStartedAt: 0,
    currentSessionId: () => 'sess-leader',
    getCustomModeStore: vi.fn(async () => ({}) as never),
    buildSessionStartPayload: vi.fn(async () => ({})),
    prefSnapshot: () => ({}),
    persistPrefs: vi.fn(async () => undefined),
    pendingConfirms: new Map(),
    abortControllers: new Map(),
    getSessionAgent: vi.fn(() => agent),
    peekSessionAgent: vi.fn(() => agent),
    isSessionLive: vi.fn(() => true),
    getForegroundSession: () => session,
    setForegroundSession: vi.fn(),
    clients: new Map(),
    onSessionsUndisplayed: vi.fn(),
    send: vi.fn(),
    broadcast: vi.fn(),
  };
}

describe('CLI WebUI route contexts — session-aware seams', () => {
  it('builds every context with the seams the shared bodies need', () => {
    const contexts = createWebuiRouteContexts(makeParams() as never) as unknown as Record<
      string,
      Record<string, unknown>
    >;

    const missing: string[] = [];
    for (const [name, seams] of Object.entries(REQUIRED_SEAMS)) {
      const ctx = contexts[name];
      if (!ctx) {
        missing.push(`${name} was not built at all`);
        continue;
      }
      for (const seam of seams) {
        if (ctx[seam] === undefined) missing.push(`${name}.${seam}`);
      }
    }

    expect(missing).toEqual([]);
  });

  /**
   * `getAgent` CREATES on read. Read paths must ask `peekAgent`, or a stale id
   * — one a client typed, or one whose tab closed minutes ago — materialises an
   * agent and can evict the agent of a tab the user still has open.
   */
  it('answers introspection through the non-creating peek first', () => {
    const params = makeParams();
    const contexts = createWebuiRouteContexts(params as never) as unknown as {
      introspectionCtx: { getAgent?: (sessionId?: string) => unknown };
    };

    contexts.introspectionCtx.getAgent?.('sess-other');

    expect(params.peekSessionAgent).toHaveBeenCalledWith('sess-other');
    expect(params.getSessionAgent).not.toHaveBeenCalled();
  });
});
