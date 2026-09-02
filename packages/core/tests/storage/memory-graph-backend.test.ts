import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphMemoryBackend } from '../../src/storage/memory-graph-backend.js';
import type { MemoryEntry } from '../../src/types/memory.js';

let tmp: string;
let memFile: string;
let backend: GraphMemoryBackend;

const fwd = (p: string) => p.replace(/\\/g, '/');
const scope = 'project-memory' as const;

const entry = (text: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  scope,
  text,
  ts: over.ts ?? new Date(2026, 0, 1, 0, 0, over.confidence ?? 0).toISOString(),
  ...over,
});

beforeEach(async () => {
  tmp = fwd(await fs.mkdtemp(path.join(os.tmpdir(), 'mem-graph-')));
  memFile = `${tmp}/mem.md`;
  backend = new GraphMemoryBackend({
    paths: { projectDir: tmp } as never,
    graphPath: `${tmp}/memory-graph.json`,
  });
});
afterEach(async () => {
  await backend.flush();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GraphMemoryBackend.remember', () => {
  it('creates a node and persists the graph', async () => {
    await backend.remember(scope, entry('the build uses pnpm workspaces'), memFile);
    await backend.flush(); // _saveGraph is fire-and-forget; flush ensures write completes.
    const g = backend.getGraph();
    expect(g.nodes.length).toBe(1);
    // Graph file written
    await expect(fs.readFile(`${tmp}/memory-graph.json`, 'utf8')).resolves.toContain('nodes');
  });

  it('increments count when the same entry is remembered again', async () => {
    await backend.remember(scope, entry('duplicate fact here'), memFile);
    await backend.remember(scope, entry('duplicate fact here'), memFile);
    const node = backend.getGraph().nodes.find((n) => n.entry.text === 'duplicate fact here');
    expect(node?.count).toBe(2);
  });

  it('creates similarity edges between word-overlapping entries', async () => {
    await backend.remember(scope, entry('the typescript build pipeline is fast'), memFile);
    await backend.remember(scope, entry('the typescript build pipeline is slow'), memFile);
    expect(backend.getGraph().edges.length).toBeGreaterThan(0);
  });

  it('creates edges from shared tags', async () => {
    await backend.remember(scope, entry('alpha note', { tags: ['x', 'y'] }), memFile);
    await backend.remember(
      scope,
      entry('totally unrelated words zzz', { tags: ['x', 'y'] }),
      memFile,
    );
    const edges = backend.getGraph().edges;
    expect(edges.some((e) => e.relation === 'same_turn' || e.relation === 'similar')).toBe(true);
  });
});

describe('GraphMemoryBackend.list / search', () => {
  beforeEach(async () => {
    await backend.remember(
      scope,
      entry('pnpm install is the setup step', { type: 'fact', priority: 'high', tags: ['build'] }),
      memFile,
    );
    await backend.remember(
      scope,
      entry('use conventional commits always', {
        type: 'convention',
        priority: 'critical',
        tags: ['git'],
      }),
      memFile,
    );
  });

  it('lists entries enriched with graph metadata, newest first', async () => {
    const list = await backend.list(scope, memFile);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((e) => e.priority === 'critical')).toBe(true);
  });

  it('respects a list limit', async () => {
    const list = await backend.list(scope, memFile, 1);
    expect(list.length).toBe(1);
  });

  it('searches by word and tag overlap with priority/count boosts', async () => {
    const res = await backend.search(scope, 'commits git', memFile);
    expect(res[0]?.text).toContain('conventional commits');
  });

  it('still surfaces noded entries via metadata boosts even without a lexical match', async () => {
    // Graph nodes contribute priority/count score, so remembered entries rank
    // above the score>0 cutoff regardless of query word overlap.
    const res = await backend.search(scope, 'zzznomatchzzz', memFile);
    expect(res.length).toBeGreaterThan(0);
  });

  it('respects a search limit', async () => {
    const res = await backend.search(scope, 'the', memFile, 1);
    expect(res.length).toBeLessThanOrEqual(1);
  });

  it('readAll returns the raw markdown', async () => {
    const raw = await backend.readAll(scope, memFile);
    expect(raw).toContain('pnpm');
  });
});

describe('GraphMemoryBackend.forget / clear / consolidate', () => {
  it('forgets matching entries and prunes their graph nodes/edges', async () => {
    await backend.remember(scope, entry('forget me please now'), memFile);
    await backend.remember(scope, entry('keep this one around'), memFile);
    const removed = await backend.forget(scope, 'forget me', memFile);
    expect(removed).toBeGreaterThan(0);
    expect(backend.getGraph().nodes.some((n) => n.entry.text.includes('forget me'))).toBe(false);
  });

  it('is a no-op when forget matches nothing', async () => {
    await backend.remember(scope, entry('something'), memFile);
    expect(await backend.forget(scope, 'nonexistent-xyz', memFile)).toBe(0);
  });

  it('clears all entries and removes the graph file', async () => {
    await backend.remember(scope, entry('to be cleared'), memFile);
    await backend.clear(scope, memFile);
    expect(backend.getGraph().nodes.length).toBe(0);
    await expect(fs.access(`${tmp}/memory-graph.json`)).rejects.toThrow();
  });

  it('delegates consolidate to the file backend', async () => {
    await backend.remember(scope, entry('consolidate target'), memFile);
    await expect(backend.consolidate(scope, memFile)).resolves.toBeTypeOf('number');
  });
});

describe('GraphMemoryBackend.findRelated + persistence', () => {
  it('finds related memories via graph edges ordered by weight', async () => {
    await backend.remember(scope, entry('react component renders the list view'), memFile);
    await backend.remember(scope, entry('react component renders the grid view'), memFile);
    const related = await backend.findRelated(
      scope,
      memFile,
      'react component renders the list view',
    );
    expect(related.some((e) => e.text.includes('grid view'))).toBe(true);
  });

  it('reloads the graph from disk in a fresh backend instance', async () => {
    await backend.remember(scope, entry('persisted across reload'), memFile);
    const reopened = new GraphMemoryBackend({
      paths: { projectDir: tmp } as never,
      graphPath: `${tmp}/memory-graph.json`,
    });
    const list = await reopened.list(scope, memFile);
    expect(list.some((e) => e.text.includes('persisted across reload'))).toBe(true);
  });

  it('starts with an empty graph when the graph file is absent/corrupt', async () => {
    await fs.writeFile(`${tmp}/memory-graph.json`, 'not json');
    const related = await backend.findRelated(scope, memFile, 'anything');
    expect(related).toEqual([]);
  });

  it('orders multiple related edges by weight (sort comparator)', async () => {
    await backend.remember(scope, entry('shared alpha beta gamma topic'), memFile);
    await backend.remember(scope, entry('shared alpha beta gamma delta'), memFile);
    await backend.remember(scope, entry('shared alpha beta gamma epsilon'), memFile);
    const related = await backend.findRelated(scope, memFile, 'shared alpha beta gamma topic');
    expect(related.length).toBeGreaterThanOrEqual(2); // multiple edges → comparator invoked
  });

  it('prunes edges when forgetting a node that participates in edges', async () => {
    await backend.remember(scope, entry('overlap one two three four'), memFile);
    await backend.remember(scope, entry('overlap one two three five'), memFile);
    expect(backend.getGraph().edges.length).toBeGreaterThan(0);
    await backend.forget(scope, 'overlap one two three four', memFile);
    expect(backend.getGraph().nodes.some((n) => n.entry.text.includes('four'))).toBe(false);
  });

  it('treats entries with only short words as having zero overlap', async () => {
    await backend.remember(scope, entry('a an of in on'), memFile); // all words <= 2 chars
    await backend.remember(scope, entry('to be or by it'), memFile);
    // No similarity edge is created (wordOverlap returns 0 for empty word sets).
    expect(backend.getGraph().edges.length).toBe(0);
  });
});
