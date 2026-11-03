import { createToolOutputSerializer } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { toolSearchTool } from '../src/tool-search.js';

const makeCtx = (tools: any[] = []) => ({ cwd: '/fake', tools, projectRoot: '/fake' }) as any;

const executeToolSearch = (
  input: Parameters<typeof toolSearchTool.execute>[0],
  ctx: Parameters<typeof toolSearchTool.execute>[1],
) => toolSearchTool.execute(input, ctx, { signal: new AbortController().signal });

describe('toolSearchTool', () => {
  it('finds old names and renders lifecycle, cost and recovery guidance on demand', async () => {
    const ctx = makeCtx([
      {
        name: 'canonical',
        aliases: ['old_name'],
        description: 'A fixture.',
        permission: 'confirm',
        mutating: true,
        inputSchema: { type: 'object' },
        deprecated: { since: '1.4', replacedBy: 'replacement' },
        cost: { kind: 'paid', fanOut: true },
        retrySafe: false,
        preconditions: ['Index ready'],
      },
    ]);
    const output = await executeToolSearch({ query: 'old_name' }, ctx);
    expect(output.tools[0]).toMatchObject({
      name: 'canonical',
      aliases: ['old_name'],
      cost: { kind: 'paid' },
      retrySafe: false,
      preconditions: ['Index ready'],
    });
    const rendered = toolSearchTool.serialize!(output, { query: 'old_name' });
    expect(rendered).toContain('replacement');
    expect(rendered).toContain('paid');
    expect(rendered).toContain('Index ready');
  });
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
    expect(result.tools[0]!.name).toBe('foo');
  });

  it('searches the lazy catalog rather than only the direct provider tools', async () => {
    const direct = [{ name: 'read', description: 'Read', permission: 'auto', mutating: false }];
    const lazy = {
      name: 'browser_open',
      description: 'Open browser',
      usageHint: 'Open a browser at the requested URL.',
      permission: 'auto',
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    };
    const ctx = { ...makeCtx(direct), catalogTools: [...direct, lazy] };
    const result = await executeToolSearch({ query: 'browser' }, ctx);
    expect(result.tools.map((tool) => tool.name)).toEqual(['browser_open']);
    expect(result.tools[0]).toMatchObject({
      usageHint: 'Open a browser at the requested URL.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    });
  });

  it('returns the lazy Kanban action schema needed for tool_use', async () => {
    const ctx = { ...makeCtx([]), catalogTools: [kanbanTool] };
    const result = await executeToolSearch({ query: 'kanban' }, ctx);
    const schema = result.tools[0]?.inputSchema as {
      properties?: { action?: { enum?: string[] } };
    };

    expect(result.tools[0]?.name).toBe('kanban');
    expect(schema.properties?.action?.enum).toContain('workbench');
    expect(schema.properties?.action?.enum).toContain('create_board');
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
    expect(result.tools[0]!.name).toBe('bar');
  });

  it('filters by mutating flag', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'Foo', permission: 'auto', mutating: false },
      { name: 'bar', description: 'Bar', permission: 'auto', mutating: true },
    ]);
    const result = await executeToolSearch({ mutating: false }, ctx);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe('foo');
  });

  it('makes category and capability tags discoverable and filterable', async () => {
    const ctx = makeCtx([
      {
        name: 'codebase-search',
        description: 'Search indexed declarations',
        category: 'Project',
        capabilities: ['codebase.search'],
        permission: 'auto',
        mutating: false,
      },
      {
        name: 'write',
        description: 'Write a file',
        category: 'Filesystem',
        permission: 'confirm',
        mutating: true,
      },
    ]);

    const result = await executeToolSearch({ tags: ['codebase'] }, ctx);

    expect(result.tools).toEqual([
      expect.objectContaining({
        name: 'codebase-search',
        category: 'Project',
        capabilities: ['codebase.search'],
      }),
    ]);
  });

  it('does not claim that a default empty search lists every tool', async () => {
    const ctx = makeCtx([
      { name: 'read', description: 'Read', permission: 'auto', mutating: false },
    ]);
    const result = await executeToolSearch({ query: 'missing' }, ctx);

    expect(result.hint).toContain('limit up to 100');
    expect(result.hint).not.toContain('list them all');
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

  it('finds a tool from a phrase a model writes, ranking the name match first', async () => {
    const ctx = makeCtx([
      {
        name: 'write',
        description: 'Write a file at a path',
        permission: 'confirm',
        mutating: true,
      },
      {
        name: 'image_generate',
        description: 'Generate an image from a text prompt and save it into the project.',
        usageHint: 'Give a prompt and a project-relative path.',
        permission: 'confirm',
        mutating: true,
      },
      { name: 'grep', description: 'Search file contents', permission: 'auto', mutating: false },
    ]);
    const result = await executeToolSearch(
      { query: 'image_generate generate image with prompt and path' },
      ctx,
    );
    expect(result.tools.map((t) => t.name)).toEqual(['image_generate']);

    const loose = await executeToolSearch({ query: 'save image file' }, ctx);
    expect(loose.tools[0]?.name).toBe('image_generate');
  });

  it('says when the filters, not the query, emptied the result', async () => {
    const ctx = makeCtx([
      {
        name: 'image_generate',
        description: 'Generate an image',
        permission: 'confirm',
        mutating: true,
      },
    ]);
    const result = await executeToolSearch({ query: 'image_generate', permission: 'auto' }, ctx);
    expect(result.tools).toEqual([]);
    expect(result.hint).toContain(
      '1 tool(s) match "image_generate" but the tags/permission/mutating filters excluded them',
    );

    const none = await executeToolSearch({ query: 'nothing-like-this', permission: 'auto' }, ctx);
    expect(none.hint).toContain('No tools matched');
  });

  it('keeps a literal match ahead of word matches', async () => {
    const ctx = makeCtx([
      {
        name: 'notes',
        description: 'Keep project notes and a list of todos',
        permission: 'auto',
        mutating: false,
      },
      { name: 'todo', description: 'Track the todo list', permission: 'auto', mutating: false },
    ]);
    const result = await executeToolSearch({ query: 'todo list' }, ctx);
    expect(result.tools.map((t) => t.name)).toEqual(['todo', 'notes']);
  });

  it('does not match on stop words alone', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Use this tool with the data',
        permission: 'auto',
        mutating: false,
      },
    ]);
    const result = await executeToolSearch({ query: 'use the tool with a bar' }, ctx);
    expect(result.tools).toEqual([]);
  });

  // The tags filter matches bidirectionally (`candidate.includes(tag) ||
  // tag.includes(candidate)`). `tag.includes('')` is always true, so an empty
  // candidate defeated the filter entirely. Two sources produced one: the
  // optional `category` via `?? ''`, and names that split into empty segments
  // — every MCP tool is named `mcp__<server>__<tool>` (core/utils/tool-name.ts).
  it('excludes a category-less tool that matches none of the requested tags', async () => {
    const ctx = makeCtx([
      {
        name: 'mcp__github__create_issue',
        description: 'Create an issue on a GitHub repository.',
        permission: 'confirm',
        mutating: true,
      },
    ]);
    // Not filesystem, no capabilities, and the name has nothing to do with
    // either tag — the filter must exclude it.
    const result = await executeToolSearch({ tags: ['database', 'sql'] }, ctx);
    expect(result.tools).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('excludes a category-less tool with a simple name from a non-matching tag', async () => {
    const ctx = makeCtx([
      { name: 'thing', description: 'Does a thing.', permission: 'auto', mutating: false },
    ]);
    const result = await executeToolSearch({ tags: ['filesystem'] }, ctx);
    expect(result.tools).toEqual([]);
  });

  it('still returns a category-less tool when a tag matches its name segment', async () => {
    const ctx = makeCtx([
      {
        name: 'mcp__github__create_issue',
        description: 'Create an issue on a GitHub repository.',
        permission: 'confirm',
        mutating: true,
      },
    ]);
    const result = await executeToolSearch({ tags: ['github'] }, ctx);
    expect(result.tools.map((t) => t.name)).toEqual(['mcp__github__create_issue']);
  });
});

describe('toolSearchTool vocabulary', () => {
  const t = (name: string, description: string, extra: Record<string, unknown> = {}) => ({
    name,
    description,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {} },
    ...extra,
  });

  it('matches plural and verb forms of a single word', async () => {
    const ctx = makeCtx([
      t('browser_screenshot', 'Capture a page or element PNG.'),
      t('read', 'Read a file.'),
    ]);
    const plural = await executeToolSearch({ query: 'screenshots' }, ctx);
    expect(plural.tools.map((tool) => tool.name)).toEqual(['browser_screenshot']);
    const verb = await executeToolSearch({ query: 'reading' }, ctx);
    expect(verb.tools.map((tool) => tool.name)).toEqual(['read']);
  });

  it('translates task vocabulary into catalog vocabulary', async () => {
    const ctx = makeCtx([
      t('fetch', 'Fetch a URL and return its content.'),
      t('tree', 'Display a project or subpath directory tree.'),
      t('write', 'Write a file.'),
    ]);
    const download = await executeToolSearch({ query: 'download' }, ctx);
    expect(download.tools[0]?.name).toBe('fetch');
    const folder = await executeToolSearch({ query: 'list folder contents' }, ctx);
    expect(folder.tools[0]?.name).toBe('tree');
  });

  it('ranks a tool whose name is the query word above tools that only mention it', async () => {
    const ctx = makeCtx([
      t('codebase-targeted-test', 'Pick the tests affected by a change.'),
      t('test', "Execute the project's test suite."),
    ]);
    const result = await executeToolSearch({ query: 'run tests' }, ctx);
    expect(result.tools[0]?.name).toBe('test');
  });

  it('puts an exact name first even when other tools contain it', async () => {
    const ctx = makeCtx([t('project_kit_run', 'Run a kit.'), t('project_kit', 'Inspect kits.')]);
    const result = await executeToolSearch({ query: 'project_kit' }, ctx);
    expect(result.tools[0]?.name).toBe('project_kit');
  });

  it('searches category and capability tags', async () => {
    const ctx = makeCtx([
      t('mcp__docs__lookup', 'Look things up.', { capabilities: ['knowledge.retrieve'] }),
    ]);
    const result = await executeToolSearch({ query: 'retrieve' }, ctx);
    expect(result.tools.map((tool) => tool.name)).toEqual(['mcp__docs__lookup']);
  });

  it('sends full schemas only for the leading results', async () => {
    const tools = Array.from({ length: 8 }, (_, i) =>
      t(`file_tool_${i}`, `Handles a file. Second sentence ${i}.`, { usageHint: `hint ${i}` }),
    );
    const result = await executeToolSearch({ query: 'file' }, makeCtx(tools));

    expect(result.tools).toHaveLength(8);
    for (const tool of result.tools.slice(0, 3)) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.schemaOmitted).toBeUndefined();
    }
    for (const tool of result.tools.slice(3)) {
      expect(tool.inputSchema).toBeUndefined();
      expect(tool.usageHint).toBeUndefined();
      expect(tool.schemaOmitted).toBe(true);
      expect(tool.description).toBe('Handles a file.');
    }
    expect(result.hint).toContain('exact name');
    // The exact name then returns that tool's schema.
    const exact = await executeToolSearch({ query: 'file_tool_7' }, makeCtx(tools));
    expect(exact.tools[0]).toMatchObject({ name: 'file_tool_7', usageHint: 'hint 7' });
    expect(exact.tools[0]?.inputSchema).toBeDefined();
  });
});

describe('toolSearchTool model-facing output', () => {
  // The leading results promise "the exact input schema needed by tool_use".
  // Through the generic object renderer every result line was clipped at 1,000
  // chars, so any real schema arrived cut mid-JSON and the model guessed the
  // arguments (live: two tool_use validation errors, ~1.7k chars each).
  const bigSchema = {
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `option_${i}`,
        { type: 'string', description: `Option ${i} controls one specific aspect of the run.` },
      ]),
    ),
    required: ['option_0'],
  };
  const tools = Array.from({ length: 8 }, (_, i) => ({
    name: `file_tool_${i}`,
    description: `Handles a file. Second sentence ${i}.`,
    usageHint: `USAGE ${i}: ${'detail '.repeat(150)}`,
    permission: 'auto',
    mutating: false,
    inputSchema: bigSchema,
  }));

  it('carries the leading schemas whole and keeps the rest to one line', async () => {
    const result = await executeToolSearch({ query: 'file' }, makeCtx(tools));
    const text = createToolOutputSerializer().serialize(result, {
      toolName: 'tool_search',
      tool: toolSearchTool as never,
    });
    const schemaJson = JSON.stringify(bigSchema);
    expect(text.split(schemaJson).length - 1).toBe(3);
    expect(text).not.toContain('chars)');
    // Trailing results: name and first sentence, no schema, no usage text.
    expect(text).toContain('file_tool_7');
    expect(text).not.toContain('USAGE 7');
    // Usage hints are bounded; the exact-name search returns one in full.
    expect(text.length).toBeLessThan(9_000);
    const exact = await executeToolSearch({ query: 'file_tool_7' }, makeCtx(tools));
    const exactText = toolSearchTool.serialize!(exact, { query: 'file_tool_7' });
    expect(exactText).toContain(tools[7]!.usageHint.trim());
    expect(exactText).toContain(schemaJson);
  });
});
