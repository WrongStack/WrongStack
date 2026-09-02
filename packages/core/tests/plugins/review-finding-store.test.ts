/**
 * Tests for the Chimera Finding Store — FS-P0.1 through FS-P0.4.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINDING_DEFAULT_PAGE_SIZE,
  FINDING_IGNORED_RETENTION_MS,
  FINDING_RESOLVED_RETENTION_MS,
  FINDING_STORE_FILE,
  JsonlFindingStore,
  resolveFindingStorePath,
} from '../../src/plugins/review-finding-store.js';
import type { ChimeraFinding } from '../../src/plugins/review-finding-types.js';

let dir: string;
let store: JsonlFindingStore;

function makeFinding(overrides: Partial<ChimeraFinding> = {}): ChimeraFinding {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    fingerprint: `fp-${id}`,
    severity: 'medium',
    source: 'auto',
    title: 'Test finding',
    description: 'A test finding description',
    createdAt: new Date().toISOString(),
    status: 'active',
    originReport: {
      reportId: 'r-1',
      sessionId: 's-1',
      agentId: 'a-1',
      reviewerModel: 'test-model',
    },
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-store-'));
  store = new JsonlFindingStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

// ── Path and constants ─────────────────────────────────────────────

describe('store path', () => {
  it('resolves to the correct file name', () => {
    expect(resolveFindingStorePath(dir)).toBe(path.join(dir, FINDING_STORE_FILE));
  });

  it('JsonlFindingStore exposes storePath', () => {
    expect(store.storePath).toBe(resolveFindingStorePath(dir));
  });
});

describe('store constants', () => {
  it('FINDING_RESOLVED_RETENTION_MS is 30 days', () => {
    expect(FINDING_RESOLVED_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('FINDING_IGNORED_RETENTION_MS is 14 days', () => {
    expect(FINDING_IGNORED_RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
  it('FINDING_DEFAULT_PAGE_SIZE is 50', () => {
    expect(FINDING_DEFAULT_PAGE_SIZE).toBe(50);
  });
});

// ── Upsert ─────────────────────────────────────────────────────────

describe('upsert', () => {
  it('creates new findings', async () => {
    const findings = [makeFinding()];
    const result = await store.upsert(findings, {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    expect(result.created).toBe(1);
    expect(result.relinked).toBe(0);
    expect(result.reopened).toBe(0);
  });

  it('relinks duplicate fingerprints', async () => {
    const f1 = makeFinding({ fingerprint: 'same-fp' });
    await store.upsert([f1], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });

    const f2 = makeFinding({ fingerprint: 'same-fp' });
    const result = await store.upsert([f2], {
      sessionId: 's2',
      reportId: 'r2',
      agentId: 'a2',
      model: 'm1',
    });
    expect(result.created).toBe(0);
    expect(result.relinked).toBe(1);
    expect(result.reopened).toBe(0);
  });

  it('reopens resolved findings with same fingerprint', async () => {
    const f1 = makeFinding({ fingerprint: 'reopen-fp' });
    await store.upsert([f1], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    // Resolve it
    await store.transition(f1.id, 'resolved', { id: 'op', kind: 'operator' }, { outcome: 'fixed' });

    const f2 = makeFinding({ fingerprint: 'reopen-fp' });
    const result = await store.upsert([f2], {
      sessionId: 's2',
      reportId: 'r2',
      agentId: 'a2',
      model: 'm1',
    });
    expect(result.reopened).toBe(1);

    const reopened = await store.get(f1.id);
    expect(reopened?.status).toBe('active');
  });

  it('is idempotent for empty input', async () => {
    const result = await store.upsert([], {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    expect(result.created).toBe(0);
  });

  it('survives multiple upserts', async () => {
    await store.upsert([makeFinding()], {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    await store.upsert([makeFinding()], {
      sessionId: 's1',
      reportId: 'r2',
      agentId: 'a1',
      model: 'm1',
    });
    const all = await store.list();
    expect(all.length).toBe(2);
  });
});

// ── Transition ─────────────────────────────────────────────────────

describe('transition', () => {
  it('transitions from active to triaged', async () => {
    const f = makeFinding();
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    const updated = await store.transition(f.id, 'triaged', { id: 'op', kind: 'operator' });
    expect(updated.status).toBe('triaged');
  });

  it('transitions to resolved with outcome', async () => {
    const f = makeFinding();
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    const updated = await store.transition(
      f.id,
      'resolved',
      { id: 'op', kind: 'operator' },
      { outcome: 'fixed' },
    );
    expect(updated.status).toBe('resolved');
    expect(updated.resolution?.outcome).toBe('fixed');
  });

  it('rejects invalid transitions', async () => {
    const f = makeFinding();
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    await expect(
      store.transition(f.id, 'in_progress', { id: 'op', kind: 'operator' }),
    ).rejects.toThrow('Invalid transition');
  });

  it('rejects resolution without outcome', async () => {
    const f = makeFinding();
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    await expect(
      store.transition(f.id, 'resolved', { id: 'op', kind: 'operator' }),
    ).rejects.toThrow('outcome');
  });

  it('throws for unknown finding', async () => {
    await expect(
      store.transition('no-such-id', 'resolved', { id: 'op', kind: 'operator' }),
    ).rejects.toThrow('not found');
  });
});

// ── List and get ───────────────────────────────────────────────────

describe('list and get', () => {
  it('returns empty list for empty store', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('returns all findings without filters', async () => {
    await store.upsert([makeFinding({ severity: 'critical' }), makeFinding({ severity: 'high' })], {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    const all = await store.list();
    expect(all.length).toBe(2);
  });

  it('filters by severity', async () => {
    await store.upsert(
      [
        makeFinding({ severity: 'critical', fingerprint: 'fp-c' }),
        makeFinding({ severity: 'high', fingerprint: 'fp-h' }),
        makeFinding({ severity: 'low', fingerprint: 'fp-l' }),
      ],
      { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' },
    );
    const critical = await store.list({ severities: ['critical'] });
    expect(critical).toHaveLength(1);
    expect(critical[0]!.severity).toBe('critical');
  });

  it('filters by status', async () => {
    const f = makeFinding({ fingerprint: 'fp-1' });
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    await store.upsert([makeFinding({ fingerprint: 'fp-2' })], {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    await store.transition(f.id, 'resolved', { id: 'op', kind: 'operator' }, { outcome: 'fixed' });
    const resolved = await store.list({ statuses: ['resolved'] });
    expect(resolved).toHaveLength(1);
  });

  it('sorts by severity then age', async () => {
    const oldCritical = makeFinding({
      severity: 'critical',
      fingerprint: 'fp-1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const newHigh = makeFinding({
      severity: 'high',
      fingerprint: 'fp-2',
      createdAt: '2026-06-01T00:00:00Z',
    });
    await store.upsert([newHigh, oldCritical], {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    const all = await store.list();
    expect(all[0]!.severity).toBe('critical');
    expect(all[1]!.severity).toBe('high');
  });

  it('gets by id', async () => {
    const f = makeFinding();
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    const found = await store.get(f.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(f.id);
  });

  it('gets by fingerprint', async () => {
    const f = makeFinding({ fingerprint: 'unique-fp' });
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    const found = await store.get('unique-fp');
    expect(found).not.toBeNull();
  });

  it('returns null for missing finding', async () => {
    expect(await store.get('no-such-id')).toBeNull();
  });
});

// ── getEvents ──────────────────────────────────────────────────────

describe('getEvents', () => {
  it('returns lifecycle events for a finding', async () => {
    const f = makeFinding();
    await store.upsert([f], { sessionId: 's1', reportId: 'r1', agentId: 'a1', model: 'm1' });
    await store.transition(f.id, 'triaged', { id: 'op', kind: 'operator' });
    const events = await store.getEvents(f.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.eventType).toBe('created');
  });

  it('returns empty array for unknown finding', async () => {
    expect(await store.getEvents('no-such')).toEqual([]);
  });
});
