import { describe, it, expect, vi } from 'vitest';
import { sanitizeModel, generateSessionId } from '../../src/storage/session-id.js';
import { sessionContentText, userInputTitle } from '../../src/storage/session-helpers.js';
import { mapWithConcurrency } from '../../src/storage/storage-concurrency.js';
import {
  compareSessionSummaries,
  matchesSessionFilter,
} from '../../src/storage/session-summary.js';
import { resolveMaxSpawnDepth, HARD_MAX_SPAWN_DEPTH } from '../../src/coordination/spawn-budget.js';
import { NETWORK_ERR_RE } from '../../src/execution/regex-patterns.js';
import type { SessionSummary } from '../../src/types/session.js';
import type { ContentBlock } from '../../src/types/blocks.js';

// ── session-id ──────────────────────────────────────────────────────────

describe('sanitizeModel', () => {
  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(sanitizeModel('gpt-4 turbo!')).toBe('gpt-4-turbo');
  });
  it('collapses multiple hyphens', () => {
    expect(sanitizeModel('a---b')).toBe('a-b');
  });
  it('trims leading/trailing hyphens', () => {
    expect(sanitizeModel('--abc--')).toBe('abc');
  });
  it('caps at 40 chars', () => {
    expect(sanitizeModel('a'.repeat(50)).length).toBe(40);
  });
});

describe('generateSessionId', () => {
  it('produces YYYY-MM-DD/sess_ format', () => {
    const id = generateSessionId('2026-06-06T10:00:00Z');
    expect(id.startsWith('2026-06-06/sess_')).toBe(true);
    expect(id.length).toBeGreaterThan(20);
  });
  it('ignores the _model parameter (legacy compatibility)', () => {
    const id1 = generateSessionId('2026-06-06T10:00:00Z');
    const id2 = generateSessionId('2026-06-06T10:00:00Z', 'gpt-4');
    expect(id1.slice(0, 10)).toBe(id2.slice(0, 10));
  });
  it('falls back to Date.now() on invalid date', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-30T12:34:56.000Z'));
      const id = generateSessionId('not-a-date');
      expect(id.startsWith('2026-08-30/sess_')).toBe(true);
      expect(id).toMatch(/^2026-08-30\/sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── session-helpers ─────────────────────────────────────────────────────

describe('userInputTitle', () => {
  it('extracts text from a string', () => {
    expect(userInputTitle('Hello world')).toBe('Hello world');
  });
  it('extracts text from content blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ];
    expect(userInputTitle(blocks)).toBe('Part 1 Part 2');
  });
  it('filters non-text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Keep' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ];
    expect(userInputTitle(blocks)).toBe('Keep');
  });
  it('returns fallback for empty content', () => {
    expect(userInputTitle('')).toBe('(non-text input)');
    expect(userInputTitle([])).toBe('(non-text input)');
  });
  it('caps at 60 chars', () => {
    expect(userInputTitle('a'.repeat(100)).length).toBe(60);
  });
  it('removes terminal control sequences and normalizes whitespace', () => {
    const unsafe = '\u001b]0;forged title\u0007  safe\n\u001b[31mred\u001b[0m\u009b2J';
    expect(sessionContentText(unsafe)).toBe('safe red');
    expect(userInputTitle(unsafe)).toBe('safe red');
  });
});

// ── storage-concurrency ─────────────────────────────────────────────────

describe('mapWithConcurrency', () => {
  it('maps all items preserving order', async () => {
    const result = await mapWithConcurrency([1, 2, 3], 2, async (n) => n * 2);
    expect(result).toEqual([2, 4, 6]);
  });
  it('returns empty for empty input', async () => {
    const result = await mapWithConcurrency([], 2, async (n) => n);
    expect(result).toEqual([]);
  });
  it('handles concurrency of 1 (sequential)', async () => {
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(n);
      return n;
    });
    expect(order).toEqual([1, 2, 3]);
  });
  it('clamps concurrency to at least 1', async () => {
    const result = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(result).toEqual([1, 2]);
  });
});

// ── session-summary ─────────────────────────────────────────────────────

describe('compareSessionSummaries', () => {
  const mk = (startedAt: string, id = 's1'): SessionSummary =>
    ({ id, startedAt, tokenTotal: 0, title: 't', provider: 'p', model: 'm', providerName: 'pn', modelName: 'mn' }) as SessionSummary;

  it('sorts newest first', () => {
    expect(compareSessionSummaries(mk('2026-01-02'), mk('2026-01-01'))).toBe(-1);
  });
  it('sorts oldest last', () => {
    expect(compareSessionSummaries(mk('2026-01-01'), mk('2026-01-02'))).toBe(1);
  });
  it('breaks ties by id ascending', () => {
    expect(compareSessionSummaries(mk('2026-01-01', 'a'), mk('2026-01-01', 'b'))).toBe(-1);
    expect(compareSessionSummaries(mk('2026-01-01', 'b'), mk('2026-01-01', 'a'))).toBe(1);
  });
});

describe('matchesSessionFilter', () => {
  const mk = (overrides: Partial<SessionSummary> = {}): SessionSummary =>
    ({ id: 's1', startedAt: '2026-06-06T10:00:00Z', tokenTotal: 1000, title: 'Test Session', provider: 'anthropic', model: 'claude-3', providerName: 'pn', modelName: 'mn', ...overrides }) as SessionSummary;

  it('passes when no criteria given', () => {
    expect(matchesSessionFilter(mk(), {})).toBe(true);
  });
  it('filters by since', () => {
    expect(matchesSessionFilter(mk(), { since: '2026-06-07' })).toBe(false);
    expect(matchesSessionFilter(mk(), { since: '2026-06-05' })).toBe(true);
  });
  it('filters by until', () => {
    expect(matchesSessionFilter(mk(), { until: '2026-06-05' })).toBe(false);
    expect(matchesSessionFilter(mk(), { until: '2026-06-07' })).toBe(true);
  });
  it('filters by provider', () => {
    expect(matchesSessionFilter(mk(), { provider: 'openai' })).toBe(false);
    expect(matchesSessionFilter(mk(), { provider: 'anthropic' })).toBe(true);
  });
  it('filters by model', () => {
    expect(matchesSessionFilter(mk(), { model: 'gpt-4' })).toBe(false);
    expect(matchesSessionFilter(mk(), { model: 'claude-3' })).toBe(true);
  });
  it('filters by minTokens', () => {
    expect(matchesSessionFilter(mk(), { minTokens: 1001 })).toBe(false);
    expect(matchesSessionFilter(mk(), { minTokens: 999 })).toBe(true);
  });
  it('filters by titleContains (case-insensitive)', () => {
    expect(matchesSessionFilter(mk(), { titleContains: 'test' })).toBe(true);
    expect(matchesSessionFilter(mk(), { titleContains: 'nonexistent' })).toBe(false);
  });
});

// ── spawn-budget ────────────────────────────────────────────────────────

describe('resolveMaxSpawnDepth', () => {
  it('returns HARD_MAX_SPAWN_DEPTH for undefined', () => {
    expect(resolveMaxSpawnDepth(undefined)).toBe(HARD_MAX_SPAWN_DEPTH);
  });
  it('returns HARD_MAX_SPAWN_DEPTH for NaN/Infinity', () => {
    expect(resolveMaxSpawnDepth(NaN)).toBe(HARD_MAX_SPAWN_DEPTH);
    expect(resolveMaxSpawnDepth(Infinity)).toBe(HARD_MAX_SPAWN_DEPTH);
  });
  it('clamps to [0, HARD_MAX_SPAWN_DEPTH]', () => {
    expect(resolveMaxSpawnDepth(-1)).toBe(0);
    expect(resolveMaxSpawnDepth(100)).toBe(HARD_MAX_SPAWN_DEPTH);
  });
  it('floors decimals', () => {
    expect(resolveMaxSpawnDepth(1.9)).toBe(1);
  });
});

// ── regex-patterns ──────────────────────────────────────────────────────

describe('NETWORK_ERR_RE', () => {
  it('matches ECONNREFUSED', () => {
    expect(NETWORK_ERR_RE.test('Error: ECONNREFUSED')).toBe(true);
  });
  it('matches ETIMEDOUT', () => {
    expect(NETWORK_ERR_RE.test('ETIMEDOUT connection')).toBe(true);
  });
  it('matches fetch failed', () => {
    expect(NETWORK_ERR_RE.test('fetch failed')).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(NETWORK_ERR_RE.test('TypeError: invalid')).toBe(false);
  });
});
