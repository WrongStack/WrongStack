/**
 * TechStack — store round-trips against a REAL in-memory SQLite database.
 *
 * tests/store/sqlite.test.ts mocks node:sqlite, so it can only check the
 * arguments handed to `run`/`get` — every SELECT result there is a value the
 * test stubbed itself, and no SQL text is ever executed. A wrong WHERE clause,
 * a swapped column, a broken CAS guard, or an off-by-one boundary all pass it.
 * This suite writes through the store and reads back through the store, so the
 * SQL is what gets tested. (job-progress-retention.test.ts does the same for
 * progress retention only.)
 *
 * @see packages/techstack/src/store/sqlite.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/store/schema.js';
import { TechStackStore } from '../../src/store/sqlite.js';
import type { Finding, Snapshot, TechStackJob } from '../../src/types.js';

let store: TechStackStore;

beforeEach(() => {
  store = new TechStackStore({ projectSlug: 'roundtrip', dbPath: ':memory:' });
});

afterEach(() => {
  store.close();
});

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap-1',
    projectId: 'proj-1',
    targetRoot: '/project',
    fingerprint: 'fp-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    adapterVersion: '1.0',
    dependencies: [],
    findings: [],
    workspaces: [],
    coverage: 'full',
    ...overrides,
  };
}

function job(overrides: Partial<TechStackJob> = {}): TechStackJob {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    targetRoot: '/project',
    kind: 'inventory',
    status: 'queued',
    fingerprint: 'fp-1',
    requestedBy: 'user',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const FINDING: Finding = {
  id: 'f-1',
  dependencyId: 'dep-1',
  type: 'upgrade',
  severity: 'info',
  action: 'upgrade_minor',
  confidence: 0.9,
  rationale: 'Safe minor upgrade',
  evidence: [],
} as Finding;

describe('snapshots', () => {
  it('getSnapshot returns the NEWEST snapshot of that project only', () => {
    store.saveSnapshot(snapshot({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }));
    store.saveSnapshot(snapshot({ id: 'new', createdAt: '2026-03-01T00:00:00.000Z' }));
    store.saveSnapshot(snapshot({ id: 'mid', createdAt: '2026-02-01T00:00:00.000Z' }));
    // Newer than all of them, but another project's.
    store.saveSnapshot(
      snapshot({ id: 'other', projectId: 'proj-2', createdAt: '2026-12-01T00:00:00.000Z' }),
    );
    expect(store.getSnapshot('proj-1')?.id).toBe('new');
    expect(store.getSnapshot('proj-2')?.id).toBe('other');
    expect(store.getSnapshot('proj-none')).toBeUndefined();
  });

  it('round-trips the whole snapshot object by id', () => {
    const full = snapshot({ id: 'snap-full', coverage: 'partial', fingerprint: 'fp-x' });
    store.saveSnapshot(full);
    expect(store.getSnapshotById('snap-full')).toEqual(full);
    expect(store.getSnapshotById('missing')).toBeUndefined();
  });

  it('saving an existing id replaces it instead of duplicating', () => {
    store.saveSnapshot(snapshot({ id: 'dup', fingerprint: 'before' }));
    store.saveSnapshot(snapshot({ id: 'dup', fingerprint: 'after' }));
    const listed = store.listSnapshots('proj-1');
    expect(listed.map((s) => s.id)).toEqual(['dup']);
    expect(listed[0]?.fingerprint).toBe('after');
  });

  it('listSnapshots is newest-first, project-scoped, and honours the limit', () => {
    for (let month = 1; month <= 5; month++) {
      store.saveSnapshot(
        snapshot({ id: `s${month}`, createdAt: `2026-0${month}-01T00:00:00.000Z` }),
      );
    }
    store.saveSnapshot(snapshot({ id: 'foreign', projectId: 'proj-2' }));
    expect(store.listSnapshots('proj-1').map((s) => s.id)).toEqual(['s5', 's4', 's3', 's2', 's1']);
    expect(store.listSnapshots('proj-1', 2).map((s) => s.id)).toEqual(['s5', 's4']);
  });

  it('deleteSnapshotsBefore is strict (<), project-scoped, and reports the count', () => {
    store.saveSnapshot(snapshot({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }));
    store.saveSnapshot(snapshot({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z' }));
    // Exactly AT the cutoff — must survive a strict "before".
    store.saveSnapshot(snapshot({ id: 'c', createdAt: '2026-03-01T00:00:00.000Z' }));
    store.saveSnapshot(
      snapshot({ id: 'foreign-old', projectId: 'proj-2', createdAt: '2020-01-01T00:00:00.000Z' }),
    );

    expect(store.deleteSnapshotsBefore('proj-1', '2026-03-01T00:00:00.000Z')).toBe(2);
    expect(store.listSnapshots('proj-1').map((s) => s.id)).toEqual(['c']);
    // Another project's older snapshot is untouched.
    expect(store.getSnapshotById('foreign-old')?.id).toBe('foreign-old');
    // Nothing left to delete → 0, not an error.
    expect(store.deleteSnapshotsBefore('proj-1', '2026-03-01T00:00:00.000Z')).toBe(0);
  });
});

describe('jobs', () => {
  it('round-trips a job, mapping absent optionals back to undefined (not null)', () => {
    const minimal = job();
    store.saveJob(minimal);
    const got = store.getJob('job-1');
    // toEqual would treat `sessionId: undefined` and a missing key alike, so
    // additionally pin that no NULL leaks out of the row mapping.
    expect(got).toEqual(minimal);
    expect(got?.sessionId).toBeUndefined();
    expect(got?.completedAt).toBeUndefined();
    expect(got?.error).toBeUndefined();
    expect(got && 'progress' in got).toBe(false);
  });

  it('round-trips every optional field when set', () => {
    const full = job({
      id: 'job-full',
      kind: 'analyze',
      status: 'failed',
      sessionId: 'sess-1',
      completedAt: '2026-07-02T00:00:00.000Z',
      error: 'boom',
      progress: { phase: 'researching', completed: 2, total: 4 },
    });
    store.saveJob(full);
    expect(store.getJob('job-full')).toEqual(full);
  });

  it('updateJobStatus stamps completedAt only for terminal statuses', () => {
    store.saveJob(job({ id: 'j-run' }));
    store.updateJobStatus('j-run', 'discovering');
    expect(store.getJob('j-run')?.completedAt).toBeUndefined();

    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      const id = `j-${terminal}`;
      store.saveJob(job({ id }));
      store.updateJobStatus(id, terminal);
      const got = store.getJob(id);
      expect(got?.status).toBe(terminal);
      expect(got?.completedAt, terminal).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('the schema rejects a status outside the lifecycle', () => {
    store.saveJob(job({ id: 'j-bad' }));
    expect(() => store.updateJobStatus('j-bad', 'exploded' as never)).toThrow(/CHECK/i);
    expect(store.getJob('j-bad')?.status).toBe('queued');
  });

  it('listJobs is newest-first, project-scoped, and honours the limit', () => {
    store.saveJob(job({ id: 'j1', createdAt: '2026-01-01T00:00:00.000Z' }));
    store.saveJob(job({ id: 'j3', createdAt: '2026-03-01T00:00:00.000Z' }));
    store.saveJob(job({ id: 'j2', createdAt: '2026-02-01T00:00:00.000Z' }));
    store.saveJob(job({ id: 'foreign', projectId: 'proj-2' }));
    expect(store.listJobs('proj-1').map((j) => j.id)).toEqual(['j3', 'j2', 'j1']);
    expect(store.listJobs('proj-1', 1).map((j) => j.id)).toEqual(['j3']);
  });
});

describe('outbox', () => {
  it('createOutbox is idempotent per delivery id and starts pending with 0 attempts', () => {
    store.createOutbox('d1', 'r1', 's1');
    // A redelivery attempt with different ids must not overwrite the entry.
    store.createOutbox('d1', 'r-other', 's-other');
    expect(store.listOutboxByStatus('pending')).toEqual([
      {
        deliveryId: 'd1',
        reportId: 'r1',
        sessionId: 's1',
        status: 'pending',
        attempts: 0,
        claimedAt: undefined,
        deliveredAt: undefined,
      },
    ]);
  });

  it('claimOutbox is a compare-and-swap: one winner, owning session only', () => {
    store.createOutbox('d1', 'r1', 's1');
    // Wrong session cannot claim someone else's delivery.
    expect(store.claimOutbox('d1', 's2')).toBe(false);
    expect(store.claimOutbox('d1', 's1')).toBe(true);
    // Already claimed → the second claimer loses.
    expect(store.claimOutbox('d1', 's1')).toBe(false);
    // Unknown delivery → false, not an error.
    expect(store.claimOutbox('nope', 's1')).toBe(false);

    const [claimed] = store.listOutboxByStatus('claimed');
    expect(claimed).toMatchObject({ deliveryId: 'd1', status: 'claimed', attempts: 1 });
    expect(claimed?.claimedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(store.listOutboxByStatus('pending')).toEqual([]);
  });

  it('deliverOutbox and failOutbox move the entry to their own status', () => {
    store.createOutbox('d-ok', 'r1', 's1');
    store.createOutbox('d-bad', 'r2', 's1');
    store.claimOutbox('d-ok', 's1');
    store.claimOutbox('d-bad', 's1');

    store.deliverOutbox('d-ok');
    store.failOutbox('d-bad');

    const [delivered] = store.listOutboxByStatus('delivered');
    expect(delivered?.deliveryId).toBe('d-ok');
    expect(delivered?.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    const [failed] = store.listOutboxByStatus('failed');
    expect(failed?.deliveryId).toBe('d-bad');
    // A failure is not a delivery.
    expect(failed?.deliveredAt).toBeUndefined();
    expect(store.listOutboxByStatus('claimed')).toEqual([]);
  });

  it('a failed delivery cannot be re-claimed', () => {
    store.createOutbox('d1', 'r1', 's1');
    store.failOutbox('d1');
    expect(store.claimOutbox('d1', 's1')).toBe(false);
  });
});

describe('research cache', () => {
  it('round-trips findings and upserts on the same key', () => {
    store.setCachedResearch('k1', [FINDING]);
    expect(store.getCachedResearch('k1')).toEqual([FINDING]);

    const replaced = { ...FINDING, id: 'f-2', rationale: 'replaced' } as Finding;
    store.setCachedResearch('k1', [replaced]);
    expect(store.getCachedResearch('k1')).toEqual([replaced]);
    expect(store.getCachedResearch('missing')).toBeNull();
  });

  it('an expired entry reads as null AND is deleted on read', () => {
    // ttl 0 → expires_at == now, and the check is `<=`, so it is already stale.
    store.setCachedResearch('stale', [FINDING], 0);
    expect(cacheKeys()).toEqual(['stale']);
    expect(store.getCachedResearch('stale')).toBeNull();
    // Reading null alone cannot tell "deleted" from "hidden"; look at the table.
    expect(cacheKeys()).toEqual([]);
  });

  it('pruneExpiredResearchCache removes expired entries and keeps live ones', () => {
    store.setCachedResearch('expired-a', [FINDING], -1000);
    store.setCachedResearch('expired-b', [FINDING], -1);
    store.setCachedResearch('live', [FINDING], 60_000);
    // Prune is the only thing touching the table here — no reads beforehand,
    // since a read of an expired key would delete it and mask a broken prune.
    store.pruneExpiredResearchCache();
    expect(cacheKeys()).toEqual(['live']);
    expect(store.getCachedResearch('live')).toEqual([FINDING]);
  });
});

describe('lifecycle', () => {
  it('close() is idempotent against a real handle (a second close does not throw)', () => {
    const local = new TechStackStore({ projectSlug: 'lifecycle', dbPath: ':memory:' });
    local.close();
    // A raw DatabaseSync throws "database is not open" here; the store swallows it.
    expect(() => local.close()).not.toThrow();
  });

  it('reopening a file store keeps its data and one schema-version row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'techstack-reopen-'));
    const dbPath = join(dir, 'nested', 'techstack.db');
    try {
      // The parent directory does not exist yet — the store must create it.
      const first = new TechStackStore({ projectSlug: 'reopen', dbPath });
      first.saveJob(job({ id: 'persisted' }));
      first.close();

      const second = new TechStackStore({ projectSlug: 'reopen', dbPath });
      try {
        expect(second.getJob('persisted')?.id).toBe('persisted');
        const versions = dbOf(second)
          .prepare('SELECT version FROM techstack_schema_version')
          .all() as Array<{ version: number }>;
        expect(versions).toEqual([{ version: SCHEMA_VERSION }]);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema migration', () => {
  it('upgrades a v1 database (jobs without depth/model) so saveJob no longer throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'techstack-migrate-'));
    const dbPath = join(dir, 'techstack.db');
    try {
      // Build a legacy v1 database: the v1 `jobs` table has no depth/model.
      const Database = loadRuntimeDatabaseSync();
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE techstack_schema_version (version INTEGER NOT NULL);
        INSERT INTO techstack_schema_version (version) VALUES (1);
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          target_root TEXT NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          fingerprint TEXT NOT NULL DEFAULT '',
          requested_by TEXT NOT NULL DEFAULT '',
          session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          error TEXT,
          progress_json TEXT
        );
      `);
      raw.close();

      // Opening the store must backfill the missing columns. Before the
      // migration this succeeded while saveJob threw "no such column: depth".
      const upgraded = new TechStackStore({ projectSlug: 'migrate', dbPath });
      try {
        expect(() =>
          upgraded.saveJob(job({ id: 'migrated', depth: 'full', model: 'claude-x' })),
        ).not.toThrow();
        const loaded = upgraded.getJob('migrated');
        expect(loaded?.depth).toBe('full');
        expect(loaded?.model).toBe('claude-x');
        const versions = dbOf(upgraded)
          .prepare('SELECT version FROM techstack_schema_version')
          .all() as Array<{ version: number }>;
        expect(versions).toEqual([{ version: SCHEMA_VERSION }]);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The store's private handle — for asserting on table state the API cannot show. */
function dbOf(s: TechStackStore): DatabaseSync {
  return (s as unknown as { db: DatabaseSync }).db;
}

function cacheKeys(): string[] {
  return (
    dbOf(store).prepare('SELECT cache_key FROM research_cache ORDER BY cache_key').all() as Array<{
      cache_key: string;
    }>
  ).map((r) => r.cache_key);
}
