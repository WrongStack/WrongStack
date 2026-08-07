import { describe, expect, it } from 'vitest';
import { toolSearchTool } from '../src/tool-search.js';

const makeCtx = (tools: any[] = []) => ({ cwd: '/fake', tools, projectRoot: '/fake' }) as any;

const executeToolSearch = (
  input: Parameters<typeof toolSearchTool.execute>[0],
  ctx: Parameters<typeof toolSearchTool.execute>[1],
) => toolSearchTool.execute(input, ctx, { signal: new AbortController().signal });

describe('toolSearchTool', () => {
  it('has correct metadata', () => {
    expect(toolSearchTool.name).toBe('tool_search');
    expect(toolSearchTool.permission).toBe('auto');
    expect(toolSearchTool.mutating).toBe(false);
  });

  it('returns empty for no matches', async () => {
    const ctx = makeCtx([{ name: 'foo', description: 'Foo', permission: 'auto', mutating: false }]);
    const result = await executeToolSearch({ query: 'nonexistent' }, ctx);
    expect(result.tools).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('filters by name query', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'A foo tool', permission: 'auto', mutating: false },
      { name: 'bar', description: 'A bar tool', permission: 'auto', mutating: false },
    ]);
    const result = await executeToolSearch({ query: 'foo' }, ctx);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('foo');
  });

  it('searches the lazy catalog rather than only the direct provider tools', async () => {
    const direct = [{ name: 'read', description: 'Read', permission: 'auto', mutating: false }];
    const lazy = {
      name: 'browser_open',
      description: 'Open browser',
      permission: 'auto',
      mutating: false,
    };
    const ctx = { ...makeCtx(direct), catalogTools: [...direct, lazy] };
    const result = await executeToolSearch({ query: 'browser' }, ctx);
    expect(result.tools.map((tool) => tool.name)).toEqual(['browser_open']);
  });

  it('filters by description query', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'Does foo things', permission: 'auto', mutating: false },
      { name: 'bar', description: 'Does bar things', permission: 'auto', mutating: false },
    ]);
    const result = await executeToolSearch({ query: 'things' }, ctx);
    expect(result.total).toBe(2);
  });

  it('filters by permission', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'Foo', permission: 'auto', mutating: false },
      { name: 'bar', description: 'Bar', permission: 'deny', mutating: false },
    ]);
    const result = await executeToolSearch({ permission: 'deny' }, ctx);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('bar');
  });

  it('filters by mutating flag', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'Foo', permission: 'auto', mutating: false },
      { name: 'bar', description: 'Bar', permission: 'auto', mutating: true },
    ]);
    const result = await executeToolSearch({ mutating: false }, ctx);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('foo');
  });

  it('respects limit', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'Foo', permission: 'auto', mutating: false },
      { name: 'bar', description: 'Bar', permission: 'auto', mutating: false },
    ]);
    const result = await executeToolSearch({ limit: 1 }, ctx);
    expect(result.tools).toHaveLength(1);
    // truncated is true when filtered.length > limit
    expect(result.truncated).toBe(true);
  });

  it('caps limit at 100', async () => {
    const ctx = makeCtx([{ name: 'foo', description: 'Foo', permission: 'auto', mutating: false }]);
    const result = await executeToolSearch({ limit: 999 }, ctx as any);
    expect(result.tools).toHaveLength(1);
  });

  it('combines all filters', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'A foo tool', permission: 'auto', mutating: false },
      { name: 'bar', description: 'A bar tool', permission: 'confirm', mutating: true },
    ]);
    const result = await executeToolSearch({ query: 'foo', mutating: false }, ctx);
    expect(result.tools).toHaveLength(1);
  });
});
