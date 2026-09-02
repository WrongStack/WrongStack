import type { Sage } from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import { runTriageCommand } from '../src/slash-commands/memory-triage.js';

let nextId = 0;

function sage(overrides: Partial<Sage> = {}): Sage {
  nextId += 1;
  return {
    id: `mem-${nextId}`,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'A deliberately long enough memory text so the triage pre-filter keeps it uncertain.',
    importance: 0.5,
    confidence: 0.7,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [{ type: 'user' }],
    createdAt: new Date('2026-08-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-08-01T00:00:00Z').toISOString(),
    ...overrides,
  } as Sage;
}

interface Recorded {
  listSagePage: Array<{
    statuses?: string[];
    limit?: number;
    cursor?: unknown;
    includeAllSessions?: boolean;
  }>;
  updateSage: Array<{ id: string; patch: Record<string, unknown> }>;
  createCandidate: Array<Record<string, unknown>>;
}

interface Page {
  memories: Sage[];
  nextCursor?: string | undefined;
}

function makeSurface(
  pages: Page[],
  opts: { updateSageImpl?: (id: string, patch: Record<string, unknown>) => Promise<unknown> } = {},
) {
  const recorded: Recorded = { listSagePage: [], updateSage: [], createCandidate: [] };
  let call = 0;
  const surface = {
    listSagePage: async (options: {
      statuses?: string[];
      limit?: number;
      cursor?: unknown;
      includeAllSessions?: boolean;
    }) => {
      recorded.listSagePage.push(options);
      const page = pages[Math.min(call, pages.length - 1)] ?? { memories: [] };
      call += 1;
      return page;
    },
    updateSage: async (id: string, patch: Record<string, unknown>) => {
      recorded.updateSage.push({ id, patch });
      return opts.updateSageImpl ? opts.updateSageImpl(id, patch) : { ok: true };
    },
    createCandidate: async (input: Record<string, unknown>) => {
      recorded.createCandidate.push(input);
      return { id: `cand-${recorded.createCandidate.length}` };
    },
    listCandidates: async () => [],
  };
  return { surface, recorded };
}

function makePort(surface: unknown) {
  // The wrapper resolves the surface via require()'d getSageSurface, which
  // runs from Node's native module registry — its capability object is a
  // different instance from anything the Vitest runner imports. A fake port
  // has exactly one capability, so hand the surface out for any lookup.
  return {
    getCapability: () => surface,
  } as never;
}

function ctxWith(surface: unknown, extra: Record<string, unknown> = {}) {
  return { memoryStore: makePort(surface), ...extra } as never;
}

describe('runTriageCommand', () => {
  it('reports when no memory store is configured', async () => {
    const out = await runTriageCommand({} as never, []);
    expect(out.message).toBe('No SAGE surface available.');
  });

  it('reports when the store exposes no SAGE surface capability', async () => {
    const out = await runTriageCommand(
      { memoryStore: { getCapability: () => undefined } } as never,
      [],
    );
    expect(out.message).toBe('No SAGE surface available.');
  });

  describe('flag parsing', () => {
    it('rejects an unknown flag with usage help', async () => {
      const { surface } = makeSurface([{ memories: [] }]);
      const out = await runTriageCommand(ctxWith(surface), ['--bogus']);
      expect(out.message).toContain('Unknown flag "--bogus".');
      expect(out.message).toContain(
        'Usage: /memory triage [--dry-run|--apply] [--limit N] [--max-phase3 N] [--max-phase4-pairs N]',
      );
    });

    it('collects every flag error into one message', async () => {
      const { surface } = makeSurface([{ memories: [] }]);
      const out = await runTriageCommand(ctxWith(surface), ['--bogus', '--limit']);
      expect(out.message).toContain('- Unknown flag "--bogus".');
      expect(out.message).toContain('- --limit needs a value.');
    });

    it('ignores positional tokens while parsing flags', async () => {
      const { surface } = makeSurface([{ memories: [sage()] }]);
      const out = await runTriageCommand(ctxWith(surface), ['extra', 'tokens', '--dry-run']);
      expect(out.message).toContain('# Triage Report');
    });

    for (const flag of ['limit', 'max-phase3', 'max-phase4-pairs']) {
      it(`--${flag} requires a value`, async () => {
        const { surface } = makeSurface([{ memories: [] }]);
        const out = await runTriageCommand(ctxWith(surface), [`--${flag}`]);
        expect(out.message).toContain(`--${flag} needs a value.`);
      });

      it(`--${flag} rejects a following flag as its value`, async () => {
        const { surface } = makeSurface([{ memories: [] }]);
        const out = await runTriageCommand(ctxWith(surface), [`--${flag}`, '--apply']);
        expect(out.message).toContain(`--${flag} needs a value.`);
      });

      it(`--${flag} rejects non-numeric and sub-1 values`, async () => {
        const { surface } = makeSurface([{ memories: [] }]);
        const words = await runTriageCommand(ctxWith(surface), [`--${flag}`, 'abc']);
        const zero = await runTriageCommand(ctxWith(surface), [`--${flag}`, '0']);
        expect(words.message).toContain(`--${flag} must be a positive integer (got "abc").`);
        expect(zero.message).toContain(`--${flag} must be a positive integer (got "0").`);
      });
    }

    it('accepts explicit numeric values for all numeric flags', async () => {
      const { surface } = makeSurface([{ memories: [sage()] }]);
      const out = await runTriageCommand(ctxWith(surface), [
        '--limit',
        '5',
        '--max-phase3',
        '2',
        '--max-phase4-pairs',
        '3',
      ]);
      expect(out.message).toContain('# Triage Report');
    });
  });

  it('short-circuits when there are no active memories', async () => {
    const { surface, recorded } = makeSurface([{ memories: [] }]);
    const out = await runTriageCommand(ctxWith(surface), []);
    expect(out.message).toBe('No active memories to triage.');
    expect(recorded.listSagePage[0]?.statuses).toEqual(['active', 'stale']);
    expect(recorded.listSagePage[0]?.includeAllSessions).toBe(true);
  });

  it('dry-run (default) renders the triage report without touching the store', async () => {
    const { surface, recorded } = makeSurface([{ memories: [sage()] }]);
    const out = await runTriageCommand(ctxWith(surface), []);
    expect(out.message).toContain('# Triage Report');
    expect(out.message).toContain('**Mode:** dry-run');
    expect(out.message).not.toContain('## Apply Results');
    expect(recorded.updateSage).toHaveLength(0);
  });

  it('explicit --dry-run behaves the same as the default', async () => {
    const { surface } = makeSurface([{ memories: [sage()] }]);
    const out = await runTriageCommand(ctxWith(surface), ['--dry-run']);
    expect(out.message).toContain('**Mode:** dry-run');
  });

  it('pages through all active memories when no limit is set', async () => {
    const { surface, recorded } = makeSurface([
      { memories: [sage()], nextCursor: 'page-2' },
      { memories: [sage()], nextCursor: 'page-3' },
      { memories: [sage()] },
    ]);
    const out = await runTriageCommand(ctxWith(surface), []);
    expect(out.message).toContain('- Input: 3 memories');
    expect(recorded.listSagePage).toHaveLength(3);
    expect(recorded.listSagePage[1]?.cursor).toBe('page-2');
    expect(recorded.listSagePage[2]?.cursor).toBe('page-3');
  });

  it('stops paging once the limit is reached and slices the excess', async () => {
    const { surface, recorded } = makeSurface([
      { memories: [sage(), sage(), sage()], nextCursor: 'page-2' },
      { memories: [sage(), sage()] },
    ]);
    const out = await runTriageCommand(ctxWith(surface), ['--limit', '4']);
    expect(out.message).toContain('- Input: 4 memories');
    expect(recorded.listSagePage).toHaveLength(2);
    expect(recorded.listSagePage[0]?.limit).toBe(4);
    expect(recorded.listSagePage[1]?.limit).toBe(1);
  });

  it('clamps --limit above 500 down to the page ceiling', async () => {
    const { surface, recorded } = makeSurface([{ memories: [sage()] }]);
    await runTriageCommand(ctxWith(surface), ['--limit', '999']);
    expect(recorded.listSagePage[0]?.limit).toBe(500);
  });

  it('wires the provider transport with the configured model and compact decoding params', async () => {
    const grayish = sage({
      anchors: [{ type: 'symbol', path: 'src/a.ts', symbol: 'alpha' }],
      tags: ['area:x'],
      importance: 0.55,
      confidence: 0.5,
    });
    const { surface } = makeSurface([{ memories: [grayish] }]);
    const provider = {
      complete: vi.fn(async () => ({ content: [{ type: 'text', text: '5 | essential' }] })),
    };
    const out = await runTriageCommand(
      ctxWith(surface, { llmProvider: provider, llmModel: 'triage-model' }),
      [],
    );
    expect(out.message).toContain('# Triage Report');
    if (provider.complete.mock.calls.length > 0) {
      const [request, options] = provider.complete.mock.calls[0] as unknown as [
        { model: string; maxTokens: number; temperature: number },
        { signal: AbortSignal },
      ];
      expect(request.model).toBe('triage-model');
      expect(request.maxTokens).toBe(60);
      expect(request.temperature).toBeCloseTo(0.1);
      expect(options.signal.aborted).toBe(false);
    }
  });

  it('filters non-text blocks out of the provider response', async () => {
    const grayish = sage({
      anchors: [{ type: 'symbol', path: 'src/a.ts', symbol: 'alpha' }],
      tags: ['area:x'],
      importance: 0.55,
      confidence: 0.5,
    });
    const { surface, recorded } = makeSurface([{ memories: [grayish] }]);
    const provider = {
      complete: vi.fn(async () => ({
        content: [
          { type: 'image', data: '...' } as never,
          { type: 'text', text: '  2 | transient  ' },
        ],
      })),
    };
    await runTriageCommand(ctxWith(surface, { llmProvider: provider }), ['--apply']);
    // Score 2 on a gray memory → stale auto-apply: updateSage must have fired.
    expect(recorded.updateSage.length).toBeGreaterThanOrEqual(1);
  });

  it('apply mode executes auto-apply updates through the surface', async () => {
    // Unanchored gray memory scores 35/100, so an LLM "3 | niche" rating
    // resolves to the stale action (status patch + confidence lowered to 0.4).
    const grayish = sage({ importance: 0.55, confidence: 0.5 });
    const { surface, recorded } = makeSurface([{ memories: [grayish] }]);
    const provider = {
      complete: vi.fn(async () => ({ content: [{ type: 'text', text: '3 | niche' }] })),
    };
    const out = await runTriageCommand(ctxWith(surface, { llmProvider: provider }), ['--apply']);
    expect(out.message).toContain('## Apply Results');
    expect(out.message).toContain('**Auto-apply:** 1 succeeded, 0 failed');
    expect(recorded.updateSage.length).toBeGreaterThanOrEqual(1);
    const statusPatch = recorded.updateSage.find((c) => c.patch.status !== undefined);
    expect(statusPatch?.patch.status).toBe('stale');
  });

  it('apply mode counts update failures per memory and keeps going', async () => {
    const a = sage({ importance: 0.55, confidence: 0.5 });
    const b = sage({ importance: 0.55, confidence: 0.5 });
    const { surface } = makeSurface([{ memories: [a, b] }], {
      updateSageImpl: async (id) => {
        throw new Error(`sqlite locked for ${id}`);
      },
    });
    const provider = {
      complete: vi.fn(async () => ({ content: [{ type: 'text', text: '3 | niche' }] })),
    };
    const out = await runTriageCommand(ctxWith(surface, { llmProvider: provider }), ['--apply']);
    expect(out.message).toContain('✗ Failed to update');
    expect(out.message).toContain('sqlite locked');
    expect(out.message).toContain('**Auto-apply:** 0 succeeded, 2 failed');
  });

  it('apply mode executes LLM-approved merges: supersede the older memory', async () => {
    const older = sage({
      id: 'older',
      text: 'The build pipeline uses pnpm v9 with strict peer dependencies.',
      anchors: [{ type: 'file', path: 'docs/build.md' }],
      createdAt: new Date('2026-06-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-06-01T00:00:00Z').toISOString(),
    });
    const newer = sage({
      id: 'newer',
      text: 'The build pipeline uses pnpm v9 with strict peer dependency checks enabled.',
      anchors: [{ type: 'file', path: 'docs/build.md' }],
      createdAt: new Date('2026-07-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-07-01T00:00:00Z').toISOString(),
    });
    const { surface, recorded } = makeSurface([{ memories: [older, newer] }]);
    const provider = {
      complete: vi.fn(async (req: { system: Array<{ type: string; text: string }> }) => {
        const system = req.system?.map((b) => ('text' in b ? b.text : '')).join(' ') ?? '';
        const text = system.includes('same fact') ? 'YES' : '3 | neutral';
        return { content: [{ type: 'text', text }] };
      }),
    };
    const out = await runTriageCommand(ctxWith(surface, { llmProvider: provider }), ['--apply']);
    expect(out.message).toContain('**Merges:**');
    const superseded = recorded.updateSage.find((c) => c.patch.status === 'superseded');
    const keeper = recorded.updateSage.find((c) => Array.isArray(c.patch.supersedes));
    expect(superseded).toBeDefined();
    expect(keeper).toBeDefined();
    if (superseded && keeper) {
      expect(['older', 'newer']).toContain(superseded.id);
      expect(keeper.id).not.toBe(superseded.id);
      expect(keeper.patch.supersedes).toEqual([superseded.id]);
    }
  });

  it('apply mode reports merge failures without aborting the run', async () => {
    const older = sage({
      id: 'older',
      text: 'The build pipeline uses pnpm v9 with strict peer dependencies.',
      anchors: [{ type: 'file', path: 'docs/build.md' }],
      createdAt: new Date('2026-06-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-06-01T00:00:00Z').toISOString(),
    });
    const newer = sage({
      id: 'newer',
      text: 'The build pipeline uses pnpm v9 with strict peer dependency checks enabled.',
      anchors: [{ type: 'file', path: 'docs/build.md' }],
      createdAt: new Date('2026-07-01T00:00:00Z').toISOString(),
      updatedAt: new Date('2026-07-01T00:00:00Z').toISOString(),
    });
    const { surface } = makeSurface([{ memories: [older, newer] }], {
      updateSageImpl: async () => {
        throw new Error('merge write failed');
      },
    });
    const provider = {
      complete: vi.fn(async (req: { system: Array<{ type: string; text: string }> }) => {
        const system = req.system?.map((b) => ('text' in b ? b.text : '')).join(' ') ?? '';
        const text = system.includes('same fact') ? 'YES' : '3 | neutral';
        return { content: [{ type: 'text', text }] };
      }),
    };
    const out = await runTriageCommand(ctxWith(surface, { llmProvider: provider }), ['--apply']);
    expect(out.message).toContain('✗ Failed to merge older → newer');
    expect(out.message).toContain('**Merges:** 0 succeeded, 1 failed');
  });

  it('falls back to a neutral LLM (score 3) when no provider is configured', async () => {
    const { surface, recorded } = makeSurface([{ memories: [sage()] }]);
    const out = await runTriageCommand(ctxWith(surface), ['--apply']);
    expect(out.message).toContain('## Apply Results');
    // Neutral "3" on a sub-50 gray memory resolves to the stale action, so the
    // fallback still performs auto-apply updates — it only skips Phase 4 merges.
    expect(out.message).toContain('**Auto-apply:** 1 succeeded, 0 failed');
    expect(out.message).toContain('**Merges:** 0 succeeded, 0 failed');
    expect(recorded.updateSage[0]?.patch.status).toBe('stale');
  });

  it('files proposals as memory candidates during apply', async () => {
    const grayish = sage({ importance: 0.55, confidence: 0.5 });
    const { surface, recorded } = makeSurface([{ memories: [grayish] }]);
    const provider = {
      complete: vi.fn(async () => ({ content: [{ type: 'text', text: '1 | noise' }] })),
    };
    const out = await runTriageCommand(ctxWith(surface, { llmProvider: provider }), ['--apply']);
    // Score 1 → propose_archive: one candidate filed with the triage tag.
    expect(out.message).toContain('**Proposals:** 1 of 1 filed');
    expect(out.message).toContain('`/memory candidates`');
    expect(recorded.createCandidate).toHaveLength(1);
    expect(recorded.createCandidate[0]?.tags).toEqual(['triage']);
    expect(recorded.createCandidate[0]?.kind).toBe('memory_review');
  });

  it('reports proposal filing failures per memory', async () => {
    const grayish = sage({ importance: 0.55, confidence: 0.5 });
    const { surface } = makeSurface([{ memories: [grayish] }]);
    (surface as { createCandidate: (input: unknown) => Promise<unknown> }).createCandidate =
      async () => {
        throw new Error('candidate table locked');
      };
    const provider = {
      complete: vi.fn(async () => ({ content: [{ type: 'text', text: '1 | noise' }] })),
    };
    const out = await runTriageCommand(ctxWith(surface, { llmProvider: provider }), ['--apply']);
    expect(out.message).toContain('✗ Failed to file proposal for mem-');
    expect(out.message).toContain('candidate table locked');
  });
});
