import type { KanbanServerEvent } from '@wrongstack/kanban';
import { describe, expect, it, vi } from 'vitest';
import { createKanbanMcpServer, createKanbanMcpToolHost } from '../src/adapter.js';

describe('createKanbanMcpToolHost', () => {
  it('advertises action-filtered schemas for each enabled tier', async () => {
    const host = createKanbanMcpToolHost('C:/project', {
      writable: true,
      dependencies: { executeKanban: vi.fn() },
    });
    const tools = await host.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'kanban_read',
      'kanban_watch',
      'kanban_manage',
    ]);
    const readSchema = tools[0]!.inputSchema as {
      properties: { action: { enum: string[] } };
    };
    expect(readSchema.properties.action.enum).toContain('get_board');
    expect(readSchema.properties.action.enum).not.toContain('update_task');
  });

  it('executes an allowed action with project and actor context', async () => {
    const executeKanban = vi.fn().mockResolvedValue({ ok: true, boards: [] });
    const host = createKanbanMcpToolHost('C:/project', {
      actor: 'cursor-agent',
      dependencies: { executeKanban },
    });
    const result = await host.callTool('kanban_read', { action: 'list_boards' });
    expect(result).toEqual({ content: { ok: true, boards: [] }, isError: false });
    expect(executeKanban).toHaveBeenCalledWith(
      { action: 'list_boards' },
      expect.objectContaining({ projectRoot: 'C:/project', agentId: 'cursor-agent' }),
      expect.any(AbortSignal),
    );
  });

  it('rejects hidden tools and cross-tier actions', async () => {
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: { executeKanban: vi.fn() },
    });
    await expect(host.callTool('kanban_manage', { action: 'update_task' })).resolves.toMatchObject({
      isError: true,
    });
    await expect(host.callTool('kanban_read', { action: 'delete_board' })).resolves.toMatchObject({
      isError: true,
    });
  });

  it('surfaces Kanban failures and thrown errors as MCP errors', async () => {
    const failedHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn().mockResolvedValue({ ok: false, error: 'not found' }),
      },
    });
    await expect(
      failedHost.callTool('kanban_read', { action: 'get_board', boardId: 'missing' }),
    ).resolves.toMatchObject({ isError: true });

    const thrownHost = createKanbanMcpToolHost('C:/project', {
      dependencies: { executeKanban: vi.fn().mockRejectedValue(new Error('daemon failed')) },
    });
    await expect(thrownHost.callTool('kanban_read', { action: 'list_boards' })).resolves.toEqual({
      content: 'daemon failed',
      isError: true,
    });
  });

  it('long-polls and filters daemon mutation events by board', async () => {
    let listener: ((event: KanbanServerEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn().mockResolvedValue({
          subscribe: (next: (event: KanbanServerEvent) => void) => {
            listener = next;
            return unsubscribe;
          },
          onDisconnect: () => vi.fn(),
        }),
      },
    });

    const pending = host.callTool('kanban_watch', { boardId: 'board-a', timeoutMs: 1_000 });
    await vi.waitFor(() => expect(listener).toBeTypeOf('function'));
    listener?.({ type: 'event', event: 'board.updated', data: { boardId: 'board-b' } });
    listener?.({ type: 'event', event: 'board.updated', data: { boardId: 'board-a' } });

    await expect(pending).resolves.toEqual({
      content: {
        changed: true,
        event: 'board.updated',
        data: { boardId: 'board-a' },
      },
      isError: false,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('reports disabled live watch without falling back to files', async () => {
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(host.callTool('kanban_watch', {})).resolves.toEqual({
      content: 'Kanban project server is disabled; live watch is unavailable',
      isError: true,
    });
  });
});

describe('createKanbanMcpServer', () => {
  it('publishes server identity and the Kanban workflow prompt', async () => {
    const server = createKanbanMcpServer('C:/project', {
      dependencies: { executeKanban: vi.fn() },
    });
    const initialized = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      ))!,
    ) as { result: { serverInfo: { name: string } } };
    expect(initialized.result.serverInfo.name).toBe('wrongstack-kanban-mcp');

    const prompts = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }),
      ))!,
    ) as { result: { prompts: Array<{ name: string }> } };
    expect(prompts.result.prompts).toContainEqual(
      expect.objectContaining({ name: 'work-kanban-task' }),
    );

    const rendered = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'prompts/get',
          params: { name: 'work-kanban-task', arguments: { boardId: 'board-1' } },
        }),
      ))!,
    ) as { result: { messages: Array<{ content: { text: string } }> } };
    expect(rendered.result.messages[0]?.content.text).toContain('board-1');
  });
});
