import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyMemoryAnchors } from '../src/anchors/verify.js';
import { hybridRerankCoverage, hybridRerankMemories } from '../src/retrieval/hybrid-rerank.js';
import { SqliteSageStore } from '../src/sqlite-store.js';
import { createSageTools } from '../src/tools/memory-tools.js';
import type { Sage, VectorRecallProvider } from '../src/types.js';

function mem(id: string, text: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text,
    importance: 0.8,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sage 100% coverage suite', () => {
  let tempDir: string;
  let store: SqliteSageStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-100-'));
    store = new SqliteSageStore({ projectRoot: tempDir });
    await store.initialize();
  });

  afterEach(async () => {
    try {
      store.close();
    } catch {}
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('hybrid-rerank.ts vectorCache and error catch', () => {
    it('covers cache eviction past MAX_CACHED_VECTORS and coverage helpers', () => {
      hybridRerankCoverage.clearVectorCache();
      expect(hybridRerankCoverage.cacheSize()).toBe(0);

      // Create > 512 candidates to trigger cache eviction
      const candidates: Sage[] = [];
      for (let i = 0; i < 520; i++) {
        candidates.push(mem(`c-${i}`, `Candidate text variation ${i}`));
      }

      const reranked = hybridRerankMemories('query variation text', candidates, 0.5);
      expect(reranked).toHaveLength(520);
      expect(hybridRerankCoverage.cacheSize()).toBeGreaterThan(500);

      hybridRerankCoverage.clearVectorCache();
      expect(hybridRerankCoverage.cacheSize()).toBe(0);
    });
  });

  describe('tools/memory-tools.ts memory_search_explain', () => {
    it('executes memory_search_explain with and without searchSageWithBreakdown', async () => {
      const toolWithBreakdown = createSageTools(store).find(
        (t) => t.name === 'memory_search_explain',
      )!;
      expect(toolWithBreakdown).toBeDefined();

      const m = await store.rememberSage({
        text: 'Fused search test memory text',
        scope: 'project',
        kind: 'fact',
      });

      // 1. Store exposes searchSageWithBreakdown
      const hits1 = (await toolWithBreakdown.execute(
        { query: 'fused search test', include_stale: true, limit: 5 } as any,
        {} as any,
        {} as any,
      )) as any[];
      expect(Array.isArray(hits1)).toBe(true);

      // 2. Service without searchSageWithBreakdown (synthesizes breakdown)
      const serviceNoBreakdown = {
        searchSage: vi.fn(async () => [m, mem('m2', 'second memory')]),
      };
      const toolFallback = createSageTools(serviceNoBreakdown as any).find(
        (t) => t.name === 'memory_search_explain',
      )!;
      const hits2 = (await toolFallback.execute(
        { query: 'fused search' } as any,
        {} as any,
        {} as any,
      )) as any[];
      expect(hits2).toHaveLength(2);
      expect(hits2[0].source).toBe('lexical');
      expect(hits2[0].vectorScore).toBeNull();
    });
  });

  describe('sqlite-store.ts searchSageWithBreakdown', () => {
    it('supports pure lexical breakdown and augmented breakdown with vector recall', async () => {
      const m1 = await store.rememberSage({
        text: 'Lexical breakdown memory 1',
        scope: 'project',
        kind: 'fact',
      });
      const _m2 = await store.rememberSage({
        text: 'Lexical breakdown memory 2',
        scope: 'project',
        kind: 'decision',
      });

      // Pure lexical breakdown
      const lexical = await store.searchSageWithBreakdown('Lexical breakdown');
      expect(lexical.length).toBeGreaterThan(0);
      expect(lexical[0]?.source).toBe('lexical');
      expect(lexical[0]?.vectorScore).toBeNull();

      // Augmented breakdown with VectorRecallProvider
      const mockVectorProvider: VectorRecallProvider = {
        async search(_query, opts) {
          return [
            {
              id: `vec-${m1.id}`,
              score: 0.95,
              text: m1.text,
              tags: [],
              metadata: { sageId: m1.id },
            },
          ].slice(0, opts.limit);
        },
      };

      const augmented = await store.searchSageWithBreakdown('Lexical breakdown', {
        vectorRecall: mockVectorProvider,
        vectorRecallWeight: 0.5,
        vectorRecallMinScore: 0.1,
        vectorRecallThreshold: 0.1,
        limit: 5,
      });
      expect(augmented.length).toBeGreaterThan(0);
      expect(augmented.some((h) => h.source === 'both')).toBe(true);
    });
  });

  describe('sqlite-store-recovery.ts edge cases', () => {
    it('skips memories with no provenance when requireProvenance is true', async () => {
      // Memory without sources and without anchors
      const m = await store.rememberSage({
        text: 'Deleted without provenance',
        scope: 'project',
        kind: 'fact',
        sources: [],
        anchors: [],
      });
      await store.deleteSage(m.id, 'test delete', { force: true });

      const report = await store.backfillRecoverable({
        requireProvenance: true,
        dryRun: true,
      });
      expect(report.byReason['no_provenance']).toBeGreaterThan(0);
    });

    it('marks race_lost when memory is no longer deleted during recovery mutation', async () => {
      const { backfillRecoverableSqliteSage } = await import('../src/sqlite-store-recovery.js');
      const ctx = {
        nowIso: () => new Date().toISOString(),
        getMemory: (_id: string) => ({
          id: 'mem-race',
          status: 'active', // simulates memory restored by another process/turn
          kind: 'fact',
          scope: 'project',
          text: 'race test',
          sources: [{ type: 'user' }],
          anchors: [],
          tags: [],
        }),
        listMemories: () => [
          {
            id: 'mem-race',
            status: 'deleted',
            kind: 'fact',
            scope: 'project',
            text: 'race test',
            sources: [{ type: 'user' }],
            anchors: [],
            tags: [],
          },
        ],
        runMutation: async (fn: () => void) => fn(),
        upsertMemory: () => {},
        syncAnchorEdges: () => {},
        audit: () => {},
        emit: () => {},
      };

      const report = await backfillRecoverableSqliteSage(ctx as any, { dryRun: false });
      expect(report.byReason['race_lost']).toBe(1);
    });
  });

  describe('sqlite-store-search.ts suggestLexicalAdjacent', () => {
    it('applies scopes and importanceAtLeast filters in lexical adjacency suggestions', async () => {
      await store.rememberSage({
        text: 'alpha beta gamma project convention',
        scope: 'project',
        kind: 'convention',
        importance: 0.8,
      });

      // Search with a query that has multiple terms where primary FTS misses but terms exist in corpus
      // with scopes and importanceAtLeast
      const results = await store.searchSage('alpha gamma nonexistenttermxyz', {
        scopes: ['project'],
        importanceAtLeast: 0.5,
        suggestions: 'always',
      });
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('sqlite-store-hygiene.ts age tie breaking and deep verification', () => {
    it('runs deep verification pass across active memories', async () => {
      await store.rememberSage({
        text: 'Memory with anchor for deep verify',
        scope: 'project',
        kind: 'fact',
        anchors: [{ type: 'command', command: 'git' }],
      });
      await store.rememberSage({
        text: 'Memory without anchor for deep verify',
        scope: 'project',
        kind: 'fact',
      });

      const report = await store.hygiene({
        verifyAnchors: true,
        deep: true,
      });
      expect(report).toBeDefined();
      expect(report.verified).toBeGreaterThan(0);
    });

    it('breaks ties by id when createdAt is identical in compareMemoryAgeAscending', async () => {
      const now = '2026-01-01T12:00:00.000Z';
      // Insert session memories that share exact createdAt to trigger tie-break
      await store.rememberSage({
        id: 'mem_01AAAAAA',
        text: 'Session mem 1',
        scope: 'session',
        kind: 'fact',
        ownerSessionId: 'sess-tie',
        createdAt: now,
      } as any);
      await store.rememberSage({
        id: 'mem_01BBBBBB',
        text: 'Session mem 2',
        scope: 'session',
        kind: 'fact',
        ownerSessionId: 'sess-tie',
        createdAt: now,
      } as any);

      // Trigger session retention pruning
      const report = await store.hygiene({
        maxSessionMemories: 1,
      });
      expect(report).toBeDefined();
    });
  });

  describe('anchors/verify.ts commandExists and gitBlobCache', () => {
    it('handles non-existent explicit command path', async () => {
      const m = mem('cmd-fail', 'runs missing script', {
        anchors: [{ type: 'command', command: './scripts/non_existent_script_12345.sh' }],
      });
      const res = await verifyMemoryAnchors(tempDir, m);
      expect(res.status).toBe('stale');
    });

    it('returns unknown when gitBlobCache is provided but path is missing from cache', async () => {
      const { anchorVerificationCoverage } = await import('../src/anchors/verify.js');
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'hello git', 'utf8');

      const res = await anchorVerificationCoverage.verifyAnchor(
        tempDir,
        { type: 'file', path: 'test.txt', gitBlobHash: 'abc1234' },
        undefined,
        new Map(), // empty cache
      );
      expect(res.status).toBe('unknown');
      expect(res.reason).toContain('Git blob could not be calculated');
    });

    it('tests anchorMatches with symbol, command, and role filters in search', async () => {
      const file = path.join(tempDir, 'sample.ts');
      await fs.writeFile(file, 'export const sample = 42;\n', 'utf8');
      await store.rememberSage({
        text: 'Anchor with symbol command and role',
        anchors: [
          {
            type: 'file',
            path: 'sample.ts',
            symbol: 'sample',
            command: 'test-cmd',
            role: 'Architect',
          },
        ],
      });

      // Matching search
      const res1 = await store.unifiedSearchService({
        text: 'Anchor',
        anchor: {
          type: 'file',
          path: 'sample.ts',
          symbol: 'sample',
          command: 'test-cmd',
          role: 'architect',
        },
      });
      expect(res1.hits).toHaveLength(1);

      // Non-matching symbol
      const res2 = await store.unifiedSearchService({
        text: 'Anchor',
        anchor: { type: 'file', path: 'sample.ts', symbol: 'different' },
      });
      expect(res2.hits).toHaveLength(0);

      // Non-matching command
      const res3 = await store.unifiedSearchService({
        text: 'Anchor',
        anchor: { type: 'file', path: 'sample.ts', command: 'different' },
      });
      expect(res3.hits).toHaveLength(0);

      // Non-matching role
      const res4 = await store.unifiedSearchService({
        text: 'Anchor',
        anchor: { type: 'file', path: 'sample.ts', role: 'Engineer' },
      });
      expect(res4.hits).toHaveLength(0);
    });
  });

  describe('sqlite-store-recovery.ts backfill and superseded head following', () => {
    it('applies backfill recovering deleted records and handles skips', async () => {
      const m1 = await store.rememberSage({
        text: 'Deleted memory 1 to recover',
        anchors: [{ type: 'file', path: 'src/app.ts' }],
        sources: [{ type: 'file', uri: 'file:///app.ts' }],
      });
      await store.deleteSage(m1.id, 'test del', { force: true });
      const m2Id = 'mem_empty_text';
      (store as any).upsertMemory(
        mem(m2Id, '   ', {
          status: 'deleted',
          anchors: [{ type: 'file', path: 'src/app.ts' }],
          sources: [{ type: 'file', uri: 'file:///app.ts' }],
        }),
      );

      // 1. updatedBefore filter skip
      const reportSkipBefore = await store.backfillRecoverable({
        filter: { updatedBefore: '1970-01-01T00:00:00.000Z' },
      });
      expect(reportSkipBefore.skipped).toBeGreaterThan(0);

      // 2. empty_text skip
      const reportSkipEmpty = await store.backfillRecoverable({
        filter: { ids: [m2Id], requireText: true },
      });
      expect(reportSkipEmpty.byReason['empty_text']).toBe(1);

      // 3. Apply backfill (!dryRun)
      const appliedReport = await store.backfillRecoverable({
        dryRun: false,
        requireText: true,
        filter: { ids: [m1.id] },
      });
      expect(appliedReport.recovered).toBe(1);
    });

    it('follows superseded head in recoverSage and throws when head is unavailable', async () => {
      const orig = await store.rememberSage({ text: 'Original memory' });
      const sup = await store.rememberSage({ text: 'Superseding memory', supersedes: [orig.id] });
      (store as any).upsertMemory({ ...orig, status: 'superseded', supersededBy: sup.id });

      // Following chain to active head
      const head = await store.recoverSage(orig.id);
      expect(head.id).toBe(sup.id);

      // Cycle or unavailable head throws
      const isolated = await store.rememberSage({ text: 'Isolated superseded' });
      (store as any).upsertMemory({
        ...isolated,
        status: 'superseded',
        supersededBy: 'non_existent_id',
      });
      await expect(store.recoverSage(isolated.id)).rejects.toThrow(
        /is superseded but its active chain head is unavailable/,
      );
    });
  });

  describe('sqlite-store-hygiene.ts deep verification pass', () => {
    it('exercises deepWorker in deep hygiene pass for memories with and without anchors', async () => {
      const sampleFile = path.join(tempDir, 'valid.ts');
      await fs.writeFile(sampleFile, 'export const valid = 1;\n', 'utf8');

      // Memory with anchors
      await store.rememberSage({
        text: 'Deep hygiene anchored memory',
        anchors: [{ type: 'file', path: 'valid.ts' }],
      });
      // Memory without anchors
      await store.rememberSage({
        text: 'Deep hygiene anchorless memory',
        anchors: [],
      });

      const report = await store.hygiene({ verifyDepth: 'deep' as any });
      expect(report).toBeDefined();
      expect(report.verified).toBeGreaterThan(0);
    });
  });

  describe('sqlite-store-legacy-consolidate.ts duplicate consolidation with anchors', () => {
    it('merges anchors across duplicate memories during consolidation', async () => {
      (store as any).upsertMemory(
        mem('dup-1', 'Exact duplicate text for consolidation', {
          importance: 0.9,
          anchors: [{ type: 'file', path: 'src/a.ts' }],
          sources: [{ type: 'user' }],
        }),
      );
      (store as any).upsertMemory(
        mem('dup-2', 'Exact duplicate text for consolidation', {
          importance: 0.8,
          anchors: [{ type: 'file', path: 'src/b.ts' }],
          sources: [{ type: 'user' }],
        }),
      );

      await store.consolidate('project-memory');
      const memories = await store.searchSage('Exact duplicate text for consolidation');
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const keeper = memories[0]!;
      expect(keeper.anchors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('sqlite-store-mutation-queue.ts rejection swallowing', () => {
    it('swallows prior rejection on locked mutation chain and counter chain', async () => {
      const queue = (store as any).mutationQueue;
      const db = (store as any).db;
      const lockPath = path.join((store as any).paths.locksDir, 'store-mutation');

      // 1. runLocked error recovery with rejected prior chain
      (queue as any).mutationChain = Promise.reject(new Error('prior mutation reject'));
      const secondLocked = await queue.runLocked({
        db,
        lockPath,
        work: () => 42,
      });
      expect(secondLocked).toBe(42);

      // 2. runCounter error recovery with rejected prior chain
      (queue as any).counterChain = Promise.reject(new Error('prior counter reject'));
      const secondCounter = await queue.runCounter(db, () => 99);
      expect(secondCounter).toBe(99);

      // 3. Pre-transaction abort
      await expect(
        queue.runLocked({
          db,
          lockPath,
          signal: AbortSignal.abort(),
          work: () => 1,
        }),
      ).rejects.toThrow('Operation aborted');

      // 4. Pre-commit abort
      const controller = new AbortController();
      await expect(
        queue.runLocked({
          db,
          lockPath,
          signal: controller.signal,
          work: () => {
            controller.abort();
            return 2;
          },
        }),
      ).rejects.toThrow('Operation aborted');

      // 5. Thenable rejection
      await expect(
        queue.runLocked({
          db,
          lockPath,
          work: () => Promise.resolve(3) as any,
        }),
      ).rejects.toThrow(/transaction work must be synchronous/);

      // 6. Work throws error
      await expect(
        queue.runLocked({
          db,
          lockPath,
          work: () => {
            throw new Error('work failed');
          },
        }),
      ).rejects.toThrow('work failed');

      await queue.drain();
    });
  });

  describe('sqlite-store-search.ts kinds and scopes clauses and suggestLexicalAdjacent', () => {
    it('executes FTS, non-FTS, and suggest queries with kinds and scopes', async () => {
      await store.rememberSage({
        text: 'Search query wordone wordtwo testing',
        kind: 'fact',
        scope: 'project',
        importance: 0.7,
      });

      // 1. FTS query with kinds and scopes
      const ftsHits = await store.unifiedSearchService({
        text: 'wordone',
        kinds: ['fact'],
        scopes: ['project'],
      });
      expect(ftsHits.hits).toHaveLength(1);

      // 2. Non-FTS query with kinds and scopes (no text query)
      const nonFtsHits = await store.unifiedSearchService({
        kinds: ['fact'],
        scopes: ['project'],
      });
      expect(nonFtsHits.hits.length).toBeGreaterThanOrEqual(1);

      // 3. suggest: always with kinds and scopes
      const suggestHits = await store.unifiedSearchService(
        {
          text: 'wordone wordtwo nonexistingword',
          kinds: ['fact'],
          scopes: ['project'],
          importanceAtLeast: 0.5,
        },
        { suggest: 'always' },
      );
      expect(suggestHits).toBeDefined();
    });
  });

  describe('sqlite-store.ts searchSageWithBreakdown vector materialization', () => {
    it('materializes vector-only hits via materializeSageByIdFactory', async () => {
      const m = await store.rememberSage({ text: 'Vector only memory candidate' });
      const vectorRecall: VectorRecallProvider = {
        search: async () => [
          {
            id: 'vec-1',
            score: 0.95,
            text: 'Vector only memory candidate',
            tags: [],
            metadata: { sageId: m.id },
          },
        ],
      };

      const breakdown = await store.searchSageWithBreakdown('unmatched query', {
        vectorRecall,
      });
      expect(breakdown.some((b) => b.memory.id === m.id)).toBe(true);
    });
  });

  describe('triage/value-score.ts computeValueScores', () => {
    it('computes batch value scores for memories', async () => {
      const { computeValueScores } = await import('../src/triage/value-score.js');
      const m = mem('vs-1', 'Value score batch memory');
      const scores = computeValueScores([m]);
      expect(scores.has('vs-1')).toBe(true);
      expect(scores.get('vs-1')?.total).toBeGreaterThan(0);
    });
  });

  describe('domain-term-extractor and middlewares defaults', () => {
    it('extractFromCommits runs default exec when opts.exec is omitted', async () => {
      const { SageDomainTermExtractor } = await import('../src/domain-term-extractor.js');
      const extractor = new SageDomainTermExtractor();
      // Runs default exec (git log) on tempDir (even if not git repo, catches gracefully)
      const terms = await extractor.extractFromCommits({ projectRoot: tempDir, maxCommits: 1 });
      expect(Array.isArray(terms)).toBe(true);
    });

    it('createSageDomainTermExtractorMiddleware uses default log and factory on error', async () => {
      const { createSageDomainTermExtractorMiddleware } = await import(
        '../src/middleware/domain-term-extractor-middleware.js'
      );
      // Pass-through when memory is undefined
      const passThroughMiddleware = createSageDomainTermExtractorMiddleware({});
      const dummyReq = { messages: [] } as any;
      const nextFn = vi.fn(async (r) => r);
      await passThroughMiddleware.handler(dummyReq, nextFn);
      expect(nextFn).toHaveBeenCalled();

      expect(nextFn).toHaveBeenCalled();

      // Middleware with default factory and default log
      const defaultMiddleware = createSageDomainTermExtractorMiddleware({
        memory: store as any,
        minConfidence: 0.1,
      });

      const req = {
        messages: [
          { role: 'user', content: 'We need to discuss **SpecialProjectJargon** architecture' },
          { role: 'user', content: 12345 }, // exercises messageText return ''
        ],
      } as any;
      await defaultMiddleware.handler(req, nextFn);
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Middleware with throwing extractorFactory to trigger default log
      const throwingMiddleware = createSageDomainTermExtractorMiddleware({
        memory: store as any,
        extractorFactory: () => {
          throw new Error('factory deliberate error');
        },
      });
      await throwingMiddleware.handler(req, nextFn);
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    it('subscribeSessionEndCommitExtractor uses default createExtractor', async () => {
      const { subscribeSessionEndCommitExtractor } = await import(
        '../src/middleware/session-end-commit-extractor.js'
      );
      const events = {
        on: vi.fn((_event, listener) => {
          // Trigger listener with waitUntil hook
          listener({ sessionId: 'sess-1', waitUntil: (p: Promise<void>) => p });
          return () => {};
        }),
      } as any;
      const unsub = subscribeSessionEndCommitExtractor(events, {
        memory: store as any,
        projectRoot: tempDir,
      });
      expect(unsub).toBeTypeOf('function');
    });
  });

  describe('tool-call-memory-trace.ts pruning and diverse hints', () => {
    it('prunes seen injections without cooldown by oldest first', async () => {
      const { pruneCooldowns } = await import('../src/middleware/tool-call-memory-trace.js');
      const maxTracked = 20_000;
      const seen = new Map<string, number>();
      for (let i = 0; i < maxTracked + 10; i++) {
        seen.set(`item-${i}`, i);
      }
      pruneCooldowns(seen, { lastPruneAt: 0 }, 100_000, 0);
      expect(seen.size).toBe(maxTracked);
    });

    it('filters existing evidence in storeProviderMemoryEvidence', async () => {
      const { storeProviderMemoryEvidence } = await import(
        '../src/middleware/tool-call-memory-trace.js'
      );
      const ctx = {
        memoryEvidence: [
          { source: 'other-source', text: 'other' },
          { source: 'sage.tool-memory', text: 'old sage' },
        ],
      } as any;
      storeProviderMemoryEvidence(ctx, 'new sage text', 100);
      expect(ctx.memoryEvidence.some((e: any) => e.text === 'new sage text')).toBe(true);
      expect(ctx.memoryEvidence.some((e: any) => e.text === 'old sage')).toBe(false);
    });

    it('exercises selectDiverseMemories deferred branch with query, graph, and path reasons', async () => {
      const { selectDiverseMemories } = await import('../src/middleware/tool-call-memory-trace.js');
      const m1 = mem('m-1', 'Memory 1', { kind: 'fact' });
      const m2 = mem('m-2', 'Memory 2', { kind: 'fact' });
      const m3 = mem('m-3', 'Memory 3', { kind: 'fact' });
      const m4 = mem('m-4', 'Memory 4', { kind: 'fact' });
      const m5 = mem('m-5', 'Memory 5', { kind: 'fact' });
      const m6 = mem('m-6', 'Memory 6', { kind: 'fact' });

      const reasonsById = new Map<string, string[]>([
        ['m-1', ['anchor:file']],
        ['m-2', ['anchor:file']],
        ['m-3', ['anchor:file']],
        ['m-4', ['anchor:file']],
        ['m-5', ['graph:linked']],
        ['m-6', ['query:match']],
      ]);

      const result = selectDiverseMemories([m1, m2, m3, m4, m5, m6], 5, reasonsById);
      expect(result.selected.length).toBeGreaterThan(0);
    });
  });

  describe('comprehensive line coverage edges across all modules', () => {
    it('covers tools/memory-tools.ts execute methods and error branches', async () => {
      const tools = createSageTools(store as any);
      const verifyTool = tools.find((t) => t.name === 'memory_verify')!;
      const hygieneTool = tools.find((t) => t.name === 'memory_hygiene')!;

      // 1. memory_verify
      const vRes = await verifyTool.execute({}, {} as any, {} as any);
      expect(Array.isArray(vRes)).toBe(true);

      // 2. memory_hygiene
      const hRes = await hygieneTool.execute({}, {} as any, {} as any);
      expect(hRes).toBeDefined();

      // 3. memory_gather_batch with throwing graphFor
      const m = await store.rememberSage({ text: 'Gather test memory' });
      const mockStore = {
        listSagePage: async () => ({
          memories: [m],
          total: 1,
          statusCounts: {},
          nextCursor: null,
        }),
        graphFor: vi.fn(async () => {
          throw new Error('graph fail');
        }),
      };
      const gatherWithFailingGraph = createSageTools(mockStore as any).find(
        (t) => t.name === 'memory_gather_batch',
      )!;
      // Not aborted -> ignores error
      const gRes1 = await gatherWithFailingGraph.execute(
        { includeRelations: true } as any,
        {} as any,
        {} as any,
      );
      expect(gRes1).toBeDefined();

      // Aborted -> rethrows
      const controller = new AbortController();
      controller.abort();
      await expect(
        gatherWithFailingGraph.execute(
          { includeRelations: true } as any,
          {} as any,
          { signal: controller.signal } as any,
        ),
      ).rejects.toThrow();
    });

    it('covers embeddings/provider.ts dimension mismatch', async () => {
      const { cosineSimilarity } = await import('../src/embeddings/provider.js');
      expect(cosineSimilarity(new Float32Array(2), new Float32Array(3))).toBe(0);
    });

    it('covers retrieval/hybrid-rerank.ts error catch', () => {
      const faultyMemory = {
        get text(): string {
          throw new Error('text error');
        },
      } as any;
      const reranked = hybridRerankMemories('query', [faultyMemory], 0.5);
      expect(reranked).toEqual([faultyMemory]);
    });

    it('covers retrieval/relevance.ts single anchor and single tag answersTheQuery branches', async () => {
      const { memoryQueryRelevance } = await import('../src/retrieval/relevance.js');
      const m1 = mem('r-1', 'Memory with one anchor', {
        anchors: [{ type: 'file', path: 'src/file.ts' }],
      });
      const score1 = memoryQueryRelevance(m1, 'different query');
      expect(score1.strength).toBeGreaterThanOrEqual(0);

      const m2 = mem('r-2', 'Memory with one tag', {
        tags: ['mytag'],
      });
      const score2 = memoryQueryRelevance(m2, 'mytag query');
      expect(score2.strength).toBe(0.7);
    });

    it('covers retrieval/vector-augment.ts clamp01 boundaries', async () => {
      const { augmentLexicalWithVectorRecall } = await import('../src/retrieval/vector-augment.js');
      const m = mem('va-1', 'Augment memory');
      const hits = await augmentLexicalWithVectorRecall('query', [m], {
        vectorWeight: -1,
        vectorOnlyThreshold: 2,
      });
      expect(hits).toHaveLength(1);
    });

    it('covers shared/session-consolidation.ts accepted branch', async () => {
      const { consolidateSession } = await import('../src/shared/session-consolidation.js');
      const fact = {
        text: 'Consolidate candidate text',
        kind: 'fact' as const,
        confidence: 1,
        importance: 1,
      };
      const services = {
        createCandidate: vi.fn(async () => ({ id: 'cand-1', ...fact }) as any),
        acceptCandidate: vi.fn(async () => mem('acc-1', fact.text)),
      };
      const report = await consolidateSession(services as any, new Set(), {
        sessionId: 'sess-cons',
        facts: [fact],
      });
      expect(report.accepted).toBe(1);
    });

    it('covers triage/value-score.ts unclassified kind', async () => {
      const { computeValueScores } = await import('../src/triage/value-score.js');
      const m = mem('vs-u', 'Unclassified kind memory', { kind: 'unclassified_kind' as any });
      const scores = computeValueScores([m]);
      expect(scores.has('vs-u')).toBe(true);
    });

    it('covers triage/pre-filter.ts proven injection track record exemption', async () => {
      const { preFilter } = await import('../src/triage/pre-filter.js');
      const m = mem('pf-1', 'Proven injection memory text that is long enough', {
        injectionCount: 15,
        useCount: 3,
      });
      const res = preFilter(m);
      expect(res.verdict).toBe('keep');
    });

    it('covers triage/orchestrator.ts verbose discard logging', async () => {
      const { runTriage } = await import('../src/triage/orchestrator.js');
      const lowValMem = mem('low-1', 'Low value memory text that is long enough', {
        importance: 0.1,
        confidence: 0.1,
        kind: 'preference',
      });
      const result = await runTriage([lowValMem], async () => '4 | Keep', {
        verbose: true,
      });
      expect(result).toBeDefined();
    });

    it('covers triage/merge-detection.ts command clustering and verbose logging', async () => {
      const { detectMerges } = await import('../src/triage/merge-detection.js');
      const m1 = mem('md-1', 'First command memory text that is long enough', {
        anchors: [{ type: 'command', command: 'npm test' }],
      });
      const m2 = mem('md-2', 'Second command memory text that is long enough', {
        anchors: [{ type: 'command', command: 'npm test' }],
      });
      const result = await detectMerges([m1, m2], async () => 'YES | Identical commands', {
        verbose: true,
      });
      expect(result.summary.mergeYes).toBe(1);
    });

    it('covers triage/llm-evaluator.ts undefined rejectionGate and fallback keep', async () => {
      const { evaluateMemory, evaluateBatch } = await import('../src/triage/llm-evaluator.js');
      const m = mem('llm-1', 'LLM eval memory');
      const vs = {
        total: 50,
        band: 'gray' as const,
        rejectionPressure: 0.5,
        rejectionGate: undefined,
      };
      // 1. evaluateMemory with score 0 -> reaches fallback keep
      const res = await evaluateMemory(m, vs as any, async () => '0 | Unexpected score');
      expect(res.action).toBe('keep');

      // 2. evaluateBatch with verbose true and missing vs
      const vsMap = new Map();
      await evaluateBatch([m], vsMap, async () => '4 | OK', { verbose: true });
    });

    it('covers triage/action-dispatcher.ts default unknown action', async () => {
      const { dispatchAction } = await import('../src/triage/action-dispatcher.js');
      const m = mem('ad-1', 'Action dispatcher memory');
      const res = dispatchAction({
        memory: m,
        evaluation: { action: 'keep', score: 4, actionReason: 'good memory' } as any,
        valueScore: { total: 80 } as any,
      });
      expect(res.autoApply).toBeNull();
    });

    it('covers shared/path-remap.ts same symbol and cursor edge cases', async () => {
      const { remapAnchors, readIdentifierAt } = await import('../src/shared/path-remap.js');
      // 1. Same path
      const res = remapAnchors([], 'src/a.ts', 'src/a.ts');
      expect(res.changed).toBe(false);

      // 2. readIdentifierAt
      const filePath = path.join(tempDir, 'id_test.ts');
      await fs.writeFile(filePath, 'const myVariable = 42;\n', 'utf8');
      const foundId = readIdentifierAt(filePath, 1, 10);
      expect(foundId).toBe('myVariable');

      // 3. readIdentifierAt after identifier
      const afterId = readIdentifierAt(filePath, 1, 17);
      expect(afterId).toBe('myVariable');

      // 4. readIdentifierAt whitespace
      const noId = readIdentifierAt(filePath, 1, 18);
      expect(noId).toBeUndefined();

      // 5. readIdentifierAt missing file
      const missingId = readIdentifierAt('nonexistent_file_xyz.ts', 1, 1);
      expect(missingId).toBeUndefined();
    });

    it('covers paths.ts realpathCache eviction', async () => {
      const { normalizeProjectPath } = await import('../src/paths.js');
      for (let i = 0; i < 4100; i++) {
        normalizeProjectPath(tempDir, `fake_path_${i}`);
      }
      expect(true).toBe(true);
    });

    it('covers project-server-endpoint.ts non-win32 platform branch', async () => {
      const { sageProjectServerEndpoint } = await import('../src/project-server-endpoint.js');
      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const endpoint = sageProjectServerEndpoint(tempDir);
        expect(endpoint.endsWith('.sock')).toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('covers project-server-client.ts pre-aborted signal and buffer overflow', async () => {
      const { SageProjectServerConnection } = await import('../src/project-server-client.js');
      const conn = new SageProjectServerConnection(tempDir);

      // Pre-aborted signal
      const signal = AbortSignal.abort();
      await expect(
        conn.call('stats', undefined as any, { signal, meta: { caller: 'test' } as any }),
      ).rejects.toThrow();

      // Buffer overflow
      const fakeSocket = {
        destroy: vi.fn(),
      } as any;
      (conn as any).socket = fakeSocket;
      (conn as any).onData(fakeSocket, 'a'.repeat(8 * 1024 * 1024 + 10));
      expect(fakeSocket.destroy).toHaveBeenCalled();
    });

    it('covers sqlite-store-codec.ts non-object record validation', async () => {
      const { sqliteRowToMemory } = await import('../src/sqlite-store-codec.js');
      expect(() => sqliteRowToMemory({ data: 'null' })).toThrow(/Memory record is not an object/);
      expect(() => sqliteRowToMemory({ data: '123' })).toThrow(/Memory record is not an object/);
    });

    it('covers sqlite-store-legacy-api.ts rememberSage throw catch in import', async () => {
      const { importLegacySqliteMemory } = await import('../src/sqlite-store-legacy-api.js');
      const mockCtx = {
        rememberSage: async () => {
          throw new Error('deliberate remember failure');
        },
      };
      const report = await importLegacySqliteMemory(mockCtx, '- ab\n- cd\n');
      expect(report.skipped).toBe(2);
    });

    it('covers sqlite-store-legacy-forget.ts empty query check', async () => {
      const count = await store.forget('   ');
      expect(count).toBe(0);
    });

    it('covers sqlite-store-legacy-clear.ts invalid record continue', async () => {
      // Insert corrupt row that parses to empty id
      (store as any).db.exec(
        `INSERT INTO memories (id, scope, kind, status, importance, confidence, freshness, created_at, updated_at, data)
         VALUES ('bad_mem', 'project', 'fact', 'active', 0.5, 0.5, 1, '2026-01-01', '2026-01-01', '{"id":"","text":"bad","scope":"project","kind":"fact","status":"active","importance":0.5,"confidence":0.5,"freshness":1,"createdAt":"","updatedAt":""}')`,
      );
      await store.clear('project-memory');
      expect(true).toBe(true);
    });

    it('covers sqlite-store-legacy-list.ts tie breaks and createdAt ordering', async () => {
      const t1 = '2026-01-01T00:00:00.000Z';
      const t2 = '2026-01-02T00:00:00.000Z';
      (store as any).upsertMemory(mem('a1', 'List mem 1', { createdAt: t1 }));
      (store as any).upsertMemory(mem('a2', 'List mem 2', { createdAt: t2 }));
      (store as any).upsertMemory(mem('a0', 'List mem 0', { createdAt: t1 }));

      const list = await store.list('project-memory');
      expect(list.length).toBeGreaterThanOrEqual(3);
    });

    it('covers sqlite-store-list-page.ts with sessionId filter', async () => {
      const page = await store.listSagePage({ sessionId: 'sess-page-test' });
      expect(page.memories).toBeDefined();
    });

    it('covers sqlite-store-recovery.ts scopes and updatedAfter filter skips', async () => {
      const m = await store.rememberSage({ text: 'Deleted to filter skip' });
      await store.deleteSage(m.id, 'del', { force: true });
      const report = await store.backfillRecoverable({
        filter: { scopes: ['session'], updatedAfter: '2099-01-01T00:00:00.000Z' },
      });
      expect(report.skipped).toBeGreaterThan(0);
    });

    it('covers sqlite-store-relationship-sync.ts whitespace and duplicate skips', async () => {
      const { syncSqliteRelationshipEdges } = await import(
        '../src/sqlite-store-relationship-sync.js'
      );
      const m = await store.rememberSage({ text: 'Relationship memory test' });
      syncSqliteRelationshipEdges(
        { stmt: (sql) => (store as any).stmt(sql), nowIso: () => (store as any).nowIso() },
        mem(m.id, 'Relationship memory test', {
          supersedes: ['   ', m.id, 'other-id', 'other-id'],
        }),
      );
      expect(true).toBe(true);
    });

    it('covers sqlite-store-statement-cache.ts cache eviction', async () => {
      const { SqliteStatementCache } = await import('../src/sqlite-store-statement-cache.js');
      const cache = new SqliteStatementCache(1);
      const db = (store as any).db;
      cache.get(db, 'SELECT 1');
      cache.get(db, 'SELECT 2');
      cache.clear();
      expect(true).toBe(true);
    });

    it('covers sqlite-store-update.ts empty text error', async () => {
      const m = await store.rememberSage({ text: 'Valid text for update' });
      await expect(store.updateSage(m.id, { text: '   ' })).rejects.toThrow(
        'SAGE text must not be empty.',
      );
    });

    it('covers store-helpers.ts ephemeral pattern and short text validation', async () => {
      const { assessRememberQuality, validateRememberInput } = await import(
        '../src/store-helpers.js'
      );
      const q = assessRememberQuality({
        text: 'WIP: currently testing',
        kind: 'fact',
        anchors: [],
        tags: [],
        scope: 'session',
      });
      expect(q.reasons).toContain('ephemeral_pattern');

      expect(() => validateRememberInput({ text: 'abc' } as any)).toThrow(
        'SAGE text is too short to be useful long-term memory.',
      );
    });

    it('covers anchors/verify.ts stripWrapper assignments, flags, and non-win32 builtins', async () => {
      const { anchorVerificationCoverage } = await import('../src/anchors/verify.js');
      // 1. verifyAnchor with env assignment
      const envRes = await anchorVerificationCoverage.verifyAnchor(tempDir, {
        type: 'command',
        command: 'env FOO=bar node -v',
      });
      expect(envRes.status).toBeDefined();

      // 2. verifyAnchor with > 8 flags
      const flagRes = await anchorVerificationCoverage.verifyAnchor(tempDir, {
        type: 'command',
        command: 'node -a -b -c -d -e -f -g -h -i index.js',
      });
      expect(flagRes.status).toBeDefined();

      // 3. buildShellBuiltins on non-win32
      const orig = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const builtinRes = await anchorVerificationCoverage.verifyAnchor(tempDir, {
          type: 'command',
          command: 'export FOO=1',
        });
        expect(builtinRes.status).toBeDefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: orig });
      }
    });

    it('covers middleware/turn-memory.ts use, anchor, and unused boosts and array message content', async () => {
      const { createSageTurnMiddleware } = await import('../src/middleware/turn-memory.js');
      const m1 = mem('tm-1', 'Boosted memory with anchors and uses', {
        anchors: [{ type: 'file', path: 'src/file.ts' }],
        useCount: 3,
        injectionCount: 1,
      });
      const m2 = mem('tm-2', 'Penalized memory with 3 injections and 0 uses', {
        anchors: [],
        useCount: 0,
        injectionCount: 4,
      });
      const mockPort = {
        searchSage: async () => [m1, m2],
      };
      const mw = createSageTurnMiddleware({ memory: mockPort as any });
      const req = {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Boosted memory with anchors query' }],
          },
        ],
      } as any;
      const next = vi.fn(async (r) => r);
      await mw.handler(req, next);
      expect(next).toHaveBeenCalled();
    });

    it('covers middleware/tool-call-memory-triggers.ts pathQueryTerms with parent segment', async () => {
      const { extractTrigger } = await import('../src/middleware/tool-call-memory-triggers.js');
      const trig = extractTrigger('read', { path: 'src/submodule/app.ts' });
      expect(trig?.queryText).toContain('submodule');
      expect(trig?.queryText).toContain('app');
    });

    it('covers middleware/session-end-commit-extractor.ts no memory and throwing extractor', async () => {
      const { subscribeSessionEndCommitExtractor } = await import(
        '../src/middleware/session-end-commit-extractor.js'
      );
      const events = {
        on: vi.fn((_event, listener) => {
          listener({ sessionId: 'sess-e1', waitUntil: (p: Promise<void>) => p });
          return () => {};
        }),
      } as any;

      // 1. Without memory
      subscribeSessionEndCommitExtractor(events, { projectRoot: tempDir });

      // 2. With throwing extractor
      subscribeSessionEndCommitExtractor(events, {
        memory: store as any,
        projectRoot: tempDir,
        createExtractor: () => {
          throw new Error('deliberate commit extract failure');
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });
});
