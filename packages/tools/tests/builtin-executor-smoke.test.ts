import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { PermissionDecision } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../core/src/execution/tool-executor.js';
import type { ToolResultBlock, ToolUseBlock } from '../../core/src/types/blocks.js';
import { builtinTools } from '../src/builtin.js';

// This suite drives the codebase index in-process. The project daemon now
// fails closed when its build cannot be located, so the in-process path has to
// be requested rather than fallen into — the same declaration a user would make
// with WRONGSTACK_INDEX_INLINE=1.
process.env['WRONGSTACK_INDEX_INLINE'] = '1';

/**
 * Never let this suite spawn a detached kanban daemon. `builtinTools` includes
 * the kanban tool, and the daemon outlives the test — it used to be left
 * running against a `tmpDir` this file had already deleted, one immortal ~45MB
 * process per run. The file-backed fallback is what this smoke test wants.
 */
process.env['WRONGSTACK_KANBAN_SERVER'] = '0';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tools-smoke-'));
  await fs.writeFile(path.join(tmpDir, 'sample.txt'), 'alpha\nbravo\n');
  await fs.writeFile(path.join(tmpDir, 'edit.txt'), 'old value\n');
  await fs.writeFile(path.join(tmpDir, 'replace.txt'), 'replace me\n');
  await fs.writeFile(
    path.join(tmpDir, 'doc.ts'),
    'function demo(input: string) {\n  return input;\n}\n',
  );
  await fs.mkdir(path.join(tmpDir, '.state'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(): Context {
  const readMtimes = new Map<string, number>();
  const ctx = {
    messages: [],
    todos: [],
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    systemPrompt: [],
    provider: { id: 'test', capabilities: {}, complete: vi.fn(), stream: vi.fn() },
    session: {
      id: 'smoke-session',
      append: vi.fn(),
      close: vi.fn(),
      recordFileChange: vi.fn(),
    },
    signal: new AbortController().signal,
    tokenCounter: {
      account: vi.fn(),
      total: vi.fn().mockReturnValue({ input: 0, output: 0 }),
      estimateCost: vi.fn().mockReturnValue({ total: 0 }),
    },
    cwd: tmpDir,
    projectRoot: tmpDir,
    model: 'test-model',
    tools: builtinTools,
    meta: {
      'plan.path': path.join(tmpDir, '.state', 'plan.json'),
      'task.path': path.join(tmpDir, '.state', 'tasks.json'),
      'codebase.indexDir': path.join(tmpDir, '.state', 'index'),
    },
    state: {
      replaceTodos: vi.fn((items) => {
        ctx.todos = items;
      }),
    },
    registerAbortHook: vi.fn().mockReturnValue(() => {}),
    drainAbortHooks: vi.fn(),
    recordRead: vi.fn((filePath: string, mtimeMs: number) => {
      const resolved = path.resolve(filePath);
      readMtimes.set(resolved, mtimeMs);
      ctx.readFiles.add(resolved);
      ctx.fileMtimes.set(resolved, mtimeMs);
    }),
    hasRead: vi.fn((filePath: string) => readMtimes.has(path.resolve(filePath))),
    lastReadMtime: vi.fn((filePath: string) => readMtimes.get(path.resolve(filePath))),
    usage: vi.fn().mockReturnValue({ input: 0, output: 0 }),
  } as never as Context;
  return ctx;
}

function makeUse(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: `smoke-${name}`, name, input };
}

function makeExecutor() {
  const registry = {
    get: (name: string) => builtinTools.find((t) => t.name === name),
    list: () => builtinTools,
  };
  const policy = {
    evaluate: vi.fn(
      async (tool): Promise<PermissionDecision> => ({
        permission: tool.permission === 'confirm' ? 'confirm' : 'auto',
        source: 'default',
      }),
    ),
  };
  return new ToolExecutor(registry, {
    permissionPolicy: policy as never,
    confirmAwaiter: vi.fn(async () => 'yes'),
    secretScrubber: { scrub: (s: string) => s } as never,
    perIterationOutputCapBytes: 200_000,
    maxToolTimeoutMs: 30_000,
  });
}

async function runTool(name: string, input: Record<string, unknown>, ctx = makeCtx()) {
  const result = await makeExecutor().executeBatch([makeUse(name, input)], ctx, 'sequential');
  const output = result.outputs[0];
  expect(output, name).toBeDefined();
  expect(output?.result.type, name).toBe('tool_result');
  const block = output!.result as ToolResultBlock;
  expect(block.is_error, `${name} failed: ${block.content}`).not.toBe(true);
  return block.content;
}

describe('builtin tools through ToolExecutor smoke', () => {
  it('runs core filesystem, shell, session, and metadata tools on their simplest successful paths', async () => {
    const ctx = makeCtx();

    await runTool('read', { path: 'sample.txt' }, ctx);
    await runTool('write', { path: 'created.txt', content: 'created\n' }, ctx);
    await runTool('edit', { path: 'edit.txt', old_string: 'old', new_string: 'new' }, ctx);
    await runTool(
      'replace',
      { pattern: 'replace', replacement: 'preview', files: 'replace.txt', dry_run: true },
      ctx,
    );
    await runTool('glob', { pattern: '*.txt', path: '.', limit: 10 }, ctx);
    await runTool('grep', { pattern: 'alpha', path: '.', limit: 10 }, ctx);
    await runTool('bash', { command: 'node -p 21+21', timeout_ms: 10_000 }, ctx);
    await runTool('exec', { command: 'node', args: ['-p', '21+21'], timeout: 10_000 }, ctx);
    await runTool('todo', { todos: [{ id: 't1', content: 'Smoke todo', status: 'pending' }] }, ctx);
    await runTool('plan', { action: 'add', title: 'Smoke plan' }, ctx);
    await runTool(
      'task',
      {
        action: 'add',
        task: { title: 'Smoke task', type: 'chore', priority: 'low' },
      },
      ctx,
    );
    await runTool('git', { command: 'status' }, ctx);
    await runTool(
      'patch',
      { patch: '--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-alpha\n+alpha\n', dry_run: true },
      ctx,
    );
    await runTool('json', { data: '{"ok":true}', query: 'ok' }, ctx);
    await runTool('diff', { files: 'sample.txt' }, ctx);
    await runTool('tree', { path: '.', depth: 1 }, ctx);
    await runTool('document', { target: 'function', path: 'doc.ts' }, ctx);
    await runTool('tool_search', { query: 'read', limit: 5 }, ctx);
    await runTool('tool_help', { tool: 'read' }, ctx);
    await runTool('tool_use', { tool: 'json', input: { data: '{"nested":1}' } }, ctx);
    await runTool(
      'batch_tool_use',
      { parallel: false, calls: [{ tool: 'read', input: { path: 'sample.txt' } }] },
      ctx,
    );
    await runTool('codebase-search', { query: 'demo', limit: 5 }, ctx);
    await runTool('codebase-stats', {}, ctx);
  });
});
