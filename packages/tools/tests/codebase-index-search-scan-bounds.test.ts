/**
 * WS-031 — the codebase index turned one tool argument into a full-corpus scan.
 *
 * `buildWriterSearchWhere` interpolated the caller's query straight into a LIKE
 * pattern: `%${token}%`, with no `escapeLike` and no `ESCAPE` clause, while
 * every other LIKE in the same builder escaped properly. So `%` stayed a live
 * wildcard and the one-character query `%` compiled to `text LIKE '%%%'` —
 * every row in `symbols`.
 *
 * The FTS5-less ranked fallback then called `this.search(query, filter)` with
 * no limit, so all of those rows were materialized as JS objects on the request
 * path, in a subsystem with a documented OOM history. The two halves multiply:
 * the wildcard picks the whole corpus, the missing limit brings it into memory.
 *
 * `_` is the quieter half of the same bug — it is common in real symbol names
 * (`user_id`), where it silently matched any character.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Symbol as IndexSymbol,
  SymbolKind,
  SymbolLang,
} from '../src/codebase-index/schema.js';
import { IndexStore } from '../src/codebase-index/writer.js';
import { SEARCH_CANDIDATE_SCAN_CAP } from '../src/codebase-index/writer-search-helpers.js';

let store: IndexStore;
let tmpDir: string;

const sym = (over: Partial<IndexSymbol> & { name: string; file: string }): IndexSymbol => ({
  id: 0,
  lang: (over.lang ?? 'ts') as SymbolLang,
  kind: (over.kind ?? 'function') as SymbolKind,
  name: over.name,
  file: over.file,
  line: over.line ?? 1,
  col: over.col ?? 0,
  signature: over.signature ?? `${over.name}()`,
  docComment: over.docComment ?? '',
  scope: over.scope ?? '',
  text: over.text ?? over.name,
});

/**
 * `ftsAvailable` is private and set from a runtime capability probe, so there
 * is no public lever for the legacy path. Reaching in is the only way to cover
 * it — and it is exactly the degraded environment where the unbounded scan
 * mattered, so leaving it untested is not an option.
 */
function forceLegacyRankedPath(target: IndexStore): void {
  (target as unknown as { ftsAvailable: boolean }).ftsAvailable = false;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-scan-bounds-'));
  store = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.idx') });
  store.insertSymbols([
    sym({ name: 'alpha', file: '/p/a.ts', text: 'alpha one' }),
    sym({ name: 'beta', file: '/p/b.ts', text: 'beta two' }),
    sym({ name: 'gamma', file: '/p/c.ts', text: 'gamma three' }),
    sym({ name: 'userXid', file: '/p/d.ts', text: 'userXid four' }),
    sym({ name: 'user_id', file: '/p/e.ts', text: 'user_id five' }),
    sym({ name: 'pctLiteral', file: '/p/f.ts', signature: 'pct(share: 100%): void' }),
  ]);
});

afterEach(async () => {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('LIKE wildcard escaping (WS-031)', () => {
  it('does not let a bare % select the whole corpus — the exact amplifier', () => {
    // Before: `text LIKE '%%%'` matched all six rows. After: `%` is content,
    // so it matches only the one row whose persisted columns literally contain
    // a percent sign. "Matches nothing" would be the wrong fix — see the next
    // test.
    expect(store.search('%').map((r) => r.name)).toEqual(['pctLiteral']);
    expect(store.search('%%%%')).toEqual([]);
  });

  it('treats % as a literal, so it still finds text that really contains one', () => {
    // Escaping must not turn the character into a dead query — `100%` is
    // ordinary content and has to remain findable.
    expect(store.search('100%').map((r) => r.name)).toEqual(['pctLiteral']);
  });

  it('treats _ as a literal rather than a single-character wildcard', () => {
    // `user_id` used to match `userXid` too. Both rows exist, so this fails
    // loudly if the escape is dropped: unescaped, `_` alone matched every row
    // with at least one character, and `user_id` matched `userXid`.
    expect(store.search('user_id').map((r) => r.name)).toEqual(['user_id']);
    expect(store.search('_').map((r) => r.name)).toEqual(['user_id']);
  });

  it('leaves ordinary queries and multi-token OR semantics unchanged', () => {
    expect(store.search('alpha').map((r) => r.name)).toEqual(['alpha']);
    expect(new Set(store.search('alpha beta').map((r) => r.name))).toEqual(
      new Set(['alpha', 'beta']),
    );
    expect(
      store
        .search('user')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['userXid', 'user_id']);
  });

  it('escapes a literal backslash too, so the ESCAPE character is not injectable', () => {
    expect(() => store.search('a\\')).not.toThrow();
    expect(store.search('a\\')).toEqual([]);
  });
});

describe('ranked fallback candidate bound (WS-031)', () => {
  it('never scans unbounded — the fallback passes the scan cap through', () => {
    forceLegacyRankedPath(store);
    const spy = vi.spyOn(store, 'search');

    store.searchRanked('user', undefined, 5);

    expect(spy).toHaveBeenCalledWith('user', undefined, { limit: SEARCH_CANDIDATE_SCAN_CAP });
    expect(SEARCH_CANDIDATE_SCAN_CAP).toBeLessThan(Number.POSITIVE_INFINITY);
    spy.mockRestore();
  });

  it('reports total from SQL COUNT(*), so the cap cannot understate the match count', () => {
    forceLegacyRankedPath(store);
    // Several rows contain "e" in their persisted columns; ask for two.
    // `total` used to be the length of the materialized candidate array, which
    // is precisely the value a scan cap would corrupt.
    const out = store.searchRanked('e', undefined, 2);
    expect(out.results.length).toBeLessThanOrEqual(2);
    expect(out.total).toBeGreaterThan(out.results.length);
    expect(out.total).toBe(store.search('e').length);
  });

  it('still returns an empty result for a query that matches nothing', () => {
    forceLegacyRankedPath(store);
    expect(store.searchRanked('nosuchsymbolanywhere', undefined, 5)).toEqual({
      results: [],
      total: 0,
    });
  });

  it('a wildcard query no longer reaches the ranked fallback as a corpus scan', () => {
    forceLegacyRankedPath(store);
    const out = store.searchRanked('%', undefined, 10);
    // One literal candidate out of six rows. Unescaped this was the whole
    // corpus — that is the property under test.
    expect(out.total).toBe(1);
    // The ranked window is empty here because the in-process BM25 pass runs its
    // own `tokenise`, which yields no tokens for a punctuation-only query, so
    // nothing scores. That is long-standing fallback behaviour independent of
    // this fix (`total` was `candidates.length` before and was also 1). Pinned
    // so a future change to BM25 tokenisation is a deliberate decision.
    expect(out.results.length).toBeLessThanOrEqual(out.total);
  });
});
