import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard, type KanbanServerEvent, type KanbanTask } from '@wrongstack/kanban';
import { addCheckToTask, addGoalMetricToTask, addTask } from '@wrongstack/kanban/test-support';
import type { MCPServerTool } from '@wrongstack/mcp';
// Namespace import: vitest resolves this to the tools SOURCE, while the test
// tsconfig resolves it to the built dist, which may predate the export.
import * as kanbanToolModule from '@wrongstack/tools/kanban';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { createKanbanMcpServer, createKanbanMcpToolHost } from '../src/adapter.js';
import { KANBAN_READ_ACTIONS } from '../src/policy.js';

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

  it('publishes tier-driven MCP annotations on every descriptor', async () => {
    // Read the hints through the upstream element type rather than a local
    // restatement, so this assertion follows the wire shape if `MCPServerTool`
    // ever widens.
    const annotationsOf = (tool: MCPServerTool): MCPServerTool['annotations'] => tool.annotations;

    const host = createKanbanMcpToolHost('C:/project', {
      destructive: true,
      dependencies: { executeKanban: vi.fn() },
    });
    const tools = await host.listTools();
    const annotations = new Map(tools.map((tool) => [tool.name, annotationsOf(tool)]));
    expect(annotations.get('kanban_read')).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(annotations.get('kanban_watch')).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(annotations.get('kanban_manage')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(annotations.get('kanban_destructive')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
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
      { action: 'list_boards', limit: 20, includeArchived: false },
      expect.objectContaining({ projectRoot: 'C:/project', agentId: 'cursor-agent' }),
      expect.any(AbortSignal),
    );
  });

  it('forwards the MCP request cancellation signal to Kanban actions', async () => {
    const executeKanban = vi.fn().mockResolvedValue({ ok: true, boards: [] });
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: { executeKanban },
    });
    const controller = new AbortController();

    await host.callTool('kanban_read', { action: 'list_boards' }, { signal: controller.signal });

    expect(executeKanban).toHaveBeenCalledWith(
      { action: 'list_boards', limit: 20, includeArchived: false },
      expect.anything(),
      controller.signal,
    );
  });

  it('bounds list reads for external callers unless they ask for more', async () => {
    const executeKanban = vi.fn().mockResolvedValue({ ok: true });
    const host = createKanbanMcpToolHost('C:/project', { dependencies: { executeKanban } });

    await host.callTool('kanban_read', { action: 'search_tasks', query: 'x' });
    await host.callTool('kanban_read', {
      action: 'list_boards',
      limit: 500,
      includeArchived: true,
    });
    await host.callTool('kanban_read', { action: 'get_board', boardId: 'b1' });

    expect(executeKanban.mock.calls.map((call) => call[0])).toEqual([
      { action: 'search_tasks', query: 'x', limit: 10 },
      { action: 'list_boards', limit: 500, includeArchived: true },
      { action: 'get_board', boardId: 'b1' },
    ]);
  });

  it('holds external calls to the advertised schema before the tool runs', async () => {
    const executeKanban = vi.fn().mockResolvedValue({ ok: true });
    const host = createKanbanMcpToolHost('C:/project', {
      writable: true,
      dependencies: { executeKanban },
    });

    const bad = await host.callTool('kanban_manage', {
      action: 'add_task',
      boardId: 'b1',
      title: 't',
      priority: 'urgent!!',
    });
    await host.callTool('kanban_read', { action: 'list_boards', limit: '5' });

    expect(bad).toMatchObject({ isError: true, content: expect.stringMatching(/priority/) });
    expect(executeKanban.mock.calls.map((call) => call[0])).toEqual([
      { action: 'list_boards', limit: 5, includeArchived: false },
    ]);
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
    // The kanban tool THROWS on failure (it never returns ok:false); the thrown
    // error carries a stable code, retryability and lifecycle issues, and all
    // of it must reach the MCP client.
    const issues = [{ code: 'missing-owner', field: 'assignee', message: 'Assign an owner.' }];
    const failedHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn().mockRejectedValue(
          Object.assign(new Error('[REFUSED] Cannot start. Issues: assignee: Assign an owner.'), {
            kanbanCode: 'REFUSED',
            retryable: false,
            issues,
          }),
        ),
      },
    });
    await expect(
      failedHost.callTool('kanban_read', { action: 'get_board', boardId: 'missing' }),
    ).resolves.toEqual({
      isError: true,
      content: {
        ok: false,
        error: {
          code: 'REFUSED',
          message: '[REFUSED] Cannot start. Issues: assignee: Assign an owner.',
          retryable: false,
          issues,
        },
      },
    });

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

  it('cancels a live watch and releases daemon listeners immediately', async () => {
    const unsubscribeEvent = vi.fn();
    const unsubscribeDisconnect = vi.fn();
    const controller = new AbortController();
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn().mockResolvedValue({
          subscribe: () => unsubscribeEvent,
          onDisconnect: () => unsubscribeDisconnect,
        }),
      },
    });

    const pending = host.callTool(
      'kanban_watch',
      { timeoutMs: 25_000 },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(unsubscribeEvent).not.toHaveBeenCalled());
    controller.abort(new Error('client stopped watching'));

    await expect(pending).resolves.toEqual({
      content: 'client stopped watching',
      isError: true,
    });
    expect(unsubscribeEvent).toHaveBeenCalledOnce();
    expect(unsubscribeDisconnect).toHaveBeenCalledOnce();
  });

  it('does not acquire a daemon connection for a pre-cancelled watch', async () => {
    const getConnection = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: { executeKanban: vi.fn(), getConnection },
    });

    await expect(host.callTool('kanban_watch', {}, { signal: controller.signal })).resolves.toEqual(
      { content: 'already cancelled', isError: true },
    );
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('clamps watch timeout to 100ms, handles daemon disconnect, post-connect abort, array event data, sessionId, ok:false, post-exec abort, and retryable/non-Error failures', async () => {
    // S14-M1 & S14-M3: normalizeTimeout minimum 100ms clamp & timeout resolution
    const timeoutHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn().mockResolvedValue({
          subscribe: () => () => {},
          onDisconnect: () => () => {},
        }),
      },
    });
    await expect(timeoutHost.callTool('kanban_watch', { timeoutMs: 5 })).resolves.toEqual({
      content: { changed: false, timedOut: true, timeoutMs: 100 },
      isError: false,
    });

    // S14-M2 & S14-M10: onDisconnect callback & array event.data with boardId property ignored
    let eventListener: ((event: KanbanServerEvent) => void) | undefined;
    let disconnectListener: (() => void) | undefined;
    const discHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn().mockResolvedValue({
          subscribe: (fn: (event: KanbanServerEvent) => void) => {
            eventListener = fn;
            return () => {};
          },
          onDisconnect: (fn: () => void) => {
            disconnectListener = fn;
            return () => {};
          },
        }),
      },
    });
    const watchDisc = discHost.callTool('kanban_watch', { boardId: 'b1', timeoutMs: 5_000 });
    await vi.waitFor(() => expect(disconnectListener).toBeTypeOf('function'));
    const arrData = Object.assign([], { boardId: 'b1' });
    eventListener?.({ type: 'event', event: 'board.updated', data: arrData as unknown });
    disconnectListener?.();
    await expect(watchDisc).resolves.toEqual({
      content: { changed: false, disconnected: true, reason: 'Kanban daemon disconnected' },
      isError: false,
    });

    // S14-M4: signal aborted during getConnection before subscribe is called
    const subscribeSpy = vi.fn(() => () => {});
    const abortCtrl = new AbortController();
    const raceHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn(async () => {
          abortCtrl.abort(new Error('aborted during connect'));
          return { subscribe: subscribeSpy, onDisconnect: () => () => {} };
        }),
      },
    });
    await expect(
      raceHost.callTool('kanban_watch', {}, { signal: abortCtrl.signal }),
    ).resolves.toEqual({
      content: 'aborted during connect',
      isError: true,
    });
    expect(subscribeSpy).not.toHaveBeenCalled();

    // S14-M5 & S14-M6: opts.sessionId override & result.ok === false
    let seenSessionId = '';
    const customHost = createKanbanMcpToolHost('C:/project', {
      sessionId: '  custom-sess-99  ',
      dependencies: {
        executeKanban: vi.fn(async (_args, ctx) => {
          seenSessionId = (ctx as unknown as { eventSessionId: () => string }).eventSessionId();
          return { ok: false, reason: 'soft-fail' };
        }),
      },
    });
    await expect(customHost.callTool('kanban_read', { action: 'list_boards' })).resolves.toEqual({
      content: { ok: false, reason: 'soft-fail' },
      isError: true,
    });
    expect(seenSessionId).toBe('custom-sess-99');

    // S14-M7, S14-M8, S14-M9: retryable: true error, non-Error throw, and post-await abort on executeKanban
    const retryableErr = Object.assign(new Error('lock busy'), {
      kanbanCode: 'BUSY',
      retryable: true,
    });
    const errHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi
          .fn()
          .mockRejectedValueOnce(retryableErr)
          .mockRejectedValueOnce('plain-string-error'),
      },
    });
    await expect(errHost.callTool('kanban_read', { action: 'list_boards' })).resolves.toEqual({
      content: { ok: false, error: { code: 'BUSY', message: 'lock busy', retryable: true } },
      isError: true,
    });
    await expect(errHost.callTool('kanban_read', { action: 'list_boards' })).resolves.toEqual({
      content: 'plain-string-error',
      isError: true,
    });

    const execCtrl = new AbortController();
    const postAbortHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(async () => {
          execCtrl.abort(new Error('aborted-after-exec'));
          return { ok: true };
        }),
      },
    });
    await expect(
      postAbortHost.callTool('kanban_read', { action: 'list_boards' }, { signal: execCtrl.signal }),
    ).resolves.toEqual({
      content: 'aborted-after-exec',
      isError: true,
    });
  });
});

describe('Kanban MCP against the real kanban tool', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wstack-kanban-mcp-adapter-'));
  });
  afterEach(async () => {
    await removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 50 });
  });

  it('keeps the read tier identical to the tool read-only actions', () => {
    const readOnly = (kanbanToolModule as Record<string, unknown>)['KANBAN_READ_ONLY_ACTIONS'];
    expect(Array.isArray(readOnly)).toBe(true);
    expect([...KANBAN_READ_ACTIONS].sort()).toEqual([...(readOnly as string[])].sort());
  });

  // The MCP context has no setCurrentKanbanTask (it is not an agent run). The
  // managed start_task path called it unguarded, so the card was moved to
  // Running with a lease and THEN the call died with a TypeError.
  it('starts a managed card through the MCP context without a TypeError', async () => {
    const board = await createBoard(dir, {
      title: 'Managed via MCP',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'in-progress', title: 'Running', order: 2 },
        { id: 'review', title: 'Review', order: 3 },
        { id: 'done', title: 'Done', order: 4 },
      ],
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    const added = await addTask(dir, board.id, {
      title: 'Implement safely',
      description: 'Change the parser while preserving existing behavior.',
      assignedAgent: 'agent-1',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['parser'],
    });
    const taskId = added!.task.id;
    await addGoalMetricToTask(dir, board.id, taskId, { name: 'New syntax parses', target: 'pass' });
    await addCheckToTask(dir, board.id, taskId, {
      description: 'Regression suite passes',
      type: 'test',
    });

    const host = createKanbanMcpToolHost(dir, { actor: 'agent-1', writable: true });
    const result = await host.callTool('kanban_manage', {
      action: 'start_task',
      boardId: board.id,
      taskId,
      author: 'agent-1',
      transitionComment: 'Starting from an external MCP client.',
    });

    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const content = result.content as { ok: boolean; task: KanbanTask };
    expect(content.task.lifecycle?.currentStage).toBe('running');
    expect(content.task.assignment?.status).toBe('running');
  });

  it('returns a structured NOT_FOUND for a missing board', async () => {
    const host = createKanbanMcpToolHost(dir, { actor: 'agent-1' });
    const result = await host.callTool('kanban_read', { action: 'get_board', boardId: 'nope' });
    expect(result).toMatchObject({
      isError: true,
      content: { ok: false, error: { code: 'NOT_FOUND', retryable: false } },
    });
  });
});

describe('createKanbanMcpServer', () => {
  it('publishes annotations through the tools/list JSON-RPC surface', async () => {
    const server = createKanbanMcpServer('C:/project', {
      writable: true,
      dependencies: { executeKanban: vi.fn() },
    });
    const listed = JSON.parse(
      (await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      ))!,
    ) as { result: { tools: Array<{ name: string; annotations?: object }> } };
    const byName = new Map(listed.result.tools.map((tool) => [tool.name, tool.annotations]));

    // Tier selection still gates what is published: writable mode exposes
    // manage but never destructive.
    expect([...byName.keys()].sort()).toEqual(['kanban_manage', 'kanban_read', 'kanban_watch']);
    expect(byName.get('kanban_read')).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get('kanban_watch')).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get('kanban_manage')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

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

  it('surfaces a failed workbench query as a JSON-RPC error on resources/read (F2735)', async () => {
    const server = createKanbanMcpServer('C:/project', {
      dependencies: { executeKanban: vi.fn().mockRejectedValue(new Error('kanban daemon failed')) },
    });
    const raw = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: 'kanban://workbench' },
      }),
    );
    const res = JSON.parse(raw!) as { error?: { message: string }; result?: unknown };
    // Error prose must not be served as a successful application/json resource.
    expect(res.result).toBeUndefined();
    expect(res.error?.message).toContain('kanban daemon failed');
  });

  it('ignores non-board IPC events and trims boardId in kanban_watch', async () => {
    let subscriber: ((event: KanbanServerEvent) => void) | undefined;
    const host = createKanbanMcpServer('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: async () => ({
          subscribe: (cb) => {
            subscriber = cb;
            return () => {
              subscriber = undefined;
            };
          },
          onDisconnect: () => () => {},
        }),
      },
    });
    const pending = host.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'kanban_watch', arguments: { boardId: '  board-1  ', timeoutMs: 1000 } },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    subscriber?.({ type: 'event', event: 'workflow.state.updated', data: { boardId: 'board-1' } });
    subscriber?.({ type: 'event', event: 'board.updated', data: { boardId: 'board-1' } });
    const raw = await pending;
    expect(raw).toContain('board.updated');
    expect(raw).not.toContain('workflow.state.updated');
  });

  it('preserves default limit and includeArchived when args contain explicit undefined keys (F137)', async () => {
    const executeKanban = vi.fn(async () => ({ ok: true, boards: [] }));
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: { executeKanban },
    });
    await host.callTool('kanban_read', {
      action: 'list_boards',
      limit: undefined,
      includeArchived: undefined,
    });
    expect(executeKanban).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'list_boards',
        limit: 20,
        includeArchived: false,
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('validates kanban_watch arguments and parses --flag=value CLI options without leaking secrets (F682)', async () => {
    const { parseArgs } = await import('../src/main.js');
    const host = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn().mockResolvedValue({
          subscribe: () => () => {},
          onDisconnect: () => () => {},
        }),
      },
    });
    const unknownKey = await host.callTool('kanban_watch', { unknownField: 'typo' });
    expect(unknownKey).toEqual({
      content: 'kanban_watch: unknown argument "unknownField"',
      isError: true,
    });
    const badBoardId = await host.callTool('kanban_watch', {
      boardId: 123 as unknown as string,
    });
    expect(badBoardId).toEqual({
      content: 'kanban_watch: "boardId" must be a string',
      isError: true,
    });

    const eqParsed = parseArgs([
      '--project-root=/tmp/proj',
      '--port=4100',
      '--actor=bot-k',
      '--token=-kanban-secret-999',
    ]);
    expect(eqParsed.actor).toBe('bot-k');
    expect(eqParsed.httpPort).toBe(4100);
    expect(eqParsed.httpToken).toBe('-kanban-secret-999');

    const bareToken = parseArgs(['--project-root', '/tmp/proj', '--token', '--writable']);
    expect(bareToken.tokenMissing).toBe(true);
    expect(bareToken.writable).toBe(true);

    // F860: kanban_watch cleans up connection.subscribe listener if onDisconnect throws
    let unsubscribed = false;
    const throwingDisconnectHost = createKanbanMcpToolHost('C:/project', {
      dependencies: {
        executeKanban: vi.fn(),
        getConnection: vi.fn().mockResolvedValue({
          subscribe: () => () => {
            unsubscribed = true;
          },
          onDisconnect: () => {
            throw new Error('socket closed');
          },
        }),
      },
    });
    const watchErr = await throwingDisconnectHost.callTool('kanban_watch', { timeoutMs: 500 });
    expect(watchErr.isError).toBe(true);
    expect(unsubscribed).toBe(true);
  });
});
