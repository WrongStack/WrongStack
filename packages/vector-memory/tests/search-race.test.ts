/**
 * Tests for the search-channel race — runs the same query through SAGE
 * (lexical) and the vector store (semantic) independently and surfaces
 * the overlap + the channel-specific misses. The race is the simplest
 * way to make the dual-channel value visible to operators.
 *
 * Pin:
 *  - `formatSearchRace` produces a readable per-bucket breakdown
 *  - `runSearchRace` classifies memories into the right bucket
 *  - Failures on the vector side don't poison the lexical side
 *  - The summary metrics correctly report agreement / miss rates
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { getSageSurface, isSqliteAvailable, type Sage, SqliteMemoryPort } from '@wrongstack/sage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSearchRace, VectorMemoryStore, type VectorSearchHit } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SUITE_LABEL = `wrongstack-vm-race-${testRunId}`;

const describeIfSqlite = isSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('runSearchRace', () => {
  let projectRoot: string;
  let sagePort: SqliteMemoryPort;
  let vectorStore: VectorMemoryStore;

  beforeEach(async () => {
    projectRoot = path.join(
      os.tmpdir(),
      `${SUITE_LABEL}-${Math.random().toString(36).slice(2, 8)}`,
    );
    sagePort = new SqliteMemoryPort({ projectRoot });
    await sagePort.initialize();
    vectorStore = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });
  });

  afterEach(async () => {
    vectorStore.close();
    await sagePort.dispose();
  });

  it('classifies a memory found by both channels into the overlap bucket', async () => {
    const surface = getSageSurface(sagePort)!;
    const created = await surface.rememberSage({
      text: 'database connection pool sizing guidance',
      tags: ['postgres'],
      anchors: [],
    });
    // Seed the vector store from the SAGE surface so it carries sageId.
    await vectorStore.remember({
      text: 'database connection pool sizing guidance',
      tags: ['postgres'],
      metadata: { source: 'sage', sageId: created.id },
    });

    const lexical: Sage[] = await surface.searchSage('connection pool', { limit: 10 });
    const race = await runSearchRace('connection pool', lexical, vectorStore, { limit: 10 });

    expect(race.overlap.length).toBeGreaterThan(0);
    expect(race.overlap[0]!.id).toBe(created.id);
    expect(race.overlap[0]!.vectorScore).toBeGreaterThan(0);
    expect(race.metrics.overlapCount).toBe(race.overlap.length);
    expect(race.metrics.agreementRatio).toBeGreaterThan(0);
  });

  it('classifies a memory found by lexical but not vector as lexical-only', async () => {
    const surface = getSageSurface(sagePort)!;
    // Lexical-side memory (in SAGE only) — do NOT mirror it to vector.
    const created = await surface.rememberSage({
      text: 'rare-token symbol abcdef-xyz-1234',
      tags: ['note'],
      anchors: [],
    });
    // A second memory in BOTH channels so the race has overlap context.
    const overlap = await surface.rememberSage({
      text: 'common phrasing shared across both stores',
      anchors: [],
    });
    await vectorStore.remember({
      text: 'common phrasing shared across both stores',
      metadata: { source: 'sage', sageId: overlap.id },
    });

    const lexical: Sage[] = await surface.searchSage('abcdef-xyz-1234', { limit: 10 });
    const race = await runSearchRace('abcdef-xyz-1234', lexical, vectorStore, { limit: 10 });

    const lexicalOnlyIds = race.lexicalOnly.map((row) => row.id);
    expect(lexicalOnlyIds).toContain(created.id);
    expect(lexicalOnlyIds).not.toContain(overlap.id);
    expect(race.metrics.lexicalOnlyRatio).toBeGreaterThan(0);
  });

  it('classifies a memory found by vector but not lexical as vector-only', async () => {
    const surface = getSageSurface(sagePort)!;
    // Mirror one memory into vector-only (no SAGE id) AND one that's
    // mirrored correctly. The race should report both channels
    // participating.
    const mirrored = await surface.rememberSage({
      text: 'paraphrased semantic anchor',
      anchors: [],
    });
    await vectorStore.remember({
      text: 'paraphrased semantic anchor',
      metadata: { source: 'sage', sageId: mirrored.id },
    });
    // A vector-only entry (no sageId) — should be skipped (we can't
    // map it to a SAGE id) and not appear in any bucket.
    await vectorStore.remember({
      text: 'standalone vector-only entry',
      metadata: { source: 'manual' },
    });

    const lexical: Sage[] = await surface.searchSage('paraphrased semantic anchor', {
      limit: 10,
    });
    const race = await runSearchRace('paraphrased semantic anchor', lexical, vectorStore, {
      limit: 10,
    });

    // The race should put `mirrored` in overlap (both channels hit it).
    expect(race.overlap.some((row) => row.id === mirrored.id)).toBe(true);
    // Standalone (no sageId) entries must not appear in any bucket.
    for (const row of race.vectorOnly) {
      const sid = (row as { id: string }).id;
      expect(sid).not.toBe('manual');
    }
  });

  it('treats vector-side failures as an empty channel without throwing', async () => {
    const surface = getSageSurface(sagePort)!;
    await surface.rememberSage({ text: 'normal memory', anchors: [] });

    // Build a broken store whose `.search()` throws — the race must
    // swallow the failure and return lexical-only results.
    const brokenStore = {
      search: async () => {
        throw new Error('provider unavailable');
      },
    } as unknown as VectorMemoryStore;

    const lexical: Sage[] = await surface.searchSage('normal', { limit: 10 });
    const race = await runSearchRace('normal', lexical, brokenStore, { limit: 10 });

    expect(race.vectorOnly).toEqual([]);
    expect(race.overlap).toEqual([]);
    expect(race.lexicalOnly.length).toBeGreaterThan(0);
    expect(race.metrics.vectorCount).toBe(0);
    expect(race.metrics.lexicalOnlyRatio).toBe(1);
  });
});

// Regression (2026-09-02): the overlap bucket used `vectorScore: 0` as a
// "not yet patched" sentinel, so a genuine score-0 vector hit — routine when
// store.search clamps negative cosines to 0 (HashingEmbeddingProvider
// fallback) — was swept into lexicalOnly with vectorScore null, the inverse
// of the truth. Null is the sentinel now; a real 0 stays in overlap.
describe('runSearchRace — zero-score vector hits', () => {
  it('classifies a score-0 vector hit as overlap, not lexical-only', async () => {
    const lexical = [
      { id: 'm1', text: 'alpha beta' },
      { id: 'm2', text: 'gamma delta' },
    ] as unknown as Sage[];
    const store = {
      search: async () =>
        [
          {
            entry: { id: 'v1', text: 'alpha beta mirror', metadata: { sageId: 'm1' } },
            score: 0,
          },
          {
            entry: { id: 'v2', text: 'semantic paraphrase', metadata: { sageId: 'v-only' } },
            score: 0.9,
          },
        ] as unknown as VectorSearchHit[],
    } as unknown as VectorMemoryStore;

    const race = await runSearchRace('anything', lexical, store, { limit: 10 });

    expect(race.lexicalOnly.map((row) => row.id)).toEqual(['m2']);
    const m1 = race.overlap.find((row) => row.id === 'm1');
    expect(m1?.vectorScore).toBe(0);
    expect(m1?.lexicalScore).toBe(1);
    expect(race.vectorOnly.map((row) => row.id)).toEqual(['v-only']);
    expect(race.metrics.lexicalCount).toBe(2);
    expect(race.metrics.lexicalOnlyRatio).toBe(0.5);
    expect(race.metrics.agreementRatio).toBe(0.5);
  });

  it('preserves forward lexical ranking order in lexicalOnly', async () => {
    const lexical = [
      { id: 'm1', text: 'top hit' },
      { id: 'm2', text: 'second hit' },
      { id: 'm3', text: 'third hit' },
    ] as unknown as Sage[];
    const emptyStore = {
      search: async () => [] as VectorSearchHit[],
    } as unknown as VectorMemoryStore;

    const race = await runSearchRace('query', lexical, emptyStore, { limit: 10 });
    expect(race.lexicalOnly.map((r) => r.id)).toEqual(['m1', 'm2', 'm3']);
    expect(race.lexicalOnly.map((r) => r.lexicalScore)).toEqual([1, 0.5, 0]);
  });

  it('retains the highest score when multiple vector hits reference the same sageId', async () => {
    const lexical = [
      { id: 'm1', text: 'top hit' },
    ] as unknown as Sage[];
    const store = {
      search: async () => [
        { entry: { id: 'v1', text: 'chunk 1', metadata: { sageId: 'm1' } }, score: 0.95 },
        { entry: { id: 'v2', text: 'chunk 2', metadata: { sageId: 'm1' } }, score: 0.25 },
      ] as unknown as VectorSearchHit[],
    } as unknown as VectorMemoryStore;

    const race = await runSearchRace('query', lexical, store, { limit: 10 });
    const overlapHit = race.overlap.find((h) => h.id === 'm1');
    expect(overlapHit?.vectorScore).toBe(0.95);
  });
});

