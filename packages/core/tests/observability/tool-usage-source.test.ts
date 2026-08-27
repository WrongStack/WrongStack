/**
 * Tests for the hybrid `ToolUsageSource` resolver + `filterUnderused`
 * policy. The source prefers Chronicle when available; falls back to the
 * in-process bridge Map when Chronicle is missing. The policy layer
 * (filterUnderused) is pure and deterministic — exercised here in
 * isolation so the slash command / boot seam can rely on it.
 */

import { describe, expect, it } from 'vitest';
import type { ToolUsageRecord } from '../../src/observability/event-bridge.js';
import {
  createToolUsageSource,
  filterUnderused,
  type UnderusedToolCandidate,
} from '../../src/observability/tool-usage-source.js';

describe('createToolUsageSource', () => {
  it('returns chronicle source when chronicle is provided', () => {
    const source = createToolUsageSource({
      chronicle: {
        underusedTools: () => [],
      } as never,
    });
    expect(source.kind).toBe('chronicle');
  });

  it('falls back to in-process when chronicle is missing', () => {
    const source = createToolUsageSource({ bridge: new Map() });
    expect(source.kind).toBe('in-process');
  });

  it('returns empty source when neither backend is available', async () => {
    const source = createToolUsageSource({});
    const candidates = await source.candidates({ idleDays: 30, minInvocations: 0 });
    expect(candidates).toEqual([]);
  });

  it('in-process source only reports tools older than idleDays', async () => {
    const now = Date.parse('2026-07-15T00:00:00.000Z');
    const day = 86_400_000;
    const bridge = new Map<string, ToolUsageRecord>([
      [
        'fresh',
        {
          invocations: 100,
          failures: 0,
          durationMsTotal: 1000,
          lastInvokedAt: now - 1 * day,
          firstInvokedAt: now - 1 * day,
        },
      ],
      [
        'stale',
        {
          invocations: 1,
          failures: 0,
          durationMsTotal: 5,
          lastInvokedAt: now - 60 * day,
          firstInvokedAt: now - 60 * day,
        },
      ],
    ]);
    const source = createToolUsageSource({ bridge, now: () => now });
    const candidates = await source.candidates({ idleDays: 30, minInvocations: 3 });
    // `stale` qualifies (1 invocation, 60 days old); `fresh` does not.
    expect(candidates.map((c) => c.name).sort()).toEqual(['stale']);
  });

  it('in-process source attaches source: "in-process" to every row', async () => {
    const now = Date.parse('2026-07-15T00:00:00.000Z');
    const day = 86_400_000;
    const bridge = new Map<string, ToolUsageRecord>([
      [
        'old',
        {
          invocations: 0,
          failures: 0,
          durationMsTotal: 0,
          lastInvokedAt: now - 60 * day,
          firstInvokedAt: now - 60 * day,
        },
      ],
    ]);
    const source = createToolUsageSource({ bridge, now: () => now });
    const candidates = await source.candidates({ idleDays: 30, minInvocations: 0 });
    expect(candidates[0]?.source).toBe('in-process');
  });
});

describe('filterUnderused', () => {
  const baseCandidate: UnderusedToolCandidate = {
    name: 'read',
    invocations: 2,
    failures: 0,
    durationMsTotal: 10,
    lastInvokedAt: Date.parse('2026-06-15T00:00:00.000Z'),
    daysSinceLastUse: 30,
    source: 'chronicle',
  };

  it('drops tools above the invocations threshold', () => {
    const out = filterUnderused([{ ...baseCandidate, invocations: 100 }], {
      idleDays: 30,
      minInvocations: 3,
    });
    expect(out).toHaveLength(0);
  });

  it('drops tools invoked inside the idle window', () => {
    const recent = Date.now() - 86_400_000; // 1 day ago
    const out = filterUnderused([{ ...baseCandidate, lastInvokedAt: recent }], {
      idleDays: 30,
      minInvocations: 3,
    });
    expect(out).toHaveLength(0);
  });

  it('keeps tools at or below the threshold AND older than the window', () => {
    const out = filterUnderused([baseCandidate], { idleDays: 30, minInvocations: 3 });
    expect(out).toHaveLength(1);
  });

  it('keeps tools with null lastInvokedAt (never observed in window)', () => {
    // Anchor `now` explicitly so the candidate's missing timestamp is
    // treated as "never observed" and kept.
    const now = Date.parse('2026-07-15T00:00:00.000Z');
    const out = filterUnderused(
      [{ ...baseCandidate, invocations: 0, lastInvokedAt: null }],
      { idleDays: 30, minInvocations: 0 },
      now,
    );
    expect(out).toHaveLength(1);
  });

  it('respects the now anchor for deterministic boundary tests', () => {
    const now = Date.parse('2026-07-15T00:00:00.000Z');
    const exactly31DaysAgo = now - 31 * 86_400_000;
    const out = filterUnderused(
      [{ ...baseCandidate, invocations: 0, lastInvokedAt: exactly31DaysAgo }],
      { idleDays: 30, minInvocations: 0 },
      now,
    );
    expect(out).toHaveLength(1);
  });

  it('drops tools invoked within the idle window under an explicit now anchor', () => {
    const now = Date.parse('2026-07-15T00:00:00.000Z');
    const oneDayAgo = now - 86_400_000;
    const out = filterUnderused(
      [{ ...baseCandidate, invocations: 0, lastInvokedAt: oneDayAgo }],
      { idleDays: 30, minInvocations: 0 },
      now,
    );
    expect(out).toHaveLength(0);
  });
});
