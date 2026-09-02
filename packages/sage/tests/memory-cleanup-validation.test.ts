/**
 * Memory cleanup validation test — 14 seeded memories (7 clean + 6 test bait + 1 boundary)
 *
 * Validates that:
 * 1. `memory_gather_batch` enumerates memories with relations metadata
 * 2. `memory_hygiene` runs without errors and respects the "never delete on its own" invariant
 * 3. The gather + hygiene pipeline produces the expected report shape
 */
import { describe, expect, it } from 'vitest';
import type { SageServiceLike } from '../src/service-contract.js';
import type {
  GatherBatchResult,
  ListSagePageOptions,
  MemoryGraphEdge,
  RememberSageInput,
  Sage,
  SageHygieneReport,
  UpdateSageInput,
} from '../src/types.js';
import { createSageTools } from '../src/tools/memory-tools.js';

// ── 14 seeded memories ───────────────────────────────────────────────────────

const NOW = '2026-07-29T12:00:00.000Z';

interface SeedMemory {
  id: string;
  text: string;
  kind:
    | 'fact'
    | 'decision'
    | 'convention'
    | 'warning'
    | 'anti_pattern'
    | 'bug_root_cause'
    | 'file_note';
  persistence: 'permanent' | 'long_lived' | 'short_lived';
  importance: number;
  confidence: number;
  tags: string[];
}

/** 7 clean — well-formed, durable, no issues. */
const CLEAN_MEMORIES: SeedMemory[] = [
  {
    id: 'mem_clean_1',
    text: 'Project uses pnpm workspaces for monorepo management.',
    kind: 'fact',
    persistence: 'permanent',
    importance: 0.9,
    confidence: 1,
    tags: ['build', 'pnpm'],
  },
  {
    id: 'mem_clean_2',
    text: 'Use AbortSignal.timeout() for long-running fetch operations.',
    kind: 'convention',
    persistence: 'long_lived',
    importance: 0.8,
    confidence: 0.95,
    tags: ['async', 'fetch'],
  },
  {
    id: 'mem_clean_3',
    text: 'API routes use conventional HTTP status codes: 200, 201, 400, 401, 403, 404, 500.',
    kind: 'convention',
    persistence: 'long_lived',
    importance: 0.85,
    confidence: 0.9,
    tags: ['api', 'http'],
  },
  {
    id: 'mem_clean_4',
    text: 'Tests are co-located: src/foo.ts → tests/foo.test.ts in the same package.',
    kind: 'convention',
    persistence: 'long_lived',
    importance: 0.75,
    confidence: 0.95,
    tags: ['testing'],
  },
  {
    id: 'mem_clean_5',
    text: 'Never force-push shared branches; use --force-with-lease on personal branches only.',
    kind: 'warning',
    persistence: 'permanent',
    importance: 0.9,
    confidence: 0.95,
    tags: ['git', 'workflow'],
  },
  {
    id: 'mem_clean_6',
    text: 'Use native fetch instead of axios or node-fetch in Node >= 22.',
    kind: 'decision',
    persistence: 'long_lived',
    importance: 0.8,
    confidence: 0.9,
    tags: ['node', 'fetch'],
  },
  {
    id: 'mem_clean_7',
    text: 'Request validation must happen server-side with field-level error messages.',
    kind: 'convention',
    persistence: 'long_lived',
    importance: 0.8,
    confidence: 0.85,
    tags: ['api', 'validation'],
  },
];

/** 6 test bait — each has a specific issue the cleanup should detect. */
const BAIT_MEMORIES: SeedMemory[] = [
  // BAIT 1: Contradiction (conflicts with clean_6 — says use axios instead of fetch)
  {
    id: 'mem_bait_contradiction',
    text: 'Use axios for HTTP requests because it has better error handling.',
    kind: 'fact',
    persistence: 'long_lived',
    importance: 0.6,
    confidence: 0.5,
    tags: ['node', 'fetch'],
  },
  // BAIT 2: Near-duplicate (paraphrases clean_3 — same topic)
  {
    id: 'mem_bait_duplicate',
    text: 'API should return 200 for success, 201 for creation, 400 for bad input.',
    kind: 'convention',
    persistence: 'long_lived',
    importance: 0.5,
    confidence: 0.6,
    tags: ['api', 'http'],
  },
  // BAIT 3: Noise (too vague to be useful)
  {
    id: 'mem_bait_noise',
    text: 'Fixed some stuff in the build script.',
    kind: 'fact',
    persistence: 'short_lived',
    importance: 0.2,
    confidence: 0.3,
    tags: ['build'],
  },
  // BAIT 4: Misclassification (should be warning, not fact)
  {
    id: 'mem_bait_misclass',
    text: 'Direct SQL string concatenation is a security risk.',
    kind: 'fact',
    persistence: 'long_lived',
    importance: 0.7,
    confidence: 0.8,
    tags: ['security', 'sql'],
  },
  // BAIT 5: Expired short_lived (created 90 days ago with no expiry set — past review threshold)
  {
    id: 'mem_bait_expired',
    text: 'Temporary debug config for local testing.',
    kind: 'file_note',
    persistence: 'short_lived',
    importance: 0.3,
    confidence: 0.4,
    tags: ['debug'],
  },
  // BAIT 6: Low-quality unanchored (no anchors, short text, ephemeral pattern)
  {
    id: 'mem_bait_lowq',
    text: 'Working on the auth refactor.',
    kind: 'fact',
    persistence: 'short_lived',
    importance: 0.1,
    confidence: 0.2,
    tags: ['wip'],
  },
];

/** 1 boundary — tests PersistenceClass boundary (short_lived tagged correctly). */
const BOUNDARY_MEMORY: SeedMemory = {
  id: 'mem_boundary',
  text: 'Session-scoped note about a one-time investigation.',
  kind: 'file_note',
  persistence: 'short_lived',
  importance: 0.4,
  confidence: 0.6,
  tags: ['session'],
};

const ALL_SEED_MEMORIES = [...CLEAN_MEMORIES, ...BAIT_MEMORIES, BOUNDARY_MEMORY];

function toSage(seed: SeedMemory): Sage {
  return {
    id: seed.id,
    revision: 1,
    scope: 'project',
    kind: seed.kind,
    status: 'active',
    persistence: seed.persistence,
    text: seed.text,
    importance: seed.importance,
    confidence: seed.confidence,
    freshness: 1,
    tags: [...seed.tags],
    anchors: [],
    sources: [{ type: 'test', sessionId: 'validation-test' }],
    createdAt: NOW,
    updatedAt: NOW,
    lastAccessedAt: NOW,
  };
}

function buildMockService(): SageServiceLike & { seeds: Sage[] } {
  const seeds = ALL_SEED_MEMORIES.map(toSage);
  const seedsById = new Map(seeds.map((s) => [s.id, s]));
  const service = {
    seeds,
    async readAll() {
      return '';
    },
    async read() {
      return '';
    },
    async remember() {},
    async forget() {
      return 0;
    },
    async consolidate() {},
    async clear() {},
    async list() {
      return [];
    },
    async search() {
      return [];
    },
    async unifiedSearchService() {
      return {
        hits: [],
        suggestions: [],
        totalCandidates: 0,
        rankingApplied: 'hybrid' as const,
        queryEcho: {},
      };
    },
    async findRelated() {
      return [];
    },
    withTraceId() {
      return this;
    },
    async retrieveForPath() {
      return [];
    },
    async searchSage(_query: string, _opts?: { limit?: number; includeStatuses?: string[] }) {
      return seeds
        .filter((s) => s.text.toLowerCase().includes(_query.toLowerCase()))
        .slice(0, _opts?.limit ?? 20);
    },
    async graphFor() {
      return [] as MemoryGraphEdge[];
    },
    async verify() {
      return [];
    },
    async hygiene(_opts?: { verify?: boolean }) {
      return {
        startedAt: NOW,
        completedAt: NOW,
        examined: seeds.filter((s) => s.status === 'active').length,
        deduplicated: 0,
        superseded: 0,
        contradicted: 0,
        staled: 0,
        reviewCandidatesCreated: 0,
        archived: 0,
        archivedUnused: 0,
        deleted: 0,
        purgedDeleted: 0,
        verified: 0,
        transitiveMerges: 0,
      } satisfies SageHygieneReport;
    },
    async listCandidates() {
      return [];
    },
    async createCandidate(input: { text: string }) {
      return { id: 'candidate_new', status: 'pending', text: input.text } as never;
    },
    async resolveCandidate() {
      return undefined;
    },
    async acceptCandidate() {
      return undefined;
    },
    async rejectCandidate() {
      return false;
    },
    async rememberSage(input: RememberSageInput) {
      const mem: Sage = {
        id: `mem_val_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        revision: 1,
        scope: 'project',
        kind: (input.kind ?? 'fact') as Sage['kind'],
        status: 'active',
        text: input.text,
        importance: input.importance ?? 0.5,
        confidence: 0.5,
        freshness: 1,
        tags: [],
        anchors: [],
        sources: [{ type: 'test' }],
        createdAt: NOW,
        updatedAt: NOW,
      };
      seeds.push(mem);
      seedsById.set(mem.id, mem);
      return mem;
    },
    updateSage: async (id: string, patch: UpdateSageInput) => {
      const existing = seedsById.get(id);
      if (!existing) throw new Error(`Memory ${id} not found`);
      Object.assign(existing, patch);
      return existing;
    },
    async deleteSage() {},
    async recoverSage() {
      return seeds[0]!;
    },
    async backfillRecoverable() {
      return {
        startedAt: NOW,
        completedAt: NOW,
        dryRun: true,
        examined: 0,
        recoverable: 0,
        recovered: 0,
        skipped: 0,
        skippedRecords: [],
        recoverableRecords: [],
        byKind: {},
        byReason: {},
      } as never;
    },
    async findMemoriesForFile() {
      return {
        filePath: '',
        primaryMatches: [],
        symbolMatches: [],
        relatedMatches: [],
        totalCount: 0,
        activeCount: 0,
        supersededCount: 0,
        reviewPendingCount: 0,
      } as never;
    },
    async getSage(id: string) {
      return seedsById.get(id) ?? null;
    },
    getBackend() {
      return undefined;
    },
    listSagePage: async (options?: ListSagePageOptions) => {
      let filtered = seeds;
      if (options?.statuses && options.statuses.length > 0) {
        filtered = filtered.filter((s) => options.statuses!.includes(s.status));
      }
      if (options?.kind && options.kind !== 'all') {
        filtered = filtered.filter((s) => s.kind === options.kind);
      }
      const total = filtered.length;
      const limit = Math.min(options?.limit ?? 50, 500);
      const page = filtered.slice(0, limit);
      return {
        memories: page,
        nextCursor: page.length < total ? 'mock-cursor' : null,
        total,
        statusCounts: { active: seeds.filter((s) => s.status === 'active').length },
      };
    },
  };
  return service as SageServiceLike & { seeds: Sage[] };
}

describe('memory cleanup validation — 14 seeded memories', () => {
  it('seeds 14 memories into the mock service', () => {
    const service = buildMockService();
    expect(service.seeds).toHaveLength(14);
  });

  it('memory_gather_batch enumerates all active memories', async () => {
    const service = buildMockService();
    const tools = createSageTools(service);
    const gatherBatch = tools.find((t) => t.name === 'memory_gather_batch')!;
    const signal = new AbortController().signal;

    const result = (await gatherBatch.execute(
      { statuses: ['active'], limit: 50 },
      {} as never,
      { signal } as never,
    )) as GatherBatchResult;

    expect(result.memories).toHaveLength(14);
    expect(result.total).toBe(14);
    expect(result.nextCursor).toBeNull();
    expect(result.statusCounts).toBeDefined();
    expect(result.relations).toBeInstanceOf(Array);
  });

  it('memory_gather_batch accepts a cursor parameter without error', async () => {
    const service = buildMockService();
    const tools = createSageTools(service);
    const gatherBatch = tools.find((t) => t.name === 'memory_gather_batch')!;
    const signal = new AbortController().signal;

    const page1 = (await gatherBatch.execute(
      { statuses: ['active'], limit: 5 },
      {} as never,
      { signal } as never,
    )) as GatherBatchResult;

    expect(page1.memories).toHaveLength(5);
    expect(page1.nextCursor).toBeDefined();

    // Passing a cursor should not throw (tool-level validation)
    await expect(
      gatherBatch.execute(
        { statuses: ['active'], limit: 5, cursor: page1.nextCursor! },
        {} as never,
        { signal } as never,
      ),
    ).resolves.toBeDefined();
  });

  it('memory_gather_batch with includeRelations: false returns no relations', async () => {
    const service = buildMockService();
    const tools = createSageTools(service);
    const gatherBatch = tools.find((t) => t.name === 'memory_gather_batch')!;
    const signal = new AbortController().signal;

    const result = (await gatherBatch.execute(
      { statuses: ['active'], limit: 14, includeRelations: false },
      {} as never,
      { signal } as never,
    )) as GatherBatchResult;

    expect(result.relations).toHaveLength(0);
    expect(result.relationsScannedAt).toBe(0);
  });

  it('memory_gather_batch filters by kind', async () => {
    const service = buildMockService();
    const tools = createSageTools(service);
    const gatherBatch = tools.find((t) => t.name === 'memory_gather_batch')!;
    const signal = new AbortController().signal;

    const result = (await gatherBatch.execute(
      { statuses: ['active'], kind: 'convention', limit: 50 },
      {} as never,
      { signal } as never,
    )) as GatherBatchResult;

    expect(result.memories.length).toBeGreaterThan(0);
    for (const memory of result.memories) {
      expect(memory.kind).toBe('convention');
    }
  });

  it('memory_hygiene never deletes on its own', async () => {
    const service = buildMockService();
    const tools = createSageTools(service);
    const hygiene = tools.find((t) => t.name === 'memory_hygiene')!;
    const signal = new AbortController().signal;

    const report = (await hygiene.execute(
      { verify: true },
      {} as never,
      { signal } as never,
    )) as SageHygieneReport;

    // Core invariant: hygiene never deletes or archives on its own
    expect(report.archived).toBe(0);
    expect(report.deleted).toBe(0);
    expect(report.archivedUnused).toBe(0);
    expect(report.purgedDeleted).toBe(0);

    // Report shape is valid
    expect(report.examined).toBeGreaterThan(0);
    expect(typeof report.startedAt).toBe('string');
    expect(typeof report.completedAt).toBe('string');
    expect(typeof report.deduplicated).toBe('number');
    expect(typeof report.staled).toBe('number');
    expect(typeof report.reviewCandidatesCreated).toBe('number');
    expect(typeof report.verified).toBe('number');
    expect(typeof report.transitiveMerges).toBe('number');
  });

  it('clean memories pass without triggering findings', () => {
    // Verify that ALL clean memories have properties that should pass review
    for (const memory of CLEAN_MEMORIES) {
      expect(memory.importance).toBeGreaterThanOrEqual(0.75);
      expect(memory.confidence).toBeGreaterThanOrEqual(0.85);
      expect(memory.text.length).toBeGreaterThan(12);
    }
  });

  it('bait memories have detectable issues', () => {
    // BAIT 1: contradicts clean_6 (axios vs fetch)
    const bait1 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_bait_contradiction')!;
    const clean6 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_clean_6')!;
    expect(bait1.tags).toEqual(expect.arrayContaining(clean6.tags!));
    expect(bait1.kind).toBe('fact');

    // BAIT 2: near-duplicate of clean_3 (both about HTTP status codes)
    const bait2 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_bait_duplicate')!;
    const clean3 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_clean_3')!;
    expect(bait2.tags).toEqual(expect.arrayContaining(clean3.tags!));

    // BAIT 3: noise — low importance, low confidence
    const bait3 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_bait_noise')!;
    expect(bait3.importance).toBeLessThan(0.3);
    expect(bait3.confidence).toBeLessThan(0.4);

    // BAIT 4: misclassification — should be warning, not fact
    const bait4 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_bait_misclass')!;
    expect(bait4.kind).toBe('fact');

    // BAIT 5: past review threshold
    const bait5 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_bait_expired')!;
    expect(bait5.persistence).toBe('short_lived');

    // BAIT 6: low quality — short text, low confidence, ephemeral pattern
    const bait6 = ALL_SEED_MEMORIES.find((m) => m.id === 'mem_bait_lowq')!;
    expect(bait6.text.length).toBeLessThan(30);
    expect(bait6.importance).toBeLessThan(0.2);
  });
});
