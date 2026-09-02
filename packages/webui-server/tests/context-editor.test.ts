import type { Context } from '@wrongstack/core/agent';
import { type Message, ToolErrorCategory } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  applyContextEditorProposal,
  buildContextEditorSnapshot,
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

  it('accepts an allowed, valid base64 image source', () => {
    const result = validateContextEditorMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
          },
        ],
      },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.messages).toHaveLength(1);
  });

  it('rejects invalid and oversized base64 image data', () => {
    const invalid = validateContextEditorMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'not base64!' },
          },
        ],
      },
    ]);
    expect(invalid.errors).toEqual([expect.objectContaining({ code: 'INVALID_IMAGE_DATA' })]);

    const oversizedData = 'A'.repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3) * 4);
    const oversized = validateContextEditorMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: oversizedData },
          },
        ],
      },
    ]);
    expect(oversized.errors).toEqual([expect.objectContaining({ code: 'IMAGE_TOO_LARGE' })]);
  });

  it('rejects unsupported image media types', () => {
    const result = validateContextEditorMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/svg+xml', data: 'aGVsbG8=' },
          },
        ],
      },
    ]);

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'UNSUPPORTED_IMAGE_MEDIA_TYPE' }),
    ]);
  });

  it.each([
    'https://example.com/image.png',
    'https://localhost/image.png',
    'https://127.0.0.1/image.png',
    'https://169.254.169.254/latest/meta-data',
    'http://example.com/image.png',
    'https://user:password@example.com/image.png',
  ])('rejects URL image source %s without throwing', (url) => {
    expect(() =>
      validateContextEditorMessages([
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url } }],
        },
      ]),
    ).not.toThrow();

    const result = validateContextEditorMessages([
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url } }],
      },
    ]);
    expect(result.errors).toEqual([expect.objectContaining({ code: 'UNSAFE_IMAGE_URL' })]);
  });

  it('warns in the snapshot when an existing URL image blocks retaining that message', () => {
    const ctx = mockContext([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/existing.png' },
          },
        ],
      },
    ]);

    const snapshot = buildContextEditorSnapshot(ctx, undefined);

    expect(snapshot.messageBreakdown[0]?.warnings).toContainEqual({
      path: '/messages/0/content/0/source/url',
      code: 'UNSAFE_IMAGE_URL',
      severity: 'danger',
      message:
        'URL image sources cannot be retained in context editor proposals; remove the whole message before applying other edits.',
    });
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
      removals: [],
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
  it('preserves retained tool error metadata through validation and apply', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-error', name: 'read', input: { path: 'x' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-error',
            content: 'Permission denied: blocked',
            is_error: true,
            _toolErrorInfo: {
              category: ToolErrorCategory.PERMISSION,
              retryable: false,
              userMessage: 'blocked',
            },
          },
        ],
      },
      { role: 'system', content: 'remove this' },
    ];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: messages.slice(0, 2),
      removals: [{ messageIndex: 2 }],
      allowRepair: true,
    });

    expect(result.ok).toBe(true);
    expect(result.validationErrors).toHaveLength(0);
    expect(result.messages?.[1]?.content).toEqual(messages[1]?.content);

    const applied = await applyContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: messages.slice(0, 2),
      removals: [{ messageIndex: 2 }],
      allowRepair: true,
    });
    expect('revision' in applied).toBe(true);
    expect(ctx.messages[1]?.content).toEqual(messages[1]?.content);
  });

  it('rejects removal plans above the bounded entry limit', () => {
    const messages: Message[] = [{ role: 'assistant', content: 'keep' }];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages,
      removals: Array.from({ length: 4097 }, () => ({ messageIndex: 0 })),
      allowRepair: true,
    });

    expect(result.ok).toBe(false);
    expect(result.validationErrors).toContainEqual({
      path: '/removals',
      code: 'TOO_MANY_REMOVALS',
      message: 'removals must contain at most 4096 entries.',
    });
  });

  it('rejects with revision conflict when baseRevision mismatches', () => {
    const ctx = mockContext([{ role: 'user', content: 'hello' }]);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: 'stale-revision',
      messages: [{ role: 'user', content: 'hello' }],
      removals: [],
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
      removals: [],
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
      removals: [{ messageIndex: 1 }],
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
      removals: [{ messageIndex: 0 }],
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
      removals: [{ messageIndex: 1 }],
      allowRepair: false,
    });
    expect(result.ok).toBe(false);
    expect(result.repair.changed).toBe(true);
  });

  it('pairs every assistant in a tool-mediated turn through the terminal response', () => {
    const messages: Message[] = [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu4', name: 'read', input: { path: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu4', content: 'contents' }],
      },
      { role: 'assistant', content: 'final response from contents' },
      { role: 'user', content: 'keep this turn' },
      { role: 'assistant', content: 'kept response' },
    ];
    const ctx = mockContext(messages);
    const snapshot = buildContextEditorSnapshot(ctx, undefined);
    expect(snapshot.messageBreakdown[0]?.pairedAssistantIndices).toEqual([1, 3]);

    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: messages.slice(2),
      removals: [{ messageIndex: 0 }, { messageIndex: 1 }],
      allowRepair: true,
    });
    expect(result.ok).toBe(false);
    expect(result.validationErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_ASSISTANT_PAIR',
          message: 'Editing user message 0 must also remove assistant message 3.',
        }),
      ]),
    );
  });

  it('requires the paired assistant when a user range is removed', () => {
    const messages: Message[] = [
      { role: 'user', content: 'remove secret' },
      { role: 'assistant', content: 'reply' },
    ];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [
        { role: 'user', content: 'remove ' },
        { role: 'assistant', content: 'reply' },
      ],
      removals: [{ messageIndex: 0, start: 7, end: 13 }],
      allowRepair: true,
    });
    expect(result.ok).toBe(false);
    expect(result.validationErrors.some((item) => item.code === 'MISSING_ASSISTANT_PAIR')).toBe(
      true,
    );
  });

  it('validates a user range and its automatically removed assistant as one pair', () => {
    const messages: Message[] = [
      { role: 'user', content: 'remove secret' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'keep' },
    ];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [
        { role: 'user', content: 'remove ' },
        { role: 'user', content: 'keep' },
      ],
      removals: [{ messageIndex: 0, start: 7, end: 13 }, { messageIndex: 1 }],
      allowRepair: true,
    });
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([
      { role: 'user', content: 'remove ' },
      { role: 'user', content: 'keep' },
    ]);
  });

  it('applies multiple non-overlapping ranges on one text target in one proposal', () => {
    const messages: Message[] = [{ role: 'assistant', content: '0123456789' }];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [{ role: 'assistant', content: '034789' }],
      removals: [
        { messageIndex: 0, start: 1, end: 3 },
        { messageIndex: 0, start: 5, end: 7 },
      ],
      allowRepair: true,
    });

    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([{ role: 'assistant', content: '034789' }]);
  });

  it('rejects removal ranges that split a Unicode surrogate pair', () => {
    const messages: Message[] = [{ role: 'assistant', content: 'A😀B' }];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [{ role: 'assistant', content: 'A\ude00B' }],
      removals: [{ messageIndex: 0, start: 1, end: 2 }],
      allowRepair: true,
    });

    expect(result.ok).toBe(false);
    expect(result.validationErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INVALID_UNICODE_RANGE' })]),
    );
  });

  it('rejects a proposal that does not match its declared character range', () => {
    const messages: Message[] = [{ role: 'assistant', content: 'abcdef' }];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [{ role: 'assistant', content: 'wrong' }],
      removals: [{ messageIndex: 0, start: 1, end: 3 }],
      allowRepair: true,
    });
    expect(result.ok).toBe(false);
    expect(result.validationErrors.some((item) => item.code === 'REMOVAL_PLAN_MISMATCH')).toBe(
      true,
    );
  });

  it('rejects overlapping character ranges on the same target', () => {
    const messages: Message[] = [{ role: 'assistant', content: 'abcdefgh' }];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [{ role: 'assistant', content: 'afgh' }],
      removals: [
        { messageIndex: 0, start: 1, end: 4 },
        { messageIndex: 0, start: 3, end: 5 },
      ],
      allowRepair: true,
    });

    expect(result.ok).toBe(false);
    expect(result.validationErrors.some((item) => item.code === 'OVERLAPPING_RANGES')).toBe(true);
  });

  it('rejects a changed proposal when the removal plan is missing', () => {
    const messages: Message[] = [{ role: 'assistant', content: 'before' }];
    const ctx = mockContext(messages);
    const result = validateContextEditorProposal({
      ctx,
      baseRevision: contextEditorRevision(ctx.messages),
      messages: [{ role: 'assistant', content: 'after' }],
      removals: undefined,
      allowRepair: true,
    });

    expect(result.ok).toBe(false);
    expect(result.validationErrors).toContainEqual({
      path: '/removals',
      code: 'REMOVAL_PLAN_REQUIRED',
      message: 'A removal plan is required for every context editor proposal.',
    });
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
      removals: [{ messageIndex: 1 }],
      allowRepair: true,
    });
    expect(result.ok).toBe(true);
    expect(result.repair.changed).toBe(false);
    expect(result.after?.messages).toBe(2);
  });
});
