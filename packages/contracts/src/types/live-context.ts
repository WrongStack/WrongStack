import type { ContentBlock } from './blocks.js';
import type { Message } from './messages.js';

/**
 * Header of the request-only live-context tail. On breakpoint wires it rides
 * the trailing user message after the cache boundary; on automatic-prefix
 * wires it opens each replayed snapshot message. Everything after it was
 * written by the host (plan, glossary, continuity, gates, memory evidence,
 * mail), not by the message's author.
 */
export const LIVE_CONTEXT_MARKER = '[live_context]';

/**
 * The blocks the message's author wrote. Two kinds of host text share a user
 * message with them and are cut off here:
 * - blocks the host folded in after the author's input (`authoredLength`):
 *   tool coach, loop steers, session notes;
 * - the request-only `[live_context]` tail.
 * A tool-result carrier without `authoredLength` has no author text at all —
 * any text beside its results was folded in by the host.
 */
export function authoredBlocks(
  message: Pick<Message, 'content' | 'authoredLength'>,
): ContentBlock[] {
  const content: ContentBlock[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  const authored =
    typeof message.authoredLength === 'number'
      ? content.slice(0, Math.max(0, message.authoredLength))
      : content.some((block) => block.type === 'tool_result')
        ? []
        : content;
  const marker = authored.findIndex(
    (block) => block.type === 'text' && block.text === LIVE_CONTEXT_MARKER,
  );
  return marker < 0 ? authored.slice() : authored.slice(0, marker);
}

/**
 * Text the message's author wrote, without host-written blocks. Request
 * middleware that classifies "what the user asked" (skill routing, mentions,
 * jargon mining) must read this, never the raw content: host notes name tools
 * and quote plans and earlier turns, and keying off them routes on text the
 * user never sent.
 */
export function authoredText(
  message: Pick<Message, 'content' | 'authoredLength'>,
  separator = '\n',
): string {
  return authoredBlocks(message)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(separator);
}
