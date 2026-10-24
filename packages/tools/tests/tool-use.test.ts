import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
} from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { toolUseTool } from '../src/tool-use.js';

const makeOpts = () => ({ signal: new AbortController().signal });

const makeCtx = (tools: any[] = []) => {
  const ctx = { cwd: '/fake', tools, projectRoot: '/fake', meta: {} } as any;
  const governedExecute: GovernedToolExecutor = async (toolName, input) => {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) return { success: false, error: `tool "${toolName}" not found` };
    try {
      return { success: true, result: await tool.execute(input, ctx, makeOpts()) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY] = governedExecute;
  return ctx;
};

describe('toolUseTool', () => {
  it('has correct metadata', () => {
    expect(toolUseTool.name).toBe('tool_use');
    expect(toolUseTool.permission).toBe('confirm');
    expect(toolUseTool.mutating).toBe(true);
    expect(toolUseTool.inputSchema.required).toContain('tool');
  });

  it('rejects missing tool name', async () => {
    const ctx = makeCtx([]);
    await expect(toolUseTool.execute({ tool: '' } as any, ctx, makeOpts())).rejects.toThrow(
      /required/,
    );
  });

  it('throws for unknown tool', async () => {
    const ctx = makeCtx([]);
    await expect(
      toolUseTool.execute({ tool: 'nonexistent', input: {} }, ctx, makeOpts()),
    ).rejects.toThrow(/not found/);
  });

  it('throws for denied tool', async () => {
    const ctx = makeCtx([
      {
        name: 'denied',
        execute: vi.fn(),
        permission: 'deny',
        mutating: false,
      },
    ]);
    await expect(
      toolUseTool.execute({ tool: 'denied', input: {} }, ctx, makeOpts()),
    ).rejects.toThrow(/denied by policy/);
  });

  it('fails closed when the governed executor bridge is unavailable', async () => {
    const directExecute = vi.fn().mockResolvedValue({ unsafe: true });
    const ctx = makeCtx([
      { name: 'works', execute: directExecute, permission: 'auto', mutating: false },
    ]);
    delete ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY];

    await expect(
      toolUseTool.execute({ tool: 'works', input: {} }, ctx, makeOpts()),
    ).rejects.toThrow(/governed nested execution is unavailable/);
    expect(directExecute).not.toHaveBeenCalled();
  });

  it('blocks recursive tool_use dispatch', async () => {
    const ctx = makeCtx([toolUseTool]);
    await expect(
      toolUseTool.execute({ tool: 'tool_use', input: { tool: 'tool_use' } }, ctx, makeOpts()),
    ).rejects.toThrow(/recursive/);
  });

  it('dispatches confirm-permission tools (outer tool_use already gated the call)', async () => {
    // `tool_use` itself has permission: 'confirm', so the user has already
    // seen and approved the inner tool name + args by the time execute()
    // runs. Previously this path errored with "requires confirmation",
    // making it impossible to invoke any confirm-tool via tool_use.
    const ctx = makeCtx([
      {
        name: 'needs-confirm',
        execute: vi.fn().mockResolvedValue({ ok: true }),
        permission: 'confirm',
        mutating: false,
      },
    ]);
    const result = await toolUseTool.execute({ tool: 'needs-confirm', input: {} }, ctx, makeOpts());
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ ok: true });
  });

  it('propagates a nested failure as a thrown error, not a successful payload', async () => {
    const ctx = makeCtx([
      {
        name: 'broken',
        execute: vi.fn().mockRejectedValue(new Error('boom')),
        permission: 'auto',
        mutating: false,
      },
    ]);
    await expect(
      toolUseTool.execute({ tool: 'broken', input: {} }, ctx, makeOpts()),
    ).rejects.toThrow(/"broken" failed: boom/);
  });

  it('returns result on success', async () => {
    const ctx = makeCtx([
      {
        name: 'works',
        execute: vi.fn().mockResolvedValue({ value: 42 }),
        permission: 'auto',
        mutating: false,
      },
    ]);
    const result = await toolUseTool.execute({ tool: 'works', input: {} }, ctx, makeOpts());
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ value: 42 });
  });

  it('reports execution time', async () => {
    const ctx = makeCtx([
      {
        name: 'works',
        execute: vi.fn().mockResolvedValue({ value: 42 }),
        permission: 'auto',
        mutating: false,
      },
    ]);
    const result = await toolUseTool.execute({ tool: 'works', input: {} }, ctx, makeOpts());
    expect(result.executionMs).toBeGreaterThanOrEqual(0);
  });

  it('carries non-Error nested failure values into the thrown message', async () => {
    const ctx = makeCtx([
      {
        name: 'throws-string',
        execute: vi.fn().mockRejectedValue('string error'),
        permission: 'auto',
        mutating: false,
      },
    ]);
    await expect(
      toolUseTool.execute({ tool: 'throws-string', input: {} }, ctx, makeOpts()),
    ).rejects.toThrow(/string error/);
  });
});
