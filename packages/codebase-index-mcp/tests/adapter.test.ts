import { describe, expect, it, vi } from 'vitest';
import { createCodebaseIndexMcpServer, createCodebaseIndexMcpToolHost } from '../src/adapter.js';

describe('createCodebaseIndexMcpToolHost', () => {
  it('advertises read-only IPC queries by default and hides LSP-only input', async () => {
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      dependencies: { executeTool: vi.fn() },
    });
    const tools = await host.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'codebase_search',
      'codebase_stats',
      'codebase_package_graph',
      'codebase_file_graph',
      'codebase_symbol_graph',
    ]);
    const search = tools[0]!.inputSchema as { properties: Record<string, unknown> };
    expect(search.properties).not.toHaveProperty('preferLsp');
  });

  it('executes canonical index tools with project and index directory context', async () => {
    const executeTool = vi.fn().mockResolvedValue({ total: 1, results: [{ name: 'Thing' }] });
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      indexDir: 'C:/index',
      dependencies: { executeTool },
    });

    await expect(host.callTool('codebase_search', { query: 'Thing' })).resolves.toMatchObject({
      isError: false,
      content: { total: 1 },
    });
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codebase-search' }),
      { query: 'Thing' },
      expect.objectContaining({
        projectRoot: 'C:/project',
        meta: expect.objectContaining({ codebaseIndexDir: 'C:/index' }),
      }),
      expect.any(AbortSignal),
    );
  });

  it('routes graph reads through the project service dependencies', async () => {
    const packageGraph = vi.fn().mockResolvedValue({ nodes: [], edges: [] });
    const fileGraph = vi.fn().mockResolvedValue({ nodes: [{ id: 'a' }], edges: [] });
    const symbolGraph = vi.fn().mockResolvedValue({ nodes: [{ id: 'b' }], edges: [] });
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      indexDir: 'C:/index',
      dependencies: { executeTool: vi.fn(), packageGraph, fileGraph, symbolGraph },
    });

    await expect(host.callTool('codebase_package_graph', {})).resolves.toMatchObject({
      isError: false,
    });
    await expect(
      host.callTool('codebase_file_graph', { package: '@wrongstack/core' }),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      host.callTool('codebase_symbol_graph', { file: 'packages/core/src/index.ts' }),
    ).resolves.toMatchObject({ isError: false });

    expect(packageGraph).toHaveBeenCalledWith({ projectRoot: 'C:/project', indexDir: 'C:/index' });
    expect(fileGraph).toHaveBeenCalledWith({
      projectRoot: 'C:/project',
      indexDir: 'C:/index',
      packageFilter: '@wrongstack/core',
    });
    expect(symbolGraph).toHaveBeenCalledWith({
      projectRoot: 'C:/project',
      indexDir: 'C:/index',
      fileFilter: 'packages/core/src/index.ts',
    });
  });

  it('rejects hidden writers and malformed required inputs', async () => {
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      dependencies: { executeTool: vi.fn() },
    });
    await expect(host.callTool('codebase_index', {})).resolves.toMatchObject({ isError: true });
    await expect(host.callTool('codebase_search', {})).resolves.toEqual({
      content: 'codebase_search requires a non-empty string "query"',
      isError: true,
    });
    await expect(host.callTool('codebase_file_graph', {})).resolves.toMatchObject({
      isError: true,
    });
  });

  it('exposes the index writer in writable mode and converts failures to MCP errors', async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error('daemon failed'));
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      writable: true,
      dependencies: { executeTool },
    });
    expect((await host.listTools()).map((tool) => tool.name)).toContain('codebase_index');
    await expect(host.callTool('codebase_index', { force: false })).resolves.toEqual({
      content: 'daemon failed',
      isError: true,
    });
  });
});

describe('createCodebaseIndexMcpServer', () => {
  it('publishes server identity and the exploration prompt', async () => {
    const server = createCodebaseIndexMcpServer('C:/project', {
      dependencies: { executeTool: vi.fn() },
    });
    const initialized = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      ))!,
    ) as { result: { serverInfo: { name: string } } };
    expect(initialized.result.serverInfo.name).toBe('wrongstack-codebase-index-mcp');

    const prompts = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }),
      ))!,
    ) as { result: { prompts: Array<{ name: string }> } };
    expect(prompts.result.prompts).toContainEqual(
      expect.objectContaining({ name: 'explore-codebase' }),
    );
  });
});
