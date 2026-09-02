import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

/**
 * Graph membership is the strongest relatedness signal `scoreMemoryRelationship`
 * knows (8 points, against 1.5 per shared tag capped at 4). The traversal that
 * produces it must not be skippable by tag volume: a memory reachable only
 * through the graph scores 0 without it and is dropped by the `score > 0`
 * filter, so the failure mode is invisibility rather than a lower rank.
 */
describe('findRelatedSage graph traversal', () => {
  let dir: string;
  let store: SqliteSageStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sage-fr-'));
    store = new SqliteSageStore({ projectRoot: dir });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close?.();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the sqlite handle; the temp dir is disposable.
    }
  });

  /**
   * Builds: a seed carrying `flood`, a relative reachable ONLY through a
   * `supersedes` edge (no shared tag, no shared anchor), and `noise` memories
   * that share nothing but the `flood` tag. Each noise memory gets distinct
   * subject matter so near-duplicate merging cannot collapse the corpus.
   */
  const seedCorpus = async (noise: number) => {
    const seed = await store.rememberSage({
      text: 'Seed: auth module entry point',
      kind: 'file_note',
      scope: 'project',
      tags: ['flood'],
      anchors: [{ type: 'file', path: 'src/auth/index.ts' }],
      importance: 0.9,
      confidence: 0.9,
    });
    const graphOnly = await store.rememberSage({
      text: 'Graph-only relative reachable through the supersedes edge',
      kind: 'fact',
      scope: 'project',
      tags: ['unrelated-tag'],
      importance: 0.95,
      confidence: 0.95,
      supersedes: [seed.id],
    });
    for (let i = 0; i < noise; i++) {
      await store.rememberSage({
        text: `Topic ${i}: the ${i} subsystem uses strategy ${i * 7} for its ${
          i % 5 === 0 ? 'cache' : 'queue'
        } layer number ${i * 13}`,
        kind: 'fact',
        scope: 'project',
        tags: ['flood'],
        importance: 0.2,
        confidence: 0.2,
      });
    }
    return { seed, graphOnly };
  };

  // limit 20 ⇒ bfsBudget = max(100, 20 * 20) = 400. The old gate skipped the
  // traversal once the candidate set reached that budget, so the boundary sits
  // between these two rows: 180 co-tagged memories stayed under it, 430 did not.
  it.each([
    [10, 'well under the BFS budget'],
    [180, 'just under the BFS budget'],
    [430, 'past the BFS budget'],
  ])(
    'returns the graph-only relative with %i co-tagged memories (%s)',
    async (noise) => {
      const { seed, graphOnly } = await seedCorpus(noise);

      const related = await store.findRelatedSage([seed.id], { limit: 20 });

      expect(related.map((memory) => memory.id)).toContain(graphOnly.id);
      // Graph membership outscores tag co-occurrence, so it leads the ranking
      // rather than merely surviving inside the cap.
      expect(related[0]?.id).toBe(graphOnly.id);
    },
    60_000,
  );

  it('keeps a high-importance co-tagged memory when the tag source is capped', async () => {
    // The tag candidate source is bounded at the BFS budget, ordered by
    // importance. The cap is only defensible if it cuts from the bottom: a
    // strong co-tagged memory buried behind hundreds of weak ones must still
    // arrive.
    const { seed } = await seedCorpus(430);
    const strong = await store.rememberSage({
      text: 'Strong co-tagged memory that must survive the tag candidate cap',
      kind: 'fact',
      scope: 'project',
      tags: ['flood'],
      importance: 1,
      confidence: 1,
    });

    const related = await store.findRelatedSage([seed.id], { limit: 20 });

    expect(related.map((memory) => memory.id)).toContain(strong.id);
  }, 60_000);

  it('does not let tag volume decide whether the graph was explored', async () => {
    const { seed, graphOnly } = await seedCorpus(430);

    // A caller asking for a single result still gets the graph neighbour: the
    // budget bounds how far the walk goes, never whether it happens.
    const related = await store.findRelatedSage([seed.id], { limit: 1 });

    expect(related).toHaveLength(1);
    expect(related[0]?.id).toBe(graphOnly.id);
  }, 60_000);
});
