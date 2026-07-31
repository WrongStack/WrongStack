import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeKanbanServerConnections, getKanbanServerConnection } from '@wrongstack/kanban';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKanbanMcpToolHost } from '../src/adapter.js';

function objectContent(result: { content: unknown; isError: boolean }): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  expect(result.content).toBeTypeOf('object');
  return result.content as Record<string, unknown>;
}

describe('Kanban MCP full-access IPC integration', () => {
  let projectRoot = '';
  let previousForceIpc: string | undefined;
  let serverProcess: ChildProcess | undefined;

  beforeAll(async () => {
    previousForceIpc = process.env['WRONGSTACK_KANBAN_FORCE_IPC'];
    process.env['WRONGSTACK_KANBAN_FORCE_IPC'] = '1';
    projectRoot = await mkdtemp(join(tmpdir(), 'wrongstack-kanban-mcp-'));
    const projectServer = fileURLToPath(
      new URL('../../kanban/dist/project-server.js', import.meta.url),
    );
    serverProcess = spawn(process.execPath, [projectServer, '--project-root', projectRoot], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'production', VITEST: 'false' },
    });
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      const timeout = setTimeout(
        () => reject(new Error(`Kanban project server readiness timed out: ${stderr}`)),
        10_000,
      );
      serverProcess?.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      serverProcess?.stdout?.on('data', (chunk: Buffer) => {
        if (!chunk.toString('utf8').includes('kanban project server listening')) return;
        clearTimeout(timeout);
        resolve();
      });
      serverProcess?.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Kanban project server exited before ready (${String(code)}): ${stderr}`));
      });
    });
  });

  afterAll(async () => {
    try {
      const connection = await getKanbanServerConnection(projectRoot);
      await connection?.request('shutdown', { reason: 'Kanban MCP integration test complete' });
    } catch {
      // The daemon may already have stopped after a failed assertion.
    } finally {
      closeKanbanServerConnections();
      if (serverProcess && serverProcess.exitCode === null) serverProcess.kill('SIGTERM');
      if (previousForceIpc === undefined) delete process.env['WRONGSTACK_KANBAN_FORCE_IPC'];
      else process.env['WRONGSTACK_KANBAN_FORCE_IPC'] = previousForceIpc;
      if (projectRoot) {
        await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  });

  it('creates, edits, reads, deletes a task, and deletes its board through MCP over IPC', async () => {
    const host = createKanbanMcpToolHost(projectRoot, {
      actor: 'kanban-mcp-integration',
      destructive: true,
    });
    expect((await host.listTools()).map((tool) => tool.name)).toEqual([
      'kanban_read',
      'kanban_watch',
      'kanban_manage',
      'kanban_destructive',
    ]);

    const createResult = objectContent(
      await host.callTool('kanban_manage', {
        action: 'create_board',
        title: 'External MCP integration board',
      }),
    );
    const board = createResult['board'] as { id: string };
    expect(board.id).toBeTruthy();

    const addResult = objectContent(
      await host.callTool('kanban_manage', {
        action: 'add_task',
        boardId: board.id,
        title: 'External MCP task',
        description: 'Created through the MCP management tier.',
      }),
    );
    const task = addResult['task'] as { id: string };
    expect(task.id).toBeTruthy();

    objectContent(
      await host.callTool('kanban_manage', {
        action: 'update_task',
        boardId: board.id,
        taskId: task.id,
        description: 'Updated through the MCP management tier.',
        priority: 'high',
      }),
    );
    const readResult = objectContent(
      await host.callTool('kanban_read', {
        action: 'get_task',
        boardId: board.id,
        taskId: task.id,
      }),
    );
    expect(readResult['task']).toMatchObject({
      id: task.id,
      description: 'Updated through the MCP management tier.',
      priority: 'high',
    });

    objectContent(
      await host.callTool('kanban_destructive', {
        action: 'delete_task',
        boardId: board.id,
        taskId: task.id,
      }),
    );
    objectContent(
      await host.callTool('kanban_destructive', {
        action: 'delete_board',
        boardId: board.id,
      }),
    );

    const boardsResult = objectContent(
      await host.callTool('kanban_read', { action: 'list_boards' }),
    );
    expect(boardsResult['boards']).toEqual([]);
  });
});
