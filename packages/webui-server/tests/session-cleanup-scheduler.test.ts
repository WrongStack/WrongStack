import type { SessionStore } from '@wrongstack/core/types';
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
}) {
  const ids = options.ids ?? [];
  const store = {
    list: vi.fn(async () =>
      ids.map((id) => ({
        id,
        title: id,
        startedAt: '2026-01-01T00:00:00.000Z',
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
    const scheduled = scheduleOwnerlessEmptySessionCleanup(fixture.ctx, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.store.list).toHaveBeenCalledTimes(1);

    scheduled.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.store.list).toHaveBeenCalledTimes(1);
  });
});
