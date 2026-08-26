import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSessionLanes, useSessionStore } from '../../src/stores/session-store';

const PERSIST_KEY = 'wrongstack-session-lanes';

function getPersisted(): Record<string, unknown> | null {
  const raw = localStorage.getItem(PERSIST_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function setPersisted(value: Record<string, unknown> | null): void {
  if (value === null) {
    localStorage.removeItem(PERSIST_KEY);
    return;
  }
  localStorage.setItem(PERSIST_KEY, JSON.stringify(value));
}

function resetStore() {
  // Four tabs means four lanes; a leftover lane would hand its accounting to
  // the next test.
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionStore.setState({
    session: null,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastInputTokens: 0,
    cost: 0,
    startTime: null,
    maxContext: 0,
    contextLimitWarning: null,
    cacheStats: null,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    projectName: '',
    projectRoot: '',
    cwd: '',
    mode: 'default',
    modes: [],
    contextMode: 'balanced',
    contextModes: [],
    iteration: null,
    todos: [],
    lastVisitedAt: 0,
  });
  setPersisted(null);
}

function flushWrites(): void {
  // Persist middleware writes are queued on a microtask; for test speed we
  // grab the persist API and call flush() if available.
  const api = (useSessionStore as unknown as { persist?: { flush?: () => void } }).persist;
  api?.flush?.();
}

afterEach(() => {
  resetStore();
});

const makeSession = (
  overrides: Partial<{
    id: string;
    title: string;
    startedAt: string;
    provider: string;
    model: string;
  }> = {},
): Parameters<typeof useSessionStore.getState>[0]['session'] => ({
  id: 'session-1',
  title: 'Test Session',
  startedAt: '2024-01-01T00:00:00.000Z',
  provider: 'anthropic',
  model: 'anthropic-test-model',
  ...overrides,
});

// ── setSession ─────────────────────────────────────────────────────

describe('setSession', () => {
  beforeEach(() => resetStore());

  it('sets session', () => {
    const session = makeSession();
    useSessionStore.getState().setSession(session);
    expect(useSessionStore.getState().session).toEqual(session);
  });

  it('clears a provider-limit warning when the route changes', () => {
    useSessionStore.setState({
      session: makeSession(),
      contextLimitWarning: {
        providerId: 'anthropic',
        modelId: 'anthropic-test-model',
        previousMaxContext: 1_000_000,
        maxContext: 200_000,
      },
    });
    useSessionStore
      .getState()
      .setSession(makeSession({ provider: 'openai-codex', model: 'gpt-5.6-sol' }));
    expect(useSessionStore.getState().contextLimitWarning).toBeNull();
  });

  it('can set session to null', () => {
    useSessionStore.setState({ session: makeSession() });
    useSessionStore.getState().setSession(null);
    expect(useSessionStore.getState().session).toBe(null);
  });
});

// ── updateUsage ───────────────────────────────────────────────────

describe('updateUsage', () => {
  beforeEach(() => resetStore());

  it('accumulates input tokens', () => {
    useSessionStore.getState().updateUsage({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 });
    useSessionStore.getState().updateUsage({ input: 200, output: 0, cacheRead: 0, cacheWrite: 0 });
    const state = useSessionStore.getState();
    expect(state.totalTokens.input).toBe(300);
  });

  it('accumulates output tokens', () => {
    useSessionStore.getState().updateUsage({ input: 0, output: 50, cacheRead: 0, cacheWrite: 0 });
    useSessionStore.getState().updateUsage({ input: 0, output: 70, cacheRead: 0, cacheWrite: 0 });
    expect(useSessionStore.getState().totalTokens.output).toBe(120);
  });

  it('accumulates cacheRead tokens', () => {
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 10, cacheWrite: 0 });
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 20, cacheWrite: 0 });
    expect(useSessionStore.getState().totalTokens.cacheRead).toBe(30);
  });

  it('accumulates cacheWrite tokens', () => {
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 5 });
    useSessionStore.getState().updateUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 15 });
    expect(useSessionStore.getState().totalTokens.cacheWrite).toBe(20);
  });

  it('sets lastInputTokens to input + cacheRead + cacheWrite', () => {
    useSessionStore.getState().updateUsage({ input: 100, output: 0, cacheRead: 10, cacheWrite: 5 });
    expect(useSessionStore.getState().lastInputTokens).toBe(115);
  });

  it('uses previous lastInputTokens when inputDelta is 0', () => {
    useSessionStore.getState().updateUsage({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 });
    const prev = useSessionStore.getState().lastInputTokens;
    useSessionStore.getState().updateUsage({ input: 0, output: 50, cacheRead: 0, cacheWrite: 0 });
    expect(useSessionStore.getState().lastInputTokens).toBe(prev);
  });

  it('updates aggregate and per-provider cache hit ratios live', () => {
    useSessionStore
      .getState()
      .updateUsage({ input: 200, output: 20, cacheRead: 800, cacheWrite: 0 }, 'minimax');
    useSessionStore
      .getState()
      .updateUsage({ input: 100, output: 10, cacheRead: 300, cacheWrite: 100 }, 'anthropic');

    const cache = useSessionStore.getState().cacheStats;
    expect(cache?.hitRatio).toBeCloseTo(1100 / 1500, 6);
    expect(cache?.coverageTokens).toBe(300);
    expect(cache?.providers).toEqual([
      { provider: 'minimax', input: 200, cacheRead: 800, cacheWrite: 0, hitRatio: 0.8 },
      { provider: 'anthropic', input: 100, cacheRead: 300, cacheWrite: 100, hitRatio: 0.6 },
    ]);
  });
});

// ── addCost ───────────────────────────────────────────────────────

describe('addCost', () => {
  beforeEach(() => resetStore());

  it('accumulates cost', () => {
    useSessionStore.getState().addCost(0.05);
    useSessionStore.getState().addCost(0.1);
    expect(useSessionStore.getState().cost).toBeCloseTo(0.15);
  });
});

// ── startSession ──────────────────────────────────────────────────

describe('startSession', () => {
  beforeEach(() => resetStore());

  it('sets session and startTime', () => {
    const session = makeSession();
    const before = Date.now();
    useSessionStore.getState().startSession(session);
    const state = useSessionStore.getState();
    expect(state.session).toEqual(session);
    expect(state.startTime).toBeGreaterThanOrEqual(before);
  });

  it('resets iteration, lastInputTokens, totalTokens, and cost', () => {
    useSessionStore.setState({
      iteration: { index: 5, max: 10 },
      lastInputTokens: 999,
      cost: 1.5,
      totalTokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    });
    useSessionStore.getState().startSession(makeSession());
    const state = useSessionStore.getState();
    expect(state.iteration).toBe(null);
    expect(state.lastInputTokens).toBe(0);
    expect(state.cost).toBe(0);
    expect(state.totalTokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

// ── endSession ────────────────────────────────────────────────────

describe('endSession', () => {
  beforeEach(() => resetStore());

  it('clears session and startTime', () => {
    useSessionStore.setState({
      session: makeSession(),
      startTime: Date.now(),
      iteration: { index: 3, max: 10 },
    });
    useSessionStore.getState().endSession();
    const state = useSessionStore.getState();
    expect(state.session).toBe(null);
    expect(state.startTime).toBe(null);
    expect(state.iteration).toBe(null);
  });
});

// ── setEnv ────────────────────────────────────────────────────────

describe('setEnv', () => {
  beforeEach(() => resetStore());

  it('sets all env fields', () => {
    useSessionStore.getState().setEnv({
      maxContext: 200_000,
      projectRoot: '/project',
      projectName: 'my-project',
      cwd: '/project/src',
      mode: 'code',
      contextMode: 'frugal',
      inputCost: 3,
      outputCost: 15,
      cacheReadCost: 0.3,
    });
    const state = useSessionStore.getState();
    expect(state.maxContext).toBe(200_000);
    expect(state.projectRoot).toBe('/project');
    expect(state.projectName).toBe('my-project');
    expect(state.cwd).toBe('/project/src');
    expect(state.mode).toBe('code');
    expect(state.contextMode).toBe('frugal');
    expect(state.inputCost).toBe(3);
    expect(state.outputCost).toBe(15);
    expect(state.cacheReadCost).toBe(0.3);
  });

  it('only updates provided fields, keeps existing values for others', () => {
    useSessionStore.setState({
      maxContext: 100_000,
      projectRoot: '/old',
      mode: 'default',
    });
    useSessionStore.getState().setEnv({ projectRoot: '/new' });
    const state = useSessionStore.getState();
    expect(state.projectRoot).toBe('/new');
    expect(state.maxContext).toBe(100_000); // unchanged
    expect(state.mode).toBe('default'); // unchanged
  });
});

// ── setIteration ───────────────────────────────────────────────────

describe('setIteration', () => {
  beforeEach(() => resetStore());

  it('sets iteration', () => {
    useSessionStore.getState().setIteration({ index: 3, max: 10 });
    expect(useSessionStore.getState().iteration).toEqual({ index: 3, max: 10 });
  });

  it('can set iteration to null', () => {
    useSessionStore.setState({ iteration: { index: 3, max: 10 } });
    useSessionStore.getState().setIteration(null);
    expect(useSessionStore.getState().iteration).toBe(null);
  });
});

// ── setModes ──────────────────────────────────────────────────────

describe('setModes', () => {
  beforeEach(() => resetStore());

  it('sets modes', () => {
    const modes = [
      { id: 'default', name: 'Default', description: '' },
      { id: 'code', name: 'Code', description: 'For coding tasks' },
    ];
    useSessionStore.getState().setModes(modes);
    expect(useSessionStore.getState().modes).toEqual(modes);
  });

  it('replaces existing modes', () => {
    useSessionStore.setState({ modes: [{ id: 'old', name: 'Old', description: '' }] });
    useSessionStore.getState().setModes([{ id: 'new', name: 'New', description: '' }]);
    expect(useSessionStore.getState().modes).toHaveLength(1);
    expect(useSessionStore.getState().modes[0].id).toBe('new');
  });
});

// ── setContextModes ────────────────────────────────────────────────

describe('setContextModes', () => {
  beforeEach(() => resetStore());

  it('sets contextModes', () => {
    const modes = [
      {
        id: 'balanced',
        name: 'Balanced',
        description: '',
        thresholds: { warn: 0.5, soft: 0.7, hard: 0.9 },
      },
    ];
    useSessionStore.getState().setContextModes(modes);
    expect(useSessionStore.getState().contextModes).toEqual(modes);
  });
});

// ── setTodos ──────────────────────────────────────────────────────

describe('setTodos', () => {
  beforeEach(() => resetStore());

  it('sets todos', () => {
    const todos = [
      { id: '1', content: 'Do this', status: 'pending' as const },
      { id: '2', content: 'Do that', status: 'in_progress' as const, activeForm: 'Doing that' },
    ];
    useSessionStore.getState().setTodos(todos);
    expect(useSessionStore.getState().todos).toEqual(todos);
  });

  it('replaces existing todos', () => {
    useSessionStore.setState({
      todos: [{ id: 'old', content: 'Old', status: 'pending' as const }],
    });
    useSessionStore
      .getState()
      .setTodos([{ id: 'new', content: 'New', status: 'completed' as const }]);
    expect(useSessionStore.getState().todos).toHaveLength(1);
    expect(useSessionStore.getState().todos[0].id).toBe('new');
  });
});

// ── F5 resilience: persistence + migrate ─────────────────────────
//
// The persist middleware covers the F5 contract: after a page refresh the
// session pointer + env fields must come back from localStorage without
// help from the WebSocket.
//
// Partialize is intentional: heavy fields (modes, contextModes,
// iteration, todos, totalTokens, cost, startTime) are NOT persisted so
// they get re-fetched from the server on reconnect — the server is the
// authority on live run state.
describe('F5 resilience — persistence', () => {
  const laneOptions = useSessionStore.persist.getOptions();

  function activeLane(blob: {
    state: { activeSessionId: string; lanes: Record<string, Record<string, unknown>> };
  }) {
    return blob.state.lanes[blob.state.activeSessionId]!;
  }

  it('writes the persisted session pointer + env on setSession', () => {
    useSessionStore.setState({
      projectName: 'wrongstack-demo',
      projectRoot: '/tmp/wrongstack-demo',
      cwd: '/tmp/wrongstack-demo/src',
    });
    useSessionStore.getState().setSession(makeSession({ id: 'sess-XYZ' }));
    useSessionStore.setState({ mode: 'code', contextMode: 'frugal' });
    flushWrites();
    const blob = getPersisted() as unknown as {
      state: { activeSessionId: string; lanes: Record<string, Record<string, unknown>> };
    } | null;
    expect(blob).toBeTruthy();
    // Project fields are shared by all four tabs; the session pointer, mode
    // and context policy belong to the tab that owns them.
    expect((blob!.state as unknown as Record<string, unknown>).projectName).toBe('wrongstack-demo');
    expect((blob!.state as unknown as Record<string, unknown>).cwd).toBe(
      '/tmp/wrongstack-demo/src',
    );
    expect(blob!.state.activeSessionId).toBe('sess-XYZ');
    const lane = activeLane(blob!);
    expect(lane.session).toMatchObject({ id: 'sess-XYZ' });
    expect(lane.mode).toBe('code');
    expect(lane.contextMode).toBe('frugal');
  });

  it('does NOT persist heavy fields (todos, iteration, totalTokens, cost)', () => {
    useSessionStore.getState().setSession(makeSession({ id: 'sess-heavy' }));
    useSessionStore.setState({
      iteration: { index: 5, max: 10 },
      totalTokens: { input: 999, output: 88, cacheRead: 11, cacheWrite: 0 },
      cost: 0.42,
      startTime: 1_700_000_000_000,
      todos: [{ id: 't', content: 'x', status: 'pending' }],
    });
    flushWrites();
    const blob = getPersisted() as unknown as {
      state: { activeSessionId: string; lanes: Record<string, Record<string, unknown>> };
    };
    const lane = activeLane(blob);
    for (const field of ['iteration', 'totalTokens', 'cost', 'startTime', 'todos']) {
      expect(lane[field], field).toBeUndefined();
    }
    // ...and the project-wide catalogs are not in the blob either.
    const state = blob.state as unknown as Record<string, unknown>;
    expect(state.modes).toBeUndefined();
    expect(state.contextModes).toBeUndefined();
  });

  it('stamps lastVisitedAt on setSession and startSession', () => {
    const before = Date.now();
    useSessionStore.getState().setSession(makeSession());
    const after = Date.now();
    const s = useSessionStore.getState();
    expect(s.lastVisitedAt).toBeGreaterThanOrEqual(before);
    expect(s.lastVisitedAt).toBeLessThanOrEqual(after);
  });

  it('merge() round-trips the session pointer, env and per-tab mode', () => {
    const merged = laneOptions.merge?.(
      {
        activeSessionId: 'restored-after-f5',
        projectName: 'persisted-project',
        projectRoot: '/tmp/persisted-project',
        cwd: '/tmp/persisted-project',
        lanes: {
          'restored-after-f5': {
            session: {
              id: 'restored-after-f5',
              title: 'Round trip',
              startedAt: 1_700_000_000_000,
              provider: 'anthropic',
              model: 'anthropic-test-model',
            },
            mode: 'plan',
            contextMode: 'deep',
            lastVisitedAt: 1_700_000_000_001,
          },
        },
      },
      useSessionStore.persist.getOptions() as never,
    ) as {
      activeSessionId: string;
      projectName: string;
      cwd: string;
      lanes: Record<string, Record<string, unknown>>;
    };
    expect(merged.activeSessionId).toBe('restored-after-f5');
    expect(merged.projectName).toBe('persisted-project');
    expect(merged.cwd).toBe('/tmp/persisted-project');
    expect(merged.lanes['restored-after-f5']).toMatchObject({
      session: { id: 'restored-after-f5' },
      mode: 'plan',
      contextMode: 'deep',
      lastVisitedAt: 1_700_000_000_001,
    });
  });

  it('merge() restores every tab, not just the one that was in front', () => {
    const merged = laneOptions.merge?.(
      {
        activeSessionId: 'b',
        lanes: {
          a: { session: { id: 'a', startedAt: 1, provider: 'p', model: 'm' }, mode: 'code' },
          b: { session: { id: 'b', startedAt: 2, provider: 'p', model: 'm' }, mode: 'plan' },
        },
      },
      useSessionStore.persist.getOptions() as never,
    ) as { lanes: Record<string, { mode: string }> };
    expect(merged.lanes.a?.mode).toBe('code');
    expect(merged.lanes.b?.mode).toBe('plan');
  });

  it('merge() drops a corrupt session shape without losing the lane', () => {
    const merged = laneOptions.merge?.(
      { activeSessionId: 'x', lanes: { x: { session: 'not-an-object', mode: 42 } } },
      useSessionStore.persist.getOptions() as never,
    ) as { lanes: Record<string, { session: unknown; mode: string }> };
    expect(merged.lanes.x?.session).toBeNull();
    expect(merged.lanes.x?.mode).toBe('default');
  });

  it('merge() coerces non-string env fields to defaults', () => {
    const merged = laneOptions.merge?.(
      { projectName: 42, cwd: { bogus: true }, lanes: {} },
      useSessionStore.persist.getOptions() as never,
    ) as { projectName: string; cwd: string; activeSessionId: string };
    expect(merged.projectName).toBe('');
    expect(merged.cwd).toBe('');
    expect(merged.activeSessionId).toBe('__unbound__');
  });

  it('does NOT clear lastVisitedAt when endSession() runs', () => {
    useSessionStore.getState().startSession(makeSession({ id: 'sess-end' }));
    const stamped = useSessionStore.getState().lastVisitedAt;
    expect(stamped).toBeGreaterThan(0);
    useSessionStore.getState().endSession();
    expect(useSessionStore.getState().lastVisitedAt).toBe(stamped);
  });
});

// ── cacheStats (prompt-cache snapshot) ─────────────────────────────
//
// `cacheStats` is the WebUI-side mirror of the cumulative
// `TokenCounter.cacheStats()` figure plus a per-request `coverageTokens`
// field. The store does NOT cap coverage — that is `handleStatsGet`'s
// responsibility (it reads `currentRequest.cacheRead` from the server
// payload and clamps against `lastInputTokens`). What the store DOES
// own is the lifecycle:
//
//   - cleared on provider/model switch (`setSession` with a different
//     provider/model), so a stale reading from the previous provider
//     can never apply to the new prompt cache;
//   - cleared on `startSession` and `endSession`, same lifecycle as
//     `contextLimitWarning`;
//   - `setCacheStats(null)` clears it (used when the server reports no
//     cache yet or when the WS handler decodes a malformed payload);
//   - unrelated store mutations (todos, modes, env, …) must NOT clear
//     the snapshot — only the explicit setters do.

const CACHE_FIXTURE = {
  readTokens: 12_000,
  writeTokens: 3_000,
  hitRatio: 0.4,
  coverageTokens: 8_000,
};

describe('cacheStats', () => {
  beforeEach(() => resetStore());

  it('starts null on a fresh store', () => {
    expect(useSessionStore.getState().cacheStats).toBeNull();
  });

  it('setCacheStats writes the snapshot', () => {
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    expect(useSessionStore.getState().cacheStats).toEqual(CACHE_FIXTURE);
  });

  it('setCacheStats(null) clears the snapshot', () => {
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    expect(useSessionStore.getState().cacheStats).toEqual(CACHE_FIXTURE);
    useSessionStore.getState().setCacheStats(null);
    expect(useSessionStore.getState().cacheStats).toBeNull();
  });

  it('clears on provider/model switch via setSession', () => {
    // Seed a session + a cache reading from the previous provider.
    useSessionStore
      .getState()
      .setSession(makeSession({ provider: 'anthropic', model: 'claude-opus-4.5' }));
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    expect(useSessionStore.getState().cacheStats).toEqual(CACHE_FIXTURE);

    // Switching provider + model must clear the cache snapshot — a
    // stale Anthropic reading cannot apply to an OpenAI prompt cache.
    useSessionStore
      .getState()
      .setSession(makeSession({ provider: 'openai-codex', model: 'gpt-5.6-sol' }));
    expect(useSessionStore.getState().cacheStats).toBeNull();
  });

  it('preserves the snapshot when setSession is called with the same provider/model', () => {
    // A no-op route change (e.g. re-entering the same session) must
    // not clobber a still-valid cache reading. Mirrors the
    // `contextLimitWarning` preservation rule.
    useSessionStore
      .getState()
      .setSession(makeSession({ provider: 'anthropic', model: 'claude-opus-4.5' }));
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    useSessionStore
      .getState()
      .setSession(makeSession({ provider: 'anthropic', model: 'claude-opus-4.5' }));
    expect(useSessionStore.getState().cacheStats).toEqual(CACHE_FIXTURE);
  });

  it('clears on startSession', () => {
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    useSessionStore.getState().startSession(makeSession({ id: 'sess-2' }));
    expect(useSessionStore.getState().cacheStats).toBeNull();
  });

  it('clears on endSession', () => {
    useSessionStore.getState().setSession(makeSession({ id: 'sess-3' }));
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    expect(useSessionStore.getState().cacheStats).toEqual(CACHE_FIXTURE);
    useSessionStore.getState().endSession();
    expect(useSessionStore.getState().cacheStats).toBeNull();
  });

  it('survives unrelated store mutations (todos, modes, env, iteration)', () => {
    // Regression for the `useSessionStore.cacheStats` field: writing to
    // any of the unrelated slices must NOT clear the cache snapshot.
    // Only `setCacheStats` and the session-lifecycle setters do.
    useSessionStore.getState().setSession(makeSession({ id: 'sess-4' }));
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    const baseline = useSessionStore.getState().cacheStats;
    expect(baseline).toEqual(CACHE_FIXTURE);

    useSessionStore.getState().setTodos([{ id: 't1', content: 'do a thing', status: 'pending' }]);
    useSessionStore.getState().setModes([{ id: 'code', name: 'Code', description: '' }]);
    useSessionStore.getState().setIteration({ index: 1, max: 5 });
    useSessionStore.setState((_prev) => ({
      inputCost: 3,
      outputCost: 15,
      cacheReadCost: 0.3,
      maxContext: 200_000,
      lastInputTokens: 9_000,
    }));

    expect(useSessionStore.getState().cacheStats).toEqual(baseline);
  });

  it('survives an unrelated stats.get reply that updates only the snapshot', () => {
    // The handler writes `cacheStats` on every `stats.get` reply. A
    // second reply that flips the cache off (server now reports
    // `cache: null` because the provider temporarily has no cache
    // prefix) must clear it. A second reply that re-confirms the same
    // snapshot must leave it intact — the shape is stable enough for
    // reference equality.
    useSessionStore.getState().setSession(makeSession({ id: 'sess-5' }));
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);

    // Same snapshot → preserved.
    useSessionStore.getState().setCacheStats({ ...CACHE_FIXTURE });
    expect(useSessionStore.getState().cacheStats).toEqual(CACHE_FIXTURE);

    // Server reports no cache → cleared.
    useSessionStore.getState().setCacheStats(null);
    expect(useSessionStore.getState().cacheStats).toBeNull();

    // A new reading lands → restored.
    useSessionStore.getState().setCacheStats(CACHE_FIXTURE);
    expect(useSessionStore.getState().cacheStats).toEqual(CACHE_FIXTURE);
  });

  it('preserves coverageTokens as supplied (the handler is responsible for capping at lastInputTokens)', () => {
    // The store accepts any `coverageTokens` value — it does not clamp.
    // `handleStatsGet` is the only writer and reads
    // `currentRequest.cacheRead` from the server payload, clamping
    // against `lastInputTokens` before calling `setCacheStats`. This
    // test pins that contract: the store is a dumb mirror; the cap is
    // the handler's job. If a future change moves the clamp into the
    // store, this assertion will need to be revisited.
    const uncapped = { ...CACHE_FIXTURE, coverageTokens: 1_000_000 };
    useSessionStore.setState({ lastInputTokens: 9_000 });
    useSessionStore.getState().setCacheStats(uncapped);
    expect(useSessionStore.getState().cacheStats?.coverageTokens).toBe(1_000_000);
  });
});
