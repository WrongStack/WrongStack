import { ToolCapabilities } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';
import type { MCPClient, MCPTool } from '../src/client.js';
import { wrapMCPTool } from '../src/wrap-tool.js';

const mkClient = (callImpl: (name: string, input: unknown) => Promise<unknown>) =>
  ({
    callTool: vi.fn(async (name: string, input: unknown) => {
      const out = await callImpl(name, input);
      return { content: out, isError: false };
    }),
  }) as never as MCPClient;

describe('wrapMCPTool', () => {
  it('namespaces tool names', () => {
    const mcpTool: MCPTool = { name: 'list', inputSchema: { type: 'object' } };
    const wrapped = wrapMCPTool(
      'postgres',
      mcpTool,
      mkClient(async () => 'ok'),
    );
    expect(wrapped.name).toBe('mcp__postgres__list');
  });

  it('sanitizes server/tool names to the provider wire pattern', async () => {
    const callTool = vi.fn(async () => ({ content: 'ok', isError: false }));
    const client = { callTool } as never as MCPClient;
    const wrapped = wrapMCPTool(
      'claude.ai Gmail',
      { name: 'search:messages', inputSchema: { type: 'object' } },
      client,
    );
    expect(wrapped.name).toMatch(
      /^mcp__claude_ai_Gmail_[a-f0-9]{10}__search_messages_[a-f0-9]{10}$/,
    );
    expect(wrapped.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);

    // The remote call must still use the ORIGINAL tool name.
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    await wrapped.execute({}, ctx, { signal: new AbortController().signal });
    expect(callTool).toHaveBeenCalledWith('search:messages', {}, expect.anything());
  });

  it('clamps oversized qualified names to 128 chars keeping the prefix', () => {
    const wrapped = wrapMCPTool(
      'srv',
      { name: 'x'.repeat(300), inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
    );
    expect(wrapped.name).toHaveLength(128);
    expect(wrapped.name.startsWith('mcp__srv__')).toBe(true);
  });

  it('declares the MCP proxy capability for permission boundaries', () => {
    const wrapped = wrapMCPTool(
      'ssh',
      { name: 'ssh_execute', inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
    );
    expect(wrapped.capabilities).toContain(ToolCapabilities.MCP_PROXY);
  });

  it('marks mutating heuristically', () => {
    const wrapped = wrapMCPTool(
      'fs',
      { name: 'writeFile', inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
    );
    expect(wrapped.mutating).toBe(true);
    const ro = wrapMCPTool(
      'fs',
      { name: 'listDirectory', inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
    );
    expect(ro.mutating).toBe(false);
  });

  it('flattens content array of text blocks', async () => {
    const wrapped = wrapMCPTool(
      's',
      { name: 'fetch', inputSchema: { type: 'object' } },
      mkClient(async () => [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ]),
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    const out = await wrapped.execute({}, ctx, { signal: new AbortController().signal });
    expect(out).toBe('line1\nline2');
  });

  it('stringifies non-text object content as JSON', async () => {
    const wrapped = wrapMCPTool(
      's',
      { name: 'fetch', inputSchema: { type: 'object' } },
      mkClient(async () => ({ foo: 1, bar: [1, 2] })),
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    const out = await wrapped.execute({}, ctx, { signal: new AbortController().signal });
    expect(out).toContain('foo');
    expect(out).toContain('1');
  });

  it('stringifies null/undefined result as empty string', async () => {
    const wrapped = wrapMCPTool(
      's',
      { name: 'noop', inputSchema: { type: 'object' } },
      mkClient(async () => null),
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    const out = await wrapped.execute({}, ctx, { signal: new AbortController().signal });
    expect(out).toBe('');
  });

  it('forwards the executor abort signal to client.callTool', async () => {
    const callTool = vi.fn(async () => ({ content: 'ok', isError: false }));
    const client = { callTool } as never as MCPClient;
    const wrapped = wrapMCPTool('s', { name: 'fetch', inputSchema: { type: 'object' } }, client);
    const ctrl = new AbortController();
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    await wrapped.execute({ q: 1 }, ctx, { signal: ctrl.signal });
    expect(callTool).toHaveBeenCalledWith('fetch', { q: 1 }, { signal: ctrl.signal });
  });

  it('reports call saturation and outcomes without exposing tool input', async () => {
    const onStart = vi.fn();
    const onFinish = vi.fn();
    const wrapped = wrapMCPTool(
      'private-server',
      { name: 'secret-tool', inputSchema: { type: 'object' } },
      mkClient(async () => 'ok'),
      'confirm',
      { onStart, onFinish },
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    await wrapped.execute({ token: 'must-not-be-observed' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledWith({ durationMs: expect.any(Number), ok: true });
    expect(JSON.stringify(onFinish.mock.calls)).not.toContain('must-not-be-observed');
  });

  it('reports failed outcomes even when the client throws', async () => {
    const onFinish = vi.fn();
    const wrapped = wrapMCPTool(
      'server',
      { name: 'fails', inputSchema: { type: 'object' } },
      mkClient(async () => {
        throw new Error('boom');
      }),
      'confirm',
      { onStart: vi.fn(), onFinish },
    );
    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    await expect(
      wrapped.execute({}, ctx, { signal: new AbortController().signal }),
    ).rejects.toThrow('boom');
    expect(onFinish).toHaveBeenCalledWith({ durationMs: expect.any(Number), ok: false });
  });

  it('safely executes without opts and falls back to ctx.signal', async () => {
    const callTool = vi.fn(async (_name, _input, opts?: { signal?: AbortSignal }) => {
      return { content: opts?.signal?.aborted ? 'aborted' : 'ok', isError: false };
    });
    const client = { callTool } as never as MCPClient;
    const wrapped = wrapMCPTool(
      'server',
      { name: 'query', inputSchema: { type: 'object' } },
      client,
    );

    const ctx = {} as Parameters<typeof wrapped.execute>[1];
    const executeWithoutOpts = wrapped.execute as (
      input: Parameters<typeof wrapped.execute>[0],
      context: Parameters<typeof wrapped.execute>[1],
    ) => ReturnType<typeof wrapped.execute>;
    const result = await executeWithoutOpts({ a: 1 }, ctx);
    expect(result).toBe('ok');

    const ac = new AbortController();
    ac.abort();
    const ctxWithSignal = { signal: ac.signal } as Parameters<typeof wrapped.execute>[1];
    const abortedResult = await executeWithoutOpts({ a: 1 }, ctxWithSignal);
    expect(abortedResult).toBe('aborted');
  });
});
