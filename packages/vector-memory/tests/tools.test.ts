/**
 * createVectorMemoryTools tests — verify tool shape, permissions, and execution.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVectorMemoryTools, VectorMemoryStore } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function makeStore(): VectorMemoryStore {
  const projectRoot = path.join(
    os.tmpdir(),
    `wrongstack-vm-tools-${testRunId}-${Math.random().toString(36).slice(2, 8)}`,
  );
  return new VectorMemoryStore({
    provider: new FakeEmbeddingProvider({ dimensions: 32 }),
    projectRoot,
  });
}

describe('createVectorMemoryTools', () => {
  let store: VectorMemoryStore;

  beforeEach(() => {
    store = makeStore();
  });

  afterEach(() => {
    store.close();
  });

  it('exposes four tools with the expected names and permissions', () => {
    const tools = createVectorMemoryTools(store);
    expect(tools.map((t) => t.name)).toEqual([
      'vector_memory_remember',
      'vector_memory_search',
      'vector_memory_stats',
      'vector_memory_forget',
    ]);
    const remember = tools.find((t) => t.name === 'vector_memory_remember')!;
    const search = tools.find((t) => t.name === 'vector_memory_search')!;
    const stats = tools.find((t) => t.name === 'vector_memory_stats')!;
    const forget = tools.find((t) => t.name === 'vector_memory_forget')!;
    expect(remember.permission).toBe('confirm');
    expect(remember.mutating).toBe(true);
    expect(search.permission).toBe('auto');
    expect(search.mutating).toBe(false);
    expect(stats.permission).toBe('auto');
    expect(forget.permission).toBe('confirm');
    expect(forget.mutating).toBe(true);
  });

  it('executes vector_memory_remember and returns an id + hasVector flag', async () => {
    const tools = createVectorMemoryTools(store);
    const remember = tools.find((t) => t.name === 'vector_memory_remember')!;
    const result = (await remember.execute!({ text: 'persist me', tags: ['t'] }, {} as never, {
      signal: new AbortController().signal,
    })) as { id: string; hasVector: boolean };
    expect(result.id).toBeTypeOf('string');
    expect(result.hasVector).toBe(true);
  });

  it('executes vector_memory_search and returns ranked hits', async () => {
    await store.remember({ text: 'apple banana' });
    await store.remember({ text: 'apple mango' });
    const tools = createVectorMemoryTools(store);
    const search = tools.find((t) => t.name === 'vector_memory_search')!;
    const result = (await search.execute!({ query: 'apple banana', limit: 5 }, {} as never, {
      signal: new AbortController().signal,
    })) as { hits: Array<{ id: string; score: number; text: string }> };
    expect(result.hits.length).toBe(2);
    expect(result.hits[0]!.text).toContain('apple');
  });

  it('executes vector_memory_stats and returns counts', async () => {
    await store.remember({ text: 'one' });
    const tools = createVectorMemoryTools(store);
    const stats = tools.find((t) => t.name === 'vector_memory_stats')!;
    const result = (await stats.execute!({}, {} as never, {
      signal: new AbortController().signal,
    })) as {
      entries: number;
      vectors: number;
    };
    expect(result.entries).toBe(1);
    expect(result.vectors).toBe(1);
  });

  it('executes vector_memory_forget and reports removal', async () => {
    const entry = await store.remember({ text: 'goodbye' });
    const tools = createVectorMemoryTools(store);
    const forget = tools.find((t) => t.name === 'vector_memory_forget')!;
    const result = (await forget.execute!({ id: entry.id }, {} as never, {
      signal: new AbortController().signal,
    })) as { removed: boolean };
    expect(result.removed).toBe(true);
  });
});
