import { ToolExecutor } from '@wrongstack/core/execution';
import { GOVERNED_TOOL_EXECUTOR_META_KEY, type GovernedToolExecutor } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { batchToolUseTool } from '../src/batch-tool-use.js';

const makeCtx = (tools: any[] = []) => {
  const governedExecute: GovernedToolExecutor = async (toolName, input) => {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) return { success: false, error: `tool "${toolName}" not found` };
    try {
      return { success: true, result: await tool.execute(input, ctx, makeOpts()) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const ctx = {
    cwd: '/fake',
    tools,
    projectRoot: '/fake',
    meta: { [GOVERNED_TOOL_EXECUTOR_META_KEY]: governedExecute },
  } as any;
  return ctx;
};
const makeOpts = () => ({ signal: new AbortController().signal });

describe('batchToolUseTool', () => {
  it('has correct metadata', () => {
    expect(batchToolUseTool.name).toBe('batch_tool_use');
    expect(batchToolUseTool.permission).toBe('confirm');
    expect(batchToolUseTool.mutating).toBe(true);
    expect(batchToolUseTool.timeoutMs).toBe(120_000);
    expect(batchToolUseTool.capabilities).toEqual(['tool.meta']);
    const callsSchema = batchToolUseTool.inputSchema.properties?.['calls'] as {
      maxItems: number;
      items: { properties: { tool: { enum: string[] } } };
    };
    expect(callsSchema.maxItems).toBe(8);
    expect(callsSchema.items.properties.tool.enum).toContain('read');
    expect(callsSchema.items.properties.tool.enum).not.toContain('bash');
  });

  it('returns empty result for empty calls', async () => {
    const ctx = makeCtx();
    const result = await batchToolUseTool.execute({ calls: [] }, ctx, makeOpts());
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('returns empty result for null/undefined calls', async () => {
    const ctx = makeCtx();
    const result = await batchToolUseTool.execute({ calls: undefined as any }, ctx, makeOpts());
    expect(result.total).toBe(0);
  });

  it('runs tools in parallel by default', async () => {
    let _resolve: (v: any) => void;
    const _promise = new Promise((r) => {
      _resolve = r;
    });
    const fakeTool = {
      name: 'read',
      execute: vi.fn().mockReturnValue(Promise.resolve({ value: 1 })),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'read', input: {} }] },
      ctx,
      makeOpts(),
    );

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.results[0].success).toBe(true);
  });

  it('limits parallel nested calls to three', async () => {
    let active = 0;
    let peakActive = 0;
    const fakeTool = {
      name: 'read',
      async execute() {
        active++;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ok: true };
      },
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      {
        calls: Array.from({ length: 8 }, () => ({ tool: 'read', input: {} })),
      },
      ctx,
      makeOpts(),
    );

    expect(result.succeeded).toBe(8);
    expect(peakActive).toBe(3);
  });

  it('rejects batches larger than the schema limit', async () => {
    const ctx = makeCtx([]);

    await expect(
      batchToolUseTool.execute(
        {
          calls: Array.from({ length: 9 }, () => ({ tool: 'read', input: {} })),
        },
        ctx,
        makeOpts(),
      ),
    ).rejects.toThrow('at most 8 items');
  });

  it('blocks recursive batch_tool_use dispatch', async () => {
    const ctx = makeCtx([batchToolUseTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'batch_tool_use', input: { calls: [] } }] },
      ctx,
      makeOpts(),
    );

    expect(result.failed).toBe(1);
    expect(result.results[0]?.error).toContain('recursive');
  });

  it('rejects process, mutation, browser, MCP, delegation, and meta tools', async () => {
    const names = ['bash', 'write', 'test', 'browser_click', 'mcp_use', 'delegate', 'tool_use'];
    const execute = vi.fn().mockResolvedValue({ unsafe: true });
    const ctx = makeCtx(
      names.map((name) => ({
        name,
        mutating: name === 'write',
        execute,
      })),
    );

    const result = await batchToolUseTool.execute(
      { calls: names.map((tool) => ({ tool, input: {} })) },
      ctx,
      makeOpts(),
    );

    expect(result.failed).toBe(names.length);
    expect(result.results.every((entry) => entry.error?.includes('not eligible'))).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports tool not found', async () => {
    const ctx = makeCtx([]);
    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'nonexistent', input: {} }] },
      ctx,
      makeOpts(),
    );
    expect(result.total).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('not found');
  });

  it('fails closed when no governed executor bridge is installed', async () => {
    const directExecute = vi.fn().mockResolvedValue({ unsafe: true });
    const ctx = makeCtx([{ name: 'read', execute: directExecute }]);
    delete ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY];

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'read', input: {} }] },
      ctx,
      makeOpts(),
    );

    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toContain('governed nested execution is unavailable');
    expect(directExecute).not.toHaveBeenCalled();
  });

  it('re-evaluates every nested tool through ToolExecutor and blocks a denied subcall', async () => {
    const deniedExecute = vi.fn().mockResolvedValue({ unsafe: true });
    const deniedTool = {
      name: 'read',
      description: 'denied inner tool',
      inputSchema: { type: 'object' },
      permission: 'confirm' as const,
      mutating: false,
      capabilities: ['fs.read'],
      execute: deniedExecute,
    };
    const tools = [batchToolUseTool, deniedTool];
    const ctx = makeCtx(tools);
    delete ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY];
    Object.assign(ctx, {
      signal: new AbortController().signal,
      session: { id: 'batch-policy-test' },
      agentId: 'leader',
    });
    const evaluate = vi.fn(async (tool: { name: string }) =>
      tool.name === 'read'
        ? { permission: 'deny' as const, source: 'deny' as const, reason: 'capability not granted' }
        : { permission: 'confirm' as const, source: 'default' as const },
    );
    const executor = new ToolExecutor(
      {
        get: (name) => tools.find((tool) => tool.name === name),
        list: () => tools,
      },
      {
        permissionPolicy: { evaluate } as never,
        confirmAwaiter: vi.fn(async () => 'yes' as const),
        secretScrubber: { scrub: (text: string) => text } as never,
      },
    );

    const execution = await executor.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'outer-batch',
          name: 'batch_tool_use',
          input: { calls: [{ tool: 'read', input: {} }], parallel: false },
        },
      ],
      ctx,
      'sequential',
    );

    expect(evaluate.mock.calls.map(([tool]) => tool.name)).toEqual(['batch_tool_use', 'read']);
    expect(
      String(
        execution.outputs[0]?.result.type === 'tool_result'
          ? execution.outputs[0].result.content
          : '',
      ),
    ).toContain('capability not granted');
    expect(deniedExecute).not.toHaveBeenCalled();
  });

  it('handles parallel=false (sequential)', async () => {
    const fakeTool = {
      name: 'read',
      execute: vi.fn().mockResolvedValue({ value: 1 }),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'read', input: {} }], parallel: false },
      ctx,
      makeOpts(),
    );
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('stops on error when stop_on_error=true', async () => {
    const fakeTool = {
      name: 'read',
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      {
        calls: [
          { tool: 'read', input: {} },
          { tool: 'read', input: {} },
        ],
        stop_on_error: true,
        parallel: false,
      },
      ctx,
      makeOpts(),
    );
    // With stop_on_error + sequential, loop should break after first failure
    expect(result.results.length).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.stop_on_error).toBe(true);
  });

  it('stop_on_error=true does not start queued calls after a failure (parallel default)', async () => {
    const started: number[] = [];
    // Park calls 1 and 2 so their workers stay busy while call 0 fails fast.
    const gates = [1, 2].map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    });
    const governedExecute: GovernedToolExecutor = async (_toolName, input) => {
      const i = (input as { i: number }).i;
      started.push(i);
      if (i === 0) return { success: false, error: 'boom' };
      if (i === 1 || i === 2) await gates[i - 1]!.promise;
      return { success: true, result: i };
    };
    const ctx = {
      cwd: '/fake',
      tools: [{ name: 'read', mutating: false }],
      projectRoot: '/fake',
      meta: { [GOVERNED_TOOL_EXECUTOR_META_KEY]: governedExecute },
    } as any;

    const calls = Array.from({ length: 8 }, (_, i) => ({ tool: 'read', input: { i } }));
    // Release the gates so the pool can always drain (both pre- and post-stop).
    const release = setTimeout(() => {
      gates.forEach((g) => {
        g.resolve();
      });
    }, 100);
    release.unref?.();

    const result = await batchToolUseTool.execute(
      { calls, stop_on_error: true, parallel: true },
      ctx,
      makeOpts(),
    );

    // In-flight calls (1, 2) finish — they cannot be un-run — but no queued
    // call (3..7) may start once the failure has been recorded.
    expect(started.filter((i) => i >= 3)).toEqual([]);
    // Serial-path parity: executed results only; total still reflects the input.
    expect(result.total).toBe(8);
    expect(result.results).toHaveLength(3);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(2);
  });

  it('stop_on_error=false (default) still runs every call in parallel mode', async () => {
    const started: number[] = [];
    const governedExecute: GovernedToolExecutor = async (_toolName, input) => {
      const i = (input as { i: number }).i;
      started.push(i);
      return { success: true, result: i };
    };
    const ctx = {
      cwd: '/fake',
      tools: [{ name: 'read', mutating: false }],
      projectRoot: '/fake',
      meta: { [GOVERNED_TOOL_EXECUTOR_META_KEY]: governedExecute },
    } as any;

    const calls = Array.from({ length: 8 }, (_, i) => ({ tool: 'read', input: { i } }));
    const result = await batchToolUseTool.execute({ calls }, ctx, makeOpts());

    expect(started).toHaveLength(8);
    expect(result.results).toHaveLength(8);
    expect(result.succeeded).toBe(8);
    expect(result.failed).toBe(0);
  });

  it('continues when stop_on_error=false even after failure', async () => {
    const fakeTool = {
      name: 'read',
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      {
        calls: [
          { tool: 'read', input: {} },
          { tool: 'read', input: {} },
        ],
        stop_on_error: false,
      },
      ctx,
      makeOpts(),
    );
    expect(result.results.length).toBe(2);
    expect(result.failed).toBe(2);
  });

  it('handles non-Error thrown values in executeSingle', async () => {
    const fakeTool = {
      name: 'read',
      execute: vi.fn().mockRejectedValue('string error value'),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'read', input: {} }] },
      ctx,
      makeOpts(),
    );
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toBe('string error value');
  });

  it('reports execution time', async () => {
    const fakeTool = {
      name: 'read',
      execute: vi.fn().mockResolvedValue({ value: 1 }),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'read', input: {} }] },
      ctx,
      makeOpts(),
    );
    expect(result.results[0].executionMs).toBeGreaterThanOrEqual(0);
  });
});
