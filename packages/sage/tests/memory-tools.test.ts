import { describe, expect, it, vi } from 'vitest';
import type { SageServiceLike } from '../src/service-contract.js';
import { isSageService } from '../src/service-guard.js';
import { createSageTools } from '../src/tools/memory-tools.js';

function createMockService(): SageServiceLike {
  return {
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
        rankingApplied: 'hybrid',
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
    async searchSage() {
      return [];
    },
    async graphFor() {
      return [];
    },
    async verify() {
      return [];
    },
    async hygiene() {
      return {
        startedAt: '',
        completedAt: '',
        examined: 0,
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
      };
    },
    async listCandidates() {
      return [];
    },
    async createCandidate(input: { text: string }) {
      return { id: 'candidate_new', status: 'pending', text: input.text } as never;
    },
    async resolveCandidate(candidateId: string, decision: string) {
      return { candidateId, decision, applied: true } as never;
    },
    async acceptCandidate() {
      return undefined;
    },
    async rejectCandidate() {
      return false;
    },
    async rememberSage() {
      return { id: 'mem_new' } as never;
    },
    async updateSage() {
      return { id: 'mem_upd' } as never;
    },
    async deleteSage() {},
    async recoverSage() {
      return { id: 'mem_rec' } as never;
    },
    async backfillRecoverable() {
      return {
        startedAt: '',
        completedAt: '',
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
      // Minimal stub shape — only fields the tool's response type requires.
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
    async getSage() {
      return { id: 'mem_get' } as never;
    },
    async listSagePage() {
      return { memories: [], nextCursor: null, total: 0, statusCounts: {} };
    },
  };
}

describe('isSageService', () => {
  it('accepts the complete service contract', () => {
    expect(isSageService(createMockService())).toBe(true);
  });

  it('rejects partial duck types before their tools are exposed', () => {
    const partial = createMockService();
    delete (partial as unknown as Record<string, unknown>)['findMemoriesForFile'];

    expect(isSageService(partial)).toBe(false);
  });
});

describe('createSageTools', () => {
  it('returns 15 tools with correct names', () => {
    const service = createMockService();
    const tools = createSageTools(service);
    expect(tools).toHaveLength(15);
    expect(tools.map((t) => t.name)).toEqual([
      'memory_for_file',
      'memory_for_path',
      'memory_search',
      'memory_search_explain',
      'memory_graph',
      'memory_gather_batch',
      'memory_verify',
      'memory_hygiene',
      'memory_candidates',
      'remember',
      'forget',
      'memory_update',
      'memory_delete',
      'memory_recover',
      'memory_backfill_recoverable',
    ]);
  });

  it('all tools have expected shape', () => {
    const tools = createSageTools(createMockService());
    for (const tool of tools) {
      expect(tool.category).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });
});

describe('memory_for_file tool', () => {
  it('calls findMemoriesForFile with the provided path and cursor range, defaulting showSuperseded=true and showDeleted=false', async () => {
    const findMemoriesForFile = vi.fn().mockResolvedValue({
      filePath: 'src/file.ts',
      primaryMatches: [],
      symbolMatches: [],
      relatedMatches: [],
      totalCount: 0,
      activeCount: 0,
      supersededCount: 0,
      reviewPendingCount: 0,
    });
    const service = createMockService();
    service.findMemoriesForFile = findMemoriesForFile;

    const tool = createSageTools(service)[0]!;
    const signal = new AbortController().signal;
    await tool.execute(
      { path: 'src/file.ts', lineStart: 42, lineEnd: 60, limit: 5 },
      {} as never,
      { signal } as never,
    );

    expect(findMemoriesForFile).toHaveBeenCalledWith('src/file.ts', {
      lineStart: 42,
      lineEnd: 60,
      limit: 5,
      includeSuperseded: true, // default true
      includeDeleted: false, // default false
    });
  });

  it('omits lineStart/lineEnd when not provided and forwards showDeleted=true verbatim', async () => {
    const findMemoriesForFile = vi.fn().mockResolvedValue({
      filePath: 'src/x.ts',
      primaryMatches: [],
      symbolMatches: [],
      relatedMatches: [],
      totalCount: 0,
      activeCount: 0,
      supersededCount: 0,
      reviewPendingCount: 0,
    });
    const service = createMockService();
    service.findMemoriesForFile = findMemoriesForFile;

    const tool = createSageTools(service)[0]!;
    const signal = new AbortController().signal;
    await tool.execute(
      { path: 'src/x.ts', showDeleted: true, showSuperseded: false },
      {} as never,
      { signal } as never,
    );

    const call = findMemoriesForFile.mock.calls[0]!;
    expect(call[0]).toBe('src/x.ts');
    // Cursor fields must be absent (no undefined keys leaking through).
    expect('lineStart' in (call[1] as object)).toBe(false);
    expect('lineEnd' in (call[1] as object)).toBe(false);
    expect((call[1] as { includeSuperseded: boolean }).includeSuperseded).toBe(false);
    expect((call[1] as { includeDeleted: boolean }).includeDeleted).toBe(true);
  });

  it('throws on abort', async () => {
    const tool = createSageTools(createMockService())[0]!;
    const abort = new AbortController();
    abort.abort();
    await expect(
      tool.execute({ path: 'x' }, {} as never, { signal: abort.signal } as never),
    ).rejects.toThrow();
  });
});

describe('memory_for_path tool', () => {
  it('calls retrieveForPath with includeAncestors: true and default limit 20', async () => {
    const retrieveForPath = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.retrieveForPath = retrieveForPath;

    const tools = createSageTools(service);
    const tool = tools[1]!;
    await tool.execute(
      { path: 'src/' },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(retrieveForPath).toHaveBeenCalledWith({
      path: 'src/',
      limit: 20,
      includeAncestors: true,
    });
  });
});

describe('memory_search tool', () => {
  it('calls searchSage with limit default 20 and active only', async () => {
    const searchSage = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.searchSage = searchSage;

    const tools = createSageTools(service);
    const tool = tools[2]!;
    await tool.execute(
      { query: 'test query' },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(searchSage).toHaveBeenCalledWith('test query', {
      limit: 20,
      includeStatuses: ['active'],
    });
  });

  it('includes stale when include_stale is true', async () => {
    const searchSage = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.searchSage = searchSage;

    const tools = createSageTools(service);
    const tool = tools[2]!;
    await tool.execute(
      { query: 'test', include_stale: true },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(searchSage).toHaveBeenCalledWith('test', {
      limit: 20,
      includeStatuses: ['active', 'stale'],
    });
  });
});

describe('memory_graph tool', () => {
  it('calls graphFor with defaults', async () => {
    const graphFor = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.graphFor = graphFor;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_graph')!;
    await tool.execute(
      { query: 'test' },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(graphFor).toHaveBeenCalledWith('test', 2, 100);
  });
});

describe('memory_gather_batch tool', () => {
  it('calls listSagePage with provided filters and returns GatherBatchResult', async () => {
    const listSagePage = vi.fn().mockResolvedValue({
      memories: [
        { id: 'mem_1', text: 'Alpha', kind: 'fact', status: 'active' },
      ],
      nextCursor: null,
      total: 1,
      statusCounts: { active: 1 },
    });
    const service = createMockService();
    service.listSagePage = listSagePage;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_gather_batch')!;
    expect(tool.name).toBe('memory_gather_batch');

    const result = (await tool.execute(
      { kind: 'fact', limit: 10, includeRelations: false } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    )) as {
      memories: unknown[];
      relations: unknown[];
      relationsScannedAt: number;
      nextCursor: string | null;
      total: number;
    };

    expect(listSagePage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'fact', limit: 10 }),
    );
    expect(result.memories).toHaveLength(1);
    expect(result.relations).toEqual([]);
    expect(result.relationsScannedAt).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(result.total).toBe(1);
  });

  it('gathers graph relations by default and sets relationsScannedAt', async () => {
    const listSagePage = vi.fn().mockResolvedValue({
      memories: [
        { id: 'mem_1', text: 'First' },
        { id: 'mem_2', text: 'Second' },
      ],
      nextCursor: 'cursor_abc',
      total: 2,
      statusCounts: { active: 2 },
    });
    const graphFor = vi.fn().mockResolvedValue([
      { id: 'edge_1', sourceId: 'mem_1', targetId: 'mem_2', relation: 'related' },
    ]);
    const service = createMockService();
    service.listSagePage = listSagePage;
    service.graphFor = graphFor;

    const tool = createSageTools(service).find((t) => t.name === 'memory_gather_batch')!;
    const result = (await tool.execute(
      {} as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    )) as {
      relations: unknown[];
      relationsScannedAt: number;
      nextCursor: string | null;
    };

    expect(graphFor).toHaveBeenCalledTimes(2);
    expect(graphFor).toHaveBeenCalledWith('mem_1', 1, 100);
    expect(graphFor).toHaveBeenCalledWith('mem_2', 1, 100);
    expect(result.relations).toHaveLength(1);
    expect(result.relationsScannedAt).toBe(2);
    // nextCursor from page is forwarded
    expect(result.nextCursor).toBe('cursor_abc');
  });

  it('deduplicates graph edges via seen set', async () => {
    const listSagePage = vi.fn().mockResolvedValue({
      memories: [
        { id: 'mem_1', text: 'A' },
        { id: 'mem_2', text: 'B' },
      ],
      nextCursor: null,
      total: 2,
      statusCounts: { active: 2 },
    });
    // Both memories return the same edge id
    const graphFor = vi.fn().mockResolvedValue([
      { id: 'edge_shared', sourceId: 'mem_1', targetId: 'mem_2', relation: 'duplicate' },
    ]);
    const service = createMockService();
    service.listSagePage = listSagePage;
    service.graphFor = graphFor;

    const tool = createSageTools(service).find((t) => t.name === 'memory_gather_batch')!;
    const result = (await tool.execute(
      {} as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    )) as {
      relations: unknown[];
      relationsScannedAt: number;
    };

    // Only one copy of the shared edge, not two
    expect(result.relations).toHaveLength(1);
    expect(result.relationsScannedAt).toBe(2);
  });

  it('caps graph relation scan at BATCH_GRAPH_SCAN_LIMIT (10) memories', async () => {
    const memories = Array.from({ length: 15 }, (_, i) => ({
      id: `mem_${i + 1}`,
      text: `Memory ${i + 1}`,
    }));
    const listSagePage = vi.fn().mockResolvedValue({
      memories,
      nextCursor: null,
      total: 15,
      statusCounts: { active: 15 },
    });
    const graphFor = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.listSagePage = listSagePage;
    service.graphFor = graphFor;

    const tool = createSageTools(service).find((t) => t.name === 'memory_gather_batch')!;
    const result = (await tool.execute(
      {} as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    )) as {
      relations: unknown[];
      relationsScannedAt: number;
    };

    // Only first 10 memories scanned; last 5 untouched
    expect(graphFor).toHaveBeenCalledTimes(10);
    expect(graphFor).toHaveBeenCalledWith('mem_1', 1, 100);
    expect(graphFor).toHaveBeenCalledWith('mem_10', 1, 100);
    expect(graphFor).not.toHaveBeenCalledWith('mem_11', 1, 100);
    expect(result.relationsScannedAt).toBe(10);
  });

  it('swallows graphFor errors for individual memories', async () => {
    const listSagePage = vi.fn().mockResolvedValue({
      memories: [
        { id: 'mem_1', text: 'A' },
        { id: 'mem_2', text: 'B' },
      ],
      nextCursor: null,
      total: 2,
      statusCounts: { active: 2 },
    });
    const graphFor = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'edge_ok', sourceId: 'mem_1', targetId: 'mem_3', relation: 'r' }])
      .mockRejectedValueOnce(new Error('graph lookup failed'));
    const service = createMockService();
    service.listSagePage = listSagePage;
    service.graphFor = graphFor;

    const tool = createSageTools(service).find((t) => t.name === 'memory_gather_batch')!;
    const result = (await tool.execute(
      {} as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    )) as {
      relations: unknown[];
      relationsScannedAt: number;
    };

    // One edge from mem_1, mem_2's error swallowed
    expect(result.relations).toHaveLength(1);
    expect(result.relationsScannedAt).toBe(2);
  });

  it('throws on abort signal', async () => {
    const tool = createSageTools(createMockService()).find((t) => t.name === 'memory_graph')!;
    const abort = new AbortController();
    abort.abort();
    await expect(
      tool.execute({} as never, {} as never, { signal: abort.signal } as never),
    ).rejects.toThrow();
  });
});

describe('memory_verify tool', () => {
  it('calls verify with memory_id', async () => {
    const verify = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.verify = verify;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_verify')!;
    const signal = new AbortController().signal;
    await tool.execute({ memory_id: 'mem_123' }, {} as never, { signal } as never);

    expect(verify).toHaveBeenCalledWith('mem_123', signal);
  });

  it('calls verify without memory_id', async () => {
    const verify = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.verify = verify;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_verify')!;
    const signal = new AbortController().signal;
    await tool.execute({}, {} as never, { signal } as never);

    expect(verify).toHaveBeenCalledWith(undefined, signal);
  });
});

describe('memory_hygiene tool', () => {
  it('calls hygiene with options', async () => {
    const hygiene = vi.fn().mockResolvedValue({
      examined: 5,
      startedAt: '',
      completedAt: '',
      deduplicated: 0,
      superseded: 0,
      contradicted: 0,
      staled: 0,
      archived: 0,
      deleted: 0,
      verified: 0,
    });
    const service = createMockService();
    service.hygiene = hygiene;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_hygiene')!;
    const signal = new AbortController().signal;
    await tool.execute({ retentionDays: 30 }, {} as never, { signal } as never);

    expect(hygiene).toHaveBeenCalledWith({ retentionDays: 30 }, signal);
  });
});

describe('memory_candidates tool', () => {
  it('lists candidates by default', async () => {
    const listCandidates = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.listCandidates = listCandidates;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    const signal = new AbortController().signal;
    await tool.execute({}, {} as never, { signal } as never);

    expect(listCandidates).toHaveBeenCalledWith(false);
  });

  it('lists candidates with include_resolved', async () => {
    const listCandidates = vi.fn().mockResolvedValue([]);
    const service = createMockService();
    service.listCandidates = listCandidates;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    await tool.execute(
      { include_resolved: true },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(listCandidates).toHaveBeenCalledWith(true);
  });

  it('accepts a candidate', async () => {
    const acceptCandidate = vi.fn().mockResolvedValue({ id: 'mem_1', text: 'Accepted' });
    const service = createMockService();
    service.acceptCandidate = acceptCandidate;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    await tool.execute(
      { action: 'accept', candidate_id: 'cand_1' },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(acceptCandidate).toHaveBeenCalledWith('cand_1');
  });

  it('rejects a candidate', async () => {
    const rejectCandidate = vi.fn().mockResolvedValue(true);
    const service = createMockService();
    service.rejectCandidate = rejectCandidate;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    const result = await tool.execute(
      { action: 'reject', candidate_id: 'cand_1', reason: 'Not needed' },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(rejectCandidate).toHaveBeenCalledWith('cand_1', 'Not needed');
    expect(result).toEqual({ rejected: true });
  });

  it('validates candidate_id required for accept/reject', async () => {
    const tools = createSageTools(createMockService());
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    const errors = tool.validate?.({ action: 'accept' }) ?? [];
    expect(errors).toContain('candidate_id is required for accept or reject');
  });

  it('proposes a candidate with review metadata encoded on tags', async () => {
    const createCandidate = vi.fn().mockResolvedValue({ id: 'candidate_new', status: 'pending' });
    const service = createMockService();
    service.createCandidate = createCandidate;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    await tool.execute(
      {
        action: 'propose',
        text: 'Outdated convention about callbacks',
        kind: 'convention',
        reason: 'noise',
        suggested_action: 'delete',
        memory_id: 'mem_old',
      },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(createCandidate).toHaveBeenCalledWith({
      text: 'Outdated convention about callbacks',
      kind: 'convention',
      targetMemoryId: 'mem_old',
      reviewReason: 'noise',
      suggestedAction: 'delete',
    });
  });

  it('requires text for propose', async () => {
    const tools = createSageTools(createMockService());
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    const errors = tool.validate?.({ action: 'propose' }) ?? [];
    expect(errors).toContain('text is required for propose');
  });

  it('resolves a candidate by applying the decision to the target memory', async () => {
    const resolveCandidate = vi
      .fn()
      .mockResolvedValue({ candidateId: 'cand_1', decision: 'delete', applied: true });
    const service = createMockService();
    service.resolveCandidate = resolveCandidate;

    const tools = createSageTools(service);
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    const result = await tool.execute(
      { action: 'resolve', candidate_id: 'cand_1', decision: 'delete', reason: 'noise' },
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(resolveCandidate).toHaveBeenCalledWith('cand_1', 'delete', 'noise');
    expect(result).toEqual({ candidateId: 'cand_1', decision: 'delete', applied: true });
  });

  it('requires candidate_id and decision for resolve', async () => {
    const tools = createSageTools(createMockService());
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    expect(tool.validate?.({ action: 'resolve' }) ?? []).toContain(
      'candidate_id is required for resolve',
    );
    expect(tool.validate?.({ action: 'resolve', candidate_id: 'cand_1' }) ?? []).toContain(
      'decision is required for resolve (delete|archive|keep)',
    );
  });

  it('validation passes for accept with candidate_id', async () => {
    const tools = createSageTools(createMockService());
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    const errors = tool.validate?.({ action: 'accept', candidate_id: 'cand_1' }) ?? [];
    expect(errors).toHaveLength(0);
  });

  it('validation passes for list action', async () => {
    const tools = createSageTools(createMockService());
    const tool = tools.find((t) => t.name === 'memory_candidates')!;
    const errors = tool.validate?.({ action: 'list' }) ?? [];
    expect(errors).toHaveLength(0);
  });
});

describe('remember tool (structured write)', () => {
  it('forwards full structured args to rememberSage', async () => {
    const rememberSage = vi
      .fn()
      .mockResolvedValue({ id: 'mem_1', kind: 'decision', text: 'x', tags: [] });
    const service = createMockService();
    service.rememberSage = rememberSage;

    const tool = createSageTools(service).find((t) => t.name === 'remember')!;
    expect(tool.name).toBe('remember');
    await tool.execute(
      {
        text: 'Use pnpm v9',
        kind: 'convention',
        scope: 'project',
        tags: ['pnpm'],
        anchors: [{ type: 'file', path: 'package.json' }],
        audience: { roles: ['reviewer'] },
        importance: 0.9,
        supersedes: ['mem_old'],
      } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Use pnpm v9',
        kind: 'convention',
        scope: 'project',
        tags: ['pnpm'],
        anchors: [{ type: 'file', path: 'package.json' }],
        audience: { roles: ['reviewer'] },
        importance: 0.9,
        supersedes: ['mem_old'],
      }),
    );
  });

  it('auto-detects agent role from ctx.meta when no explicit audience is given', async () => {
    const rememberSage = vi
      .fn()
      .mockResolvedValue({ id: 'mem_2', kind: 'convention', text: 'x', tags: [] });
    const service = createMockService();
    service.rememberSage = rememberSage;

    const tool = createSageTools(service).find((t) => t.name === 'remember')!;
    await tool.execute(
      { text: 'Always verify migration reversibility.' } as never,
      { meta: { agentRole: 'reviewer' } } as never,
      { signal: new AbortController().signal } as never,
    );

    expect(rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Always verify migration reversibility.',
        audience: { roles: ['reviewer'] },
      }),
    );
  });

  it('does not auto-detect when ctx.meta has no agentRole (leader agent)', async () => {
    const rememberSage = vi
      .fn()
      .mockResolvedValue({ id: 'mem_3', kind: 'fact', text: 'x', tags: [] });
    const service = createMockService();
    service.rememberSage = rememberSage;

    const tool = createSageTools(service).find((t) => t.name === 'remember')!;
    await tool.execute(
      { text: 'General project note.' } as never,
      { meta: {} } as never,
      { signal: new AbortController().signal } as never,
    );

    expect(rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'General project note.',
        audience: undefined,
      }),
    );
  });

  it('explicit audience wins over auto-detected role', async () => {
    const rememberSage = vi
      .fn()
      .mockResolvedValue({ id: 'mem_4', kind: 'fact', text: 'x', tags: [] });
    const service = createMockService();
    service.rememberSage = rememberSage;

    const tool = createSageTools(service).find((t) => t.name === 'remember')!;
    await tool.execute(
      {
        text: 'Scoped memory.',
        audience: { roles: ['refactor-planner'], taskTypes: ['refactor'] },
      } as never,
      { meta: { agentRole: 'reviewer' } } as never,
      { signal: new AbortController().signal } as never,
    );

    expect(rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Scoped memory.',
        audience: { roles: ['refactor-planner'], taskTypes: ['refactor'] },
      }),
    );
  });

  it('no_auto_audience flag prevents auto-scoping despite having a role', async () => {
    const rememberSage = vi
      .fn()
      .mockResolvedValue({ id: 'mem_5', kind: 'fact', text: 'x', tags: [] });
    const service = createMockService();
    service.rememberSage = rememberSage;

    const tool = createSageTools(service).find((t) => t.name === 'remember')!;
    await tool.execute(
      { text: 'General note from a subagent.', no_auto_audience: true } as never,
      { meta: { agentRole: 'reviewer', mode: 'teach' } } as never,
      { signal: new AbortController().signal } as never,
    );

    expect(rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'General note from a subagent.',
        audience: undefined,
      }),
    );
  });
});

describe('forget tool', () => {
  it('calls forget with query and default scope', async () => {
    const forget = vi.fn().mockResolvedValue(2);
    const service = createMockService();
    service.forget = forget;

    const tool = createSageTools(service).find((t) => t.name === 'forget')!;
    expect(tool.name).toBe('forget');
    const result = await tool.execute(
      { query: 'stale note' } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(forget).toHaveBeenCalledWith('stale note', 'project-memory');
    expect(result).toEqual({ removed: 2, scope: 'project-memory' });
  });
});

describe('memory_update tool', () => {
  it('applies a patch by id and requires at least one field', async () => {
    const updateSage = vi
      .fn()
      .mockResolvedValue({ id: 'mem_1', kind: 'fact', status: 'stale', text: 'x' });
    const service = createMockService();
    service.updateSage = updateSage;

    const tool = createSageTools(service).find((t) => t.name === 'memory_update')!;
    expect(tool.name).toBe('memory_update');
    expect(tool.validate?.({ id: 'mem_1' } as never)).toContain(
      'at least one field to update is required',
    );

    await tool.execute(
      { id: 'mem_1', status: 'stale', tags: ['x'] } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    );
    expect(updateSage).toHaveBeenCalledWith('mem_1', { status: 'stale', tags: ['x'] });
  });
});

describe('memory_delete tool', () => {
  it('soft-deletes by id with force authorization', async () => {
    const deleteSage = vi.fn().mockResolvedValue(undefined);
    const service = createMockService();
    service.deleteSage = deleteSage;

    const tool = createSageTools(service).find((t) => t.name === 'memory_delete')!;
    expect(tool.name).toBe('memory_delete');
    const result = await tool.execute(
      { id: 'mem_1', reason: 'obsolete', force: true } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(deleteSage).toHaveBeenCalledWith('mem_1', 'obsolete', { force: true });
    expect(result).toEqual({ deleted: true, id: 'mem_1' });
  });

  it('rejects deletion without force', async () => {
    const tool = createSageTools(createMockService()).find((t) => t.name === 'memory_delete')!;
    const errors = tool.validate?.({ id: 'mem_1', reason: 'test' } as never) ?? [];
    expect(errors).toContain(
      'force: true is required to delete any memory. This prevents accidental or autonomous deletions. Pass force: true to authorize; the override is audit-logged. For non-destructive review, use memory_candidates({ action: "propose" }) instead.',
    );
  });

  it('safely executes memory tools without opts and falls back to ctx.signal', async () => {
    const service = createMockService();
    const tools = createSageTools(service);
    const ctx = {} as never;

    const rememberTool = tools.find((t) => t.name === 'remember')!;
    const searchTool = tools.find((t) => t.name === 'memory_search')!;
    const forgetTool = tools.find((t) => t.name === 'forget')!;

    const rememberRes = await Reflect.apply(rememberTool.execute, rememberTool, [
      { text: 'test note' },
      ctx,
    ]);
    expect(rememberRes).toHaveProperty('id');

    const searchRes = await Reflect.apply(searchTool.execute, searchTool, [{ query: 'test' }, ctx]);
    expect(Array.isArray(searchRes)).toBe(true);

    const forgetRes = await Reflect.apply(forgetTool.execute, forgetTool, [{ query: 'test' }, ctx]);
    expect(forgetRes).toHaveProperty('removed');

    const ac = new AbortController();
    ac.abort();
    const ctxWithSignal = { signal: ac.signal } as never;
    await expect(
      Reflect.apply(rememberTool.execute, rememberTool, [{ text: 'test note' }, ctxWithSignal]),
    ).rejects.toThrow();
  });
});



