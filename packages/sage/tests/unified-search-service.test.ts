import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let activeStores: SqliteSageStore[] = [];

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-unified-search-'));
  activeStores = [];
});

afterEach(async () => {
  for (const store of activeStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await new Promise((r) => setTimeout(r, 10));
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function trackStore(store: SqliteSageStore): SqliteSageStore {
  activeStores.push(store);
  return store;
}

async function seedCorpus(store: SqliteSageStore): Promise<void> {
  // Five memories: three of which share a recognizable substring ("cursor")
  // so FTS5 prefix-match deterministically surfaces 3 hits; others are filler.
  // We don't use the returned Sage objects in the assertions below — but
  // we pipe them to `void` so the future type (Promise<Sage>) doesn't get
  // ignored by the framework's no-floating-promises linting.
  await store.rememberSage({
    text: 'manage cursor visibility in long-running terminal sessions',
    kind: 'fact',
    scope: 'project',
    importance: 0.7,
    confidence: 0.9,
    tags: ['terminal', 'ux'],
  });
  await store.rememberSage({
    text: 'placeholder cursor in a refresh-loop test should not block CI',
    kind: 'bug_root_cause',
    scope: 'project',
    importance: 0.9,
    confidence: 0.95,
    tags: ['ci', 'flaky'],
  });
  await store.rememberSage({
    text: 'unrelated note about auth-middleware order in middleware.rs',
    kind: 'convention',
    scope: 'project',
    importance: 0.6,
    confidence: 0.85,
    tags: ['auth'],
  });
  await store.rememberSage({
    text: 'rememberSage returns a memory id immediately on success',
    kind: 'fact',
    scope: 'project',
    importance: 0.5,
    confidence: 0.8,
    tags: ['sage', 'api'],
  });
  await store.rememberSage({
    text: 'tag-cursor interactions in sqlite-statement-cache LRU eviction',
    kind: 'preference',
    scope: 'project',
    importance: 0.4,
    confidence: 0.7,
    tags: ['sqlite', 'lru'],
  });
}

describe('executeUnifiedSearch (commit 1.5, MVP)', () => {
  it('returns hits on FTS5 prefix-match with deterministic ordering and correct count', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    await seedCorpus(store);

    const result = await store.unifiedSearchService({ text: 'cursor' });

    // Two memories share "cursor" in their text; the third ('tag-cursor') is in
    // our filler — 3 hits. The other two ('manage cursor visibility…' and
    // 'placeholder cursor in a refresh-loop test…') are the "real" cursor ones.
    // MVP: total reflects the active rows that match (after status filter).
    expect(result.totalCandidates).toBe(3);
    expect(result.hits).toHaveLength(3);
    expect(result.suggestions).toEqual([]); // MVP: suggestions always empty.
    expect(result.rankingApplied).toBe('hybrid');
    expect(result.queryEcho.text).toBe('cursor');

    // Scores are absolute in [0,1] — the same formula runs for every query
    // (sigmoid-bm25 × metadata), so every hit's score is valid regardless of
    // result-set size (the old position-relative formula scored the top hit
    // ~0.85 whether it was a strong match in a 2-hit set or a weak one in a
    // 50-hit set).
    for (let i = 0; i < result.hits.length; i++) {
      expect(result.hits[i]!.score).toBeGreaterThan(0);
      expect(result.hits[i]!.score).toBeLessThanOrEqual(1);
      expect(result.hits[i]!.matchReason).toBe('lexical');
      expect(result.hits[i]!.status).toBe('active');
    }

    // Every hit text contains "cursor" (case-insensitive) — sanity check on
    // the FTS5 prefix-match. ftsPrefixTerms lower-cases and strips non-
    // alphanumeric; "cursor*" matches any token starting with "cursor".
    for (const hit of result.hits) {
      expect(hit.text.toLowerCase()).toContain('cursor');
    }
  });

  it('returns all active rows for non-FTS queries (no MATCH clause → no text filter)', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    await seedCorpus(store);

    // Whitespace-only text query: `buildMatchExpr` returns undefined,
    // so the non-FTS branch runs. With no `LIKE` or text filter, every
    // `status='active'` row matches — ordered by `importance DESC, updated_at DESC`.
    const result = await store.unifiedSearchService({ text: '   ' });

    expect(result.hits).toHaveLength(5);
    expect(result.totalCandidates).toBe(5);
    expect(result.rankingApplied).toBe('hybrid');
    expect(result.queryEcho.text).toBe('   ');
    // Non-FTS path uses `matchReason: 'recency'` (the secondary sort key).
    // Scores are absolute in [0,1] — recency over a fixed window × metadata —
    // so a fresh, high-importance memory clears the §6 trust bar (≥ 0.5).
    for (const hit of result.hits) {
      expect(hit.matchReason).toBe('recency');
      expect(hit.status).toBe('active');
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    expect(result.hits[0]!.score).toBeGreaterThanOrEqual(0.5);

    // Non-FTS path ordering: importance DESC, then updated_at DESC. Verify
    // that the highest-importance memory ('placeholder cursor…' at 0.9)
    // appears first.
    expect(result.hits[0]?.importance).toBe(0.9);
  });
});

describe('executeUnifiedSearch — declared-field contract (2026-08-02)', () => {
  it('rejects cursor pagination explicitly instead of ignoring it', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    await seedCorpus(store);
    await expect(
      store.unifiedSearchService({
        text: 'cursor',
        cursor: { memoryId: 'mem-x', direction: 'before' },
      }),
    ).rejects.toThrow(/cursor pagination/);
  });

  it('honors freshness.createdAfter', async () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir, now: () => current }));
    await store.initialize();
    const early = await store.rememberSage({
      text: 'early memory freshness probe alpha',
      kind: 'fact',
      importance: 0.5,
    });
    current = new Date('2026-02-01T00:00:00.000Z');
    const late = await store.rememberSage({
      text: 'late memory freshness probe alpha',
      kind: 'fact',
      importance: 0.5,
    });

    const result = await store.unifiedSearchService({
      text: 'freshness probe',
      freshness: { createdAfter: '2026-01-15T00:00:00.000Z' },
    });
    const ids = result.hits.map((hit) => hit.id);
    expect(ids).toContain(late.id);
    expect(ids).not.toContain(early.id);
  });

  it('honors the audience filter', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const reviewer = await store.rememberSage({
      text: 'reviewer scoped memory audience probe',
      kind: 'fact',
      importance: 0.6,
      audience: { roles: ['reviewer'] },
    });
    const general = await store.rememberSage({
      text: 'general memory audience probe',
      kind: 'fact',
      importance: 0.6,
    });

    const result = await store.unifiedSearchService({
      text: 'audience probe',
      audience: { roles: ['reviewer'] },
    });
    const ids = result.hits.map((hit) => hit.id);
    expect(ids).toContain(reviewer.id);
    expect(ids).not.toContain(general.id);
  });

  it('honors the anchor filter', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const anchored = await store.rememberSage({
      text: 'anchored memory anchor probe alpha',
      kind: 'file_note',
      importance: 0.6,
      anchors: [{ type: 'file', path: 'src/probe-config.ts' }],
    });
    const unanchored = await store.rememberSage({
      text: 'unanchored memory anchor probe alpha',
      kind: 'fact',
      importance: 0.6,
    });

    const result = await store.unifiedSearchService({
      text: 'anchor probe',
      anchor: { type: 'file', path: 'src/probe-config.ts' },
    });
    const ids = result.hits.map((hit) => hit.id);
    expect(ids).toContain(anchored.id);
    expect(ids).not.toContain(unanchored.id);
  });

  it('honors the paths filter via the anchor graph', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const onPath = await store.rememberSage({
      text: 'memory on the filtered path probe alpha',
      kind: 'file_note',
      importance: 0.6,
      anchors: [{ type: 'file', path: 'src/path-probe.ts' }],
    });
    const offPath = await store.rememberSage({
      text: 'second note about the filtered path probe beta',
      kind: 'file_note',
      importance: 0.6,
      anchors: [{ type: 'file', path: 'src/other-file.ts' }],
    });

    const result = await store.unifiedSearchService({
      text: 'filtered path probe',
      paths: ['src/path-probe.ts'],
    });
    const ids = result.hits.map((hit) => hit.id);
    expect(ids).toContain(onPath.id);
    expect(ids).not.toContain(offPath.id);
  });

  it('populates suggestions on empty hits (suggest="empty" default)', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const alpha = await store.rememberSage({
      text: 'alpha term memory probe',
      kind: 'fact',
      importance: 0.6,
    });
    const gamma = await store.rememberSage({
      text: 'gamma term memory probe',
      kind: 'fact',
      importance: 0.6,
    });

    // No single memory contains BOTH 'alpha' and 'gamma', so the AND query
    // yields zero hits; the OR-expanded suggestion query surfaces both.
    const result = await store.unifiedSearchService({ text: 'alpha gamma' });
    expect(result.hits).toHaveLength(0);
    const suggestionIds = result.suggestions.map((hit) => hit.id);
    expect(suggestionIds).toContain(alpha.id);
    expect(suggestionIds).toContain(gamma.id);
  });

  it('never and always suggestion modes', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const a = await store.rememberSage({
      text: 'alpha beta probe',
      kind: 'fact',
      importance: 0.6,
    });
    const b = await store.rememberSage({
      text: 'gamma beta probe',
      kind: 'fact',
      importance: 0.6,
    });

    const never = await store.unifiedSearchService({ text: 'beta alpha' }, { suggest: 'never' });
    expect(never.hits.map((hit) => hit.id)).toContain(a.id);
    expect(never.suggestions).toEqual([]);

    const always = await store.unifiedSearchService({ text: 'beta alpha' }, { suggest: 'always' });
    expect(always.hits.map((hit) => hit.id)).toContain(a.id);
    expect(always.suggestions.map((hit) => hit.id)).toContain(b.id);
  });

  it('honors freshness.verifiedAfter (anchor verification time)', async () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir, now: () => current }));
    await store.initialize();
    await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, 'src', 'verify-probe.ts'),
      'export const probe = 1;\n',
    );
    const memory = await store.rememberSage({
      text: 'verify probe memory alpha',
      kind: 'file_note',
      importance: 0.6,
      anchors: [{ type: 'file', path: 'src/verify-probe.ts' }],
    });
    // Verify at T1 (2026-03) — sets lastVerifiedAt on the memory.
    current = new Date('2026-03-01T00:00:00.000Z');
    await store.verify(memory.id);

    const after = await store.unifiedSearchService({
      text: 'verify probe',
      freshness: { verifiedAfter: '2026-02-01T00:00:00.000Z' },
    });
    expect(after.hits.map((hit) => hit.id)).toContain(memory.id);
    const before = await store.unifiedSearchService({
      text: 'verify probe',
      freshness: { verifiedAfter: '2026-04-01T00:00:00.000Z' },
    });
    expect(before.hits.map((hit) => hit.id)).not.toContain(memory.id);
  });

  it('suggestions honor the paths filter', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const a = await store.rememberSage({
      text: 'alpha beta probe alpha',
      kind: 'file_note',
      importance: 0.6,
      anchors: [{ type: 'file', path: 'src/path-suggest.ts' }],
    });
    const b = await store.rememberSage({
      text: 'gamma beta probe gamma',
      kind: 'fact',
      importance: 0.6,
    });

    const unfiltered = await store.unifiedSearchService(
      { text: 'beta alpha' },
      { suggest: 'always' },
    );
    expect(unfiltered.hits.map((hit) => hit.id)).toContain(a.id);
    expect(unfiltered.suggestions.map((hit) => hit.id)).toContain(b.id);

    // With the paths filter, the OR-expanded suggestion query must not
    // surface the unanchored memory either.
    const filtered = await store.unifiedSearchService(
      { text: 'beta alpha', paths: ['src/path-suggest.ts'] },
      { suggest: 'always' },
    );
    expect(filtered.hits.map((hit) => hit.id)).toContain(a.id);
    expect(filtered.suggestions.map((hit) => hit.id)).not.toContain(b.id);
  });

  it('scores reflect memory quality, not result-set position', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const strong = await store.rememberSage({
      text: 'quality scoring probe alpha',
      kind: 'fact',
      importance: 0.9,
      confidence: 0.95,
    });
    const weak = await store.rememberSage({
      text: 'quality scoring probe beta',
      kind: 'fact',
      importance: 0.3,
      confidence: 0.4,
    });

    // Both memories match the query with the same lexical profile; the
    // metadata factor (importance/confidence/freshness) must dominate so the
    // high-quality memory outscores the low-quality one. Under the old
    // position-relative formula both would land within ~0.1 of each other
    // purely by result-set position.
    const result = await store.unifiedSearchService({ text: 'quality scoring' });
    const strongScore = result.hits.find((hit) => hit.id === strong.id)?.score;
    const weakScore = result.hits.find((hit) => hit.id === weak.id)?.score;
    expect(strongScore).toBeDefined();
    expect(weakScore).toBeDefined();
    expect(strongScore!).toBeGreaterThan(weakScore!);
  });
});
