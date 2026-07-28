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
    try { store.close(); } catch { /* already closed */ }
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

    // MVP score is 1.0 constant (no ranking signal until commit 1.5.1).
    for (const hit of result.hits) {
      expect(hit.score).toBe(1.0);
      expect(hit.matchReason).toBe('lexical');
      expect(hit.status).toBe('active');
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
    for (const hit of result.hits) {
      expect(hit.matchReason).toBe('recency');
      expect(hit.status).toBe('active');
      expect(hit.score).toBe(1.0);
    }

    // Non-FTS path ordering: importance DESC, then updated_at DESC. Verify
    // that the highest-importance memory ('placeholder cursor…' at 0.9)
    // appears first.
    expect(result.hits[0]?.importance).toBe(0.9);
  });
});
