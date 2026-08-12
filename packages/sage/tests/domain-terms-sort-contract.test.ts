/**
 * Sort-contract test — locks the invariant that the mirror-file
 * renderer (`SageDomainTermExtractor.writeDomainTermsFile`) and the
 * prompt-block renderer (`renderDomainGlossary` in core) present
 * domain terms in the **same order** for the same set of SAGE data.
 *
 * Both sorters are private/inline, so a future change to one would
 * silently desynchronise the on-disk glossary from the in-prompt
 * glossary. This test prevents that regression by feeding identical
 * data through both paths and comparing the extracted term order.
 *
 * Why this lives in `packages/sage`: the mirror path requires
 * `SageDomainTermExtractor` (sage-specific). The prompt path uses
 * `renderDomainGlossary` from core, which sage can import at test
 * time via `@wrongstack/core`.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryEntry, MemoryPort, MemoryStore } from '@wrongstack/core/types';
import { renderDomainGlossary } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_TERM_LOOKUP_TAG, SageDomainTermExtractor } from '../src/domain-term-extractor.js';
import type { Sage } from '../src/types.js';

// ── Shared test data ────────────────────────────────────────────────
// Deliberately varied confidence + timestamps so the sort is
// exercised, not trivially uniform. The tiebreaker (ts desc) is
// tested by Alpha/Beta (same confidence, different ts).
const BASE_TERMS: ReadonlyArray<{
  term: string;
  definition: string;
  confidence: number;
  updatedAt: string;
}> = [
  {
    term: 'AlphaCore',
    definition: 'high-confidence, earlier timestamp',
    confidence: 0.95,
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
  {
    term: 'BetaCore',
    definition: 'high-confidence, later timestamp (tiebreaker winner)',
    confidence: 0.95,
    updatedAt: '2026-08-02T10:00:00.000Z',
  },
  {
    term: 'GammaCore',
    definition: 'mid-confidence',
    confidence: 0.72,
    updatedAt: '2026-08-03T10:00:00.000Z',
  },
  {
    term: 'DeltaCore',
    definition: 'lower confidence',
    confidence: 0.58,
    updatedAt: '2026-08-04T10:00:00.000Z',
  },
];

/** Build a fresh array of SAGE rows from BASE_TERMS (so tests don't share refs). */
function makeSageRows(): Sage[] {
  return BASE_TERMS.map((t, i) => ({
    id: `term_${i}`,
    revision: 1,
    text: `${t.term} — ${t.definition}`,
    summary: undefined,
    kind: 'fact' as const,
    scope: 'project' as const,
    status: 'active' as const,
    confidence: t.confidence,
    importance: t.confidence,
    freshness: 1,
    tags: [DOMAIN_TERM_LOOKUP_TAG, 'glossary'],
    anchors: [],
    sources: [{ type: 'user' as const }],
    createdAt: t.updatedAt,
    updatedAt: t.updatedAt,
  }));
}

// ── Fake ports ─────────────────────────────────────────────────────

/** SAGE MemoryPort backed by an in-memory Sage[] (for the mirror path). */
function makeFakeSagePort(rows: Sage[]): MemoryPort {
  return {
    initialize: async () => {},
    getCapability: () =>
      ({
        searchSage: async () => rows.slice(),
        rememberSage: async () => rows[0]!,
        updateSage: async () => rows[0]!,
      }) as never,
    health: async () => ({ status: 'ready' as const, backend: 'fake' }),
    dispose: async () => {},
    withTraceId: () => ({}) as unknown as MemoryPort,
    readAll: async () => '',
    read: async () => '',
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    list: async () => [],
    search: async () => [],
  };
}

/** MemoryStore backed by the same Sage[] data (for the prompt path). */
function makeFakeMemoryStore(rows: Sage[]): MemoryStore {
  const entries: MemoryEntry[] = rows.map((r) => ({
    scope: 'project-memory',
    text: r.text,
    ts: r.updatedAt,
    type: 'reference',
    tags: r.tags.slice(),
    confidence: r.confidence,
  }));
  return {
    withTraceId: () => ({}) as unknown as MemoryStore,
    readAll: async () => '',
    read: async () => '',
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    list: async () => entries,
    search: async () => entries,
  };
}

// ── Order extraction helpers ───────────────────────────────────────

/** Parse the mirror markdown table and return the ordered term names. */
function extractMirrorOrder(markdown: string): string[] {
  const terms: string[] = [];
  for (const line of markdown.split('\n')) {
    // Table rows look like: | `Term` | definition | 0.95 |
    const m = line.match(/^\|\s*`([^`]+)`/);
    if (m && m[1] && !['Term'].includes(m[1])) terms.push(m[1]);
  }
  return terms;
}

/** Parse the prompt block and return the ordered term names. */
function extractPromptOrder(block: string): string[] {
  const terms: string[] = [];
  for (const line of block.split('\n')) {
    // Bullet lines look like: - **Term** — definition
    const m = line.match(/^-\s*\*\*([^*]+)\*\*/);
    if (m && m[1]) terms.push(m[1]);
  }
  return terms;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('domain-terms sort contract — mirror and prompt renderers agree', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sort-contract-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('produces identical term ordering for the same SAGE data', async () => {
    const rows = makeSageRows();
    const extractor = new SageDomainTermExtractor();

    // Mirror path: writeDomainTermsFile → domain-terms.md
    const mirrorPath = await extractor.writeDomainTermsFile(tmp, makeFakeSagePort(rows));
    const mirrorContent = await fs.readFile(mirrorPath, 'utf8');
    const mirrorOrder = extractMirrorOrder(mirrorContent);

    // Prompt path: renderDomainGlossary → prompt block
    const promptBlock = await renderDomainGlossary(
      { cwd: tmp, projectRoot: tmp, tools: [] },
      makeFakeMemoryStore(rows),
    );
    expect(promptBlock).not.toBeNull();
    const promptOrder = extractPromptOrder(promptBlock as string);

    // Both should have the same terms (all non-header entries).
    expect(mirrorOrder.length).toBeGreaterThan(0);
    expect(promptOrder.length).toBe(mirrorOrder.length);

    // The core assertion: identical ordering.
    expect(promptOrder).toEqual(mirrorOrder);
  });

  it('orders by confidence desc, then updatedAt desc (the contract)', async () => {
    const rows = makeSageRows();
    const extractor = new SageDomainTermExtractor();

    const mirrorPath = await extractor.writeDomainTermsFile(tmp, makeFakeSagePort(rows));
    const mirrorContent = await fs.readFile(mirrorPath, 'utf8');
    const order = extractMirrorOrder(mirrorContent);

    // Expected: BetaCore (0.95, later ts) > AlphaCore (0.95, earlier ts)
    //           > GammaCore (0.72) > DeltaCore (0.58)
    expect(order).toEqual(['BetaCore', 'AlphaCore', 'GammaCore', 'DeltaCore']);
  });
});
