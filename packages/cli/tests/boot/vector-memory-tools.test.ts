/**
 * End-to-end smoke test for the `vector_memory_*` tools.
 *
 * Exercises the full CLI tool-registration path: a `VectorMemoryStore`
 * with a deterministic fake provider is wired through `registerBuiltinTools`
 * and `registerCanonicalHostTools`, then each tool is looked up in the
 * real `ToolRegistry` and executed with a synthetic `Context`. This
 * pins the contract that agents can call `vector_memory_search` (and
 * its three siblings) without going through the production CLI boot.
 *
 * Uses no network and no transformers.js — the store is given a
 * `FakeEmbeddingProvider` so the smoke test stays hermetic.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '@wrongstack/core/registry';
import type { Context } from '@wrongstack/core/agent';
import type { Tool } from '@wrongstack/core/types';
import { registerCanonicalHostTools } from '@wrongstack/runtime/tool-registration';
import { VectorMemoryStore, type VectorMemoryStoreOptions } from '@wrongstack/vector-memory';

import { FakeEmbeddingProvider } from './fake-vector-embedding-provider.js';

function makeStore(opts: Partial<VectorMemoryStoreOptions> = {}): VectorMemoryStore {
  const projectRoot = path.join(
    os.tmpdir(),
    `wrongstack-vm-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return new VectorMemoryStore({
    provider: new FakeEmbeddingProvider({ dimensions: 32 }),
    projectRoot,
    ...opts,
  });
}

function syntheticContext(): Context {
  return {
    systemPrompt: [],
    cwd: '/tmp',
    projectRoot: '/tmp',
    allowOutsideProjectRoot: false,
    model: 'vector-memory-smoke',
    tools: [],
    meta: {},
  } as unknown as Context;
}

describe('vector_memory tools — end-to-end smoke', () => {
  let store: VectorMemoryStore;
  let registry: ToolRegistry;

  beforeEach(() => {
    store = makeStore();
    registry = new ToolRegistry();
    registerCanonicalHostTools({
      registry,
      tier: 'off',
      memory: { enabled: false, store: null },
      vectorMemory: { store },
    });
  });

  afterEach(() => {
    store.close();
  });

  it('registers all four vector_memory_* tools alongside the builtin pack', () => {
    const names = registry.list().map((t) => t.name);
    expect(names).toContain('vector_memory_remember');
    expect(names).toContain('vector_memory_search');
    expect(names).toContain('vector_memory_stats');
    expect(names).toContain('vector_memory_forget');
  });

  it('an agent can call vector_memory_remember → vector_memory_search end-to-end', async () => {
    const remember = registry.get('vector_memory_remember') as Tool<
      { text: string; tags?: string[] },
      { id: string; hasVector: boolean }
    >;
    const search = registry.get('vector_memory_search') as Tool<
      { query: string; limit?: number; threshold?: number },
      { hits: Array<{ id: string; score: number; text: string }> }
    >;

    const written = await remember.execute(
      { text: 'apple banana cherry', tags: ['fruit'] },
      syntheticContext(),
      { signal: new AbortController().signal },
    );
    expect(written.id).toBeTypeOf('string');
    expect(written.hasVector).toBe(true);

    await remember.execute({ text: 'completely unrelated text' }, syntheticContext(), {
      signal: new AbortController().signal,
    });

    const result = await search.execute({ query: 'apple banana', limit: 5 }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(result.hits.length).toBe(2);
    expect(result.hits[0]!.text).toContain('apple');
    // Scores should be sorted descending.
    for (let i = 1; i < result.hits.length; i++) {
      expect(result.hits[i - 1]!.score).toBeGreaterThanOrEqual(result.hits[i]!.score);
    }
  });

  it('an agent can call vector_memory_stats and see the stored entry count', async () => {
    const remember = registry.get('vector_memory_remember') as Tool<
      { text: string },
      { id: string; hasVector: boolean }
    >;
    const stats = registry.get('vector_memory_stats') as Tool<
      Record<string, never>,
      { entries: number; vectors: number; modelId: string }
    >;

    await remember.execute({ text: 'one' }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    await remember.execute({ text: 'two' }, syntheticContext(), {
      signal: new AbortController().signal,
    });

    const s = await stats.execute({}, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(s.entries).toBe(2);
    expect(s.vectors).toBe(2);
    expect(s.modelId).toMatch(/^fake-/);
  });

  it('an agent can call vector_memory_forget and the entry disappears', async () => {
    const remember = registry.get('vector_memory_remember') as Tool<
      { text: string },
      { id: string; hasVector: boolean }
    >;
    const forget = registry.get('vector_memory_forget') as Tool<
      { id: string },
      { removed: boolean }
    >;
    const search = registry.get('vector_memory_search') as Tool<
      { query: string; limit?: number },
      { hits: Array<{ id: string }> }
    >;

    const written = await remember.execute({ text: 'transient' }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    const forgetResult = await forget.execute({ id: written.id }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(forgetResult.removed).toBe(true);

    const after = await search.execute({ query: 'transient' }, syntheticContext(), {
      signal: new AbortController().signal,
    });
    expect(after.hits.find((h) => h.id === written.id)).toBeUndefined();
  });
});
