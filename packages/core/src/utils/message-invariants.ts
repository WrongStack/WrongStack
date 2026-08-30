import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import { expectDefined } from './expect-defined.js';
export interface MessageRepairReport {
  changed: boolean;
  removedToolUses: string[];
  removedToolResults: string[];
  removedMessages: number;
}

export interface MessageRepairResult {
  messages: Message[];
  report: MessageRepairReport;
}

export interface MessageRepairOptions {
  preserveTrailingToolUse?: boolean | undefined;
}

/**
 * Repair provider-level tool-call adjacency invariants.
 *
 * Anthropic requires every assistant `tool_use` block to have a matching
 * `tool_result` block in the immediately following user message. Manual
 * context surgery (summary/prune) can cut through the middle of such an
 * exchange. This function removes only the now-orphaned protocol blocks,
 * preserving surrounding text/images/thinking blocks where possible.
 */
export function repairToolUseAdjacency(
  messages: Message[],
  opts: MessageRepairOptions = {},
): MessageRepairResult {
  const removedToolUses: string[] = [];
  const removedToolResults: string[] = [];
  let removedMessages = 0;
  let changed = false;
  const out: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const original = expectDefined(messages[i]);
    let msg = original;

    if (hasToolUse(msg)) {
      const nextIds = toolResultIds(messages[i + 1]);
      const filtered = mapContent(msg, (blocks) => {
        const next: ContentBlock[] = [];
        for (const block of blocks) {
          const preserveTrailing =
            opts.preserveTrailingToolUse === true &&
            i === messages.length - 1 &&
            block.type === 'tool_use';
          if (block.type === 'tool_use' && !nextIds.has(block.id) && !preserveTrailing) {
            removedToolUses.push(block.id);
            changed = true;
            continue;
          }
          next.push(block);
        }
        return next;
      });
      msg = filtered ?? msg;
    }

    if (hasToolResult(msg)) {
      const allowed = toolUseIds(out[out.length - 1]);
      const filtered = mapContent(msg, (blocks) => {
        const next: ContentBlock[] = [];
        for (const block of blocks) {
          if (block.type === 'tool_result' && !allowed.has(block.tool_use_id)) {
            removedToolResults.push(block.tool_use_id);
            changed = true;
            continue;
          }
          next.push(block);
        }
        return next;
      });
      msg = filtered ?? msg;
    }

    if (isEmptyMessage(msg)) {
      removedMessages++;
      changed = true;
      continue;
    }
    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    report: { changed, removedToolUses, removedToolResults, removedMessages },
  };
}

function hasToolUse(msg: Message | undefined): boolean {
  return contentBlocks(msg).some((b): b is ToolUseBlock => b.type === 'tool_use');
}

function hasToolResult(msg: Message | undefined): boolean {
  return contentBlocks(msg).some((b): b is ToolResultBlock => b.type === 'tool_result');
}

function toolUseIds(msg: Message | undefined): Set<string> {
  const ids = new Set<string>();
  if (msg?.role !== 'assistant') return ids;
  for (const block of contentBlocks(msg)) {
    if (block.type === 'tool_use') ids.add(block.id);
  }
  return ids;
}

function toolResultIds(msg: Message | undefined): Set<string> {
  const ids = new Set<string>();
  if (msg?.role !== 'user') return ids;
  for (const block of contentBlocks(msg)) {
    if (block.type === 'tool_result') ids.add(block.tool_use_id);
  }
  return ids;
}

function contentBlocks(msg: Message | undefined): ContentBlock[] {
  return msg && Array.isArray(msg.content) ? msg.content : [];
}

function mapContent(msg: Message, fn: (blocks: ContentBlock[]) => ContentBlock[]): Message | null {
  if (!Array.isArray(msg.content)) return msg;
  const next = fn(msg.content);
  if (next.length === msg.content.length && next.every((b, idx) => b === msg.content[idx])) {
    return msg;
  }
  return { ...msg, content: next };
}

/**
 * True when a message content payload carries meaningful information for
 * the provider: non-whitespace text, a tool call/result, thinking with
 * text or a signature, or any other block type.
 *
 * False for empty strings/arrays and for arrays whose only blocks are
 * empty or whitespace-only text — the shape persisted when a stream is
 * interrupted before the first meaningful delta (issue #271). Strict
 * providers reject such assistant turns, so repair and replay paths must
 * treat them as empty.
 */
export function hasMeaningfulContent(content: Message['content']): boolean {
  if (!content) return false;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (block.text.trim().length > 0) return true;
      continue;
    }
    if (block.type === 'thinking') {
      // Signature-only thinking blocks are valid and required for replay;
      // blocks with neither text nor signature are provider-rejected noise.
      if (block.thinking.trim().length > 0 || block.signature) return true;
      continue;
    }
    // tool_use, tool_result, image, redacted_thinking, … — always meaningful.
    return true;
  }
  return false;
}

function isEmptyMessage(msg: Message): boolean {
  return !hasMeaningfulContent(msg.content);
}
