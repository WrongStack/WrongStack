import type { Tool } from '@wrongstack/contracts/types/tool';
import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
} from '@wrongstack/contracts/types/tool-executor';
import { describe, expect, it, vi } from 'vitest';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { ToolCapabilities } from '@wrongstack/core/security';
import type { MCPRegistryHandle } from '../../src/management/mcp-control.js';
import { createMcpUseTool } from '../../src/management/mcp-use.js';

function fakeRegistry(over: Partial<MCPRegistryHandle> = {}): MCPRegistryHandle {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    describe: vi
      .fn()
      .mockReturnValue([{ name: 'github', state: 'connected', toolCount: 2, enabled: true }]),
    list: vi.fn().mockReturnValue([]),
    activateServer: vi.fn(),
    deactivateServer: vi.fn(),
    ...over,
  } as MCPRegistryHandle;
}

function fakeToolRegistry(tools: Tool[] = []): ToolRegistry {
  return {
    get: (name: string) => tools.find((t) => t.name === name),
    list: () => tools,
  } as never as ToolRegistry;
}

const mcpTool = (name: string, exec: Tool['execute']): Tool =>
  ({
    name,
    description: '',
    category: 'mcp',
    permission: 'auto',
    inputSchema: { type: 'object' },
    execute: exec,
  }) as Tool;

const run = (
  tool: ReturnType<typeof createMcpUseTool>,
  input: Record<string, unknown>,
  innerTools: Tool[] = [],
) => {
  const ctx = { meta: {} } as { meta: Record<string, unknown> };
  const governedExecute: GovernedToolExecutor = async (toolName, toolInput) => {
    const inner = innerTools.find((candidate) => candidate.name === toolName);
    if (!inner) return { success: false, error: `tool "${toolName}" not found` };
    try {
      return {
        success: true,
        result: await inner.execute(
          toolInput,
          ctx as never,
          { signal: new AbortController().signal } as never,
        ),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY] = governedExecute;
  return tool.execute(
    input as never,
    ctx as never,
    { signal: new AbortController().signal } as never,
  );
};

describe('createMcpUseTool', () => {
  it('exposes mcp_use metadata', () => {
    const tool = createMcpUseTool({ registry: fakeRegistry(), toolRegistry: fakeToolRegistry() });
    expect(tool.name).toBe('mcp_use');
    expect(tool.permission).toBe('confirm');
    expect(tool.mutating).toBe(true);
    expect(tool.capabilities).toContain(ToolCapabilities.MCP_PROXY);
    expect(tool.inputSchema.required).toEqual(['server', 'tool', 'input']);
  });

  // Lookup failures THROW so the executor records the call as failed — a
  // plain string return was recorded as a successful tool call.
  it('throws on an unknown server with the available list', async () => {
    const tool = createMcpUseTool({
      registry: fakeRegistry({
        describe: vi
          .fn()
          .mockReturnValue([{ name: 'a', state: 'connected', toolCount: 0, enabled: true }]),
      }),
      toolRegistry: fakeToolRegistry(),
    });
    await expect(run(tool, { server: 'ghost', tool: 't', input: {} })).rejects.toThrow(
      /not found.*Available: a/,
    );
  });

  it('throws with "none" when there are no servers at all', async () => {
    const tool = createMcpUseTool({
      registry: fakeRegistry({ describe: vi.fn().mockReturnValue([]) }),
      toolRegistry: fakeToolRegistry(),
    });
    await expect(run(tool, { server: 'ghost', tool: 't', input: {} })).rejects.toThrow('none');
  });

  it('throws for a server that is not available', async () => {
    const tool = createMcpUseTool({
      registry: fakeRegistry({
        describe: vi
          .fn()
          .mockReturnValue([{ name: 'github', state: 'failed', toolCount: 0, enabled: true }]),
      }),
      toolRegistry: fakeToolRegistry(),
    });
    await expect(run(tool, { server: 'github', tool: 't', input: {} })).rejects.toThrow(
      /not available.*failed.*restart/,
    );
  });

  // Regression: `dormant` is the resting state of a lazy server — the gateway
  // rejected exactly the servers it exists to reach.
  it('calls a tool on a dormant lazy server (the wrapper wakes it)', async () => {
    const inner = mcpTool(
      'mcp__github__ping',
      vi.fn(async () => 'pong'),
    );
    const tool = createMcpUseTool({
      registry: fakeRegistry({
        describe: vi
          .fn()
          .mockReturnValue([{ name: 'github', state: 'dormant', toolCount: 1, enabled: true }]),
      }),
      toolRegistry: fakeToolRegistry([inner]),
    });
    expect(await run(tool, { server: 'github', tool: 'ping', input: {} }, [inner])).toBe('pong');
  });

  // Regression: the first concurrent call to finish deactivated the server
  // under a sibling still running its tool.
  it('keeps the server activated until the last concurrent call finishes', async () => {
    let active = false;
    const activateServer = vi.fn(() => {
      active = true;
    });
    const deactivateServer = vi.fn(() => {
      active = false;
      return 1;
    });
    const releases: Array<() => void> = [];
    const seenActive: boolean[] = [];
    const inner = mcpTool(
      'mcp__github__slow',
      vi.fn(async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        seenActive.push(active);
        return 'done';
      }),
    );
    const tool = createMcpUseTool({
      registry: fakeRegistry({
        activateServer,
        deactivateServer,
        isActivated: vi.fn(() => active),
      }),
      toolRegistry: fakeToolRegistry([inner]),
    });
    const first = run(tool, { server: 'github', tool: 'slow', input: {} }, [inner]);
    const second = run(tool, { server: 'github', tool: 'slow', input: {} }, [inner]);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]?.();
    await first;
    expect(deactivateServer).not.toHaveBeenCalled();
    releases[1]?.();
    await second;
    expect(seenActive).toEqual([true, true]);
    expect(activateServer).toHaveBeenCalledTimes(1);
    expect(deactivateServer).toHaveBeenCalledTimes(1);
  });

  it('activates, calls the resolved tool, returns its result, and deactivates', async () => {
    const activateServer = vi.fn();
    const deactivateServer = vi.fn();
    const exec = vi.fn(async () => 'tool result');
    const inner = mcpTool('mcp__github__create_issue', exec);
    const tool = createMcpUseTool({
      registry: fakeRegistry({ activateServer, deactivateServer }),
      toolRegistry: fakeToolRegistry([inner]),
    });
    const out = await run(tool, { server: 'github', tool: 'create_issue', input: { title: 'x' } }, [
      inner,
    ]);
    expect(out).toBe('tool result');
    expect(activateServer).toHaveBeenCalledWith('github');
    expect(exec).toHaveBeenCalledWith({ title: 'x' }, expect.anything(), expect.anything());
    expect(deactivateServer).toHaveBeenCalledWith('github');
  });

  it('defaults a missing input to an empty object', async () => {
    const exec = vi.fn(async () => 'ok');
    const inner = mcpTool('mcp__github__ping', exec);
    const tool = createMcpUseTool({
      registry: fakeRegistry(),
      toolRegistry: fakeToolRegistry([inner]),
    });
    await run(tool, { server: 'github', tool: 'ping' }, [inner]);
    expect(exec).toHaveBeenCalledWith({}, expect.anything(), expect.anything());
  });

  // #409: the agent's gate can ask the user to confirm the MCP tool; the
  // executor bridge cannot, so it is only the fallback.
  it("runs the call through the agent's nested gate when one is attached", async () => {
    const deactivateServer = vi.fn();
    const exec = vi.fn(async () => 'bridge');
    const inner = mcpTool('mcp__github__ping', exec);
    const tool = createMcpUseTool({
      registry: fakeRegistry({ deactivateServer }),
      toolRegistry: fakeToolRegistry([inner]),
    });
    const governed = vi.fn();
    const nestedToolCall = vi.fn(async () => ({ content: 'gated', isError: false }));
    const out = await tool.execute(
      { server: 'github', tool: 'ping', input: { a: 1 } },
      { meta: { [GOVERNED_TOOL_EXECUTOR_META_KEY]: governed }, nestedToolCall } as never,
      { signal: new AbortController().signal, toolUseId: 'u-mcp' } as never,
    );
    expect(out).toBe('gated');
    expect(nestedToolCall).toHaveBeenCalledWith({
      name: 'mcp__github__ping',
      input: { a: 1 },
      parentToolUseId: 'u-mcp',
      index: 1,
    });
    expect(governed).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(deactivateServer).toHaveBeenCalledWith('github');
  });

  it('throws when the nested gate reports a failed or declined call', async () => {
    const inner = mcpTool('mcp__github__ping', vi.fn());
    const tool = createMcpUseTool({
      registry: fakeRegistry(),
      toolRegistry: fakeToolRegistry([inner]),
    });
    const nestedToolCall = vi.fn(async () => ({
      content: 'Tool "mcp__github__ping" denied by user.',
      isError: true,
    }));
    await expect(
      tool.execute(
        { server: 'github', tool: 'ping', input: {} },
        { meta: {}, nestedToolCall } as never,
        { signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow('denied by user');
  });

  it('fails closed when governed nested execution is unavailable', async () => {
    const deactivateServer = vi.fn();
    const exec = vi.fn(async () => 'unsafe');
    const inner = mcpTool('mcp__github__ping', exec);
    const tool = createMcpUseTool({
      registry: fakeRegistry({ deactivateServer }),
      toolRegistry: fakeToolRegistry([inner]),
    });

    await expect(
      tool.execute(
        { server: 'github', tool: 'ping', input: {} },
        { meta: {} } as never,
        { signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow('governed nested execution is unavailable');
    expect(exec).not.toHaveBeenCalled();
    expect(deactivateServer).toHaveBeenCalledWith('github');
  });

  it('throws listing available tools when the requested tool is missing', async () => {
    const deactivateServer = vi.fn();
    const tool = createMcpUseTool({
      registry: fakeRegistry({ deactivateServer }),
      toolRegistry: fakeToolRegistry([
        mcpTool('mcp__github__create_issue', vi.fn()),
        mcpTool('mcp__github__list_repos', vi.fn()),
      ]),
    });
    await expect(run(tool, { server: 'github', tool: 'nope', input: {} })).rejects.toThrow(
      /not found on server "github".*create_issue.*list_repos/,
    );
    // The error path still cleans up the activation this call performed.
    expect(deactivateServer).toHaveBeenCalledWith('github');
  });

  it('throws explaining when the server published no tools', async () => {
    const tool = createMcpUseTool({ registry: fakeRegistry(), toolRegistry: fakeToolRegistry([]) });
    await expect(run(tool, { server: 'github', tool: 'nope', input: {} })).rejects.toThrow(
      'may not have published any tools',
    );
  });

  it('does not deactivate a server the operator had already activated', async () => {
    // An mcp_control activate must survive an ephemeral mcp_use call — only
    // activations performed by THIS call are torn down in the finally.
    const activateServer = vi.fn();
    const deactivateServer = vi.fn();
    const inner = mcpTool(
      'mcp__github__ping',
      vi.fn(async () => 'pong'),
    );
    const tool = createMcpUseTool({
      registry: fakeRegistry({
        activateServer,
        deactivateServer,
        isActivated: vi.fn().mockReturnValue(true),
      }),
      toolRegistry: fakeToolRegistry([inner]),
    });
    expect(await run(tool, { server: 'github', tool: 'ping', input: {} }, [inner])).toBe('pong');
    expect(activateServer).not.toHaveBeenCalled();
    expect(deactivateServer).not.toHaveBeenCalled();
  });

  it('still deactivates when the tool call throws', async () => {
    const deactivateServer = vi.fn();
    const inner = mcpTool(
      'mcp__github__boom',
      vi.fn(async () => {
        throw new Error('tool exploded');
      }),
    );
    const tool = createMcpUseTool({
      registry: fakeRegistry({ deactivateServer }),
      toolRegistry: fakeToolRegistry([inner]),
    });
    await expect(run(tool, { server: 'github', tool: 'boom', input: {} }, [inner])).rejects.toThrow(
      'tool exploded',
    );
    expect(deactivateServer).toHaveBeenCalledWith('github');
  });

  it('works when the registry lacks activate/deactivate hooks', async () => {
    const inner = mcpTool(
      'mcp__github__ping',
      vi.fn(async () => 'pong'),
    );
    const tool = createMcpUseTool({
      registry: fakeRegistry({ activateServer: undefined, deactivateServer: undefined }),
      toolRegistry: fakeToolRegistry([inner]),
    });
    expect(await run(tool, { server: 'github', tool: 'ping', input: {} }, [inner])).toBe('pong');
  });
});
