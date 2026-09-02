import { describe, expect, it } from 'vitest';
import {
  contextManagerTool,
  createContextManagerTool,
} from '../../src/infrastructure/context-manager.js';

const makeCtx = (messages: any[] = []) =>
  ({
    cwd: '/fake',
    projectRoot: '/fake',
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    hasRead: () => false,
    lastReadMtime: () => undefined,
    recordRead: () => {},
    clearFileTracking: () => {},
    todos: [],
    messages,
  }) as any;

describe('createContextManagerTool', () => {
  it('has correct metadata', () => {
    const tool = createContextManagerTool();
    expect(tool.name).toBe('context_manager');
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(false);
  });

  it('check action returns budget info', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'hello world' }]);
    const result = await tool.execute({ action: 'check' }, ctx);
    expect(result.action).toBe('check');
    expect(result.messageCount).toBe(1);
    expect(result.beforeTokens).toBeGreaterThan(0);
    expect(result.notes).toBeDefined();
  });

  it('repair action fixes orphan protocol blocks without a provider call', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: {} }],
      },
      { role: 'assistant', content: 'next' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'late' }] },
    ]);

    const result = await tool.execute({ action: 'repair' }, ctx);

    expect(result.action).toBe('repair');
    expect(result.repaired?.removedToolUses).toEqual(['u1']);
    expect(result.repaired?.removedToolResults).toEqual(['u1']);
    expect(ctx.messages).toEqual([{ role: 'assistant', content: 'next' }]);
  });

  it('prune removes messages in range', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    const result = await tool.execute({ action: 'prune', from: 0, to: 1 }, ctx);
    expect(result.action).toBe('prune');
    expect(result.removedCount).toBe(2);
    expect(result.messageCount).toBe(1);
    expect(ctx.messages).toHaveLength(1);
  });

  it('prune rejects invalid range', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'prune', from: 5, to: 10 }, ctx);
    expect(result.notes).toContain('Invalid range');
    expect(result.removedCount).toBeUndefined();
  });

  it('prune uses defaults when from/to omitted', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    const result = await tool.execute({ action: 'prune' }, ctx);
    expect(result.removedCount).toBe(2);
  });

  it('add_note injects a note at beginning by default', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'add_note', text: 'important!' }, ctx);
    expect(result.action).toBe('add_note');
    expect(result.summary).toBe('important!');
    expect(ctx.messages).toHaveLength(2);
    // afterIndex defaults to 0, so note is prepended at index 0
    expect(ctx.messages[0].content).toContain('important!');
  });

  it('add_note defaults text to (no summary)', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'add_note' }, ctx);
    expect(result.summary).toBe('(no summary)');
  });

  it('add_note respects afterIndex', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    const _result = await tool.execute(
      { action: 'add_note', text: 'inserted', afterIndex: 1 },
      ctx,
    );
    expect(ctx.messages[1].content).toContain('inserted');
  });

  it('summary replaces range with summary message', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ]);
    const result = await tool.execute({ action: 'summary', from: 0, to: 1, text: 'greeting' }, ctx);
    expect(result.action).toBe('summary');
    expect(result.summary).toBe('greeting');
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('greeting');
  });

  it('summary repairs tool_use/tool_result adjacency when range cuts an exchange', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u2', name: 'grep', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'late' }] },
      { role: 'user', content: 'continue' },
    ]);

    const result = await tool.execute({ action: 'summary', from: 1, to: 2, text: 'middle' }, ctx);

    expect(result.repaired?.removedToolUses).toEqual(['u1']);
    expect(result.repaired?.removedToolResults).toEqual(['u2']);
    expect(JSON.stringify(ctx.messages)).not.toContain('"tool_use"');
    expect(JSON.stringify(ctx.messages)).not.toContain('"tool_result"');
    expect(ctx.messages.at(-1)?.content).toBe('continue');
  });

  it('summary rejects invalid range', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'summary', from: -1, to: 5 }, ctx);
    expect(result.notes).toContain('Invalid range');
  });

  it('summary uses placeholder when text not provided', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'summary', from: 0, to: 0 }, ctx);
    expect(result.summary).toContain('placeholder');
  });

  it('compact returns error when no compactor registered', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([]);
    const result = await tool.execute({ action: 'compact' }, ctx);
    expect(result.notes).toContain('No compactor registered');
    expect(result.afterTokens).toBeUndefined();
  });

  it('compact uses registered compactor', async () => {
    const tool = createContextManagerTool({
      compactor: {
        compact: async (_ctx: any) => ({
          before: 100,
          after: 100,
          fullRequestTokensBefore: 100,
          fullRequestTokensAfter: 100,
          reductions: [],
        }),
      },
      // Bypass the min-token threshold check so the compactor actually runs.
      // Without this, runtimeThreshold = floor(128_000 × 0.4) = 51_200 while
      // currentTokens (~250 for 'a'.repeat(1000)) skips compaction.
      minCompactThreshold: 1,
    });
    const ctx = makeCtx([{ role: 'user', content: 'a'.repeat(1000) }]);
    const result = await tool.execute({ action: 'compact' }, ctx);
    expect(result.action).toBe('compact');
    expect(result.afterTokens).toBe(100);
  });

  it('compact repairs orphan protocol blocks produced by a compactor', async () => {
    const tool = createContextManagerTool({
      compactor: {
        compact: async (ctx: any) => {
          ctx.messages.splice(0, ctx.messages.length, {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'cut', name: 'read', input: {} }],
          });
          return {
            before: 1000,
            after: 100,
            fullRequestTokensBefore: 1000,
            fullRequestTokensAfter: 100,
            reductions: [{ phase: 'summary', saved: 900 }],
          };
        },
      },
      // Bypass the min-token threshold check so the compactor actually runs.
      // Without this, effectiveThreshold = maxContext * 0.5 = 64,000 and
      // currentTokens (~5) skips compaction before the compactor modifies messages.
      minCompactThreshold: 1,
    });
    const ctx = makeCtx([{ role: 'user', content: 'before' }]);

    const result = await tool.execute({ action: 'compact' }, ctx);

    expect(result.action).toBe('compact');
    expect(result.repaired?.removedToolUses).toEqual(['cut']);
    expect(result.repaired?.removedMessages).toBe(1);
    expect(ctx.messages).toEqual([]);
  });

  it('returns unknown action for unrecognized actions', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([]);
    const result = await tool.execute({ action: 'unknown' as any }, ctx);
    expect(result.notes).toContain('Unknown action');
  });

  it('exports default instance without compactor', () => {
    expect(contextManagerTool.name).toBe('context_manager');
  });
});
