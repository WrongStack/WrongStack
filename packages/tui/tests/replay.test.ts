import type { SessionEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { replaySessionEvents, replaySessionMessages } from '../src/components/history/replay.js';

describe('replaySessionEvents', () => {
  it('converts user_input events to user entries', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_input',
        ts: '2026-01-01T00:00:00Z',
        content: 'hello world',
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 1, kind: 'user', text: 'hello world' });
  });

  it('converts user_input with ContentBlock[] to text', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_input',
        ts: '2026-01-01T00:00:00Z',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_result', tool_use_id: '1', content: 'ignored' },
          { type: 'text', text: ' world' },
        ],
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'hello world' });
  });

  it('converts llm_response events to assistant entries', () => {
    const events: SessionEvent[] = [
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:00Z',
        content: [{ type: 'text', text: 'I am an assistant reply.' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 5 },
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 1,
      kind: 'assistant',
      text: 'I am an assistant reply.',
    });
  });

  it('pairs tool_use with tool_result into a single tool entry', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_use',
        ts: '2026-01-01T00:00:00Z',
        name: 'read',
        id: 'tu-1',
        input: { path: 'foo.ts' },
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:01Z',
        id: 'tu-1',
        content: 'file content here',
        isError: false,
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'tool',
      name: 'read',
      ok: true,
      input: { path: 'foo.ts' },
      output: 'file content here',
    });
  });

  it('marks tool errors when isError is true', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', ts: '2026-01-01T00:00:00Z', name: 'bash', id: 'tu-2', input: {} },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:01Z',
        id: 'tu-2',
        content: 'command failed',
        isError: true,
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries[0]).toMatchObject({ kind: 'tool', ok: false });
  });

  it('converts compaction events to info entries', () => {
    const events: SessionEvent[] = [
      {
        type: 'compaction',
        ts: '2026-01-01T00:00:00Z',
        before: 50000,
        after: 30000,
        level: 'soft',
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'info' });
    expect((entries[0] as { text: string }).text).toContain('compacted');
  });

  it('converts error events to error entries', () => {
    const events: SessionEvent[] = [
      { type: 'error', ts: '2026-01-01T00:00:00Z', message: 'something broke', phase: 'agent' },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'error' });
    expect((entries[0] as { text: string }).text).toContain('something broke');
  });

  it('does not render agent_spawned into resumed main history', () => {
    const events: SessionEvent[] = [
      {
        type: 'agent_spawned',
        ts: '2026-01-01T00:00:00Z',
        agentId: 'agent_123456789',
        role: 'bug-hunter',
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toEqual([]);
  });

  it('skips internal events (session_start, in_flight, etc.)', () => {
    const events: SessionEvent[] = [
      {
        type: 'session_start',
        ts: '2026-01-01T00:00:00Z',
        id: 's1',
        model: 'gpt4',
        provider: 'openai',
      },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', content: 'test' },
      { type: 'session_end', ts: '2026-01-01T00:00:02Z', usage: { input: 0, output: 0 } },
      { type: 'in_flight_start', ts: '2026-01-01T00:00:03Z', context: 'doing stuff' },
      { type: 'in_flight_end', ts: '2026-01-01T00:00:04Z', reason: 'clean' },
    ];
    const entries = replaySessionEvents(events, 1);
    // Only user_input should produce a visible entry
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', text: 'test' });
  });

  it('flushes orphaned tool_use events (no matching tool_result)', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', ts: '2026-01-01T00:00:00Z', name: 'read', id: 'orphaned', input: {} },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'read', ok: false });
  });

  it('does not duplicate a tool call recorded as tool_call_start → tool_call_end → tool_result', () => {
    // Standard audit level logs all three events for one call. The richer
    // tool_call_end renders the entry; the trailing tool_result must be
    // swallowed instead of rendering the same call again named by raw id.
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:00Z', content: 'read a file' },
      {
        type: 'tool_call_start',
        ts: '2026-01-01T00:00:01Z',
        name: 'read',
        id: 'tu-1',
        input: { path: 'a.ts' },
      },
      {
        type: 'tool_call_end',
        ts: '2026-01-01T00:00:02Z',
        name: 'read',
        id: 'tu-1',
        durationMs: 42,
        outputSize: 10,
        ok: true,
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:03Z',
        id: 'tu-1',
        content: 'contents',
        isError: false,
      },
    ];
    const entries = replaySessionEvents(events, 1);
    const tools = entries.filter((e) => e.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ kind: 'tool', name: 'read', durationMs: 42, ok: true });
  });

  it('preserves messages between tool lifecycle events and enriches the tool with its result', () => {
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:00Z', content: 'inspect a file' },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:01Z',
        content: [
          { type: 'text', text: 'I will read it.' },
          { type: 'tool_use', id: 'tu-order', name: 'read', input: { path: 'a.ts' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 1, output: 1 },
      },
      {
        type: 'tool_call_start',
        ts: '2026-01-01T00:00:02Z',
        name: 'read',
        id: 'tu-order',
        input: { path: 'a.ts' },
      },
      {
        type: 'tool_call_end',
        ts: '2026-01-01T00:00:03Z',
        name: 'read',
        id: 'tu-order',
        durationMs: 7,
        outputSize: 12,
        ok: true,
      },
      {
        type: 'user_input',
        ts: '2026-01-01T00:00:04Z',
        content: '[MAILBOX BTW] intervening message',
      },
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:05Z',
        id: 'tu-order',
        content: 'actual contents',
        isError: false,
      },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:06Z',
        content: [{ type: 'text', text: 'I received the result.' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
      },
    ];

    const entries = replaySessionEvents(events, 1);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
    expect(entries[2]).toMatchObject({
      kind: 'tool',
      name: 'read',
      durationMs: 7,
      output: 'actual contents',
    });
    expect(entries[3]).toMatchObject({ kind: 'user', text: '[MAILBOX BTW] intervening message' });
  });

  it('still renders tool_result alone at minimal audit level (no tool_call events)', () => {
    const events: SessionEvent[] = [
      {
        type: 'tool_result',
        ts: '2026-01-01T00:00:00Z',
        id: 'tu-9',
        content: 'ok',
        isError: false,
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', ok: true });
  });

  it('preserves event order for mixed event types', () => {
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:00Z', content: 'question 1' },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:01Z',
        content: [{ type: 'text', text: 'answer 1' }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
      },
      { type: 'error', ts: '2026-01-01T00:00:02Z', message: 'something failed', phase: 'agent' },
      { type: 'user_input', ts: '2026-01-01T00:00:03Z', content: 'question 2' },
      { type: 'compaction', ts: '2026-01-01T00:00:04Z', before: 10000, after: 5000 },
      {
        type: 'llm_response',
        ts: '2026-01-01T00:00:05Z',
        content: [{ type: 'text', text: 'answer 2' }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
      },
    ];
    const entries = replaySessionEvents(events, 1);
    expect(entries.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'error',
      'user',
      'info',
      'assistant',
    ]);
  });

  it('replays recovered messages losslessly and enriches tool entries from audit events', () => {
    const messages = [
      { role: 'user' as const, content: 'inspect a file' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'I will read it.' },
          { type: 'tool_use' as const, id: 'tu-message', name: 'read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '[MAILBOX BTW] exact intervening text' },
          { type: 'tool_result' as const, tool_use_id: 'tu-message', content: 'actual contents' },
        ],
      },
      { role: 'system' as const, content: '[note between messages]' },
      { role: 'assistant' as const, content: 'I received the result.' },
    ];
    const events: SessionEvent[] = [
      {
        type: 'tool_call_end',
        ts: '2026-01-01T00:00:03Z',
        name: 'read',
        id: 'tu-message',
        durationMs: 7,
        outputSize: 15,
        outputBytes: 15,
        outputTokens: 4,
        outputLines: 1,
        ok: true,
      },
    ];

    const entries = replaySessionMessages(messages, events, 10);
    // [MAILBOX BTW] runtime injection is filtered out so the visible history matches live interaction
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'info',
      'assistant',
    ]);
    expect(entries[2]).toMatchObject({
      kind: 'tool',
      name: 'read',
      durationMs: 7,
      ok: true,
      input: { path: 'a.ts' },
      output: 'actual contents',
      outputBytes: 15,
      outputTokens: 4,
      outputLines: 1,
    });
    expect(entries[3]).toMatchObject({ kind: 'info', text: '[note between messages]' });
    expect(entries[4]).toMatchObject({ kind: 'assistant', text: 'I received the result.' });
    expect(
      entries.some(
        (e) => 'text' in e && typeof e.text === 'string' && e.text.includes('[MAILBOX BTW]'),
      ),
    ).toBe(false);
    expect(entries.map((entry) => entry.id)).toEqual([10, 11, 12, 13, 14]);
  });

  it('assigns incrementing sequential ids', () => {
    const events: SessionEvent[] = [
      { type: 'user_input', ts: '2026-01-01T00:00:00Z', content: 'a' },
      { type: 'user_input', ts: '2026-01-01T00:00:01Z', content: 'b' },
      { type: 'user_input', ts: '2026-01-01T00:00:02Z', content: 'c' },
    ];
    const entries = replaySessionEvents(events, 10);
    expect(entries.map((e) => e.id)).toEqual([10, 11, 12]);
  });

  it('replaySessionMessages restores thinking blocks before assistant text', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking' as const, thinking: 'let me reason about this' },
          { type: 'text' as const, text: 'here is my answer' },
        ],
        ts: '2026-01-01T00:00:00Z',
      },
    ];
    const entries = replaySessionMessages(messages, [], 1);
    expect(entries.map((e) => e.kind)).toEqual(['thinking', 'assistant']);
    expect((entries[0] as { text: string }).text).toBe('let me reason about this');
    expect((entries[1] as { text: string }).text).toBe('here is my answer');
  });

  it('replaySessionMessages interleaves audit markers into the backbone by ts', () => {
    // Conversation backbone carries ts; marker events fall chronologically
    // between turns and must be inserted there without reordering the chat.
    const messages = [
      { role: 'user' as const, content: 'first', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant' as const, content: 'reply', ts: '2026-01-01T00:00:02Z' },
      { role: 'user' as const, content: 'second', ts: '2026-01-01T00:00:04Z' },
    ];
    const events: SessionEvent[] = [
      { type: 'mode_changed', ts: '2026-01-01T00:00:01Z', from: 'default', to: 'brief' },
      { type: 'compaction', ts: '2026-01-01T00:00:03Z', before: 10000, after: 5000 },
    ];
    const entries = replaySessionMessages(messages, events, 1);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'info', 'assistant', 'info', 'user']);
    expect((entries[1] as { text: string }).text).toContain('brief');
    expect((entries[3] as { text: string }).text).toContain('compacted');
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('replaySessionMessages does not reorder the conversation for a marker with equal ts', () => {
    // A marker sharing a message's ts must slot AFTER that message (backbone
    // wins ties), never ahead of it.
    const messages = [
      { role: 'user' as const, content: 'ask', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant' as const, content: 'answer', ts: '2026-01-01T00:00:01Z' },
    ];
    const events: SessionEvent[] = [
      { type: 'checkpoint', ts: '2026-01-01T00:00:00Z', promptIndex: 0, promptPreview: 'ask' },
    ];
    const entries = replaySessionMessages(messages, events, 1);
    expect(entries.map((e) => e.kind)).toEqual(['user', 'info', 'assistant']);
  });

  it('replaySessionMessages interleaves text and tool entries block-by-block (not all text first)', () => {
    // Regression: an assistant message carrying prose BEFORE a tool_use
    // followed by prose AFTER that tool_use must render three separate entries
    // in block order: assistant(pre) → tool → assistant(post).
    //
    // The old code concatenated ALL text blocks first and emitted them before
    // any tool entry, so the continuation prose appeared ahead of the tool on
    // resume — breaking the visual timeline.
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Let me check that file.' },
          { type: 'tool_use' as const, id: 'tu-1', name: 'read', input: { path: 'a.ts' } },
          { type: 'text' as const, text: 'Now I can see the issue is on line 5.' },
        ],
        ts: '2026-01-01T00:00:00Z',
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tu-1',
            content: 'actual contents',
            is_error: false,
          },
        ],
        ts: '2026-01-01T00:00:01Z',
      },
    ];

    const entries = replaySessionMessages(messages, [], 1);

    // Expected block order: assistant(pre) → tool → assistant(post)
    expect(entries.map((e) => e.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect((entries[0] as { text: string }).text).toBe('Let me check that file.');
    expect(entries[1]).toMatchObject({
      kind: 'tool',
      name: 'read',
      ok: true,
      output: 'actual contents',
    });
    expect((entries[2] as { text: string }).text).toBe('Now I can see the issue is on line 5.');
    // Both text segments are mid-turn (the message carries a tool_use),
    // so neither is `final`. `final` is per-message, not per-text-block.
    expect((entries[0] as { final: boolean }).final).toBe(false);
    expect((entries[2] as { final: boolean }).final).toBe(false);
  });
});
