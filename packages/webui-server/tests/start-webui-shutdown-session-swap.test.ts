// Bug-hunt r69 (2026-10-07) — shutdown must bind the LIVE session, not a
// wiring-time snapshot. start-webui-wiring.ts passed `session: state.getSession()`
// (evaluated once); after a post-wiring session swap (post-/new), flushSession
// appended `session_end` to the swapped-OUT session and the current one was
// offered for recovery on the next launch. The option is now `getSession`.
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  shutdowns: [] as Array<Record<string, unknown>>,
}));

// Process-signal registration is a boundary we do not own — capture the real
// callbacks so the swap scenario can invoke flushSession deterministically.
vi.mock('../src/server/server-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/server-runtime.js')>();
  return {
    ...actual,
    registerShutdown: vi.fn((options: Record<string, unknown>) => {
      registry.shutdowns.push(options);
      return 'shutdown-1';
    }),
  };
});

import { setupWebuiShutdown } from '../src/server/start-webui-shutdown.js';

function makeSession(label: string) {
  return {
    label,
    flushSync: vi.fn(),
    append: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function minimalOptions(): Record<string, unknown> {
  return {
    tokenCounter: { total: () => ({ input: 0, output: 0 }) },
    clients: new Map(),
    httpServer: new http.Server(),
    companionServer: null,
    wssPrimary: {},
    stopEmptySessionCleanup: { dispose: async () => {} },
    getKanbanSupervisorDispose: () => null,
    todosCheckpoint: { detach: async () => {} },
    stopHeapWatchdog: async () => {},
    disposeRealtimeHandlers: () => {},
    logger: { warn: () => {} },
    brainMonitor: {},
    agentServices: { flushSessionJournalsSync: undefined, closeSessionJournals: async () => {} },
    mcpRegistry: {},
    sessionIdentity: { stop: async () => {} },
    eventArming: {},
    getEternalSubscription: () => null,
    clearEternalSubscription: () => {},
    codebaseIndexing: {},
    memoryStore: { close: async () => {} },
    vectorMemoryStore: undefined,
    disposeVectorMirror: () => {},
    globalConfigPath: 'unused',
  };
}

/** Mirrors the wiring's session accessors (WebuiMutableState.getSession/setSession). */
function makeState(initial: ReturnType<typeof makeSession>) {
  const bag = { session: initial };
  return {
    getSession: () => bag.session,
    setSession: (next: ReturnType<typeof makeSession>) => {
      bag.session = next;
    },
  };
}

describe('setupWebuiShutdown — live session binding across a session swap', () => {
  beforeEach(() => {
    registry.shutdowns.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ends + closes the CURRENT session when the session was swapped after wiring', async () => {
    const oldSession = makeSession('old');
    const newSession = makeSession('new');
    const state = makeState(oldSession);
    // The wiring's production expression: the shutdown reads through the
    // store's live accessor, so a later swap is visible at shutdown time.
    setupWebuiShutdown({
      ...minimalOptions(),
      getSession: () => state.getSession(),
    } as never);

    state.setSession(newSession); // /new
    const flushSession = registry.shutdowns[0]?.flushSession as () => Promise<void>;
    await flushSession();

    expect(newSession.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_end' }),
    );
    expect(newSession.close).toHaveBeenCalledTimes(1);
    expect(oldSession.append).not.toHaveBeenCalled();
    expect(oldSession.close).not.toHaveBeenCalled();
  });

  it('without a swap, ends + closes the boot session (unchanged behavior)', async () => {
    const bootSession = makeSession('boot');
    const state = makeState(bootSession);
    setupWebuiShutdown({
      ...minimalOptions(),
      getSession: () => state.getSession(),
    } as never);
    const flushSession = registry.shutdowns[0]?.flushSession as () => Promise<void>;
    await flushSession();
    expect(bootSession.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_end' }),
    );
    expect(bootSession.close).toHaveBeenCalledTimes(1);
  });

  // 2026-11-13: a resume hands the leader role to the resumed session's own agent while the
  // root agent keeps the session it booted with. Nothing closed that one, so a desktop engine
  // left its unused boot session as a 0-byte transcript the empty-session sweep never removes.
  it('also ends + closes the root agent session a resume left behind', async () => {
    const boot = { ...makeSession('boot'), id: 'boot' };
    const resumed = { ...makeSession('resumed'), id: 'resumed' };
    const usage = { input: 3, output: 4 };
    setupWebuiShutdown({
      ...minimalOptions(),
      getSession: () => resumed,
      getRootSession: () => ({ session: boot, usage: () => usage }),
    } as never);
    const flushSession = registry.shutdowns[0]?.flushSession as () => Promise<void>;
    await flushSession();
    expect(boot.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_end', usage }),
    );
    expect(boot.close).toHaveBeenCalledTimes(1);
    expect(resumed.append).toHaveBeenCalledTimes(1);
    expect(resumed.close).toHaveBeenCalledTimes(1);
  });

  it('does not end the leader twice when the root agent holds it', async () => {
    const leader = { ...makeSession('leader'), id: 'same' };
    setupWebuiShutdown({
      ...minimalOptions(),
      getSession: () => leader,
      getRootSession: () => ({ session: leader, usage: () => ({ input: 0, output: 0 }) }),
    } as never);
    const flushSession = registry.shutdowns[0]?.flushSession as () => Promise<void>;
    await flushSession();
    expect(leader.append).toHaveBeenCalledTimes(1);
    expect(leader.close).toHaveBeenCalledTimes(1);
  });
});
