import type { Message } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { rehydrateHistory } from '../src/rehydrate-history.js';
import type { HistoryEntry } from '../src/components/history/types.js';

/**
 * Session recovery MUST render assistant messages and tool executions in
 * the same chronological order they appeared in chat history. This file
 * pins down `rehydrateHistory`'s interleaving behavior — the regression
 * case is "tool_call_end records appended after every assistant message",
 * which broke the timeline contract.
 */

type ToolCall = NonNullable<Parameters<typeof rehydrateHistory>[2]>[number];

function userMsg(text: string): Message {
  return { role: 'user', content: text, ts: '2026-06-26T10:00:00.000Z' };
}

function assistantText(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ts: '2026-06-26T10:00:01.000Z',
  };
}

function assistantWithToolUses(
  text: string,
  toolUseIds: string[],
): Message {
  const blocks = [
    { type: 'text' as const, text },
    ...toolUseIds.map((id) => ({
      type: 'tool_use' as const,
      id,
      name: 'bash',
      input: { cmd: `echo ${id}` },
    })),
  ];
  return {
    role: 'assistant',
    content: blocks,
    ts: '2026-06-26T10:00:02.000Z',
  };
}

/** A tool-calling assistant turn with NO prose — the common real case. */
function assistantToolOnly(toolUseIds: string[]): Message {
  return {
    role: 'assistant',
    content: toolUseIds.map((id) => ({
      type: 'tool_use' as const,
      id,
      name: 'bash',
      input: { cmd: `echo ${id}` },
    })),
    ts: '2026-06-26T10:00:02.000Z',
  };
}

function toolCall(id: string, name = 'bash'): ToolCall {
  return { id, name, durationMs: 12, ok: true, outputBytes: 64, outputLines: 1 };
}

function kinds(entries: HistoryEntry[]): string[] {
  return entries.map((e) => e.kind);
}

describe('rehydrateHistory — timeline interleaving', () => {
  it('interleaves assistant and tool entries in JSONL order', () => {
    const messages: Message[] = [
      userMsg('run something'),
      assistantWithToolUses('on it', ['tu_1', 'tu_2']),
      assistantText('done'),
    ];
    const toolCalls: ToolCall[] = [toolCall('tu_1'), toolCall('tu_2')];

    const entries = rehydrateHistory(messages, 1, toolCalls);

    expect(kinds(entries)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    // IDs are monotonically increasing starting from `startId`.
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('preserves tool_use order within a single assistant turn', () => {
    const messages: Message[] = [
      userMsg('go'),
      assistantWithToolUses('three tools', ['tu_a', 'tu_b', 'tu_c']),
    ];
    // toolCalls are passed in the order they were appended in JSONL.
    const toolCalls: ToolCall[] = [
      toolCall('tu_a'),
      toolCall('tu_b'),
      toolCall('tu_c'),
    ];

    const entries = rehydrateHistory(messages, 10, toolCalls);

    const toolEntries = entries.filter((e) => e.kind === 'tool');
    // Names reflect the original tool_use id order, not toolCalls order.
    // (Same here because both align, but the point is the order is taken
    // from the assistant content blocks.)
    expect(toolEntries).toHaveLength(3);
    expect(toolEntries.map((e) => e.id)).toEqual([12, 13, 14]);
  });

  it('handles multiple assistant turns each with its own tool_use', () => {
    const messages: Message[] = [
      userMsg('start'),
      assistantWithToolUses('step 1', ['tu_1']),
      assistantText('mid'),
      assistantWithToolUses('step 2', ['tu_2']),
    ];
    const toolCalls: ToolCall[] = [toolCall('tu_1'), toolCall('tu_2')];

    const entries = rehydrateHistory(messages, 1, toolCalls);

    expect(kinds(entries)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'assistant',
      'tool',
    ]);
  });

  it('falls back to end-of-timeline ordering when a tool_call_end has no matching tool_use', () => {
    // Legacy: a tool_call_end emitted but the assistant's tool_use block was
    // lost (corrupt JSONL, older writer, etc.). The user must still see the
    // audit entry — appended at the end so it can't accidentally claim to
    // belong to an unrelated assistant turn.
    const messages: Message[] = [
      userMsg('hi'),
      assistantWithToolUses('done', ['tu_1']),
    ];
    const toolCalls: ToolCall[] = [toolCall('tu_1'), toolCall('orphan')];

    const entries = rehydrateHistory(messages, 1, toolCalls);

    expect(kinds(entries)).toEqual(['user', 'assistant', 'tool', 'tool']);
    const lastTool = entries[entries.length - 1];
    expect(lastTool?.kind).toBe('tool');
    if (lastTool?.kind === 'tool') {
      // Orphan preserved — but as the last entry, not interleaved.
      expect(lastTool.name).toBe('bash');
    }
  });

  it('renders the tool entry next to its assistant even when the tool_result user message is textless', () => {
    // The normal session stream: assistant emits text + tool_use, then the
    // user turn that follows carries only the matching tool_result block.
    // Since that user message has no plain-text body, `rehydrateHistory`
    // skips it — the tool entry from tool_call_end is the visual stand-in
    // and MUST appear next to the assistant that triggered it.
    const messages: Message[] = [
      userMsg('check'),
      assistantWithToolUses('checking', ['tu_x']),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_x',
            content: 'ok',
            is_error: false,
          },
        ],
        ts: '2026-06-26T10:00:03.000Z',
      },
      assistantText('looks good'),
    ];
    const toolCalls: ToolCall[] = [toolCall('tu_x')];

    const entries = rehydrateHistory(messages, 1, toolCalls);

    // Order: user(text), assistant+tool_use, [skipped tool_result user msg],
    // assistant. The tool entry sits next to its triggering assistant.
    expect(kinds(entries)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('interleaves tool entries for a text-LESS tool-calling turn (regression)', () => {
    // The bug: an assistant turn with tool_use but no prose was skipped
    // wholesale by an `if (!text) continue` guard, so its tool_use blocks were
    // never matched and every tool fell into the end-of-timeline fallback —
    // rendering as "all assistant messages, then all tool calls" on resume.
    const messages: Message[] = [
      userMsg('do three things'),
      assistantText('starting'),
      assistantToolOnly(['tu_1']), // no prose — model just calls the tool
      assistantToolOnly(['tu_2', 'tu_3']),
      assistantText('all done'),
    ];
    const toolCalls: ToolCall[] = [
      toolCall('tu_1'),
      toolCall('tu_2'),
      toolCall('tu_3'),
    ];

    const entries = rehydrateHistory(messages, 1, toolCalls);

    // Tools sit next to the (text-less) turns that issued them — NOT dumped
    // at the end. No fallback entries.
    expect(kinds(entries)).toEqual([
      'user',
      'assistant', // "starting"
      'tool', // tu_1
      'tool', // tu_2
      'tool', // tu_3
      'assistant', // "all done"
    ]);
  });

  it('emits tool entries even when NO assistant turn has any prose', () => {
    // Pure tool-calling session (common with codex/reasoning models): every
    // assistant turn is text-less. All tools must still interleave in order,
    // none in the fallback bucket.
    const messages: Message[] = [
      userMsg('go'),
      assistantToolOnly(['tu_1']),
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false }],
        ts: '2026-06-26T10:00:03.000Z',
      },
      assistantToolOnly(['tu_2']),
    ];
    const toolCalls: ToolCall[] = [toolCall('tu_1'), toolCall('tu_2')];

    const entries = rehydrateHistory(messages, 1, toolCalls);

    expect(kinds(entries)).toEqual(['user', 'tool', 'tool']);
  });

  it('handles the empty case without crashing', () => {
    expect(rehydrateHistory([], 1, [])).toEqual([]);
    expect(rehydrateHistory([], 1)).toEqual([]);
  });

  it('keeps tool_calls untouched when messages is empty', () => {
    // Defensive — a corrupt session file might yield zero messages but
    // non-zero tool_call_end events. Don't drop them on the floor.
    const toolCalls: ToolCall[] = [toolCall('orphan_a'), toolCall('orphan_b')];

    const entries = rehydrateHistory([], 100, toolCalls);

    expect(kinds(entries)).toEqual(['tool', 'tool']);
    expect(entries[0]?.id).toBe(100);
    expect(entries[1]?.id).toBe(101);
  });

  it('matches identical tool_use ids to the first tool_call_end seen', () => {
    // Defensive: if two tool_call_ends share an id (shouldn't happen in
    // practice), the first wins so the timeline stays stable.
    const messages: Message[] = [
      userMsg('go'),
      assistantWithToolUses('try', ['dup']),
    ];
    const toolCalls: ToolCall[] = [
      { id: 'dup', name: 'first', durationMs: 1, ok: true },
      { id: 'dup', name: 'second', durationMs: 2, ok: true },
    ];

    const entries = rehydrateHistory(messages, 1, toolCalls);

    const toolEntries = entries.filter((e) => e.kind === 'tool');
    expect(toolEntries).toHaveLength(1);
    if (toolEntries[0]?.kind === 'tool') {
      expect(toolEntries[0].name).toBe('first');
    }
  });
});