/**
 * Project instruction files: the root AGENTS.md (or CLAUDE.md) sits in the
 * system prompt; a subdirectory's file is delivered once, with the tool
 * result of the first call that touches that subtree, and again only when it
 * changes or after compaction cleared the delivery record.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '../../src/core/context.js';
import {
  queueDirectoryInstructions,
  RootInstructionsCache,
} from '../../src/core/project-instructions.js';
import { SYSTEM_BLOCK_SOURCE } from '../../src/core/system-prompt-blocks.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import type { PermissionDecision, Tool } from '../../src/index.js';
import { DefaultSystemPromptBuilder } from '../../src/index.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-instr-'));
  await fs.mkdir(path.join(root, 'packages', 'foo', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Root rule: PELICAN.\n');
  await fs.writeFile(path.join(root, 'packages', 'AGENTS.md'), 'Packages rule: EGRET.\n');
  await fs.writeFile(path.join(root, 'packages', 'foo', 'CLAUDE.md'), 'Foo rule: HERON.\n');
  await fs.writeFile(path.join(root, 'packages', 'foo', 'src', 'index.ts'), 'export {};\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeCtx(): Context {
  return new Context({
    systemPrompt: [],
    provider: null as never,
    session: {
      append: async () => {},
      appendBatch: async () => {},
      flush: async () => {},
    } as never,
    signal: new AbortController().signal,
    tokenCounter: { account: () => {} } as never,
    cwd: root,
    projectRoot: root,
    model: 'test',
  });
}

describe('RootInstructionsCache', () => {
  it('fences the root AGENTS.md and prefers it over CLAUDE.md', async () => {
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Claude rule: IGNORED.\n');
    const text = await new RootInstructionsCache().load(root);
    expect(text).toContain('<project-supplied-instructions source="AGENTS.md">');
    expect(text).toContain('Root rule: PELICAN.');
    expect(text).not.toContain('IGNORED');
  });

  it('falls back to CLAUDE.md and picks up edits', async () => {
    await fs.rm(path.join(root, 'AGENTS.md'));
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Claude rule: ONE.\n');
    const cache = new RootInstructionsCache();
    expect(await cache.load(root)).toContain('Claude rule: ONE.');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Claude rule: TWO.\n');
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(path.join(root, 'CLAUDE.md'), later, later);
    expect(await cache.load(root)).toContain('Claude rule: TWO.');
    await fs.rm(path.join(root, 'CLAUDE.md'));
    expect(await cache.load(root)).toBe('');
  });

  it('reaches the system prompt as a tagged session block', async () => {
    const builder = new DefaultSystemPromptBuilder({ todayIso: '2026-09-24' });
    const regions = await builder.buildRegions({ cwd: root, projectRoot: root, tools: [] });
    const block = regions.session.find((b) => b.text.includes('Root rule: PELICAN.'));
    expect(block).toBeDefined();
    expect(SYSTEM_BLOCK_SOURCE.get(block!)).toBe('project-instructions');
    // Subdirectory files never enter the system prompt.
    const all = [...regions.core, ...regions.session, ...regions.volatile].map((b) => b.text);
    expect(all.join('\n')).not.toContain('EGRET');
  });
});

/** What one file-tool call on `target` would deliver. */
async function deliver(ctx: Context, target: string): Promise<string | undefined> {
  ctx.pendingPostToolContext = undefined;
  await queueDirectoryInstructions({ capabilities: ['fs.read'] }, { path: target }, ctx);
  return ctx.pendingPostToolContext;
}

describe('directory instructions', () => {
  it('delivers each subtree file once, outermost first, and never the root', async () => {
    const ctx = makeCtx();
    const target = path.join(root, 'packages', 'foo', 'src', 'index.ts');
    const first = await deliver(ctx, target);
    expect(first).toBeDefined();
    expect(first!.indexOf('EGRET')).toBeLessThan(first!.indexOf('HERON'));
    expect(first).toContain('source="packages/foo/CLAUDE.md"');
    expect(first).toContain('work under packages/foo/');
    expect(first).not.toContain('PELICAN');
    expect(await deliver(ctx, target)).toBeUndefined();
  });

  it('redelivers a changed file as updated, and only that file', async () => {
    const ctx = makeCtx();
    const target = path.join(root, 'packages', 'foo');
    await deliver(ctx, target);
    await fs.writeFile(path.join(root, 'packages', 'foo', 'CLAUDE.md'), 'Foo rule: KITE.\n');
    const again = await deliver(ctx, target);
    expect(again).toContain('Updated directory instructions');
    expect(again).toContain('KITE');
    expect(again).not.toContain('EGRET');
  });

  it('delivers instructions under in-root ..-prefixed directories, but not parent escapes', async () => {
    const outer = path.join(root, '..hidden');
    const inner = path.join(outer, '..nested');
    await fs.mkdir(inner, { recursive: true });
    await fs.writeFile(path.join(outer, 'AGENTS.md'), 'Hidden rule: IBIS.\n');
    await fs.writeFile(path.join(inner, 'CLAUDE.md'), 'Nested rule: WREN.\n');
    await fs.writeFile(path.join(inner, 'index.ts'), 'export {};\n');

    const ctx = makeCtx();
    const delivered = await deliver(ctx, path.join(inner, 'index.ts'));
    expect(delivered).toContain('source="..hidden/AGENTS.md"');
    expect(delivered).toContain('source="..hidden/..nested/CLAUDE.md"');
    expect(delivered!.indexOf('IBIS')).toBeLessThan(delivered!.indexOf('WREN'));
    expect(await deliver(ctx, path.join(root, '..', 'outside.ts'))).toBeUndefined();
  });

  it('ignores paths at or outside the project root', async () => {
    const ctx = makeCtx();
    expect(await deliver(ctx, root)).toBeUndefined();
    expect(await deliver(ctx, os.tmpdir())).toBeUndefined();
    expect(await deliver(ctx, path.join(root, 'README.md'))).toBeUndefined();
  });
});

describe('queueDirectoryInstructions', () => {
  it('only reacts to file tools, resolves relative paths, and resets after compaction', async () => {
    const ctx = makeCtx();
    await queueDirectoryInstructions(
      { capabilities: ['net.fetch'] },
      { path: 'packages/foo' },
      ctx,
    );
    expect(ctx.pendingPostToolContext).toBeUndefined();

    await queueDirectoryInstructions({ capabilities: ['fs.read'] }, { path: 'packages/foo' }, ctx);
    expect(ctx.pendingPostToolContext).toContain('HERON');

    ctx.pendingPostToolContext = undefined;
    await queueDirectoryInstructions({ capabilities: ['fs.read'] }, { path: 'packages/foo' }, ctx);
    expect(ctx.pendingPostToolContext).toBeUndefined();

    // Compaction clears file tracking; the instructions may have been
    // summarized away, so the next touch delivers them again.
    ctx.clearFileTracking();
    await queueDirectoryInstructions({ capabilities: ['fs.write'] }, { path: 'packages/foo' }, ctx);
    expect(ctx.pendingPostToolContext).toContain('HERON');
  });
});

describe('ToolExecutor', () => {
  it('queues directory instructions after a successful file-tool call', async () => {
    const readTool: Tool = {
      name: 'read',
      description: 'read',
      permission: 'auto',
      mutating: false,
      capabilities: ['fs.read'],
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute() {
        return 'export {};';
      },
    };
    const executor = new ToolExecutor(
      {
        get: (n: string) => (n === 'read' ? readTool : undefined),
        list: () => [readTool],
      } as never,
      {
        permissionPolicy: {
          evaluate: async (): Promise<PermissionDecision> => ({
            permission: 'auto',
            source: 'default',
          }),
        } as never,
        confirmAwaiter: vi.fn(async () => 'yes' as const),
        secretScrubber: { scrub: (s: string) => s } as never,
        perIterationOutputCapBytes: 100_000,
      },
    );
    const ctx = makeCtx();
    await executor.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'r1',
          name: 'read',
          input: { path: 'packages/foo/src/index.ts' },
        },
      ],
      ctx,
      'sequential',
    );
    expect(ctx.pendingPostToolContext).toContain('EGRET');
    expect(ctx.pendingPostToolContext).toContain('HERON');

    // The confirm-approved path (executeTool) queues them too.
    const approved = makeCtx();
    await executor.executeTool(
      readTool,
      { type: 'tool_use', id: 'r2', name: 'read', input: { path: 'packages/foo' } },
      approved,
      100_000,
    );
    expect(approved.pendingPostToolContext).toContain('HERON');
  });
});
