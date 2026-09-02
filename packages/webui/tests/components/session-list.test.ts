import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filterAndSortSessions,
  formatRelative,
  getEmptySessionIds,
  getSessionHistoryStats,
  groupSessionHistory,
} from '../../src/components/SidePanel/SessionList';
import { i18n } from '../../src/i18n';
import type { SessionHistoryEntry } from '../../src/stores';

type SessionEntry = { id: string; tokenTotal: number; isCurrent: boolean };

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 'sess_1',
    tokenTotal: 0,
    isCurrent: false,
    ...overrides,
  };
}

function makeHistoryEntry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    id: 'session-1',
    title: 'Implement history workspace',
    startedAt: '2026-01-15T10:00:00.000Z',
    model: 'claude-sonnet',
    provider: 'anthropic',
    tokenTotal: 1_000,
    isCurrent: false,
    ...overrides,
  };
}

// ── getEmptySessionIds ───────────────────────────────────────────────

describe('getEmptySessionIds', () => {
  it('returns empty array when no entries', () => {
    expect(getEmptySessionIds([])).toEqual([]);
  });

  it('returns empty array when all sessions have tokens', () => {
    const entries: SessionEntry[] = [
      makeEntry({ id: 's1', tokenTotal: 100 }),
      makeEntry({ id: 's2', tokenTotal: 1 }),
    ];
    expect(getEmptySessionIds(entries)).toEqual([]);
  });

  it('returns ID when session has tokenTotal === 0', () => {
    const entries: SessionEntry[] = [makeEntry({ id: 'empty_1', tokenTotal: 0 })];
    expect(getEmptySessionIds(entries)).toEqual(['empty_1']);
  });

  it('returns multiple IDs for multiple empty sessions', () => {
    const entries: SessionEntry[] = [
      makeEntry({ id: 'empty_1', tokenTotal: 0 }),
      makeEntry({ id: 'active', tokenTotal: 0, isCurrent: true }),
      makeEntry({ id: 'empty_2', tokenTotal: 0 }),
      makeEntry({ id: 'non_empty', tokenTotal: 500 }),
    ];
    expect(getEmptySessionIds(entries)).toEqual(['empty_1', 'empty_2']);
  });

  it('excludes the current session even if tokenTotal === 0', () => {
    const entries: SessionEntry[] = [
      makeEntry({ id: 'active', tokenTotal: 0, isCurrent: true }),
      makeEntry({ id: 'empty', tokenTotal: 0 }),
    ];
    expect(getEmptySessionIds(entries)).toEqual(['empty']);
    expect(getEmptySessionIds(entries)).not.toContain('active');
  });

  it('mixed: non-empty non-current + empty non-current + empty current', () => {
    const entries: SessionEntry[] = [
      makeEntry({ id: 'work_done', tokenTotal: 999 }),
      makeEntry({ id: 'truly_empty', tokenTotal: 0 }),
      makeEntry({ id: 'new_session', tokenTotal: 0, isCurrent: true }),
    ];
    expect(getEmptySessionIds(entries)).toEqual(['truly_empty']);
  });
});

// ── formatRelative ───────────────────────────────────────────────────

describe('formatRelative', () => {
  // We freeze Date.now() so tests are deterministic
  const FIXED_NOW = new Date('2026-01-15T12:00:00Z').getTime();
  let getNowStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getNowStub = vi.fn(() => FIXED_NOW);
    vi.spyOn(Date, 'now').mockImplementation(getNowStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty string for invalid ISO', () => {
    expect(formatRelative('not-a-date')).toBe('');
  });

  it('returns "just now" for timestamps < 1 minute ago', () => {
    const recent = new Date(FIXED_NOW - 30_000).toISOString(); // 30s ago
    expect(formatRelative(recent)).toBe(i18n.t('common:time.justNow'));
  });

  // formatRelative is i18n-backed (common:time.*) — assert against the
  // translator's own output so the tests hold in any active UI locale.
  it('returns minutes ago for < 1 hour', () => {
    const fiveMinAgo = new Date(FIXED_NOW - 5 * 60_000).toISOString();
    expect(formatRelative(fiveMinAgo)).toBe(i18n.t('common:time.minutesAgo', { count: 5 }));
  });

  it('returns hours ago for < 1 day', () => {
    const threeHoursAgo = new Date(FIXED_NOW - 3 * 3_600_000).toISOString();
    expect(formatRelative(threeHoursAgo)).toBe(i18n.t('common:time.hoursAgo', { count: 3 }));
  });

  it('returns days ago for < 7 days', () => {
    const twoDaysAgo = new Date(FIXED_NOW - 2 * 86_400_000).toISOString();
    expect(formatRelative(twoDaysAgo)).toBe(i18n.t('common:time.daysAgo', { count: 2 }));
  });

  it('returns locale date string for >= 7 days', () => {
    const tenDaysAgo = new Date(FIXED_NOW - 10 * 86_400_000).toISOString();
    expect(formatRelative(tenDaysAgo)).toBe(new Date(tenDaysAgo).toLocaleDateString());
  });
});

describe('filterAndSortSessions', () => {
  const entries = [
    makeHistoryEntry({
      id: 'active',
      name: 'WebUI redesign',
      startedAt: '2026-01-15T11:00:00.000Z',
      tokenTotal: 500,
      toolCallCount: 3,
      isCurrent: true,
    }),
    makeHistoryEntry({
      id: 'failed',
      title: 'Fix provider fallback',
      startedAt: '2026-01-14T10:00:00.000Z',
      tokenTotal: 5_000,
      toolCallCount: 12,
      toolErrorCount: 2,
      endedAt: '2026-01-14T10:30:00.000Z',
      outcome: 'error',
      toolBreakdown: { bash: 4, read_file: 8 },
    }),
    makeHistoryEntry({
      id: 'done',
      title: 'Kanban polish',
      startedAt: '2026-01-13T10:00:00.000Z',
      endedAt: '2026-01-13T10:30:00.000Z',
      tokenTotal: 2_000,
      toolCallCount: 5,
      outcome: 'completed',
    }),
  ];

  it('searches names, titles, latest requests, providers, models, IDs and tool names', () => {
    const searchable = entries.map((entry) =>
      entry.id === 'failed'
        ? { ...entry, lastUserMessage: 'Investigate stale session recovery' }
        : entry,
    );
    const result = filterAndSortSessions(searchable, {
      query: 'stale session recovery',
      filter: 'all',
      sort: 'recent',
      favoriteIds: [],
    });
    expect(result.map((entry) => entry.id)).toEqual(['failed']);
  });

  it('uses latest activity rather than creation time for recent ordering', () => {
    const result = filterAndSortSessions(
      [
        makeHistoryEntry({ id: 'newer-created', startedAt: '2026-01-15T11:00:00.000Z' }),
        makeHistoryEntry({
          id: 'resumed',
          startedAt: '2026-01-10T11:00:00.000Z',
          lastActivityAt: '2026-01-15T11:30:00.000Z',
        }),
      ],
      { query: '', filter: 'all', sort: 'recent', favoriteIds: [] },
    );
    expect(result.map((entry) => entry.id)).toEqual(['resumed', 'newer-created']);
  });

  it('filters favorites and issues independently', () => {
    const favorites = filterAndSortSessions(entries, {
      query: '',
      filter: 'favorites',
      sort: 'recent',
      favoriteIds: ['done'],
    });
    const issues = filterAndSortSessions(entries, {
      query: '',
      filter: 'issues',
      sort: 'recent',
      favoriteIds: [],
    });
    const completed = filterAndSortSessions(entries, {
      query: '',
      filter: 'completed',
      sort: 'recent',
      favoriteIds: [],
    });
    expect(favorites.map((entry) => entry.id)).toEqual(['done']);
    expect(issues.map((entry) => entry.id)).toEqual(['failed']);
    expect(completed.map((entry) => entry.id)).toEqual(['done']);
  });

  it('sorts by tokens or aggregate activity without mutating source order', () => {
    const byTokens = filterAndSortSessions(entries, {
      query: '',
      filter: 'all',
      sort: 'tokens',
      favoriteIds: [],
    });
    const byActivity = filterAndSortSessions(entries, {
      query: '',
      filter: 'all',
      sort: 'activity',
      favoriteIds: [],
    });
    expect(byTokens.map((entry) => entry.id)).toEqual(['failed', 'done', 'active']);
    expect(byActivity.map((entry) => entry.id)).toEqual(['failed', 'done', 'active']);
    expect(entries.map((entry) => entry.id)).toEqual(['active', 'failed', 'done']);
  });
});

describe('groupSessionHistory', () => {
  it('places pinned rows first and never duplicates them in time buckets', () => {
    const now = new Date(2026, 0, 15, 12).getTime();
    const rows = [
      makeHistoryEntry({ id: 'pinned', startedAt: new Date(2026, 0, 15, 9).toISOString() }),
      makeHistoryEntry({ id: 'today', startedAt: new Date(2026, 0, 15, 8).toISOString() }),
      makeHistoryEntry({ id: 'yesterday', startedAt: new Date(2026, 0, 14, 8).toISOString() }),
      makeHistoryEntry({ id: 'older', startedAt: new Date(2025, 11, 1, 8).toISOString() }),
    ];
    const groups = groupSessionHistory(rows, ['pinned'], now);
    expect(groups.map((group) => group.label)).toEqual([
      'favorites',
      'today',
      'yesterday',
      'earlier',
    ]);
    expect(
      groups.flatMap((group) => group.rows).filter((entry) => entry.id === 'pinned'),
    ).toHaveLength(1);
  });
});

describe('getSessionHistoryStats', () => {
  it('aggregates operational session metrics', () => {
    const stats = getSessionHistoryStats([
      makeHistoryEntry({ isCurrent: true, tokenTotal: 100, toolCallCount: 2, fileChangeCount: 1 }),
      makeHistoryEntry({
        id: 'error',
        tokenTotal: 250,
        toolCallCount: 4,
        fileChangeCount: 3,
        toolErrorCount: 2,
        outcome: 'error',
      }),
    ]);
    expect(stats).toEqual({ sessions: 2, active: 1, tokens: 350, tools: 6, files: 4, errors: 3 });
  });
});
