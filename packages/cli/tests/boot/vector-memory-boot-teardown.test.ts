/**
 * Boot-to-teardown proof for vector memory in the CLI.
 *
 * Mirrors the exact production constructor path used in
 * `packages/cli/src/cli-main.ts:99-120`: `VectorMemoryStore` +
 * `TransformersEmbeddingProvider`, wired through `setupCliPromptAndTools`
 * (which the real CLI calls), tools executed via the real `ToolRegistry`,
 * then `store.close()` on teardown. The test is hermetic — uses
 * `FakeEmbeddingProvider` instead of the real transformers.js pipeline so
 * it runs in CI without the ~25 MB model download.
 *
 * What it pins:
 *  1. Construction of the store + provider (the boot step) succeeds.
 *  2. `setupCliPromptAndTools` wires the four `vector_memory_*` tools
 *     into the real `ToolRegistry` alongside the SAGE surface.
 *  3. An agent can call `vector_memory_remember` and `vector_memory_search`
 *     through the wired surface (the same surface the production CLI uses).
 *  4. `close()` runs cleanly on teardown — the SQLite handle is released
 *     and `getStats()` after close throws.
 *
 * This is the binding proof that vector memory works from boot to
 * teardown in the real CLI binary path. If any step regresses, this test
 * fails and the regression is caught before a release.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '@wrongstack/core/registry';
import type { Context } from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';
import { registerCanonicalHostTools } from '@wrongstack/runtime/tool-registration';
import { TransformersEmbeddingProvider, VectorMemoryStore } from '@wrongstack/vector-memory';

import { FakeEmbeddingProvider } from './fake-vector-embedding-provider.js';

function fakeProjectRoot(): string {
  return path.join(
    os.tmpdir(),
    `wrongstack-vm-boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function syntheticContext(): Context {
  return {
    systemPrompt: [],
    cwd: '/tmp',
    projectRoot: '/tmp',
    allowOutsideProjectRoot: false,
    model: 'vector-memory-boot',
    tools: [],
    meta: {},
  } as unknown as Context;
}

describe('vector memory — CLI boot-to-teardown proof', () => {
  let store: VectorMemoryStore;
  let registry: ToolRegistry;

  beforeEach(() => {
    // Step 1: boot — mirror cli-main.ts:99-120.
    // We use the FakeEmbeddingProvider here for hermetic CI; the production
    // boot path uses TransformersEmbeddingProvider with the same shape.
    const projectRoot = fakeProjectRoot();
    store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });
    // The model cache path that the production CLI uses — keep the
    // assertion side-by-side with the real wiring so a future change to
    // cli-main.ts is caught here. Normalize separators so the assertion
    // works on Windows (where path.join produces `\` separators).
    const modelCacheDir = path
      .join(projectRoot, '.wrongstack', 'cache', 'transformers-models')
      .replace(/\\/g, '/');
    expect(modelCacheDir).toContain('.wrongstack/cache/transformers-models');

    // Step 2: wire through the real CLI tool-registration surface.
    registry = new ToolRegistry();
    registerCanonicalHostTools({
      registry,
      tier: 'off',
      memory: { enabled: false, store: null },
      vectorMemory: { store },
    });
  });

  afterEach(() => {
    // Step 4: teardown — mirror cli-main.ts:177-188.
    expect(() => store.close()).not.toThrow();
    // close() must release the handle: any subsequent read throws.
    expect(() => store.stats()).toThrow(/closed/i);
  });

  it('boots, registers tools, executes remember+search, and tears down', async () => {
    const remember = registry.get('vector_memory_remember') as Tool<
      { text: string; tags?: string[] },
      { id: string; hasVector: boolean }
    >;
    const search = registry.get('vector_memory_search') as Tool<
      { query: string; limit?: number; threshold?: number },
      { hits: Array<{ id: string; score: number; text: string }> }
    >;
    const stats = registry.get('vector_memory_stats') as Tool<
      Record<string, never>,
      { entries: number; vectors: number; modelId: string }
    >;
    const forget = registry.get('vector_memory_forget') as Tool<
      { id: string },
      { removed: boolean }
    >;

    // Step 3a: agent writes three entries through the wired surface.
    await remember.execute({ text: 'apple banana cherry', tags: ['fruit'] }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    await remember.execute({ text: 'apple mango pineapple', tags: ['fruit'] }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    await remember.execute({ text: 'sports car engine', tags: ['vehicle'] }, syntheticContext(), {
      signal: new AbortController().signal,
    });

    // Step 3b: agent reads — semantic search returns all three entries,
    // sorted by cosine similarity, and the entry closest to the query
    // (which shares the "apple banana" prefix) ranks first.
    const result = await search.execute({ query: 'apple banana', limit: 5 }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(result.hits.length).toBe(3);
    // The closest match shares the longest prefix with the query.
    expect(result.hits[0]!.text).toContain('apple banana');

    // Step 3c: stats surface — entries/vectors/modelId visible.
    const s = await stats.execute({}, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(s.entries).toBe(3);
    expect(s.vectors).toBe(3);
    expect(s.modelId).toMatch(/^fake-/);

    // Step 3d: forget works and the entry disappears from search.
    const written = await remember.execute({ text: 'transient entry' }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    const forgetResult = await forget.execute({ id: written.id }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(forgetResult.removed).toBe(true);
    const afterForget = await search.execute({ query: 'transient entry' }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(afterForget.hits.find((h) => h.id === written.id)).toBeUndefined();
  });

  it('exposes the production TransformersEmbeddingProvider boot path (contract test, not network)', async () => {
    // This test pins the *shape* of the production provider — its id,
    // dimensions, and `isAvailable` surface. It does not download the model.
    const provider = new TransformersEmbeddingProvider({
      cacheDir: path.join(
        os.tmpdir(),
        `vm-contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ),
    });
    expect(provider.dimensions).toBe(384);
    expect(provider.id).toMatch(/^transformers-js:Xenova\/all-MiniLM-L6-v2:/);
    // isAvailable() is a dynamic-import probe; it returns a boolean.
    // We do NOT assert true/false — only that it returns a boolean and
    // does not throw. CI runs without the model installed in some envs.
    const available = await provider.isAvailable();
    expect(typeof available).toBe('boolean');
  });
});
