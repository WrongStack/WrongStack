/**
 * Sort-contract test — locks the deterministic ordering of the
 * mirror-file renderer (`SageDomainTermExtractor.writeDomainTermsFile`)
 * and the prompt-block renderer (`renderDomainGlossary` in core).
 *
 * The two renderers no longer share a data source:
 *
 *   - The mirror is regenerated from the in-memory `ExtractedTerm[]`
 *     of the current extraction pass. There is no `updatedAt` on
 *     in-memory terms, so the sort falls back to **term ascending**
 *     for tiebreakers.
 *   - The prompt block in core still reads `domain-term`-tagged
 *     `MemoryEntry` records (which carry `ts`) — but in production
 *     the corpus carries no such records because the migration has
 *     purged them. The sort there remains **ts descending** for
 *     tiebreakers.
 *
 * The test pins the mirror's new deterministic ordering. The prompt
 * path is exercised separately in
 * `packages/core/tests/core/system-prompt-glossary.test.ts`; cross-
 * comparing the two orderings is no longer meaningful because the
 * data sources are decoupled.
 *
 * Why this lives in `packages/sage`: the mirror path requires
 * `SageDomainTermExtractor` (sage-specific). The prompt path is
 * owned by core and tested there.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractedTerm } from '../src/domain-term-extractor.js';
import { SageDomainTermExtractor } from '../src/domain-term-extractor.js';

// ── Shared test data ────────────────────────────────────────────────
// Deliberately varied confidence so the sort is exercised, not
// trivially uniform. Two pairs share a confidence value to verify
// the tiebreaker (term asc) is applied.
const BASE_TERMS: ReadonlyArray<{
  term: string;
  definition: string;
  confidence: number;
}> = [
  {
    term: 'AlphaCore',
    definition: 'high-confidence, lexicographically first',
    confidence: 0.95,
  },
  {
    term: 'BetaCore',
    definition: 'high-confidence, lexicographically second',
    confidence: 0.95,
  },
  {
    term: 'GammaCore',
    definition: 'mid-confidence',
    confidence: 0.72,
  },
  {
    term: 'DeltaCore',
    definition: 'lower confidence',
    confidence: 0.58,
  },
];

/** Build a fresh array of `ExtractedTerm` from BASE_TERMS. */
function makeExtractedTerms(): ExtractedTerm[] {
  return BASE_TERMS.map((t) => ({
    term: t.term,
    definition: t.definition,
    confidence: t.confidence,
    mentionCount: 1,
    evidence: [],
    sources: ['user' as const],
  }));
}

/** Parse the mirror markdown table and return the ordered term names. */
function extractMirrorOrder(markdown: string): string[] {
  const terms: string[] = [];
  for (const line of markdown.split('\n')) {
    // Table rows look like: | `Term` | definition | 0.95 |
    const m = line.match(/^\|\s*`([^`]+)`/);
    if (m?.[1] && m[1] !== 'Term') terms.push(m[1]);
  }
  return terms;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('domain-terms sort contract — mirror renderer is deterministic', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sort-contract-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('orders the mirror by confidence desc, then term asc (tiebreaker)', async () => {
    const terms = makeExtractedTerms();
    const extractor = new SageDomainTermExtractor();

    // The mirror is regenerated from the in-memory terms we just
    // passed in. Order is not driven by persisted timestamps because
    // no persistence occurs anymore.
    const mirrorPath = await extractor.writeDomainTermsFile(tmp, terms);
    const mirrorContent = await fs.readFile(mirrorPath, 'utf8');
    const order = extractMirrorOrder(mirrorContent);

    // Expected: AlphaCore (0.95) > BetaCore (0.95) > GammaCore (0.72)
    //           > DeltaCore (0.58). AlphaCore wins the 0.95 tiebreaker
    //           because it sorts earlier alphabetically.
    expect(order).toEqual(['AlphaCore', 'BetaCore', 'GammaCore', 'DeltaCore']);
  });

  it('produces a stable order across calls with the same input', async () => {
    const terms = makeExtractedTerms();
    const extractor = new SageDomainTermExtractor();

    const first = await extractor.writeDomainTermsFile(tmp, terms);
    const firstOrder = extractMirrorOrder(await fs.readFile(first, 'utf8'));

    // Re-write with the same data; the order must be identical
    // (no timestamp dependence).
    const second = await extractor.writeDomainTermsFile(tmp, terms);
    const secondOrder = extractMirrorOrder(await fs.readFile(second, 'utf8'));

    expect(secondOrder).toEqual(firstOrder);
  });
});
