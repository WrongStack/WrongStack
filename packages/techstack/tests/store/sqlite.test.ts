/**
 * TechStack — SQLite store tests.
 *
 * Tests TechStackStore: constructor, snapshot CRUD, job CRUD, outbox operations.
 * Mocks node:sqlite, node:fs, and @wrongstack/core/utils.
 *
 * @see packages/techstack/src/store/sqlite.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync } from 'node:fs';
import { SageCachePragmas } from '@wrongstack/core/utils';

// ── Mock node:fs ─────────────────────────────────────────────────────────

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

// ── Mock @wrongstack/core/utils ─────────────────────────────────────────

vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    wstackGlobalRoot: vi.fn(() => '/fake/home/.wrongstack'),
  };
});

// ── Factory: mock statement ──────────────────────────────────────────────

interface MockStatement {
  run: ReturnType<typeof vi.fn<(...params: unknown[]) => { changes: number }>>;
  get: ReturnType<typeof vi.fn<(...params: unknown[]) => Record<string, unknown> | undefined>>;
  all: ReturnType<typeof vi.fn<(...params: unknown[]) => Record<string, unknown>[]>>;
}

function mockStatement(): MockStatement {
  return {
    run: vi.fn<(...params: unknown[]) => { changes: number }>(() => ({ changes: 1 })),
    get: vi.fn<(...params: unknown[]) => Record<string, unknown> | undefined>(() => undefined),
    all: vi.fn<(...params: unknown[]) => Record<string, unknown>[]>(() => []),
  };
}

// ── Mock node:sqlite ─────────────────────────────────────────────────────

interface MockDb {
  exec: ReturnType<typeof vi.fn<(sql: string) => void>>;
  prepare: ReturnType<typeof vi.fn<(sql: string) => MockStatement>>;
  close: ReturnType<typeof vi.fn<() => void>>;
}

function createMockDb(): MockDb {
  return {
    exec: vi.fn<(sql: string) => void>(),
    prepare: vi.fn<(sql: string) => MockStatement>(() => mockStatement()),
    close: vi.fn<() => void>(),
  };
}

vi.mock('node:module', () => ({
  createRequire: () => (id: string) => {
    if (id === 'node:sqlite') {
      return {
        DatabaseSync: class FakeDatabaseSync {
          constructor(_path: string) {
            const db = createMockDb();
            Object.assign(this, db);
          }
        },
      };
    }
    throw new Error(`Mock require not implemented: ${id}`);
  },
}));

vi.mock('../../src/store/schema.js', () => ({
  applySchema: vi.fn(),
  DDL: 'CREATE TABLE mock;',
  SCHEMA_VERSION: 1,
}));

import { TechStackStore } from '../../src/store/sqlite.js';
import { applySchema } from '../../src/store/schema.js';
import type { Snapshot, TechStackJob, DeliveryStatus } from '../../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const FAKE_NOW = '2026-07-26T12:00:00.000Z';

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap-1',
    projectId: 'proj-1',
    targetRoot: '/project',
    fingerprint: 'abc123',
    createdAt: FAKE_NOW,
    adapterVersion: '1.0',
    dependencies: [],
    findings: [],
    workspaces: [],
    coverage: 'full',
    ...overrides,
  };
}

function makeJob(overrides: Partial<TechStackJob> = {}): TechStackJob {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    targetRoot: '/project',
    kind: 'inventory',
    status: 'queued',
    fingerprint: 'def456',
    requestedBy: 'user',
    createdAt: FAKE_NOW,
    ...overrides,
  };
}

/** Helper: get a prepared statement that matches a partial SQL pattern. */
function findStatement(sqlFragment: string): ReturnType<typeof mockStatement> | undefined {
  const store = lastStore!;
  const db = (store as unknown as { db: MockDb }).db;
  const mock = vi.mocked(db.prepare);
  for (const result of mock.mock.results) {
    if (result.type === 'return') {
      // Check the matching call's argument
      const callIndex = mock.mock.results.indexOf(result);
      const sql = mock.mock.calls[callIndex]?.[0];
      if (typeof sql === 'string' && sql.includes(sqlFragment)) {
        return result.value as ReturnType<typeof mockStatement>;
      }
    }
  }
  return undefined;
}

let lastStore: TechStackStore | undefined;

describe('TechStackStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FAKE_NOW));
    vi.mocked(existsSync).mockReturnValue(true);

    lastStore = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      lastStore?.close();
    } catch {
      /* ignore */
    }
  });

  // ── Constructor ─────────────────────────────────────────────────────────

  it('creates directory when it does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const newStore = new TechStackStore({ projectSlug: 'new-proj', dbPath: '/tmp/test.db' });
    expect(mkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
    newStore.close();
  });

  it('does not create directory when it already exists', () => {
    const newStore = new TechStackStore({ projectSlug: 'exists-proj', dbPath: '/tmp/exists.db' });
    expect(mkdirSync).not.toHaveBeenCalled();
    newStore.close();
  });

  it('applies schema on construction', () => {
    expect(applySchema).toHaveBeenCalled();
  });

  it('runs pragma statements on construction', () => {
    const db = (lastStore as unknown as { db: MockDb }).db;
    // cache_size / mmap_size come from the shared perf profile rather than
    // being hardcoded — they used to be pinned at 32 MiB / 128 MiB here, which
    // is exactly why WRONGSTACK_PERF_PROFILE=frugal had no effect on this store.
    const cache = SageCachePragmas();
    const pragmas = [
      'PRAGMA journal_mode = WAL;',
      'PRAGMA synchronous = NORMAL;',
      'PRAGMA busy_timeout = 10000;',
      'PRAGMA temp_store = MEMORY;',
      `PRAGMA cache_size = -${cache.cacheSizeKiB};`,
      `PRAGMA mmap_size = ${cache.mmapBytes};`,
      'PRAGMA foreign_keys = ON;',
    ];
    for (const pragma of pragmas) {
      expect(db.exec).toHaveBeenCalledWith(pragma);
    }
  });

  it('sizes its page cache from the perf profile, not a hardcoded constant', () => {
    const db = (lastStore as unknown as { db: MockDb }).db;
    const execCalls = db.exec.mock.calls.map(([sql]: [string]) => sql);
    const cachePragma = execCalls.find((sql: string) => sql.startsWith('PRAGMA cache_size'));
    expect(cachePragma).toBeDefined();
    // The old hardcoded value must not reappear unless the profile says so.
    if (SageCachePragmas().cacheSizeKiB !== 32_768) {
      expect(cachePragma).not.toBe('PRAGMA cache_size = -32768;');
    }
  });

  // ── path getter ─────────────────────────────────────────────────────────

  it('exposes the database path', () => {
    expect(lastStore!.path).toBe(':memory:');
  });

  // ── close ───────────────────────────────────────────────────────────────

  it('closes the database connection', () => {
    const db = (lastStore as unknown as { db: MockDb }).db;
    lastStore!.close();
    expect(db.close).toHaveBeenCalled();
  });

  it('close is idempotent', () => {
    const db = (lastStore as unknown as { db: MockDb }).db;
    lastStore!.close();
    lastStore!.close();
    expect(db.close).toHaveBeenCalledTimes(2);
  });

  // ── saveSnapshot / getSnapshot ──────────────────────────────────────────

  it('saves and retrieves a snapshot by project ID', () => {
    const snapshot = makeSnapshot();
    lastStore!.saveSnapshot(snapshot);

    // Call getSnapshot to trigger prepare of the SELECT statement
    const first = lastStore!.getSnapshot('proj-1');
    expect(first).toBeUndefined(); // default mock returns undefined

    // Now set the mock return on the SELECT statement
    const stmt = findStatement('SELECT raw_json FROM snapshots');
    expect(stmt).toBeDefined();
    stmt!.get.mockReturnValue({ raw_json: JSON.stringify(snapshot) });

    const retrieved = lastStore!.getSnapshot('proj-1');
    expect(retrieved).toEqual(snapshot);
  });

  it('returns undefined when no snapshot exists', () => {
    expect(lastStore!.getSnapshot('nonexistent')).toBeUndefined();
  });

  it('returns undefined when raw_json is corrupt', () => {
    // Trigger prepare, then set corrupt mock return
    lastStore!.getSnapshot('corrupt');
    const stmt = findStatement('SELECT raw_json FROM snapshots');
    expect(stmt).toBeDefined();
    stmt!.get.mockReturnValue({ raw_json: 'not-json{' });

    expect(lastStore!.getSnapshot('corrupt')).toBeUndefined();
  });

  // ── getSnapshotById ─────────────────────────────────────────────────────

  it('retrieves a snapshot by ID', () => {
    const snapshot = makeSnapshot({ id: 'snap-42' });
    lastStore!.saveSnapshot(snapshot);

    // Trigger prepare, then set mock return
    lastStore!.getSnapshotById('snap-42');
    const stmt = findStatement('SELECT raw_json FROM snapshots WHERE id = ?');
    expect(stmt).toBeDefined();
    stmt!.get.mockReturnValue({ raw_json: JSON.stringify(snapshot) });

    const retrieved = lastStore!.getSnapshotById('snap-42');
    expect(retrieved).toEqual(snapshot);
  });

  it('returns undefined when snapshot ID not found', () => {
    expect(lastStore!.getSnapshotById('nonexistent')).toBeUndefined();
  });

  // ── listSnapshots ──────────────────────────────────────────────────────

  it('lists snapshots for a project', () => {
    const snap1 = makeSnapshot({ id: 's1', createdAt: '2026-01-01' });
    const snap2 = makeSnapshot({ id: 's2', createdAt: '2026-02-01' });

    // Trigger prepare, then set mock return
    lastStore!.listSnapshots('proj-1');
    const stmt = findStatement('SELECT raw_json FROM snapshots');
    expect(stmt).toBeDefined();
    stmt!.all.mockReturnValue([
      { raw_json: JSON.stringify(snap2) },
      { raw_json: JSON.stringify(snap1) },
    ]);

    const snapshots = lastStore!.listSnapshots('proj-1');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.id).toBe('s2');
    expect(snapshots[1]!.id).toBe('s1');
  });

  it('filters out corrupt rows in listSnapshots', () => {
    lastStore!.listSnapshots('proj-1');
    const stmt = findStatement('SELECT raw_json FROM snapshots');
    expect(stmt).toBeDefined();
    stmt!.all.mockReturnValue([{ raw_json: '{"id":"good"}' }, { raw_json: 'corrupt{' }]);

    const snapshots = lastStore!.listSnapshots('proj-1');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.id).toBe('good');
  });

  // ── deleteSnapshotsBefore ──────────────────────────────────────────────

  it('deletes old snapshots and returns count', () => {
    // Trigger prepare
    lastStore!.deleteSnapshotsBefore('proj-1', '2026-01-01');
    const stmt = findStatement('DELETE FROM snapshots');
    expect(stmt).toBeDefined();
    stmt!.run.mockReturnValue({ changes: 3 });

    const count = lastStore!.deleteSnapshotsBefore('proj-1', '2026-01-01');
    expect(count).toBe(3);
  });

  // ── saveJob / getJob ──────────────────────────────────────────────────

  it('saves and retrieves a job', () => {
    const job = makeJob();
    lastStore!.saveJob(job);

    // Trigger prepare
    lastStore!.getJob('job-1');
    const stmt = findStatement('SELECT * FROM jobs WHERE id = ?');
    expect(stmt).toBeDefined();
    stmt!.get.mockReturnValue({
      id: 'job-1',
      project_id: 'proj-1',
      target_root: '/project',
      kind: 'inventory',
      status: 'queued',
      fingerprint: 'def456',
      requested_by: 'user',
      created_at: FAKE_NOW,
      session_id: null,
      completed_at: null,
      error: null,
      progress_json: null,
    });

    const retrieved = lastStore!.getJob('job-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('job-1');
    expect(retrieved!.kind).toBe('inventory');
    expect(retrieved!.status).toBe('queued');
  });

  it('returns undefined when job not found', () => {
    expect(lastStore!.getJob('nonexistent')).toBeUndefined();
  });

  it('parses progress_json when present', () => {
    lastStore!.getJob('job-1');
    const stmt = findStatement('SELECT * FROM jobs WHERE id = ?');
    expect(stmt).toBeDefined();
    stmt!.get.mockReturnValue({
      id: 'job-1',
      project_id: 'proj-1',
      target_root: '/project',
      kind: 'analyze',
      status: 'inventorying',
      fingerprint: '',
      requested_by: '',
      created_at: FAKE_NOW,
      session_id: 'sess-1',
      completed_at: null,
      error: null,
      progress_json: '{"phase":"inventorying","done":5,"total":10}',
    });

    const retrieved = lastStore!.getJob('job-1');
    expect(retrieved!.progress).toEqual({ phase: 'inventorying', done: 5, total: 10 });
    expect(retrieved!.sessionId).toBe('sess-1');
  });

  it('handles progress_json parse error gracefully', () => {
    lastStore!.getJob('job-corrupt');
    const stmt = findStatement('SELECT * FROM jobs WHERE id = ?');
    expect(stmt).toBeDefined();
    stmt!.get.mockReturnValue({
      id: 'job-corrupt',
      project_id: 'proj-1',
      target_root: '/project',
      kind: 'inventory',
      status: 'completed',
      fingerprint: '',
      requested_by: '',
      created_at: FAKE_NOW,
      session_id: null,
      completed_at: '2026-07-26T13:00:00.000Z',
      error: null,
      progress_json: 'not valid json{{{',
    });

    const retrieved = lastStore!.getJob('job-corrupt');
    expect(retrieved!.progress).toBeUndefined();
  });

  // ── updateJobStatus ───────────────────────────────────────────────────

  it('updates job status and sets completed_at for terminal status', () => {
    lastStore!.updateJobStatus('job-1', 'completed');

    const stmt = findStatement('UPDATE jobs');
    expect(stmt).toBeDefined();
    expect(stmt!.run).toHaveBeenCalledWith('completed', null, FAKE_NOW, 'job-1');
  });

  it('does not set completed_at for non-terminal status', () => {
    lastStore!.updateJobStatus('job-1', 'discovering');

    const stmt = findStatement('UPDATE jobs');
    expect(stmt).toBeDefined();
    expect(stmt!.run).toHaveBeenCalledWith('discovering', null, null, 'job-1');
  });

  it('includes progress when provided', () => {
    lastStore!.updateJobStatus('job-1', 'inventorying', {
      phase: 'inventorying',
      completed: 3,
      total: 7,
    });

    const stmt = findStatement('UPDATE jobs');
    expect(stmt).toBeDefined();
    expect(stmt!.run).toHaveBeenCalledWith(
      'inventorying',
      JSON.stringify({ phase: 'inventorying', completed: 3, total: 7 }),
      null,
      'job-1',
    );
  });

  // ── listJobs ─────────────────────────────────────────────────────────

  it('lists jobs for a project', () => {
    lastStore!.listJobs('proj-1');
    const stmt = findStatement('SELECT * FROM jobs WHERE project_id');
    expect(stmt).toBeDefined();
    stmt!.all.mockReturnValue([
      {
        id: 'job-2',
        project_id: 'proj-1',
        target_root: '/project',
        kind: 'analyze',
        status: 'completed',
        fingerprint: '',
        requested_by: '',
        created_at: FAKE_NOW,
        session_id: null,
        completed_at: FAKE_NOW,
        error: 'something went wrong',
        progress_json: null,
      },
    ]);

    const jobs = lastStore!.listJobs('proj-1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe('job-2');
    expect(jobs[0]!.error).toBe('something went wrong');
    expect(jobs[0]!.status).toBe('completed');
  });

  // ── Outbox ────────────────────────────────────────────────────────────

  it('creates an outbox entry', () => {
    lastStore!.createOutbox('del-1', 'rep-1', 'sess-1');

    const stmt = findStatement('INSERT OR IGNORE INTO outbox');
    expect(stmt).toBeDefined();
    expect(stmt!.run).toHaveBeenCalledWith('del-1', 'rep-1', 'sess-1');
  });

  it('claims a pending outbox entry', () => {
    // Trigger prepare
    lastStore!.claimOutbox('del-1', 'sess-1');
    const stmt = findStatement('UPDATE outbox');
    expect(stmt).toBeDefined();
    stmt!.run.mockReturnValue({ changes: 1 });

    const claimed = lastStore!.claimOutbox('del-1', 'sess-1');
    expect(claimed).toBe(true);
  });

  it('claimOutbox returns false when no pending entry', () => {
    lastStore!.claimOutbox('del-1', 'sess-2');
    const stmt = findStatement('UPDATE outbox');
    expect(stmt).toBeDefined();
    stmt!.run.mockReturnValue({ changes: 0 });

    const claimed = lastStore!.claimOutbox('del-1', 'sess-2');
    expect(claimed).toBe(false);
  });

  it('marks outbox as delivered', () => {
    lastStore!.deliverOutbox('del-1');

    const stmt = findStatement('UPDATE outbox SET status');
    // Should be the second prepare (deliverOutbox)
    expect(stmt!.run).toHaveBeenCalledWith('del-1');
  });

  it('marks outbox as failed', () => {
    lastStore!.failOutbox('del-1');

    const stmt = findStatement('UPDATE outbox SET status');
    // Use lastStatement since failOutbox prepares one statement
    expect(stmt!.run).toHaveBeenCalledWith('del-1');
  });

  it('lists outbox entries by status', () => {
    // First call triggers prepare
    lastStore!.listOutboxByStatus('pending' as DeliveryStatus);
    const stmt = findStatement('SELECT * FROM outbox');
    expect(stmt).toBeDefined();
    stmt!.all.mockReturnValue([
      {
        delivery_id: 'del-1',
        report_id: 'rep-1',
        session_id: 'sess-1',
        status: 'pending',
        attempts: 0,
        claimed_at: null,
        delivered_at: null,
      },
      {
        delivery_id: 'del-2',
        report_id: 'rep-2',
        session_id: 'sess-2',
        status: 'pending',
        attempts: 1,
        claimed_at: '2026-07-26 12:00:00',
        delivered_at: null,
      },
    ]);

    const entries = lastStore!.listOutboxByStatus('pending' as DeliveryStatus);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.deliveryId).toBe('del-1');
    expect(entries[0]!.attempts).toBe(0);
    expect(entries[1]!.deliveryId).toBe('del-2');
    expect(entries[1]!.attempts).toBe(1);
    expect(entries[1]!.claimedAt).toBe('2026-07-26 12:00:00');
  });

  it('listOutboxByStatus returns empty when no entries match', () => {
    const entries = lastStore!.listOutboxByStatus('delivered' as DeliveryStatus);
    expect(entries).toEqual([]);
  });

  describe('Research Cache', () => {
    it('sets and gets cached research findings', () => {
      const mockFindings = [
        {
          id: 'f-1',
          dependencyId: 'dep-1',
          type: 'upgrade' as const,
          severity: 'info' as const,
          action: 'upgrade_minor' as const,
          confidence: 0.9,
          rationale: 'Safe minor upgrade',
          evidence: [],
        },
      ];

      lastStore!.setCachedResearch('cache-key-1', mockFindings);
      const setStmt = findStatement('INSERT INTO research_cache');
      expect(setStmt).toBeDefined();
      expect(setStmt!.run).toHaveBeenCalledWith(
        'cache-key-1',
        JSON.stringify(mockFindings),
        expect.any(String),
      );

      // First call compiles statement
      lastStore!.getCachedResearch('cache-key-1');
      const getStmt = findStatement('SELECT findings_json, expires_at FROM research_cache');
      expect(getStmt).toBeDefined();
      getStmt!.get.mockReturnValue({
        findings_json: JSON.stringify(mockFindings),
        expires_at: new Date(Date.now() + 100000).toISOString(),
      });

      const cached = lastStore!.getCachedResearch('cache-key-1');
      expect(cached).toEqual(mockFindings);
    });

    it('returns null when research cache entry is expired', () => {
      lastStore!.getCachedResearch('expired-key');
      const getStmt = findStatement('SELECT findings_json, expires_at FROM research_cache');
      expect(getStmt).toBeDefined();
      getStmt!.get.mockReturnValue({
        findings_json: '[]',
        expires_at: new Date(Date.now() - 10000).toISOString(),
      });

      const cached = lastStore!.getCachedResearch('expired-key');
      expect(cached).toBeNull();

      const deleteStmt = findStatement('DELETE FROM research_cache WHERE cache_key');
      expect(deleteStmt).toBeDefined();
    });

    it('prunes expired research cache entries', () => {
      lastStore!.pruneExpiredResearchCache();
      const pruneStmt = findStatement('DELETE FROM research_cache WHERE expires_at <=');
      expect(pruneStmt).toBeDefined();
      expect(pruneStmt!.run).toHaveBeenCalledWith(expect.any(String));
    });
  });
});
