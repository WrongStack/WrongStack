import { SAGE_SURFACE_CAPABILITY, type Sage, type SageSurface } from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import { runGatherCommand, runPathMemory } from '../src/slash-commands/memory-gather.js';

function sage(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem-1',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'A memory text long enough to matter for gather previews.',
    importance: 0.75,
    confidence: 0.6,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [{ type: 'user' }],
    createdAt: new Date('2026-08-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-08-01T00:00:00Z').toISOString(),
    ...overrides,
  } as Sage;
}

function page(memories: Sage[], extra: Partial<{ total: number; statusCounts: Record<string, number>; nextCursor: string | null }> = {}) {
  return {
    memories,
    nextCursor: null,
    total: memories.length,
    statusCounts: {},
    ...extra,
  };
}

describe('runPathMemory', () => {
  it('reports when the store exposes no SAGE surface', async () => {
    const out = await runPathMemory({ getCapability: () => undefined } as never, 'src/a.ts', false);
    expect(out.message).toContain('`/memory file` requires the SAGE backend');
  });

  it('reports when no memories are attached to the path', async () => {
    const retrieveForPath = vi.fn(async () => []);
    const store = {
      getCapability: (cap: unknown) => (cap === SAGE_SURFACE_CAPABILITY ? { retrieveForPath } : undefined),
    } as never;
    const out = await runPathMemory(store, 'src/empty.ts', true);
    expect(out.message).toBe('No SAGE entries are attached to src/empty.ts.');
    expect(retrieveForPath).toHaveBeenCalledWith({ path: 'src/empty.ts', limit: 20, includeAncestors: true });
  });

  it('lists memories with tags and the first anchor that has a path, symbol, or command', async () => {
    const retrieveForPath = vi.fn(async () => [
      sage({ id: 'm1', text: 'Uses pnpm.', tags: ['build', 'pnpm'], anchors: [{ type: 'file', path: 'src/a.ts' }] }),
      sage({
        id: 'm2',
        text: 'Uses tsx.',
        anchors: [{ type: 'command', command: 'pnpm build' }],
      }),
      sage({ id: 'm3', text: 'No anchor here.', anchors: [] }),
    ]);
    const store = {
      getCapability: (cap: unknown) => (cap === SAGE_SURFACE_CAPABILITY ? { retrieveForPath } : undefined),
    } as never;
    const out = await runPathMemory(store, 'src/a.ts', false);
    expect(out.message).toContain('## SAGE for src/a.ts');
    expect(out.message).toContain('- [fact|active] Uses pnpm. #build #pnpm');
    expect(out.message).toContain('anchor: src/a.ts');
    expect(out.message).toContain('anchor: pnpm build');
    expect(out.message).toContain('- [fact|active] No anchor here.');
  });
});

describe('runGatherCommand', () => {
  function makeSage(opts: {
    listSagePage?: ReturnType<typeof vi.fn>;
    graphFor?: (id: string, depth: number, limit: number) => Promise<Array<{ from: string; to: string; relation: string }>>;
  } = {}) {
    const listSagePage =
      opts.listSagePage ??
      vi.fn(async () => page([sage()]));
    const surface = {
      listSagePage,
      ...(opts.graphFor ? { graphFor: opts.graphFor } : {}),
    } as unknown as SageSurface;
    return { surface, listSagePage };
  }

  it('reports when the surface or its listSagePage is missing', async () => {
    expect((await runGatherCommand(null, [])).message).toContain('`/memory gather` requires the SAGE backend');
    expect((await runGatherCommand({} as SageSurface, [])).message).toContain(
      '`/memory gather` requires the SAGE backend',
    );
  });

  it('applies default filters: active status, admin session scope, limit 50', async () => {
    const { surface, listSagePage } = makeSage();
    const out = await runGatherCommand(surface, []);
    expect(listSagePage).toHaveBeenCalledWith({
      statuses: ['active'],
      kind: undefined,
      query: undefined,
      limit: 50,
      includeAllSessions: true,
    });
    expect(out.message).toContain('## 📋 Memory Gather — 1 matched');
    expect(out.message).toContain('Filter: status=active');
  });

  it('joins free-form tokens into the query filter', async () => {
    const { surface, listSagePage } = makeSage();
    await runGatherCommand(surface, ['pnpm', 'workspace', 'setup']);
    expect(listSagePage.mock.calls[0]?.[0]?.query).toBe('pnpm workspace setup');
  });

  it('passes a valid --status and --kind through to the listing', async () => {
    const { surface, listSagePage } = makeSage();
    await runGatherCommand(surface, ['--status', 'stale', '--kind', 'decision', 'alpha']);
    expect(listSagePage.mock.calls[0]?.[0]?.statuses).toEqual(['stale']);
    expect(listSagePage.mock.calls[0]?.[0]?.kind).toBe('decision');
    expect(listSagePage.mock.calls[0]?.[0]?.query).toBe('alpha');
  });

  it('rejects an invalid --status with the allowed values', async () => {
    const { surface, listSagePage } = makeSage();
    const out = await runGatherCommand(surface, ['--status', 'bogus']);
    expect(out.message).toContain('Invalid --status "bogus"');
    expect(out.message).toContain('active, stale, superseded, contradicted, archived, deleted');
    expect(listSagePage).not.toHaveBeenCalled();
  });

  it('rejects an invalid --kind with the allowed values', async () => {
    const { surface } = makeSage();
    const out = await runGatherCommand(surface, ['--kind', 'bogus']);
    expect(out.message).toContain('Invalid --kind "bogus"');
    expect(out.message).toContain('Valid: fact, decision, convention');
  });

  it('clamps --limit into the 1..500 window', async () => {
    const big = makeSage();
    await runGatherCommand(big.surface, ['--limit', '999']);
    expect(big.listSagePage.mock.calls[0]?.[0]?.limit).toBe(500);

    const small = makeSage();
    await runGatherCommand(small.surface, ['--limit', '1']);
    expect(small.listSagePage.mock.calls[0]?.[0]?.limit).toBe(1);
  });

  it('collects value errors and unknown flags into one message', async () => {
    const { surface } = makeSage();
    const out = await runGatherCommand(surface, ['--limit', '--status', '--kind', 'x', '--bogus']);
    expect(out.message).toContain('- --limit needs a value between 1 and 500.');
    expect(out.message).toContain('- --status needs a value.');
    expect(out.message).toContain('- Unknown flag "--bogus".');
    // 'x' was consumed as the --kind value, so flag errors return before
    // kind validation can reject it.
    expect(out.message).not.toContain('Invalid --kind');
  });

  it('reports --kind and --status missing values when they end the args', async () => {
    const { surface } = makeSage();
    const kind = await runGatherCommand(surface, ['--kind']);
    const status = await runGatherCommand(surface, ['--status']);
    expect(kind.message).toContain('- --kind needs a value.');
    expect(status.message).toContain('- --status needs a value.');
  });

  it('rejects non-numeric and sub-1 --limit values', async () => {
    const { surface } = makeSage();
    const words = await runGatherCommand(surface, ['--limit', 'abc']);
    const zero = await runGatherCommand(surface, ['--limit', '0']);
    expect(words.message).toContain('--limit must be a positive integer (got "abc").');
    expect(zero.message).toContain('--limit must be a positive integer (got "0").');
  });

  it('reports when nothing matches', async () => {
    const { surface } = makeSage({ listSagePage: vi.fn(async () => page([])) });
    const out = await runGatherCommand(surface, ['--status', 'archived']);
    expect(out.message).toBe('No memories matched the gather criteria.');
  });

  it('renders status counts, preview truncation, and paging hints', async () => {
    const long = sage({ id: 'm-long', text: 'x'.repeat(140) });
    const { surface } = makeSage({
      listSagePage: vi.fn(async () => page([long], { total: 12, statusCounts: { active: 9, stale: 3 } })),
    });
    const out = await runGatherCommand(surface, []);
    expect(out.message).toContain('## 📋 Memory Gather — 12 matched');
    expect(out.message).toContain('Status counts: active: 9, stale: 3');
    expect(out.message).toContain(`${'x'.repeat(118)}…`);
    expect(out.message).toContain('*Showing 1 of 12 — use --limit 100 for more*');
  });

  it('omits the paging hint when everything fits on the page', async () => {
    const { surface } = makeSage();
    const out = await runGatherCommand(surface, []);
    expect(out.message).not.toContain('use --limit');
  });

  it('notes when --relations is requested but the backend lacks graphFor', async () => {
    const { surface } = makeSage();
    const out = await runGatherCommand(surface, ['--relations']);
    expect(out.message).toContain('*(Relations requested but graphFor is not available on this backend)*');
  });

  it('deduplicates relation edges across scanned memories', async () => {
    const memories = [
      sage({ id: 'm1' }),
      sage({ id: 'm2' }),
      sage({ id: 'm3', text: 'third memory that also links the same pair' }),
    ];
    const graphFor = vi.fn(async (id: string) =>
      id === 'm3'
        ? [{ from: 'm1', to: 'm2', relation: 'relates_to' }]
        : [
            { from: 'm1', to: 'm2', relation: 'relates_to' },
            { from: id, to: 'm9', relation: 'supersedes' },
          ],
    );
    const { surface } = makeSage({
      listSagePage: vi.fn(async () => page(memories)),
      graphFor: graphFor as never,
    });
    const out = await runGatherCommand(surface, ['--relations']);
    expect(out.message).toContain('### 🔗 Relations (first page)');
    expect(out.message).toContain('m1 —[relates_to]→ m2');
    expect(out.message).toContain('m1 —[supersedes]→ m9');
    expect(out.message).toContain('m2 —[supersedes]→ m9');
    expect(out.message.match(/m1 —\[relates_to\]→ m2/g)).toHaveLength(1);
  });

  it('keeps going when a graphFor call fails mid-scan', async () => {
    const graphFor = vi.fn(async (id: string) => {
      if (id === 'm1') throw new Error('graph db busy');
      return [{ from: 'm2', to: 'm3', relation: 'relates_to' }];
    });
    const { surface } = makeSage({
      listSagePage: vi.fn(async () => page([sage({ id: 'm1' }), sage({ id: 'm2' })])),
      graphFor: graphFor as never,
    });
    const out = await runGatherCommand(surface, ['--relations']);
    expect(out.message).toContain('m2 —[relates_to]→ m3');
    expect(out.message).not.toContain('graph db busy');
  });

  it('caps the relation scan at 10 memories', async () => {
    const memories = Array.from({ length: 14 }, (_, i) => sage({ id: `m${i}` }));
    const graphFor = vi.fn(async (id: string) => [{ from: id, to: 'x', relation: 'r' }]);
    const { surface } = makeSage({
      listSagePage: vi.fn(async () => page(memories)),
      graphFor: graphFor as never,
    });
    await runGatherCommand(surface, ['--relations']);
    expect(graphFor).toHaveBeenCalledTimes(10);
  });

  it('surfaces listing failures as a gather-failed message', async () => {
    const { surface } = makeSage({
      listSagePage: vi.fn(async () => {
        throw new Error('sqlite locked');
      }),
    });
    const out = await runGatherCommand(surface, []);
    expect(out.message).toBe('gather failed: sqlite locked');
  });
});
