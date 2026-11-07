import { codebaseSearchTool } from '@wrongstack/tools/codebase-index';
import { describe, expect, it, vi } from 'vitest';
import { createCodebaseIndexMcpServer, createCodebaseIndexMcpToolHost } from '../src/adapter.js';

describe('createCodebaseIndexMcpToolHost', () => {
  it('advertises read-only IPC queries by default and hides LSP-only input', async () => {
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      dependencies: { executeTool: vi.fn() },
    });
    const tools = await host.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'codebase_context',
      'codebase_search',
      'codebase_stats',
      'codebase_package_graph',
      'codebase_file_graph',
      'codebase_symbol_graph',
      'codebase_incoming_calls',
      'codebase_outgoing_calls',
      'codebase_read_symbol',
      'codebase_skeleton',
      'codebase_impact_analysis',
      'codebase_repo_map',
      'codebase_invariant_check',
      'codebase_diff_impact',
      'codebase_flow_trace',
      'codebase_onboard',
      'codebase_atlas',
      'dead_code_scan',
    ]);
    const search = tools[1]!.inputSchema as { properties: Record<string, unknown> };
    expect(search.properties).not.toHaveProperty('preferLsp');
  });

  it('answers who-calls and what-calls through the compact call-graph tools', async () => {
    const executeTool = vi.fn().mockResolvedValue({ symbol: 'start', calls: [], total: 0 });
    const host = createCodebaseIndexMcpToolHost('C:/project', { dependencies: { executeTool } });

    for (const name of ['codebase_incoming_calls', 'codebase_outgoing_calls']) {
      await expect(host.callTool(name, { symbol: 'start', limit: 5 })).resolves.toMatchObject({
        isError: false,
      });
      await expect(host.callTool(name, {})).resolves.toEqual({
        content: `${name} requires a non-empty string "symbol"`,
        isError: true,
      });
    }
    const toolNames = executeTool.mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(toolNames).toEqual(['codebase-incoming-calls', 'codebase-outgoing-calls']);
    expect(executeTool.mock.calls[0]![1]).toEqual({ symbol: 'start', limit: 5 });
  });

  it('serves symbol source, outlines, impact and the repo map from the index tools', async () => {
    const executeTool = vi.fn(async (tool: { name: string }) =>
      tool.name === 'codebase-skeleton'
        ? skeletonOutput('src', 'export function run(): void;')
        : { ok: true },
    );
    const host = createCodebaseIndexMcpToolHost('C:/project', { dependencies: { executeTool } });

    const calls: Array<[string, Record<string, unknown>]> = [
      ['codebase_read_symbol', { file: 'src/a.ts', symbol: 'run' }],
      ['codebase_skeleton', { path: 'src' }],
      ['codebase_impact_analysis', { symbol: 'run' }],
      ['codebase_repo_map', {}],
      ['codebase_invariant_check', { originalCode: 'export const x = 1;', modifiedCode: '' }],
      ['codebase_diff_impact', { staged: true }],
      ['codebase_flow_trace', { maxFlows: 3 }],
      ['codebase_onboard', { maxSteps: 5 }],
      ['codebase_atlas', { mode: 'brief' }],
      ['dead_code_scan', { limit: 10 }],
    ];
    for (const [name, args] of calls) {
      await expect(host.callTool(name, args)).resolves.toMatchObject({ isError: false });
    }
    expect(executeTool.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([
      'codebase-read-symbol',
      'codebase-skeleton',
      'codebase-impact-analysis',
      'codebase-repo-map',
      'codebase-invariant-check',
      'codebase-diff-impact',
      'codebase-flow-trace',
      'codebase-onboard',
      'codebase-atlas',
      'dead-code-scan',
    ]);
    // Required fields come from each tool's own schema.
    await expect(host.callTool('codebase_read_symbol', { file: 'src/a.ts' })).resolves.toEqual({
      content: 'codebase_read_symbol requires a non-empty string "symbol"',
      isError: true,
    });
    await expect(host.callTool('codebase_skeleton', { path: ' ' })).resolves.toMatchObject({
      isError: true,
    });
  });

  it('sends a skeleton as its own text: line breaks kept, each file once', async () => {
    const skeleton = [
      '// ══ a.ts (ts) ══',
      'export function run(): void;',
      '',
      '// ══ b.ts (ts) ══',
      'export type B = 1;',
    ].join('\n');
    const executeTool = vi.fn().mockResolvedValue(skeletonOutput('src', skeleton));
    const host = createCodebaseIndexMcpToolHost('C:/project', { dependencies: { executeTool } });

    const result = await host.callTool('codebase_skeleton', { path: 'src' });

    // It went out as one-line JSON with every file's skeleton repeated in `files`.
    expect(result.isError).toBe(false);
    expect(typeof result.content).toBe('string');
    const text = result.content as string;
    expect(text.split('\n')[0]).toBe('src · 2 files · 10 → 5 lines (50% saved) · 2 symbols');
    expect(text.endsWith(`\n\n${skeleton}`)).toBe(true);
    expect(text.match(/export function run/g)).toHaveLength(1);
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

  it('forwards the MCP request cancellation signal to canonical tools', async () => {
    const executeTool = vi.fn().mockResolvedValue({ total: 0, results: [] });
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      dependencies: { executeTool },
    });
    const controller = new AbortController();

    await host.callTool('codebase_search', { query: 'Thing' }, { signal: controller.signal });

    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codebase-search' }),
      { query: 'Thing' },
      expect.anything(),
      controller.signal,
    );
  });

  it('reports a degraded codebase_context failure as an MCP error', async () => {
    const executeTool = vi
      .fn()
      .mockResolvedValue({ query: 'x', entries: [], indexStatus: 'error', error: 'db locked' });
    const host = createCodebaseIndexMcpToolHost('C:/project', { dependencies: { executeTool } });

    await expect(host.callTool('codebase_context', { query: 'x' })).resolves.toMatchObject({
      isError: true,
      content: { error: 'db locked' },
    });
    executeTool.mockResolvedValue({ query: 'x', entries: [], indexStatus: 'no-matches' });
    await expect(host.callTool('codebase_context', { query: 'x' })).resolves.toMatchObject({
      isError: false,
    });
  });

  it('routes graph reads through the project service dependencies', async () => {
    const packageGraph = vi.fn().mockResolvedValue({ nodes: [], edges: [] });
    const fileGraph = vi.fn().mockResolvedValue({ nodes: [{ id: 'a' }], edges: [] });
    const symbolGraph = vi.fn().mockResolvedValue({ nodes: [{ id: 'b' }], edges: [] });
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      indexDir: 'C:/index',
      dependencies: { executeTool: vi.fn(), packageGraph, fileGraph, symbolGraph },
    });
    const controller = new AbortController();

    await expect(
      host.callTool('codebase_package_graph', {}, { signal: controller.signal }),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      host.callTool(
        'codebase_file_graph',
        { package: '@wrongstack/core' },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      host.callTool(
        'codebase_symbol_graph',
        { file: 'packages/core/src/index.ts' },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ isError: false });

    expect(packageGraph).toHaveBeenCalledWith(
      { projectRoot: 'C:/project', indexDir: 'C:/index' },
      controller.signal,
    );
    expect(fileGraph).toHaveBeenCalledWith(
      {
        projectRoot: 'C:/project',
        indexDir: 'C:/index',
        packageFilter: '@wrongstack/core',
      },
      controller.signal,
    );
    expect(symbolGraph).toHaveBeenCalledWith(
      {
        projectRoot: 'C:/project',
        indexDir: 'C:/index',
        fileFilter: 'packages/core/src/index.ts',
      },
      controller.signal,
    );
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

  it('exposes the index writer and mutation/test tools in writable mode and converts failures to MCP errors', async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error('daemon failed'));
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      writable: true,
      dependencies: { executeTool },
    });
    const names = (await host.listTools()).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'codebase_index',
        'codebase_ast_replace',
        'codebase_targeted_test',
        'dead_code_fix',
      ]),
    );
    await expect(host.callTool('codebase_index', { force: false })).resolves.toEqual({
      content: 'daemon failed',
      isError: true,
    });
    // Empty newBody is valid for codebase_ast_replace, but non-string is rejected.
    await expect(
      host.callTool('codebase_ast_replace', { file: 'src/a.ts', symbol: 'run' }),
    ).resolves.toEqual({
      content: 'codebase_ast_replace requires a string "newBody"',
      isError: true,
    });
  });

  it('validates symbol graph file, codebase_index force/langs, builtin.validate, trimmed graph filters, post-await aborts, and non-Error throws', async () => {
    const fileGraph = vi.fn().mockResolvedValue({ ok: true });
    const symbolGraph = vi.fn().mockResolvedValue({ ok: true });
    const executeTool = vi.fn().mockRejectedValue('raw string failure');
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      writable: true,
      dependencies: {
        executeTool,
        fileGraph,
        symbolGraph,
      },
    });

    // S13-M1: codebase_symbol_graph missing/blank file
    await expect(host.callTool('codebase_symbol_graph', { file: '   ' })).resolves.toEqual({
      content: 'codebase_symbol_graph requires a non-empty string "file"',
      isError: true,
    });

    // S13-M2 & S13-M3: codebase_index force & langs validation
    await expect(host.callTool('codebase_index', { force: 'yes' })).resolves.toEqual({
      content: 'codebase_index "force" must be a boolean',
      isError: true,
    });
    await expect(host.callTool('codebase_index', { langs: [123] })).resolves.toEqual({
      content: 'codebase_index "langs" must be an array of language strings',
      isError: true,
    });

    // S13-M4: builtin.validate(args) failure stops before executeTool is called
    const prevValidate = codebaseSearchTool.validate;
    (codebaseSearchTool as { validate?: unknown }).validate = () => ['limit must be >= 1'];
    try {
      const invalidRes = await host.callTool('codebase_search', { query: 'foo', limit: -5 });
      expect(invalidRes).toEqual({
        content: 'limit must be >= 1',
        isError: true,
      });
      expect(executeTool).not.toHaveBeenCalled();
    } finally {
      (codebaseSearchTool as { validate?: unknown }).validate = prevValidate;
    }

    // S13-M5 & S13-M6: .trim() on packageFilter and fileFilter
    await host.callTool('codebase_file_graph', { package: '  @wrongstack/core  ' });
    expect(fileGraph).toHaveBeenCalledWith(
      { projectRoot: 'C:/project', packageFilter: '@wrongstack/core' },
      expect.any(AbortSignal),
    );
    await host.callTool('codebase_symbol_graph', { file: '  src/index.ts  ' });
    expect(symbolGraph).toHaveBeenCalledWith(
      { projectRoot: 'C:/project', fileFilter: 'src/index.ts' },
      expect.any(AbortSignal),
    );

    // S13-M10: non-Error thrown value formatted via String(error)
    await expect(host.callTool('codebase_stats', {})).resolves.toEqual({
      content: 'raw string failure',
      isError: true,
    });

    // S13-M7, S13-M8, S13-M9: post-await signal.throwIfAborted() on package/file/symbol graphs
    for (const [toolName, toolArgs] of [
      ['codebase_package_graph', {}],
      ['codebase_file_graph', { package: 'pkg' }],
      ['codebase_symbol_graph', { file: 'f.ts' }],
    ] as const) {
      const ctrl = new AbortController();
      const abortAfterResolve = vi.fn(async () => {
        ctrl.abort(new Error(`aborted:${toolName}`));
        return { graph: true };
      });
      const graphHost = createCodebaseIndexMcpToolHost('C:/project', {
        dependencies: {
          packageGraph: abortAfterResolve,
          fileGraph: abortAfterResolve,
          symbolGraph: abortAfterResolve,
        },
      });
      await expect(
        graphHost.callTool(toolName, toolArgs, { signal: ctrl.signal }),
      ).resolves.toEqual({
        content: `aborted:${toolName}`,
        isError: true,
      });
    }

    // F74: frozen result note is rewritten without mutating in-place, and graph tools reject unknown arguments
    const frozenPayload = Object.freeze({
      symbols: [],
      note: 'Next: call dead-code-fix or codebase-read-symbol',
    });
    const frozenHost = createCodebaseIndexMcpToolHost('C:/project', {
      writable: false,
      dependencies: {
        executeTool: async () => frozenPayload,
        packageGraph: vi.fn().mockResolvedValue({ ok: true }),
        fileGraph,
        symbolGraph,
      },
    });
    const frozenRes = await frozenHost.callTool('codebase_search', { query: 'fn' });
    expect(frozenRes.isError).toBe(false);
    expect(frozenPayload.note).toBe('Next: call dead-code-fix or codebase-read-symbol');
    expect((frozenRes.content as { note: string }).note).toBe(
      'Next: call dead_code_fix (needs --writable) or codebase_read_symbol',
    );
    await expect(frozenHost.callTool('codebase_package_graph', { extra: true })).resolves.toEqual({
      content: 'codebase_package_graph: unknown argument "extra"',
      isError: true,
    });
    await expect(
      frozenHost.callTool('codebase_file_graph', { package: 'pkg', extra: true }),
    ).resolves.toEqual({
      content: 'codebase_file_graph: unknown argument "extra"',
      isError: true,
    });
    await expect(
      frozenHost.callTool('codebase_symbol_graph', { file: 'a.ts', extra: true }),
    ).resolves.toEqual({
      content: 'codebase_symbol_graph: unknown argument "extra"',
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
    ) as { result: { serverInfo: { name: string }; instructions?: string } };
    expect(initialized.result.serverInfo.name).toBe('wrongstack-codebase-index-mcp');
    // Shown to the client even while tools sit behind a tool search.
    expect(initialized.result.instructions).toMatch(/before grep\/glob/);

    const listed = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
      ))!,
    ) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } };
    const upfront = listed.result.tools
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
      .map((tool) => tool.name);
    expect(upfront).toEqual(['codebase_search', 'codebase_incoming_calls', 'codebase_read_symbol']);

    const prompts = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }),
      ))!,
    ) as { result: { prompts: Array<{ name: string }> } };
    expect(prompts.result.prompts).toContainEqual(
      expect.objectContaining({ name: 'explore-codebase' }),
    );
  });

  it('propagates JSON-RPC cancellation into a running index tool', async () => {
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = createCodebaseIndexMcpServer('C:/project', {
      dependencies: {
        executeTool: vi.fn(async (_tool, _args, _context, signal) => {
          observedSignal = signal;
          started();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }),
      },
    });

    const pending = server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'codebase_search', arguments: { query: 'slow' } },
      }),
    );
    await toolStarted;
    await expect(
      server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 7, reason: 'client stopped' },
        }),
      ),
    ).resolves.toBeNull();

    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toContain('client stopped');
  });

  it('forbids preferLsp on codebase_search and rejects empty or blank langs on codebase_index', async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      writable: true,
      dependencies: { executeTool },
    });
    const searchTool = (await host.listTools()).find((t) => t.name === 'codebase_search');
    expect(searchTool?.inputSchema).toMatchObject({ additionalProperties: false });

    await expect(
      host.callTool('codebase_search', { query: 'symbol', preferLsp: true }),
    ).resolves.toMatchObject({ isError: true });
    await expect(host.callTool('codebase_index', { langs: [] })).resolves.toMatchObject({
      isError: true,
    });
    await expect(host.callTool('codebase_index', { langs: ['   '] })).resolves.toMatchObject({
      isError: true,
    });
    expect(executeTool).not.toHaveBeenCalled();
  });
});

function skeletonOutput(dir: string, skeleton: string) {
  return {
    path: dir,
    isDir: true,
    skeleton,
    stats: {
      originalLines: 10,
      skeletonLines: 5,
      tokenSavingsPercent: 50,
      symbolCount: 2,
      fileCount: 2,
    },
    files: [
      {
        file: 'a.ts',
        lang: 'ts',
        stats: { originalLines: 5, skeletonLines: 3, tokenSavingsPercent: 40, symbolCount: 1 },
      },
      {
        file: 'b.ts',
        lang: 'ts',
        stats: { originalLines: 5, skeletonLines: 2, tokenSavingsPercent: 60, symbolCount: 1 },
      },
    ],
    maxFiles: 20,
    maxChars: 60_000,
  };
}

describe('read-only server refuses the write variants of read tools', () => {
  const writeCalls: Array<[string, Record<string, unknown>]> = [
    ['codebase_atlas', { mode: 'write' }],
    ['codebase_flow_trace', { persist: true }],
    ['codebase_diff_impact', { persist: true }],
  ];

  it.each(writeCalls)('%s %j without --writable', async (name, args) => {
    const executeTool = vi.fn();
    const host = createCodebaseIndexMcpToolHost('C:/project', { dependencies: { executeTool } });
    await expect(host.callTool(name, args)).resolves.toMatchObject({
      content: expect.stringContaining('--writable'),
      isError: true,
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each(writeCalls)('%s %j runs with --writable', async (name, args) => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const host = createCodebaseIndexMcpToolHost('C:/project', {
      writable: true,
      dependencies: { executeTool },
    });
    await expect(host.callTool(name, args)).resolves.toMatchObject({ isError: false });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('still serves the read variants', async () => {
    const executeTool = vi.fn().mockResolvedValue({ ok: true });
    const host = createCodebaseIndexMcpToolHost('C:/project', { dependencies: { executeTool } });
    for (const [name, args] of [
      ['codebase_atlas', { mode: 'brief' }],
      ['codebase_flow_trace', { persist: false }],
      ['codebase_diff_impact', {}],
    ] as const) {
      await expect(host.callTool(name, args)).resolves.toMatchObject({ isError: false });
    }
  });
});
