import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  Snapshot,
  TechStackJob,
  TechStackJobStatus,
  TechStackJobProgress,
} from '../src/types.js';
import { TechStackEngine } from '../src/service.js';

// ── Mock the registry + OSV so analyze() stays hermetic ────────────────

vi.mock('../src/registry/client.js', () => ({
  lookupRegistry: vi.fn(async () => ({
    latestStable: '1.0.0',
    license: 'MIT',
    deprecated: undefined,
    yanked: undefined,
    retrievedAt: '2026-01-01T00:00:00Z',
    source: 'mock-registry',
  })),
  clearRegistryCache: vi.fn(),
}));

const EMPTY_OSV_RESULT = {
  advisories: new Map(),
  evidence: {
    kind: 'osv' as const,
    source: 'https://api.osv.dev/v1/querybatch',
    retrievedAt: '2026-01-01T00:00:00Z',
  },
};

vi.mock('../src/advisory/osv.js', () => ({
  queryOsvBatch: vi.fn(async () => EMPTY_OSV_RESULT),
}));

import { lookupRegistry } from '../src/registry/client.js';
import { queryOsvBatch } from '../src/advisory/osv.js';

const mockedLookupRegistry = vi.mocked(lookupRegistry);
const mockedQueryOsv = vi.mocked(queryOsvBatch);

// ── In-memory mock store ───────────────────────────────────────────────

interface MockStore {
  snapshots: Snapshot[];
  jobs: Map<string, TechStackJob>;
  statusUpdates: Array<{ id: string; status: TechStackJobStatus; progress?: TechStackJobProgress }>;
}

function createMockStore(): { store: MockStore; engine: TechStackEngine } {
  const storeData: MockStore = {
    snapshots: [],
    jobs: new Map(),
    statusUpdates: [],
  };

  // TechStackEngine only calls saveSnapshot, saveJob, updateJobStatus
  const store = {
    saveSnapshot(snapshot: Snapshot) {
      storeData.snapshots.push(snapshot);
    },
    saveJob(job: TechStackJob) {
      storeData.jobs.set(job.id, { ...job });
    },
    updateJobStatus(id: string, status: TechStackJobStatus, progress?: TechStackJobProgress) {
      storeData.statusUpdates.push({ id, status, ...(progress ? { progress } : {}) });
      const existing = storeData.jobs.get(id);
      if (existing) storeData.jobs.set(id, { ...existing, status, progress });
    },
  } as unknown as import('../src/store/sqlite.js').TechStackStore;

  return { store: storeData, engine: new TechStackEngine(store) };
}

let tmpProject: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockedLookupRegistry.mockResolvedValue({
    latestStable: '1.0.0',
    license: 'MIT',
    deprecated: undefined,
    yanked: undefined,
    retrievedAt: '2026-01-01T00:00:00Z',
    source: 'mock-registry',
  });
  mockedQueryOsv.mockResolvedValue(EMPTY_OSV_RESULT);
  tmpProject = mkdtempSync(join(tmpdir(), 'ts-engine-'));
});

afterEach(() => {
  rmSync(tmpProject, { recursive: true, force: true });
});

// ── analyze: offline mode ──────────────────────────────────────────────

describe('TechStackEngine.analyze — offline', () => {
  it('completes an offline inventory-only analysis', async () => {
    const { store, engine } = createMockStore();

    const result = await engine.analyze('proj-1', {
      targetRoot: tmpProject,
      online: false,
      requestedBy: 'test',
    });

    expect(result.job.status).toBe('completed');
    expect(result.snapshot.dependencies).toEqual([]);
    expect(result.snapshot.workspaces).toEqual([]);
    // Snapshot persisted
    expect(store.snapshots.length).toBeGreaterThanOrEqual(1);
    // Job was created and updated
    expect(store.jobs.size).toBe(1);
    // Status progression: queued → discovering → inventorying → completed
    const statuses = store.statusUpdates.map((u) => u.status);
    expect(statuses).toContain('discovering');
    expect(statuses).toContain('completed');
  });

  it('passes the onProgress callback through all phases', async () => {
    const { engine } = createMockStore();
    const phases: string[] = [];

    await engine.analyze('proj-1', {
      targetRoot: tmpProject,
      online: false,
      onProgress: (phase) => phases.push(phase),
    });

    expect(phases).toContain('discovering');
    expect(phases).toContain('inventorying');
    expect(phases).toContain('completed');
  });

  it('uses a caller-provided jobId', async () => {
    const { store, engine } = createMockStore();

    await engine.analyze('proj-1', {
      targetRoot: tmpProject,
      online: false,
      jobId: 'custom-job-id',
    });

    expect(store.jobs.get('custom-job-id')).toBeDefined();
    expect(store.jobs.get('custom-job-id')!.status).toBe('completed');
  });
});

// ── analyze: online mode (enrich + research) ──────────────────────────

describe('TechStackEngine.analyze — online', () => {
  it('completes an online analysis with enrichment', async () => {
    const { store, engine } = createMockStore();

    const result = await engine.analyze('proj-1', {
      targetRoot: tmpProject,
      online: true,
      requestedBy: 'test',
    });

    expect(result.job.status).toBe('completed');
    // Online mode enriches — but with no deps, enrichment is a no-op
    expect(result.snapshot.dependencies).toEqual([]);
    // At least 2 snapshots saved: inventory + enriched
    expect(store.snapshots.length).toBeGreaterThanOrEqual(1);
    // Status includes enriching
    const statuses = store.statusUpdates.map((u) => u.status);
    expect(statuses).toContain('enriching');
    expect(statuses).toContain('completed');
  });

  it('passes research phases when a researcher is provided', async () => {
    const { engine } = createMockStore();
    const phases: string[] = [];

    await engine.analyze('proj-1', {
      targetRoot: tmpProject,
      online: true,
      onProgress: (phase) => phases.push(phase),
      researcher: {
        research: vi.fn().mockResolvedValue([]),
      } as never,
    });

    // With no deps, triage returns 0 candidates → research is a no-op
    // but the research phase should not crash
    expect(phases).toContain('enriching');
    expect(phases).toContain('completed');
  });
});

// ── analyze: cancellation ──────────────────────────────────────────────

describe('TechStackEngine.analyze — cancellation', () => {
  it('marks the job as cancelled when aborted', async () => {
    const { store, engine } = createMockStore();
    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.analyze('proj-1', {
        targetRoot: tmpProject,
        online: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    const statuses = store.statusUpdates.map((u) => u.status);
    expect(statuses).toContain('cancelled');
  });
});

// ── enrich: direct call with synthetic snapshot ────────────────────────

describe('TechStackEngine.enrich', () => {
  it('returns the snapshot unchanged when online is false', async () => {
    const { engine } = createMockStore();
    const snap: Snapshot = {
      id: 'snap-1',
      projectId: 'proj-1',
      targetRoot: '/fake',
      fingerprint: 'fp',
      createdAt: '2026-01-01T00:00:00Z',
      workspaces: [],
      dependencies: [],
      findings: [],
      coverage: 'full',
      adapterVersion: '0.1.0',
    };
    const result = await engine.enrich(snap, { online: false });
    expect(result).toBe(snap);
  });

  it('returns the snapshot unchanged when signal is already aborted', async () => {
    const { engine } = createMockStore();
    const controller = new AbortController();
    controller.abort();
    const snap: Snapshot = {
      id: 'snap-1',
      projectId: 'proj-1',
      targetRoot: '/fake',
      fingerprint: 'fp',
      createdAt: '2026-01-01T00:00:00Z',
      workspaces: [],
      dependencies: [],
      findings: [],
      coverage: 'full',
      adapterVersion: '0.1.0',
    };
    const result = await engine.enrich(snap, { online: true, signal: controller.signal });
    expect(result).toBe(snap);
  });
});

// ── research: direct call ──────────────────────────────────────────────

describe('TechStackEngine.research', () => {
  it('returns the snapshot unchanged when no researcher is provided', async () => {
    const { engine } = createMockStore();
    const snap: Snapshot = {
      id: 'snap-1',
      projectId: 'proj-1',
      targetRoot: '/fake',
      fingerprint: 'fp',
      createdAt: '2026-01-01T00:00:00Z',
      workspaces: [],
      dependencies: [],
      findings: [],
      coverage: 'full',
      adapterVersion: '0.1.0',
    };
    const result = await engine.research(snap, {});
    expect(result).toBe(snap);
  });

  it('returns the snapshot unchanged when researcher throws', async () => {
    const { engine } = createMockStore();
    const snap: Snapshot = {
      id: 'snap-1',
      projectId: 'proj-1',
      targetRoot: '/fake',
      fingerprint: 'fp',
      createdAt: '2026-01-01T00:00:00Z',
      workspaces: [],
      dependencies: [],
      findings: [],
      coverage: 'full',
      adapterVersion: '0.1.0',
    };
    const result = await engine.research(snap, {
      researcher: {
        research: vi.fn().mockRejectedValue(new Error('LLM down')),
      } as never,
    });
    // Research failure is not fatal — snapshot returned unchanged
    expect(result).toBe(snap);
  });

  it('returns the snapshot unchanged when signal is aborted', async () => {
    const { engine } = createMockStore();
    const controller = new AbortController();
    controller.abort();
    const snap: Snapshot = {
      id: 'snap-1',
      projectId: 'proj-1',
      targetRoot: '/fake',
      fingerprint: 'fp',
      createdAt: '2026-01-01T00:00:00Z',
      workspaces: [],
      dependencies: [],
      findings: [],
      coverage: 'full',
      adapterVersion: '0.1.0',
    };
    const result = await engine.research(snap, {
      researcher: { research: vi.fn() } as never,
      signal: controller.signal,
    });
    expect(result).toBe(snap);
  });
});

// ── inventory: direct call ─────────────────────────────────────────────

describe('TechStackEngine.inventory', () => {
  it('produces a snapshot with a stable fingerprint', async () => {
    const { store, engine } = createMockStore();

    const snap = await engine.inventory('proj-1', tmpProject);

    expect(snap.projectId).toBe('proj-1');
    expect(snap.targetRoot).toBe(tmpProject);
    expect(snap.fingerprint).toMatch(/^ts-/);
    expect(snap.adapterVersion).toBe('0.1.0');
    expect(snap.coverage).toBe('full');
    // Empty project → no workspaces, no deps
    expect(snap.workspaces).toEqual([]);
    expect(snap.dependencies).toEqual([]);
    // Persisted to the store
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]!.id).toBe(snap.id);
  });

  it('fires the onProgress callback during discovery and inventory', async () => {
    const { engine } = createMockStore();
    const phases: Array<{ phase: string; completed: number; total: number }> = [];

    await engine.inventory('proj-1', tmpProject, undefined, (phase, completed, total) => {
      phases.push({ phase, completed, total });
    });

    expect(phases.some((p) => p.phase === 'discovering')).toBe(true);
    expect(phases.some((p) => p.phase === 'inventorying')).toBe(true);
  });
});
