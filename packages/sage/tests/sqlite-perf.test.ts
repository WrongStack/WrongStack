/**
 * Performance-oriented SQLite store tests.
 *
 * These assert correctness of the optimized paths (targeted findRelated,
 * candidate canonical dedup, path edge lookup) under a larger synthetic
 * corpus, and record timing so regressions are visible in CI logs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let activeStores: SqliteSageStore[] = [];

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sqlite-perf-'));
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

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

describe('SqliteSageStore performance paths', () => {
  it('findRelatedSage returns tag/anchor related memories without scanning the whole corpus for scoring misses', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();

    // Seed + related pair
    const seed = await store.rememberSage({
      text: 'Auth module entry point',
      kind: 'file_note',
      tags: ['auth', 'security'],
      anchors: [{ type: 'file', path: 'src/auth/index.ts' }],
      importance: 0.9,
    });
    const relatedByTag = await store.rememberSage({
      text: 'JWT rotation policy',
      kind: 'convention',
      tags: ['auth'],
      importance: 0.7,
    });
    const relatedByPath = await store.rememberSage({
      text: 'Config for auth module',
      kind: 'file_note',
      anchors: [{ type: 'file', path: 'src/auth/index.ts' }],
      importance: 0.8,
    });

    // Noise corpus — no shared tags/anchors with seed
    const N = 400;
    for (let i = 0; i < N; i++) {
      await store.rememberSage({
        text: `Unrelated noise memory ${i} about unrelated topic ${i}`,
        kind: 'fact',
        tags: [`noise-${i % 17}`],
        anchors: [{ type: 'file', path: `src/noise/file-${i}.ts` }],
      });
    }

    const t0 = process.hrtime.bigint();
    const related = await store.findRelatedSage([seed.id], { limit: 20 });
    const ms = elapsedMs(t0);
    // Soft budget: even under CI load this should stay well under a second for ~400 rows.
    // The absolute bound guards against accidental full-table regressions.
    expect(ms).toBeLessThan(2_000);

    const relatedIds = new Set(related.map((m) => m.id));
    expect(relatedIds.has(relatedByTag.id)).toBe(true);
    expect(relatedIds.has(relatedByPath.id)).toBe(true);
    expect(relatedIds.has(seed.id)).toBe(false);
    // Noise should not dominate the result set
    expect(related.length).toBeLessThanOrEqual(20);
    expect(related.some((m) => m.text.startsWith('Unrelated noise'))).toBe(false);

    // eslint-disable-next-line no-console
    console.log(
      `[sqlite-perf] findRelatedSage N=${N + 3} → ${related.length} hits in ${ms.toFixed(1)}ms`,
    );
  });

  it('createCandidate dedups via indexed canonical_text under a large pending queue', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();

    const N = 200;
    for (let i = 0; i < N; i++) {
      await store.createCandidate({
        text: `Pending proposal number ${i}`,
        kind: 'fact',
        scope: 'project',
      });
    }

    const t0 = process.hrtime.bigint();
    const first = await store.createCandidate({
      text: 'Unique proposal for dedup check',
      kind: 'fact',
      scope: 'project',
    });
    const dup = await store.createCandidate({
      text: 'Unique proposal for dedup check',
      kind: 'fact',
      scope: 'project',
    });
    const ms = elapsedMs(t0);

    expect(dup.id).toBe(first.id);
    expect(ms).toBeLessThan(1_000);
    // eslint-disable-next-line no-console
    console.log(`[sqlite-perf] createCandidate dedup with ${N} pending in ${ms.toFixed(1)}ms`);
  });

  it('retrieveForPath uses edge index and stays fast with many anchored memories', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();

    await store.rememberSage({
      text: 'Target file note',
      kind: 'file_note',
      anchors: [{ type: 'file', path: 'src/target/hot.ts' }],
      importance: 0.95,
    });
    await store.rememberSage({
      text: 'Directory note',
      kind: 'file_note',
      anchors: [{ type: 'directory', path: 'src/target' }],
      importance: 0.7,
    });

    const N = 300;
    for (let i = 0; i < N; i++) {
      await store.rememberSage({
        text: `Other file note ${i}`,
        kind: 'file_note',
        anchors: [{ type: 'file', path: `src/other/file-${i}.ts` }],
      });
    }

    const t0 = process.hrtime.bigint();
    const hits = await store.retrieveForPath(['src/target/hot.ts'], {
      path: 'src/target/hot.ts',
      includeAncestors: true,
      limit: 10,
    });
    const ms = elapsedMs(t0);

    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.some((m) => m.text === 'Target file note')).toBe(true);
    expect(hits.some((m) => m.text === 'Directory note')).toBe(true);
    expect(ms).toBeLessThan(1_000);
    // eslint-disable-next-line no-console
    console.log(
      `[sqlite-perf] retrieveForPath N=${N + 2} → ${hits.length} hits in ${ms.toFixed(1)}ms`,
    );
  });

  it('batch remember + search stays within soft budget', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();

    const N = 250;
    const tWrite = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      await store.rememberSage({
        text: `Indexed fact about topic-${i % 40} detail ${i}`,
        kind: 'fact',
        tags: [`topic-${i % 40}`],
        importance: (i % 10) / 10,
      });
    }
    const writeMs = elapsedMs(tWrite);

    const tSearch = process.hrtime.bigint();
    const results = await store.searchSage('topic-7', { limit: 15 });
    const searchMs = elapsedMs(tSearch);

    expect(results.length).toBeGreaterThan(0);
    expect(writeMs).toBeLessThan(15_000);
    expect(searchMs).toBeLessThan(1_000);
    // eslint-disable-next-line no-console
    console.log(
      `[sqlite-perf] write N=${N} in ${writeMs.toFixed(0)}ms; search in ${searchMs.toFixed(1)}ms (${results.length} hits)`,
    );
  });
});
