import type { SessionStore } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupOwnerlessEmptySessions,
  DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS,
  resolveEmptySessionCleanupInterval,
  scheduleOwnerlessEmptySessionCleanup,
} from '../src/server/session-cleanup-scheduler.js';

function sessionData(messageCount: number) {
  return {
    metadata: { id: 'candidate', startedAt: '2026-01-01T00:00:00.000Z' },
    events: [],
    messages: Array.from({ length: messageCount }, () => ({ role: 'user', content: 'content' })),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCallEnds: [],
  };
}

function context(options: {
  ids?: string[];
  activeId?: string;
  participants?: string[];
  messageCounts?: Record<string, number>;
  startedAt?: Record<string, string>;
}) {
  const ids = options.ids ?? [];
  const store = {
    list: vi.fn(async () =>
      ids.map((id) => ({
        id,
        title: id,
        startedAt: options.startedAt?.[id] ?? '2026-01-01T00:00:00.000Z',
        model: 'test',
        provider: 'test',
        tokenTotal: 0,
      })),
    ),
    load: vi.fn(async (id: string) => sessionData(options.messageCounts?.[id] ?? 0)),
    isEmpty: vi.fn(async (id: string) => (options.messageCounts?.[id] ?? 0) === 0),
    delete: vi.fn(async () => undefined),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const refreshSessions = vi.fn(async () => undefined);
  return {
    ctx: {
      getActiveSessionId: () => options.activeId ?? 'active',
      getSessionStore: () => store as unknown as SessionStore,
      hasParticipants: (id: string) => options.participants?.includes(id) ?? false,
      refreshSessions,
      logger,
    },
    store,
    logger,
    refreshSessions,
  };
}

afterEach(() => vi.useRealTimers());

describe('ownerless empty session cleanup', () => {
  it('deletes only ownerless sessions with no reconstructed messages', async () => {
    const fixture = context({
      ids: ['active', 'participant', 'non-empty', 'empty'],
      activeId: 'active',
      participants: ['participant'],
      messageCounts: { 'non-empty': 1 },
    });

    await expect(cleanupOwnerlessEmptySessions(fixture.ctx)).resolves.toEqual({
      deleted: 1,
      errors: 0,
    });

    expect(fixture.store.isEmpty).toHaveBeenCalledTimes(2);
    expect(fixture.store.isEmpty).toHaveBeenCalledWith('non-empty');
    expect(fixture.store.isEmpty).toHaveBeenCalledWith('empty');
    expect(fixture.store.delete).toHaveBeenCalledTimes(1);
    expect(fixture.store.delete).toHaveBeenCalledWith('empty');
    expect(fixture.refreshSessions).toHaveBeenCalledTimes(1);
    expect(fixture.logger.info).toHaveBeenLastCalledWith(
      'Empty session cleanup completed',
      expect.objectContaining({ deleted: 1, errors: 0 }),
    );
  });

  it('logs a per-session error and continues when the canonical delete flow refuses', async () => {
    const fixture = context({ ids: ['first', 'second'] });
    fixture.store.delete.mockRejectedValueOnce(new Error('Session first is live'));

    await expect(cleanupOwnerlessEmptySessions(fixture.ctx)).resolves.toEqual({
      deleted: 1,
      errors: 1,
    });

    expect(fixture.store.delete).toHaveBeenCalledTimes(2);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      'Empty session cleanup failed for session',
      expect.objectContaining({ sessionId: 'first', message: 'Session first is live' }),
    );
  });

  it('skips sessions the catalog refuses with an ownership conflict without logging an error', async () => {
    const fixture = context({ ids: ['held', 'free'] });
    const conflict = new Error('Session held is live');
    conflict.name = 'SessionOwnershipConflictError';
    fixture.store.delete.mockRejectedValueOnce(conflict);

    await expect(cleanupOwnerlessEmptySessions(fixture.ctx)).resolves.toEqual({
      deleted: 1,
      errors: 0,
    });

    expect(fixture.store.delete).toHaveBeenCalledTimes(2);
    expect(fixture.logger.error).not.toHaveBeenCalled();
  });

  it('uses the default interval for missing or invalid environment values', () => {
    expect(resolveEmptySessionCleanupInterval(undefined)).toBe(
      DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS,
    );
    expect(resolveEmptySessionCleanupInterval('invalid')).toBe(
      DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS,
    );
    expect(resolveEmptySessionCleanupInterval('999')).toBe(
      DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS,
    );
    expect(resolveEmptySessionCleanupInterval('2500')).toBe(2_500);
  });

  it('runs on the configured interval without overlapping and can be disposed', async () => {
    vi.useFakeTimers();
    const fixture = context({ ids: [] });
    // Hold the first sweep open across the first interval tick: the startup
    // sweep and the tick coincide for a 1s interval, and the in-flight guard
    // must collapse them into ONE sweep instead of running a second.
    let releaseFirstSweep: (() => void) | undefined;
    fixture.store.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstSweep = () => resolve([]);
        }),
    );
    const scheduled = scheduleOwnerlessEmptySessionCleanup(fixture.ctx, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.store.list).toHaveBeenCalledTimes(1);

    releaseFirstSweep?.();
    await vi.advanceTimersByTimeAsync(0);

    scheduled.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.store.list).toHaveBeenCalledTimes(1);
  });

  it('sweeps once shortly after startup, before the first interval tick', async () => {
    vi.useFakeTimers();
    // Leftovers of previous short host runs: ownerless and strictly empty.
    const fixture = context({ ids: ['active', 'stale'] });
    // Default 60-minute interval — a host run that lives shorter than that
    // (open the UI, look, close) must still perform one sweep shortly after
    // boot, or the sessions its predecessors abandoned are never cleaned.
    const scheduled = scheduleOwnerlessEmptySessionCleanup(fixture.ctx);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.store.delete).toHaveBeenCalledWith('stale');
    expect(fixture.store.delete).not.toHaveBeenCalledWith('active');

    scheduled.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.store.delete).toHaveBeenCalledTimes(1);
  });

  it('skips candidates younger than minIdleMs or with an unparseable date, sweeping only idle empties', async () => {
    const now = Date.now();
    const fixture = context({
      ids: ['fresh', 'idle', 'bad-date'],
      startedAt: {
        fresh: new Date(now - 60_000).toISOString(),
        idle: new Date(now - 15 * 60_000).toISOString(),
        'bad-date': 'not-a-date',
      },
    });

    // A just-created session may not be declared anywhere yet (another
    // surface's brand-new tab, a boot session mid-startup); an unparseable
    // date must fail closed. Only provably idle empties are swept.
    await expect(
      cleanupOwnerlessEmptySessions({ ...fixture.ctx, minIdleMs: 10 * 60_000 }),
    ).resolves.toEqual({ deleted: 1, errors: 0 });

    expect(fixture.store.delete).toHaveBeenCalledTimes(1);
    expect(fixture.store.delete).toHaveBeenCalledWith('idle');
    expect(fixture.store.delete).not.toHaveBeenCalledWith('fresh');
    expect(fixture.store.delete).not.toHaveBeenCalledWith('bad-date');
  });

  it('protects sessions other live hosts hold, via extra protected ids', async () => {
    const fixture = context({ ids: ['held-by-webui', 'free'] });

    await expect(
      cleanupOwnerlessEmptySessions({
        ...fixture.ctx,
        getExtraProtectedSessionIds: async () => ['held-by-webui'],
      }),
    ).resolves.toEqual({ deleted: 1, errors: 0 });

    expect(fixture.store.delete).toHaveBeenCalledTimes(1);
    expect(fixture.store.delete).not.toHaveBeenCalledWith('held-by-webui');
    expect(fixture.store.delete).toHaveBeenCalledWith('free');
  });

  it('fails closed and never leaks unhandled rejections when getExtraProtectedSessionIds rejects (F200)', async () => {
    const fixture = context({ ids: ['free'] });

    await expect(
      cleanupOwnerlessEmptySessions({
        ...fixture.ctx,
        getExtraProtectedSessionIds: async () => {
          throw new Error('registry unavailable');
        },
      }),
    ).resolves.toEqual({ deleted: 0, errors: 1 });
    expect(fixture.store.delete).not.toHaveBeenCalled();
  });
});
