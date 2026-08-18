/**
 * Focused test: tool executor auto-emission of file events.
 *
 * Verifies that the `ToolExecutor`'s `executeBatch` path automatically
 * emits file events (both `file_event` session events via
 * `ctx.recordFileEvent()` and `file.event` EventBus events) for any
 * tool declared with `fs.read` or `fs.write` capabilities.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { EventBus } from '../../src/kernel/events.js';
import { AutoApprovePermissionPolicy } from '../../src/security/permission-policy.js';
import type { ToolUseBlock } from '../../src/types/blocks.js';
import type { Tool } from '../../src/types/tool.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeToolUse(name: string, id: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

function makeRegistry(tools: Tool[]): { get(name: string): Tool | undefined; list(): Tool[] } {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n: string) => map.get(n), list: () => tools };
}

function makeEventBus(): EventBus {
  return new EventBus();
}

/** The production subagent policy grants exactly the capabilities under test. */
const autoApprovePolicy = new AutoApprovePermissionPolicy(['fs.read', 'fs.write']);

/** Create a minimal context with spyable `recordFileEvent` and kanban fields. */
function makeFileEventCtx(overrides: Record<string, unknown> = {}) {
  const projectRoot = path.join(os.tmpdir(), 'wstack-file-event-tests');
  return {
    meta: {},
    session: { id: 'sess-file-events' },
    traceId: undefined,
    agentId: 'test-agent',
    agentName: 'Test Agent',
    projectRoot,
    cwd: projectRoot,
    workingDir: projectRoot,
    model: 'test-model',
    provider: { id: 'test-provider' },
    signal: new AbortController().signal,
    currentKanbanTaskId: undefined as string | undefined,
    currentKanbanBoardId: undefined as string | undefined,
    recordFileEvent: vi.fn(),
    allowOutsideProjectRoot: false,
    ...overrides,
  } as unknown as Context & { recordFileEvent: ReturnType<typeof vi.fn> };
}

/** Create a mock tool with fs.read capability that returns a fixed result. */
function fsReadTool(): Tool {
  return {
    name: 'read',
    description: 'Read a file.',
    permission: 'auto',
    mutating: false,
    capabilities: ['fs.read'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    async execute(input: unknown) {
      return `content of ${(input as any).path}`;
    },
  };
}

/** Create a mock tool with fs.write capability. */
function fsWriteTool(name: string): Tool {
  return {
    name,
    description: 'Write to a file.',
    permission: 'auto',
    mutating: true,
    capabilities: ['fs.write'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path'],
    },
    async execute(input: unknown) {
      return `wrote ${((input as any).content ?? '').length} bytes to ${(input as any).path}`;
    },
  };
}

/** Create a tool with NO filesystem capabilities (negative control). */
function nonFsTool(): Tool {
  return {
    name: 'echo',
    description: 'Echo input.',
    permission: 'auto',
    mutating: false,
    capabilities: [],
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: unknown) {
      return 'echo';
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

const noopScrubber = { scrub: (s: string) => s };

describe('ToolExecutor — file event auto-emission', () => {
  it('emits both ctx.recordFileEvent and file.event for fs.read tool', async () => {
    const events = makeEventBus();
    const fileEvents: unknown[] = [];
    events.on('file.event', (p) => fileEvents.push(p));

    const tool = fsReadTool();
    const reg = makeRegistry([tool]);
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber, permissionPolicy: autoApprovePolicy } as any);
    const ctx = makeFileEventCtx();

    const result = await exec.executeBatch(
      [makeToolUse('read', 'tu-read-1', { path: 'src/main.ts' })],
      ctx,
      'sequential',
    );

    expect(result.outputs).toHaveLength(1);
    const output = result.outputs[0];
    expect(output?.result.type).toBe('tool_result');
    if (output?.result.type !== 'tool_result') {
      throw new Error('Expected the read tool to execute without pending confirmation');
    }
    expect(output.result.is_error).toBeFalsy();

    // ctx.recordFileEvent was called once with the right shape
    expect(ctx.recordFileEvent).toHaveBeenCalledTimes(1);
    const callArg = ctx.recordFileEvent.mock.calls[0]![0];
    expect(callArg.operation).toBe('read');
    expect(callArg.filePath).toBe('src/main.ts');
    expect(callArg.toolName).toBe('read');
    expect(callArg.toolUseId).toBe('tu-read-1');
    expect(callArg.absPath).toContain('main.ts');

    // file.event was emitted on the EventBus once
    expect(fileEvents.length).toBe(1);
    const busArg = fileEvents[0] as Record<string, unknown>;
    expect(busArg.operation).toBe('read');
    expect(busArg.filePath).toBe('src/main.ts');
    expect(busArg.toolName).toBe('read');
    expect(busArg.sessionId).toBe('sess-file-events');
    expect(busArg.provider).toBe('test-provider');
    expect(busArg.model).toBe('test-model');
    expect(busArg.scope).toBe('session'); // no kanban task set
  });

  it('emits create operation when write targets a new file', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-file-create-'));
    try {
      const events = makeEventBus();
      const fileEvents: unknown[] = [];
      events.on('file.event', (p) => fileEvents.push(p));

      const tool = fsWriteTool('write');
      const reg = makeRegistry([tool]);
      const exec = new ToolExecutor(reg, {
        events,
        secretScrubber: noopScrubber,
        permissionPolicy: autoApprovePolicy,
      } as any);
      const ctx = makeFileEventCtx({ projectRoot, cwd: projectRoot, workingDir: projectRoot });

      const result = await exec.executeBatch(
        [makeToolUse('write', 'tu-write-1', { path: 'new-file.ts', content: 'hello' })],
        ctx,
        'sequential',
      );

      expect(result.outputs[0]?.result.type).toBe('tool_result');
      expect(ctx.recordFileEvent).toHaveBeenCalledTimes(1);
      const callArg = ctx.recordFileEvent.mock.calls[0]![0];
      expect(callArg.operation).toBe('create');
      expect(callArg.filePath).toBe('new-file.ts');
      expect(callArg.toolName).toBe('write');

      expect(fileEvents.length).toBe(1);
      expect((fileEvents[0] as Record<string, unknown>).operation).toBe('create');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('emits update operation when write overwrites an existing file', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-file-update-'));
    try {
      await fs.writeFile(path.join(projectRoot, 'existing.ts'), 'old content');
      const events = makeEventBus();
      const fileEvents: unknown[] = [];
      events.on('file.event', (p) => fileEvents.push(p));

      const tool = fsWriteTool('write');
      const exec = new ToolExecutor(makeRegistry([tool]), {
        events,
        secretScrubber: noopScrubber,
        permissionPolicy: autoApprovePolicy,
      } as any);
      const ctx = makeFileEventCtx({ projectRoot, cwd: projectRoot, workingDir: projectRoot });

      const result = await exec.executeBatch(
        [makeToolUse('write', 'tu-write-2', { path: 'existing.ts', content: 'new content' })],
        ctx,
        'sequential',
      );

      expect(result.outputs[0]?.result.type).toBe('tool_result');
      expect(ctx.recordFileEvent).toHaveBeenCalledTimes(1);
      expect(ctx.recordFileEvent.mock.calls[0]![0].operation).toBe('update');
      expect(fileEvents).toHaveLength(1);
      expect((fileEvents[0] as Record<string, unknown>).operation).toBe('update');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('emits update operation for edit tool (fs.write)', async () => {
    const events = makeEventBus();
    const fileEvents: unknown[] = [];
    events.on('file.event', (p) => fileEvents.push(p));

    const tool = fsWriteTool('edit');
    const reg = makeRegistry([tool]);
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber, permissionPolicy: autoApprovePolicy } as any);
    const ctx = makeFileEventCtx();

    await exec.executeBatch(
      [makeToolUse('edit', 'tu-edit-1', { path: 'src/app.ts', old_string: 'a', new_string: 'b' })],
      ctx,
      'sequential',
    );

    expect(ctx.recordFileEvent).toHaveBeenCalledTimes(1);
    const callArg = ctx.recordFileEvent.mock.calls[0]![0];
    // edit tool has fs.write but name !== 'write' → operation = 'update'
    expect(callArg.operation).toBe('update');
    expect(callArg.toolName).toBe('edit');

    expect(fileEvents.length).toBe(1);
    expect((fileEvents[0] as Record<string, unknown>).operation).toBe('update');
  });

  it('includes kanban task context when set on ctx', async () => {
    const events = makeEventBus();
    const fileEvents: unknown[] = [];
    events.on('file.event', (p) => fileEvents.push(p));

    const tool = fsReadTool();
    const reg = makeRegistry([tool]);
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber, permissionPolicy: autoApprovePolicy } as any);
    const ctx = makeFileEventCtx({
      currentKanbanTaskId: 'task-42',
      currentKanbanBoardId: 'board-feature',
    });

    await exec.executeBatch(
      [makeToolUse('read', 'tu-kanban-1', { path: 'kanban.ts' })],
      ctx,
      'sequential',
    );

    // recordFileEvent is called (the real Context method would derive
    // scope/taskId/boardId internally from its own fields)
    expect(ctx.recordFileEvent).toHaveBeenCalledTimes(1);

    // Kanban context is verified via the EventBus payload which
    // explicitly carries these fields
    expect(fileEvents.length).toBe(1);
    const busArg = fileEvents[0] as Record<string, unknown>;
    expect(busArg.scope).toBe('task');
    expect(busArg.taskId).toBe('task-42');
    expect(busArg.boardId).toBe('board-feature');
  });

  it('skips file event for tool without fs capabilities', async () => {
    const events = makeEventBus();
    const fileEvents: unknown[] = [];
    events.on('file.event', (p) => fileEvents.push(p));

    const tool = nonFsTool();
    const reg = makeRegistry([tool]);
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber, permissionPolicy: autoApprovePolicy } as any);
    const ctx = makeFileEventCtx();

    await exec.executeBatch(
      [makeToolUse('echo', 'tu-echo-1')],
      ctx,
      'sequential',
    );

    expect(ctx.recordFileEvent).not.toHaveBeenCalled();
    expect(fileEvents.length).toBe(0);
  });

  it('skips file event when tool has fs capability but no path in input', async () => {
    const events = makeEventBus();
    const fileEvents: unknown[] = [];
    events.on('file.event', (p) => fileEvents.push(p));

    const tool = fsReadTool();
    const reg = makeRegistry([tool]);
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber, permissionPolicy: autoApprovePolicy } as any);
    const ctx = makeFileEventCtx();

    // Tool has fs.read but input has no 'path' key
    await exec.executeBatch(
      [makeToolUse('read', 'tu-nopath-1', { query: 'something' })],
      ctx,
      'sequential',
    );

    expect(ctx.recordFileEvent).not.toHaveBeenCalled();
    expect(fileEvents.length).toBe(0);
  });

  it('emits file events for multiple tools in a single batch', async () => {
    const events = makeEventBus();
    const fileEvents: unknown[] = [];
    events.on('file.event', (p) => fileEvents.push(p));

    const tool1 = fsReadTool();
    const tool2 = fsWriteTool('write');
    const tool3 = nonFsTool();
    const reg = makeRegistry([tool1, tool2, tool3]);
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber, permissionPolicy: autoApprovePolicy } as any);
    const ctx = makeFileEventCtx();

    await exec.executeBatch(
      [
        makeToolUse('read', 'tu-multi-1', { path: 'a.ts' }),
        makeToolUse('write', 'tu-multi-2', { path: 'b.ts', content: 'x' }),
        makeToolUse('echo', 'tu-multi-3'),
      ],
      ctx,
      'sequential',
    );

    // Two fs tools → 2 recordFileEvent calls, 2 file.event emissions
    expect(ctx.recordFileEvent).toHaveBeenCalledTimes(2);
    expect(fileEvents.length).toBe(2);

    expect((fileEvents[0] as Record<string, unknown>).operation).toBe('read');
    expect((fileEvents[1] as Record<string, unknown>).operation).toBe('create');
  });
});
