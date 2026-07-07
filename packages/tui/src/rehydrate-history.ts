import type { ContentBlock, Message } from '@wrongstack/core';
import type { HistoryEntry } from './components/history/types.js';

export function contentBlocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

/**
 * Convert restored session messages into TUI history entries so a resumed
 * session renders its prior conversation visually, not just in the LLM context.
 *
 * Order MUST match what the user saw before the crash — assistant text and
 * tool executions are interleaved chronologically. The data path makes this
 * straightforward:
 *
 *  - `messages` carries user_input / llm_response / tool_result events in
 *    JSONL order (see DefaultSessionStore.load).
 *  - For assistant messages whose `content` is an array, tool_use blocks
 *    appear in JSONL order. Each has a stable `id`.
 *  - `toolCalls` is the JSONL-ordered list of `tool_call_end` events, each
 *    carrying the same `id` as the tool_use block it resolves.
 *
 * Algorithm:
 *  - System messages are skipped (not displayed).
 *  - User messages → `kind: 'user'`.
 *  - Assistant messages → `kind: 'assistant'` (text only; tool_use blocks
 *    are dropped from the body since the tool entry renders the execution).
 *  - After each assistant message, emit a `kind: 'tool'` entry for each
 *    tool_use id that appears in that assistant's content, looking up the
 *    matching tool_call_end by id. If the assistant has multiple tool_use
 *    blocks, the tool entries appear in the same order as those blocks.
 *  - Unmatched tool_call_ends (legacy / id drift) are appended at the end
 *    in their original JSONL order so they aren't silently dropped.
 */
export function rehydrateHistory(
  messages: Message[],
  startId: number,
  toolCalls?:
    | Array<{
        name: string;
        id: string;
        durationMs: number;
        ok: boolean;
        outputBytes?: number | undefined;
        outputTokens?: number | undefined;
        outputLines?: number | undefined;
      }>
    | undefined,
): HistoryEntry[] {
  type ToolEntry = HistoryEntry;
  const entries: ToolEntry[] = [];
  // Build a one-shot id → tool_call_end index. tool_call_end events are
  // already in JSONL order (DefaultSessionStore.extractToolCallEnds walks
  // events in file order); when two tool_use blocks share an id (shouldn't
  // happen, but defensive) we keep the first end so the timeline stays sane.
  const toolCallsById = new Map<string, NonNullable<typeof toolCalls>[number]>();
  if (toolCalls) {
    for (const tc of toolCalls) {
      if (!toolCallsById.has(tc.id)) toolCallsById.set(tc.id, tc);
    }
  }
  const consumed = new Set<string>();
  const fallback: ToolEntry[] = [];

  let nextId = startId;
  const textOf = (msg: Message): string => contentBlocksText(msg.content);
  const toolEntryFor = (tc: NonNullable<typeof toolCalls>[number]): ToolEntry => ({
    id: nextId++,
    kind: 'tool',
    name: tc.name,
    durationMs: tc.durationMs,
    ok: tc.ok,
    outputBytes: tc.outputBytes,
    outputTokens: tc.outputTokens,
    outputLines: tc.outputLines,
  });
  const pushAssistantText = (parts: string[]) => {
    const text = parts.join('').trim();
    if (text) entries.push({ id: nextId++, kind: 'assistant', text });
    parts.length = 0;
  };

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      const text = textOf(msg).trim();
      // Tool-result-only user turns carry no text — skip them (the tool
      // entries were already emitted alongside the assistant that called them).
      if (text) entries.push({ id: nextId++, kind: 'user', text });
      continue;
    }
    if (msg.role === 'assistant') {
      // Replay assistant content block-by-block. Concatenating all text blocks
      // first would move prose that originally appeared after a tool ahead of
      // that tool on resume, which is the same class of bug as sorting messages
      // by role instead of by timeline.
      if (!Array.isArray(msg.content)) {
        const text = textOf(msg).trim();
        if (text) entries.push({ id: nextId++, kind: 'assistant', text });
        continue;
      }

      const textParts: string[] = [];
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === 'text') {
          textParts.push(block.text);
          continue;
        }
        if (block.type !== 'tool_use') continue;
        pushAssistantText(textParts);
        const tc = toolCallsById.get(block.id);
        if (!tc) continue;
        entries.push(toolEntryFor(tc));
        consumed.add(block.id);
      }
      pushAssistantText(textParts);
    }
  }

  // Fallback: any tool_call_end we couldn't match to a tool_use block in
  // an assistant message. Emit them in their original JSONL order so the
  // user still sees the audit trail, but only at the end of the timeline.
  if (toolCalls) {
    for (const tc of toolCalls) {
      if (!consumed.has(tc.id)) fallback.push(toolEntryFor(tc));
    }
  }
  entries.push(...fallback);
  return entries;
}
