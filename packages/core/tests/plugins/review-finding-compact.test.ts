/**
 * FS-P0.GATE verification: compaction test.
 *
 * AC8 requires: "Compaction removes findings older than the configured TTL
 * without affecting active findings."
 *
 * Existing store tests cover upsert, transition, list, and getEvents.
 * Compaction is the only untested store operation.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFindingStore } from '../../src/plugins/review-finding-store.js';

let dir: string;
let store: JsonlFindingStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-compact-'));
  store = new JsonlFindingStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const ctx = {
  sessionId: 'compact-test',
  reportId: 'r1',
  agentId: 'test-agent',
  model: 'test-model',
};

describe('FS-P0.GATE — Compaction', () => {
  it('removes old resolved findings', async () => {
    // Create a resolved finding with a very old timestamp
    const old = await store.upsert(
      [
        {
          id: 'old-resolved',
          fingerprint: 'fp-old',
          severity: 'critical' as const,
          source: 'chimera' as const,
          location: { file: 'old.ts', line: 1 },
          title: 'Old resolved',
          description: 'Should be compacted',
          status: 'resolved' as const,
          createdAt: new Date(Date.now() - 40 * 86400_000).toISOString(), // 40 days ago
          originReport: { reportId: 'r-old', sessionId: 's-old', agentId: 'a', reviewerModel: 'm' },
        },
      ],
      ctx,
    );
    expect(old.created).toBe(1);

    // Create an active finding (same age, but active — should be kept)
    const active = await store.upsert(
      [
        {
          id: 'old-active',
          fingerprint: 'fp-active',
          severity: 'high' as const,
          source: 'chimera' as const,
          location: { file: 'active.ts', line: 2 },
          title: 'Old but active',
          description: 'Should survive compaction',
          status: 'active' as const,
          createdAt: new Date(Date.now() - 40 * 86400_000).toISOString(),
          originReport: { reportId: 'r-old', sessionId: 's-old', agentId: 'a', reviewerModel: 'm' },
        },
      ],
      ctx,
    );
    expect(active.created).toBe(1);

    // Compact with a short retention window
    const result = await store.compact({
      resolvedMaxAgeMs: 30 * 86400_000, // 30 days
      ignoredMaxAgeMs: 14 * 86400_000,
    });

    expect(result.removed).toBe(1); // old resolved removed
    expect(result.eventsFolded).toBeGreaterThanOrEqual(0);

    // Active finding survived
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('old-active');
  });

  it('removes old ignored findings', async () => {
    const oldIgnored = await store.upsert(
      [
        {
          id: 'old-ignored',
          fingerprint: 'fp-ignored',
          severity: 'low' as const,
          source: 'chimera' as const,
          location: { file: 'ignored.ts', line: 3 },
          title: 'Old ignored',
          description: 'Should be compacted',
          status: 'ignored' as const,
          createdAt: new Date(Date.now() - 20 * 86400_000).toISOString(), // 20 days ago
          originReport: { reportId: 'r-ign', sessionId: 's-ign', agentId: 'a', reviewerModel: 'm' },
        },
      ],
      ctx,
    );
    expect(oldIgnored.created).toBe(1);

    const result = await store.compact({
      resolvedMaxAgeMs: 30 * 86400_000,
      ignoredMaxAgeMs: 14 * 86400_000, // 14 day TTL — our finding is 20 days old
    });

    expect(result.removed).toBe(1);
    const remaining = await store.list();
    expect(remaining).toHaveLength(0);
  });

  it('keeps active findings regardless of age', async () => {
    const veryOld = await store.upsert(
      [
        {
          id: 'very-old-active',
          fingerprint: 'fp-very-old',
          severity: 'medium' as const,
          source: 'chimera' as const,
          location: { file: 'old.ts', line: 10 },
          title: 'Very old but active',
          description: 'Active findings survive even past TTL',
          status: 'active' as const,
          createdAt: new Date(Date.now() - 100 * 86400_000).toISOString(), // 100 days ago!
          originReport: { reportId: 'r-old', sessionId: 's-old', agentId: 'a', reviewerModel: 'm' },
        },
      ],
      ctx,
    );
    expect(veryOld.created).toBe(1);

    const result = await store.compact({
      resolvedMaxAgeMs: 1, // 1ms TTL — would remove anything eligible
      ignoredMaxAgeMs: 1,
    });

    expect(result.removed).toBe(0); // active findings are never removed
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
  });

  it('compaction is idempotent', async () => {
    await store.upsert(
      [
        {
          id: 'idempotent',
          fingerprint: 'fp-ido',
          severity: 'high' as const,
          source: 'chimera' as const,
          location: { file: 'tmp.ts', line: 1 },
          title: 'Test',
          description: 'Test',
          status: 'resolved' as const,
          createdAt: new Date(Date.now() - 60 * 86400_000).toISOString(),
          originReport: { reportId: 'r', sessionId: 's', agentId: 'a', reviewerModel: 'm' },
        },
      ],
      ctx,
    );

    const r1 = await store.compact({ resolvedMaxAgeMs: 30 * 86400_000 });
    expect(r1.removed).toBe(1);

    const r2 = await store.compact({ resolvedMaxAgeMs: 30 * 86400_000 });
    expect(r2.removed).toBe(0); // already removed
    expect(r2.eventsFolded).toBe(0);
  });
});
