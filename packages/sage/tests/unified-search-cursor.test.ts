import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateRememberInput } from '../src/memory-input-validation.js';
import type { SearchOptions, SearchQuery, SearchRanking } from '../src/service-contract.js';
import { InvalidSearchCursorError } from '../src/service-contract.js';
import { computeCursorBinding } from '../src/sqlite-search-cursor.js';
import { SqliteSageStore } from '../src/sqlite-store.js';

/**
 * Focused tests for `unifiedSearchService` ranked cursor pagination (B3/B4).
 *
 * The contract under test (docs/plans/unified-sage-search-backend-contract.md
 * + service-contract.ts):
 *  - deterministic keyset pagination on the ranking's total order (ranking
 *    keys + trailing `id` tiebreaker) — a walk neither skips nor repeats;
 *  - cursors are opaque tokens bound to the normalized query + filters +
 *    ranking + session context; `limit` is deliberately NOT bound;
 *  - malformed or foreign tokens throw `InvalidSearchCursorError` (map to
 *    HTTP 400 at the boundary) — pagination never silently restarts;
 *  - `SearchHit.bm25` exposes the raw lexical source score (null on the
 *    no-text channel), `SearchResult.matchChannel` says which channel ran;
 *  - no snapshot guarantee across concurrent writes (bm25 is corpus-stats
 *    dependent) — documented, not asserted here;
 *  - `excludeSessionScoped` opts this surface into the WebUI discovery
 *    policy: ALL session-scoped rows (owned AND legacy unowned) vanish
 *    from rows AND counts, regardless of sessionId / includeAllSessions.
 */

let tempDir: string;
let activeStores: SqliteSageStore[] = [];

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-search-cursor-'));
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

/** Reach the store's private statement cache, the same retrofit the daily-triage session-scope tests use. */
function rawStmt(
  store: SqliteSageStore,
): (sql: string) => { run: (...args: unknown[]) => unknown } {
  return (sql) =>
    (
      store as unknown as {
        stmt: (sql: string) => { run: (...args: unknown[]) => unknown };
      }
    ).stmt(sql);
}

const SESSION_A = 'search-cursor-test-session-a';

interface RankedSeeds {
  alpha: { id: string };
  beta: { id: string };
  gamma: { id: string };
  delta: { id: string };
}

/**
 * Five project memories. Four texts share the token "cursor" (distinct
 * surrounding words → distinct bm25), one is unrelated filler. Importances
 * are distinct so metadata-only orderings (recency/importance rankings and
 * the plain channel) are total even before the `id` tiebreaker.
 */
async function seedRankedCorpus(store: SqliteSageStore): Promise<RankedSeeds> {
  const alpha = await store.rememberSage({
    text: 'alpha cursor tuning for terminal rendering loops',
    kind: 'fact',
    importance: 0.9,
    confidence: 0.9,
  });
  const beta = await store.rememberSage({
    text: 'beta cursor blinking interval preference for dim themes',
    kind: 'preference',
    importance: 0.5,
    confidence: 0.8,
  });
  const gamma = await store.rememberSage({
    text: 'gamma cursor hide latency in vim mode experiments',
    kind: 'fact',
    importance: 0.7,
    confidence: 0.85,
  });
  const delta = await store.rememberSage({
    text: 'delta cursor stuck regression in refresh loop harness',
    kind: 'bug_root_cause',
    importance: 0.6,
    confidence: 0.75,
  });
  await store.rememberSage({
    text: 'unrelated auth middleware ordering convention',
    kind: 'convention',
    importance: 0.8,
    confidence: 0.9,
  });
  return { alpha, beta, gamma, delta };
}

/**
 * Walk a cursor pagination to exhaustion. Enforces only the walk invariants
 * (termination, bounded page size); per-page metadata is returned for the
 * caller to assert.
 */
async function walk(
  store: SqliteSageStore,
  query: SearchQuery,
  options: SearchOptions,
): Promise<{ ids: string[]; pages: number; matchChannels: ('fts' | 'plain')[]; totals: number[] }> {
  const ids: string[] = [];
  const matchChannels: ('fts' | 'plain')[] = [];
  const totals: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await store.unifiedSearchService(
      cursor === undefined ? query : { ...query, cursor },
      options,
    );
    pages++;
    expect(pages, 'cursor walk must terminate').toBeLessThan(50);
    expect(page.hits.length).toBeLessThanOrEqual(options.limit ?? 50);
    ids.push(...page.hits.map((hit) => hit.id));
    matchChannels.push(page.matchChannel ?? 'fts');
    totals.push(page.totalCandidates);
    if (page.nextCursor === null || page.nextCursor === undefined) break;
    expect(typeof page.nextCursor).toBe('string');
    cursor = page.nextCursor;
  }
  return { ids, pages, matchChannels, totals };
}

async function freshSeededStore(): Promise<{ store: SqliteSageStore; seeds: RankedSeeds }> {
  const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
  await store.initialize();
  const seeds = await seedRankedCorpus(store);
  return { store, seeds };
}

describe('unifiedSearchService cursor pagination (B3/B4)', () => {
  it.each(['relevance', 'hybrid', 'recency', 'importance'] as const)(
    'ranking %s walks without duplicates, gaps, or order drift',
    async (ranking: SearchRanking) => {
      const { store } = await freshSeededStore();

      const full = await store.unifiedSearchService({ text: 'cursor' }, { ranking });
      expect(full.hits).toHaveLength(4);
      expect(full.matchChannel).toBe('fts');
      expect(full.nextCursor).toBeNull(); // default limit 50 covers the set

      const { ids, pages, matchChannels, totals } = await walk(
        store,
        { text: 'cursor' },
        { ranking, limit: 1 },
      );
      // The strongest property: the walk reproduces the unpaginated order
      // exactly — the cursor is a deterministic continuation, not a re-query.
      expect(ids).toEqual(full.hits.map((hit) => hit.id));
      expect(new Set(ids).size).toBe(4); // no duplicates
      expect(pages).toBe(4);
      expect(matchChannels).toEqual(['fts', 'fts', 'fts', 'fts']);
      // totalCandidates is the whole-corpus count on EVERY page.
      expect(totals).toEqual([4, 4, 4, 4]);
    },
  );

  it('final page reports a null nextCursor and pages do not overlap', async () => {
    const { store } = await freshSeededStore();

    const page1 = await store.unifiedSearchService({ text: 'cursor' }, { limit: 2 });
    expect(page1.hits).toHaveLength(2);
    expect(typeof page1.nextCursor).toBe('string');

    const page2 = await store.unifiedSearchService(
      { text: 'cursor', cursor: page1.nextCursor! },
      { limit: 2 },
    );
    expect(page2.hits).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect(page2.hits.map((hit) => hit.id)).not.toEqual(page1.hits.map((hit) => hit.id));
  });

  it('paginates filters-only queries on the plain channel with null bm25 scores', async () => {
    const { store } = await freshSeededStore();

    const full = await store.unifiedSearchService({ kinds: ['fact'] }, { ranking: 'importance' });
    expect(full.matchChannel).toBe('plain');
    expect(full.hits).toHaveLength(2); // alpha + gamma are facts
    for (const hit of full.hits) {
      expect(hit.bm25).toBeNull(); // no text query → no lexical source score
    }

    const { ids, matchChannels } = await walk(
      store,
      { kinds: ['fact'] },
      { ranking: 'importance', limit: 1 },
    );
    expect(ids).toEqual(full.hits.map((hit) => hit.id));
    expect(matchChannels).toEqual(['plain', 'plain']);
  });

  it('exposes raw bm25 source scores on lexical hits', async () => {
    const { store } = await freshSeededStore();

    const full = await store.unifiedSearchService({ text: 'cursor' });
    expect(full.matchChannel).toBe('fts');
    expect(full.hits).toHaveLength(4);
    for (const hit of full.hits) {
      expect(hit.bm25).toBeTypeOf('number');
      expect(hit.bm25 as number).toBeLessThanOrEqual(0); // SQLite bm25: lower (more negative) = better
    }
  });

  it('binds the cursor to query, filters, ranking, and session context — but not to limit', async () => {
    const { store } = await freshSeededStore();

    const page1 = await store.unifiedSearchService({ text: 'cursor' }, { limit: 1 });
    const cursor = page1.nextCursor!;
    expect(typeof cursor).toBe('string');

    const rejectsBinding = async (
      query: Partial<SearchQuery> = {},
      options?: SearchOptions,
    ): Promise<void> => {
      await expect(
        store.unifiedSearchService({ text: 'cursor', ...query, cursor } as SearchQuery, options),
      ).rejects.toThrow(InvalidSearchCursorError);
    };

    await rejectsBinding({ text: 'auth' }); // different query text
    await rejectsBinding({ kinds: ['fact'] }); // different whole-corpus filter
    await rejectsBinding({ scopes: ['project'] }); // explicit scope differs from omitted
    await rejectsBinding(undefined, { includeStatuses: ['active', 'stale'] }); // different statuses
    await rejectsBinding(undefined, { ranking: 'recency' }); // different ranking
    await rejectsBinding(undefined, { sessionId: 'another-session' }); // different session context
    await rejectsBinding(undefined, { excludeSessionScoped: true }); // different visibility policy

    // limit is deliberately NOT part of the binding — page size may change
    // mid-walk. Page 2 with a larger limit consumes the remaining hits.
    const page2 = await store.unifiedSearchService({ text: 'cursor', cursor }, { limit: 3 });
    expect(page2.hits).toHaveLength(3);
    expect(page2.nextCursor).toBeNull();
    expect(page2.totalCandidates).toBe(4);
  });

  it('rejects malformed cursor tokens strictly — never a silent first page', async () => {
    const { store } = await freshSeededStore();

    const bogusTokens = [
      'garbage',
      Buffer.from('null').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 2 })).toString('base64url'), // future version
      Buffer.from(JSON.stringify({ v: 1 })).toString('base64url'), // missing every field
      Buffer.from(
        JSON.stringify({
          v: 1,
          h: 'foreign-hash',
          r: 'hybrid',
          c: 'fts',
          p: 1,
          u: 'u',
          i: 'i',
          b: -1,
        }),
      ).toString('base64url'), // well-formed but not minted by this request
    ];
    for (const token of bogusTokens) {
      const err: unknown = await store
        .unifiedSearchService({ text: 'cursor', cursor: token })
        .catch((e: unknown) => e);
      expect(err, `token ${token} must be rejected`).toBeInstanceOf(InvalidSearchCursorError);
    }

    // Empty string is not a token either.
    await expect(store.unifiedSearchService({ text: 'cursor', cursor: '' })).rejects.toThrow(
      InvalidSearchCursorError,
    );
  });

  it('emits suggestions only on cursor-less (first-page) requests', async () => {
    const { store } = await freshSeededStore();
    await store.rememberSage({ text: 'another cursor stuck followup', kind: 'fact' });

    // 'cursor stuck' AND-matches delta and the followup; the OR-expanded neighborhood
    // (alpha/beta/gamma share "cursor") is what suggestions surface.
    const page1 = await store.unifiedSearchService(
      { text: 'cursor stuck' },
      { suggest: 'always', limit: 1 },
    );
    expect(page1.hits).toHaveLength(1);
    expect(page1.suggestions.length).toBeGreaterThan(0);

    const page2 = await store.unifiedSearchService(
      { text: 'cursor stuck', cursor: page1.nextCursor! },
      { suggest: 'always', limit: 1 },
    );
    expect(page2.suggestions).toEqual([]); // derived from the query, not the page
    expect(page2.nextCursor).toBeNull(); // the only AND-match was on page 1
  });

  it('excludeSessionScoped hides owned AND legacy unowned session rows from rows and counts', async () => {
    const { store, seeds } = await freshSeededStore();

    const owned = await store.rememberSage({
      text: 'session cursor secret owned by session a',
      scope: 'session',
      ownerSessionId: SESSION_A,
      importance: 0.95,
      confidence: 0.9,
    });
    // Legacy unowned session row: rememberSage refuses scope 'session'
    // without an owner, so retrofit one with the same raw-SQL update the
    // daily-triage session-scope tests use. beta keeps its "cursor" text —
    // it must disappear from an FTS 'cursor' query AND from the count.
    rawStmt(store)(
      "UPDATE memories SET scope = 'session', owner_session_id = NULL, data = json_set(json_remove(data, '$.ownerSessionId'), '$.scope', 'session') WHERE id = ?",
    ).run(seeds.beta.id);

    // Opt-in WebUI policy: ALL session rows hidden — even when the caller
    // names the owning session or claims the admin opt-out. A WebUI access
    // token carries no agent-session identity, so neither may surface one.
    const strict = await store.unifiedSearchService(
      { text: 'cursor' },
      { excludeSessionScoped: true, sessionId: SESSION_A, includeAllSessions: true },
    );
    const strictIds = strict.hits.map((hit) => hit.id);
    expect(strictIds).not.toContain(owned.id);
    expect(strictIds).not.toContain(seeds.beta.id);
    expect(strict.totalCandidates).toBe(3); // alpha, gamma, delta

    // The policy holds on EVERY page of a walk, not just the first.
    const { ids, totals } = await walk(
      store,
      { text: 'cursor' },
      { excludeSessionScoped: true, sessionId: SESSION_A, includeAllSessions: true, limit: 1 },
    );
    expect(ids).toEqual(strictIds);
    expect(totals).toEqual([3, 3, 3]);

    // Opt-out (flag unset) preserves the shared per-session visibility rule:
    // the owning session still sees its own row; the unowned legacy row
    // stays hidden from a session-identified caller.
    const permissive = await store.unifiedSearchService(
      { text: 'cursor' },
      { sessionId: SESSION_A },
    );
    const permissiveIds = permissive.hits.map((hit) => hit.id);
    expect(permissiveIds).toContain(owned.id);
    expect(permissiveIds).not.toContain(seeds.beta.id);
    expect(permissive.totalCandidates).toBe(4); // alpha, gamma, delta, owned
  });

  it('normalizes audience/anchor key order in cursor binding and rejects blank session ownerSessionId (F134)', () => {
    const b1 = computeCursorBinding(
      {
        text: 'auth',
        audience: { roles: ['coder', 'reviewer'], modes: ['plan'] },
        anchor: { type: 'symbol', path: 'src/a.ts', symbol: 'foo' },
      },
      ['active'],
      'relevance',
      undefined,
    );
    const b2 = computeCursorBinding(
      {
        text: 'auth',
        audience: { modes: ['plan'], roles: ['reviewer', 'coder'] },
        anchor: { symbol: 'foo', type: 'symbol', path: 'src/a.ts' },
      },
      ['active'],
      'relevance',
      undefined,
    );
    expect(b1).toBe(b2);

    expect(() =>
      validateRememberInput({
        text: 'Session memory with whitespace ownerSessionId.',
        scope: 'session',
        ownerSessionId: '   ',
      }),
    ).toThrow(/SAGE scope 'session' requires ownerSessionId/);
  });
});
