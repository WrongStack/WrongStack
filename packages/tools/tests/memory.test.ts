import type { MemoryEntry, MemoryStore } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { forgetTool, relatedMemoryTool, rememberTool, searchMemoryTool } from '../src/memory.js';
import { mkSandbox, newSignal } from './fixtures.js';

const sampleEntry: MemoryEntry = {
  text: 'use pnpm',
  ts: '2026-06-15T00:00:00.000Z',
  scope: 'project-memory',
  type: 'convention',
  tags: ['build'],
  priority: 'high',
} as MemoryEntry;

function fakeStore() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const store: MemoryStore = {
    readAll: vi.fn(async () => ''),
    read: vi.fn(async () => ''),
    remember: vi.fn(async (text: string, scope?: string, _meta?: Record<string, unknown>) => {
      calls.push({ method: 'remember', args: [text, scope] });
    }),
    forget: vi.fn(async (query: string, scope?: string) => {
      calls.push({ method: 'forget', args: [query, scope] });
      return 2;
    }),
    consolidate: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    search: vi.fn(async () => []),
    findRelated: vi.fn(async () => []),
  };
  return { store, calls };
}

describe('memory tools', () => {
  it('gates persistent memory writes but leaves memory reads automatic', () => {
    const { store } = fakeStore();
    expect(rememberTool(store).permission).toBe('confirm');
    expect(rememberTool(store).mutating).toBe(true);
    expect(forgetTool(store).permission).toBe('confirm');
    expect(searchMemoryTool(store).permission).toBe('auto');
    expect(relatedMemoryTool(store).permission).toBe('auto');
  });

  it('remember appends with default scope', async () => {
    const { store, calls } = fakeStore();
    const tool = rememberTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ text: 'use pnpm' }, sb.ctx, { signal: newSignal() });
      expect(out.ok).toBe(true);
      expect(out.scope).toBe('project-memory');
      expect(calls).toEqual([{ method: 'remember', args: ['use pnpm', 'project-memory'] }]);
    } finally {
      await sb.cleanup();
    }
  });

  it('remember honors explicit scope', async () => {
    const { store, calls } = fakeStore();
    const tool = rememberTool(store);
    const sb = await mkSandbox();
    try {
      await tool.execute({ text: 'prefer biome', scope: 'user-memory' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(calls[0]?.args[1]).toBe('user-memory');
    } finally {
      await sb.cleanup();
    }
  });

  it('forget carries a permission subject and the family icon', () => {
    const { store } = fakeStore();
    const tool = forgetTool(store);
    expect(tool.subjectKey).toBe('query');
    expect(tool.icon).toBe('settings');
  });

  it('forget dry_run previews matches without deleting', async () => {
    const { store } = fakeStore();
    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      sampleEntry,
      { ...sampleEntry, text: 'unrelated fact' },
      { ...sampleEntry, text: 'PNPM workspaces everywhere' },
    ]);
    const tool = forgetTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ query: 'pnpm', dry_run: true }, sb.ctx, {
        signal: newSignal(),
      });
      expect(store.forget).not.toHaveBeenCalled();
      expect(out.removed).toBe(0);
      expect(out.dryRun).toBe(true);
      expect(out.matched).toBe(2); // case-insensitive substring, like forget itself
      expect(out.matches).toEqual(['use pnpm', 'PNPM workspaces everywhere']);
    } finally {
      await sb.cleanup();
    }
  });

  it('forget dry_run caps the preview at 20 entries', async () => {
    const { store } = fakeStore();
    (store.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({ ...sampleEntry, text: `pnpm note ${i}` })),
    );
    const tool = forgetTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ query: 'pnpm', dry_run: true }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.matched).toBe(25);
      expect(out.matches).toHaveLength(20);
      expect(store.forget).not.toHaveBeenCalled();
    } finally {
      await sb.cleanup();
    }
  });

  it('forget reports number removed', async () => {
    const { store } = fakeStore();
    const tool = forgetTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ query: 'pnpm' }, sb.ctx, { signal: newSignal() });
      expect(out.removed).toBe(2);
    } finally {
      await sb.cleanup();
    }
  });

  it('remember forwards type/tags/priority metadata', async () => {
    const { store } = fakeStore();
    const tool = rememberTool(store);
    const sb = await mkSandbox();
    try {
      await tool.execute(
        { text: 'never push to main', type: 'anti_pattern', tags: ['git'], priority: 'critical' },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(store.remember).toHaveBeenCalledWith('never push to main', 'project-memory', {
        type: 'anti_pattern',
        tags: ['git'],
        priority: 'critical',
      });
    } finally {
      await sb.cleanup();
    }
  });

  it('remember rejects empty text', async () => {
    const { store } = fakeStore();
    const tool = rememberTool(store);
    const sb = await mkSandbox();
    try {
      await expect(tool.execute({ text: '' }, sb.ctx, { signal: newSignal() })).rejects.toThrow();
    } finally {
      await sb.cleanup();
    }
  });

  it('forget rejects empty query', async () => {
    const { store } = fakeStore();
    const tool = forgetTool(store);
    const sb = await mkSandbox();
    try {
      await expect(tool.execute({ query: '' }, sb.ctx, { signal: newSignal() })).rejects.toThrow(
        /query is required/,
      );
    } finally {
      await sb.cleanup();
    }
  });

  it('search_memory clamps the limit, defaults scope, and maps fields', async () => {
    const { store } = fakeStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([sampleEntry]);
    const tool = searchMemoryTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ query: 'pnpm', limit: 99 }, sb.ctx, { signal: newSignal() });
      expect(store.search).toHaveBeenCalledWith('pnpm', 'project-memory', 20); // clamped to 20
      expect(out.results[0]).toMatchObject({
        text: 'use pnpm',
        type: 'convention',
        priority: 'high',
      });
    } finally {
      await sb.cleanup();
    }
  });

  it('search_memory rejects empty query', async () => {
    const { store } = fakeStore();
    const tool = searchMemoryTool(store);
    const sb = await mkSandbox();
    try {
      await expect(tool.execute({ query: '' }, sb.ctx, { signal: newSignal() })).rejects.toThrow(
        /query is required/,
      );
    } finally {
      await sb.cleanup();
    }
  });

  it('find_related_memories uses the graph backend when available', async () => {
    const { store } = fakeStore();
    (store.findRelated as ReturnType<typeof vi.fn>).mockResolvedValue([sampleEntry]);
    const tool = relatedMemoryTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ text: 'pnpm', limit: 3 }, sb.ctx, { signal: newSignal() });
      expect(store.findRelated).toHaveBeenCalledWith('pnpm', 'project-memory', 3);
      expect(store.search).not.toHaveBeenCalled();
      expect(out.results).toHaveLength(1);
    } finally {
      await sb.cleanup();
    }
  });

  it('find_related_memories falls back to content search without a graph backend', async () => {
    const { store } = fakeStore();
    store.findRelated = undefined;
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([sampleEntry]);
    const tool = relatedMemoryTool(store);
    const sb = await mkSandbox();
    try {
      const out = await tool.execute({ text: 'pnpm' }, sb.ctx, { signal: newSignal() });
      expect(store.search).toHaveBeenCalledWith('pnpm', 'project-memory', 5); // default limit
      expect(out.results).toHaveLength(1);
    } finally {
      await sb.cleanup();
    }
  });

  it('find_related_memories rejects empty text', async () => {
    const { store } = fakeStore();
    const tool = relatedMemoryTool(store);
    const sb = await mkSandbox();
    try {
      await expect(tool.execute({ text: '' }, sb.ctx, { signal: newSignal() })).rejects.toThrow(
        /text is required/,
      );
    } finally {
      await sb.cleanup();
    }
  });

  it('search_memory uses default limit of 5 when not specified', async () => {
    const { store } = fakeStore();
    (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const tool = searchMemoryTool(store);
    const sb = await mkSandbox();
    try {
      await tool.execute({ query: 'test' }, sb.ctx, { signal: newSignal() });
      expect(store.search).toHaveBeenCalledWith('test', 'project-memory', 5);
    } finally {
      await sb.cleanup();
    }
  });
});
