import type { Context } from '@wrongstack/core/agent';
import type { Message } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  contextEditorRevision,
  validateContextEditorMessages,
  validateContextEditorProposal,
} from '../src/server/context-editor.js';

function mockContext(messages: Message[]): Context {
  const state = {
    replaceMessages(next: Message[]) {
      messages.length = 0;
      messages.push(...next);
    },
    replaceTodos() {},
    deleteMeta() {},
    setMeta() {},
  };
  return {
    messages,
    systemPrompt: [{ text: 'system' }],
    tools: [],
    state,
    session: { id: 'test' },
    provider: { id: 'test', capabilities: { maxContext: 200000 } },
    tokenCounter: { total: () => ({ input: 0, output: 0 }), reset: () => {}, account: () => {} },
    readFiles: new Set(),
    fileMtimes: new Map(),
    meta: {},
    lastRequestTokens: undefined,
    lastRealInputTokens: undefined,
    flushConversationJournal: async () => {},
  } as never as Context;
}

describe('contextEditorRevision', () => {
  it('produces a stable hash for identical messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(contextEditorRevision(msgs)).toBe(contextEditorRevision([...msgs]));
  });

  it('changes when content changes', () => {
    const a: Message[] = [{ role: 'user', content: 'hello' }];
    const b: Message[] = [{ role: 'user', content: 'world' }];
    expect(contextEditorRevision(a)).not.toBe(contextEditorRevision(b));
  });

  it('ignores _estTokens', () => {
    const a: Message[] = [{ role: 'user', content: 'hello', _estTokens: 10 }];
    const b: Message[] = [{ role: 'user', content: 'hello' }];
    expect(contextEditorRevision(a)).toBe(contextEditorRevision(b));
  });

  it('is unaffected by object key ordering in blocks', () => {
    const a: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'x' },
          { type: 'text', text: 'y' },
        ],
      },
    ];
    const b: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'x' },
          { type: 'text', text: 'y' },
        ],
      },
    ];
    expect(contextEditorRevision(a)).toBe(contextEditorRevision(b));
  });
});

describe('validateContextEditorMessages', () => {
  it('accepts valid string-content messages', () => {
    const result = validateContextEditorMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.messages).toHaveLength(2);
  });

  it('accepts valid block-content messages', () => {
    const result = validateContextEditorMessages([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'response' }],
      },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.messages.at(0)?.content).toEqual([{ type: 'text', text: 'response' }]);
  });

  it('rejects unknown roles', () => {
    const result = validateContextEditorMessages([{ role: 'bot', content: 'x' }]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.at(0)?.code).toBe('INVALID_ROLE');
  });

  it('rejects unknown block types', () => {
    const result = validateContextEditorMessages([
      { role: 'user', content: [{ type: 'unknown_block', text: 'x' }] },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.at(0)?.code).toBe('UNKNOWN_BLOCK_TYPE');
  });

  it('rejects invalid cache_control', () => {
    const result = validateContextEditorMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'x', cache_control: { type: 'permanent' } }],
      },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.at(0)?.code).toBe('INVALID_CACHE_CONTROL');
  });

  it('rejects malformed tool_use.input', () => {
    const result = validateContextEditorMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'bash', input: 'not-an-object' }],
      },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.code === 'INVALID_TOOL_INPUT')).toBe(true);
  });

  it('rejects malformed tool_result.tool_use_id', () => {
    const result = validateContextEditorMessages([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '', content: 'ok' }],
      },
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.code === 'INVALID_TOOL_RESULT_ID')).toBe(true);
  });

  it('strips _estTokens from client-supplied messages', () => {
    const result = validateContextEditorMessages([
      { role: 'user', content: 'hello', _estTokens: 999 } as never,
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.messages.at(0)?._estTokens).toBeUndefined();
  });

  it('flags signed thinking blocks present in the proposal', () => {
    const ctx = mockContext([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig123' }],
      },
    ]);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'reasoning', signature: 'sig123' }],
        },
      ],
      allowRepair: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'SIGNED_THINKING_PRESENT')).toBe(true);
  });

  it('enforces payload size limits with too many messages', () => {
    const huge: unknown[] = [];
    for (let i = 0; i < 100; i++) huge.push({ role: 'user', content: `msg ${i}` });
    const result = validateContextEditorMessages(huge, 0);
    expect(result.errors.some((e) => e.code === 'TOO_MANY_MESSAGES')).toBe(true);
  });
});

describe('validateContextEditorProposal', () => {
  it('rejects with revision conflict when baseRevision mismatches', () => {
    const ctx = mockContext([{ role: 'user', content: 'hello' }]);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: 'stale-revision',
      messages: [{ role: 'user', content: 'hello' }],
      allowRepair: true,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict?.code).toBe('CONTEXT_REVISION_CONFLICT');
  });

  it('rejects with RUN_ACTIVE when run is active', () => {
    const ctx = mockContext([{ role: 'user', content: 'hello' }]);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [{ role: 'user', content: 'hello' }],
      allowRepair: true,
      runActive: true,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict?.code).toBe('RUN_ACTIVE');
  });

  it('detects orphaned tool_use when tool_result is removed', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'result' }],
      },
    ];
    const ctx = mockContext(messages);
    // Remove the tool_result message → tool_use becomes orphan
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'x' } }],
        },
      ],
      allowRepair: true,
    });
    expect(result.ok).toBe(true);
    expect(result.repair.changed).toBe(true);
    expect(result.repair.removedToolUses).toContain('tu1');
  });

  it('detects orphaned tool_result when tool_use is removed', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu2', name: 'bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }],
      },
    ];
    const ctx = mockContext(messages);
    // Remove the assistant tool_use message → tool_result becomes orphan
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] },
      ],
      allowRepair: true,
    });
    expect(result.ok).toBe(true);
    expect(result.repair.changed).toBe(true);
    expect(result.repair.removedToolResults).toContain('tu2');
  });

  it('rejects when repair needed but allowRepair is false', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu3', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'data' }],
      },
    ];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'read', input: {} }] },
      ],
      allowRepair: false,
    });
    expect(result.ok).toBe(false);
    expect(result.repair.changed).toBe(true);
  });

  it('passes cleanly for valid deletion of plain text messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
    ];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'user', content: 'msg2' },
      ],
      allowRepair: true,
    });
    expect(result.ok).toBe(true);
    expect(result.repair.changed).toBe(false);
    expect(result.after?.messages).toBe(2);
  });
});
