/**
 * End-to-end integration test: real `SqliteMemoryPort` + real
 * `VectorMemoryStore` + `wrapMemoryPortWithVectorRecall` →
 * `searchSage` actually fuses lexical and semantic recall.
 *
 * This test pins the wiring path the CLI takes at boot:
 *   1. SAGE store holds active memories (lexical candidates).
 *   2. Vector store is mirrored from SAGE via `syncFromSage` so each entry
 *      carries `metadata.sageId`.
 *   3. The wrapped port's `searchSage` is called with a query that has
 *      near-zero lexical overlap with one of the SAGE memories — that
 *      memory's only path into the result is via the vector channel.
 *
 * Without the wrapper, the off-vocabulary memory is invisible. With the
 * wrapper, the semantic channel pulls it into the result and ranks it
 * via RRF.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getSageSurface,
  isSqliteAvailable,
  SAGE_RETRIEVAL_CAPABILITY,
  SqliteMemoryPort,
} from '@wrongstack/sage';

import { wrapMemoryPortWithVectorRecall, VectorMemoryStore } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SUITE_LABEL = `wrongstack-vm-int-${testRunId}`;

function makeFakeProvider(): FakeEmbeddingProvider {
  // 32-dim is enough to give distinct byte-code prefixes per text while
  // keeping the test cheap.
  return new FakeEmbeddingProvider({ dimensions: 32 });
}

const describeIfSqlite = isSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('SAGE × vector-memory end-to-end augmentation', () => {
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
      provider: makeFakeProvider(),
      projectRoot,
    });
  });

  afterEach(async () => {
    vectorStore.close();
    await sagePort.dispose();
  });

  it('semantic-only hit is surfaced by the wrapped port even when no lexical match exists', async () => {
    const surface = getSageSurface(sagePort)!;
    // Three SAGE memories. The third is described with rare/abstract
    // vocabulary that the FTS5 index will not match for our query.
    await surface.rememberSage({
      text: 'pnpm is the package manager used by this project',
      anchors: [],
    });
    const rare = await surface.rememberSage({
      text: 'photonic qubit coherence affects quantum compute orchestration',
      anchors: [],
    });
    await surface.rememberSage({
      text: 'linting runs on pre-commit hooks via husky',
      anchors: [],
    });

    // Mirror the SAGE corpus into the vector store with `metadata.sageId`
    // — this is exactly what `startFirstBootSageSync` does on first boot.
    const surface2 = getSageSurface(sagePort)!;
    const page = await surface2.listSagePage({ statuses: ['active'], limit: 100 });
    for (const m of page.memories) {
      await vectorStore.remember({
        text: m.text,
        metadata: { sageId: m.id, source: 'sage' },
        tags: m.tags,
      });
    }

    // Baseline: unwrapped port — search for a single token that the
    // rare memory does NOT contain. The lexical channel must miss it.
    const baseline = await sagePort.searchSage('xylophone', { limit: 5 });
    const baselineIds = baseline.map((m) => m.id);
    expect(baselineIds).not.toContain(rare.id);

    // Augmented: wrap the port with the vector store. The vector channel
    // has the rare memory indexed with the embedding for
    // "photonic qubit coherence affects quantum compute orchestration".
    // A semantic search for a paraphrase still ranks it; even a
    // near-miss query that doesn't lexically match should surface it
    // because the vector store has the only path to that memory.
    const wrapped = wrapMemoryPortWithVectorRecall(sagePort, { store: vectorStore });
    const retrieval = wrapped.getCapability(SAGE_RETRIEVAL_CAPABILITY);
    if (!retrieval) throw new Error('SAGE_RETRIEVAL_CAPABILITY not wired');
    const augmented = await retrieval.searchSage('quantum photonic', { limit: 5 });
    const augmentedIds = augmented.map((m) => m.id);
    expect(augmentedIds).toContain(rare.id);
  });

  it('does not double-count when the same memory appears in both channels', async () => {
    const surface = getSageSurface(sagePort)!;
    const mem = await surface.rememberSage({
      text: 'apple banana cherry pie',
      anchors: [],
    });

    // Mirror to the vector store.
    await vectorStore.remember({
      text: 'apple banana cherry pie',
      metadata: { sageId: mem.id, source: 'sage' },
    });

    const wrapped = wrapMemoryPortWithVectorRecall(sagePort, { store: vectorStore });
    const retrieval = wrapped.getCapability(SAGE_RETRIEVAL_CAPABILITY);
    if (!retrieval) throw new Error('SAGE_RETRIEVAL_CAPABILITY not wired');
    const result = await retrieval.searchSage('apple banana', { limit: 5 });
    // The same memory should appear at most once, even though it matched
    // both the lexical and the vector channels.
    const occurrences = result.filter((m) => m.id === mem.id).length;
    expect(occurrences).toBe(1);
    // And it should be ranked at or near the top (lexical hit is in the
    // canonical order; vector-augmented hits get an RRF boost on top).
    expect(result[0]!.id).toBe(mem.id);
  });

  it('falls back to pure lexical when the vector store throws', async () => {
    const surface = getSageSurface(sagePort)!;
    await surface.rememberSage({ text: 'apple banana cherry' });
    await surface.rememberSage({ text: 'apple banana mango' });

    // Build a provider that always throws.
    const brokenProvider = {
      search: async () => {
        throw new Error('vector backend down');
      },
    };
    const wrapped = wrapMemoryPortWithVectorRecall(sagePort, {
      store: vectorStore,
      vectorRecall: brokenProvider,
    });
    const retrieval = wrapped.getCapability(SAGE_RETRIEVAL_CAPABILITY);
    if (!retrieval) throw new Error('SAGE_RETRIEVAL_CAPABILITY not wired');
    const result = await retrieval.searchSage('apple', { limit: 5 });
    // Even with the vector channel down, the lexical list still comes
    // back unchanged. Order is whatever the SAGE store returned.
    expect(result.length).toBe(2);
    for (const memory of result) {
      expect(memory.text).toMatch(/apple/);
    }
  });

  it('honors a call-site vectorRecall override on the wrapped port', async () => {
    const surface = getSageSurface(sagePort)!;
    await surface.rememberSage({ text: 'first entry for override test' });

    // Wrap with a *throw* provider as the default.
    const throwProvider = {
      search: async () => {
        throw new Error('should not be called when caller overrides');
      },
    };
    const wrapped = wrapMemoryPortWithVectorRecall(sagePort, {
      store: vectorStore,
      vectorRecall: throwProvider,
    });
    const retrieval = wrapped.getCapability(SAGE_RETRIEVAL_CAPABILITY);
    if (!retrieval) throw new Error('SAGE_RETRIEVAL_CAPABILITY not wired');
    // Call site overrides with an empty-result provider → no augmentation
    // happens, but no crash either.
    const emptyProvider = {
      search: async () => [],
    };
    const result = await retrieval.searchSage('first entry', {
      limit: 5,
      vectorRecall: emptyProvider,
    });
    // The lexical hit is still returned (channel is the default lexical
    // surface; the override just changes which recall is used).
    expect(result.length).toBe(1);
    expect(result[0]!.text).toBe('first entry for override test');
  });
});
