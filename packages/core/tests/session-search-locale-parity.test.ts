import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

/**
 * Session-search locale parity — durable regression for the U+0130 divergence.
 *
 * The same `titleContains` query must select the same sessions on all three
 * implementations of the title filter:
 *   A. the SQLite catalog path (`listCatalogRecords`),
 *   B. the canonical in-process matcher (`matchesSessionFilter`),
 *   C. the session reader (`DefaultSessionReader.query`).
 *
 * The defect (proven in round r20, permanent memory 01M3X67NJGCZNJWEQ40W0W7V9H):
 * SQLite's `LIKE`/`LOWER()` fold ASCII only, so a title containing U+0130 could
 * never match a needle folding to ASCII `i` — A answered "no row" while B/C
 * answered "row", so the same query returned different sessions depending on
 * whether the catalog daemon was running. C additionally re-implemented the
 * predicate with `toLowerCase()` while B used `toLocaleLowerCase()`; U+0130 is
 * the code point where those differ (`toLowerCase()` -> `i` + U+0307,
 * `toLocaleLowerCase()` -> `i`).
 *
 * `toLocaleLowerCase()` follows the host's default locale: under `tr` it folds
 * U+0130 to `i`, elsewhere (en-US CI runners) to `i` + U+0307. The contract is
 * parity, so each needle's expected answer is derived from the host fold and
 * all three paths must give it:
 *   1. plain-ASCII needle `istanbul` against a title containing `İstanbul`
 *      (U+0130) — the A-vs-B headline symptom (matches under `tr`).
 *   2. two-code-point needle `i` + U+0307 against the same title — a plain
 *      `İstanbul` needle masks the B-vs-C disagreement, because each side
 *      folds both of its operands.
 */
const DatabaseSync = loadTestDatabaseSync();
type DatabaseSync = InstanceType<typeof DatabaseSync>;

import { initializeSqliteTextIndex } from '@wrongstack/persistence';
import { describe, expect, it } from 'vitest';
import type { CatalogSessionRecord } from '../src/session-catalog/protocol.js';
import { listCatalogRecords } from '../src/session-catalog/store-maintenance.js';
import { catalogTitleIndex } from '../src/session-catalog/store-text-index.js';
import { DefaultSessionReader } from '../src/storage/session-reader.js';
import { matchesSessionFilter } from '../src/storage/session-summary.js';
import type { SessionStore, SessionSummary } from '../src/types/session.js';

const SESSION_ID = 'sess_01LOCALEPARITY0000000000';
const TITLE = 'İstanbul deploy notes'; // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE
const ASCII_NEEDLE = 'istanbul';
const DECOMPOSED_NEEDLE = 'i\u0307stanbul'; // 'i' + COMBINING DOT ABOVE

function summary(title: string = TITLE): SessionSummary {
  return {
    id: SESSION_ID,
    title,
    startedAt: '2026-10-09T00:00:00.000Z',
    endedAt: '2026-10-09T00:10:00.000Z',
    lastActivityAt: '2026-10-09T00:10:00.000Z',
    provider: 'openai',
    model: 'gpt-5',
    tokenTotal: 10,
  } as unknown as SessionSummary;
}

function catalogDb(title: string = TITLE): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions(session_id TEXT, summary_json TEXT)');
  initializeSqliteTextIndex(db, catalogTitleIndex);
  db.prepare('INSERT INTO sessions(session_id, summary_json) VALUES (?, ?)').run(
    SESSION_ID,
    JSON.stringify({ title }),
  );
  return db;
}

/** A store with `list()` and no `listFiltered` — the in-process fallback path. */
function readerStore(title: string = TITLE): SessionStore {
  return {
    list: async () => [summary(title)],
    load: async () => ({ events: [] }),
  } as unknown as SessionStore;
}

function catalogIds(needle: string): string[] {
  const db = catalogDb();
  try {
    const rows = listCatalogRecords(
      db,
      { titleContains: needle },
      () => ({}) as CatalogSessionRecord,
    );
    return rows.map((row) => row.id);
  } finally {
    db.close();
  }
}

/** What the canonical fold answers on this host — the answer every path must give. */
function hostMatches(needle: string): boolean {
  return TITLE.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

async function readerIds(needle: string): Promise<string[]> {
  const reader = new DefaultSessionReader({ store: readerStore() });
  return (await reader.query({ titleContains: needle })).map((s) => s.id);
}

describe('session-search locale parity (U+0130)', () => {
  for (const [label, needle] of [
    ['plain-ASCII needle', ASCII_NEEDLE],
    ['two-code-point needle', DECOMPOSED_NEEDLE],
  ] as const) {
    describe(label, () => {
      const expected = hostMatches(needle) ? [SESSION_ID] : [];

      it('A: the SQLite catalog path follows the host fold', () => {
        // The row mapper is stubbed, so the row count is what this path answers.
        expect(catalogIds(needle)).toHaveLength(expected.length);
      });

      it('B: the canonical matcher follows the host fold', () => {
        expect(matchesSessionFilter(summary(), { titleContains: needle })).toBe(
          expected.length === 1,
        );
      });

      it('C: the session reader follows the host fold', async () => {
        expect(await readerIds(needle)).toEqual(expected);
      });
    });
  }

  it('the two needles fold apart, so the second trigger still separates B from C', () => {
    // Exactly one of them matches on any host: under `tr` the ASCII needle, elsewhere the
    // decomposed one. A path that mixed `toLowerCase()` with `toLocaleLowerCase()` fails one.
    expect(hostMatches(ASCII_NEEDLE)).not.toBe(hostMatches(DECOMPOSED_NEEDLE));
  });
});
