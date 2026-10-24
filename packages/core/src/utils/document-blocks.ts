import { type ContentBlock, documentAsText } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';

/**
 * The messages a model receives: documents stay native where the model takes
 * PDF input, and become their extracted text everywhere else. Returns the
 * same array (and the same message objects) when nothing had to change, so
 * a conversation without documents costs one scan.
 */
export function adaptDocumentsForModel(messages: Message[], acceptsPdf: boolean): Message[] {
  if (acceptsPdf) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (typeof m.content === 'string' || !m.content.some((b) => b.type === 'document')) return m;
    changed = true;
    return { ...m, content: documentBlocksAsText(m.content) };
  });
  return changed ? out : messages;
}

/** Content with every document block replaced by its text form. */
export function documentBlocksAsText(content: ContentBlock[]): ContentBlock[] {
  return content.map((b) => (b.type === 'document' ? documentAsText(b) : b));
}
