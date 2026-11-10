import type { Message } from '@wrongstack/contracts/types/messages';

/**
 * `<nextsteps>` blocks in past assistant turns are a client affordance: the
 * surface parses and renders them the moment the turn ends, and a chosen
 * suggestion comes back as a fresh user message (the continue-intent resolver
 * keeps its own parsed store for bare "continue"). Re-sending the raw block to
 * the provider on every later request is pure token weight, and stale
 * suggestions can read as still-pending work. Strip them from the REQUEST copy
 * of the history only — the durable log keeps them for resume and rendering.
 *
 * Cached per message object, so each message is scanned once per session and
 * every request reuses the identical stripped clone (stable bytes AND stable
 * identities keep provider prefix caches and token-estimate caches warm).
 */
// The completion marker alternative comes first and the block's opening tag
// refuses it: `<nextsteps\b` alone matches `<nextsteps-complete/>` and would
// swallow everything up to a later block's close tag.
const NEXT_STEPS_BLOCK_RE =
  /<nextsteps-complete\s*\/>[ \t]*\n?|<nextsteps\b(?!-complete)[^>]*>[\s\S]*?<\/nextsteps>[ \t]*\n?/gi;
const NEXT_STEPS_STRIPPED_PLACEHOLDER = '[nextsteps suggestions were delivered to the user]';
const strippedNextStepsCache = new WeakMap<Message, Message>();

export function stripDeliveredNextSteps(history: readonly Message[]): readonly Message[] {
  let out: Message[] | null = null;
  for (let i = 0; i < history.length; i++) {
    const msg = history[i] as Message;
    const replaced = stripNextStepsFromMessage(msg);
    if (out === null && replaced !== msg) out = history.slice(0, i);
    if (out !== null) out.push(replaced);
  }
  return out ?? history;
}

function stripNextStepsFromMessage(msg: Message): Message {
  if (msg.role !== 'assistant') return msg;
  const cached = strippedNextStepsCache.get(msg);
  if (cached) return cached;
  const hasTag =
    typeof msg.content === 'string'
      ? msg.content.includes('<nextsteps')
      : msg.content.some((b) => b.type === 'text' && b.text.includes('<nextsteps'));
  if (!hasTag) {
    strippedNextStepsCache.set(msg, msg);
    return msg;
  }
  let clone: Message;
  if (typeof msg.content === 'string') {
    const text = msg.content.replace(NEXT_STEPS_BLOCK_RE, '').trimEnd();
    clone = { ...msg, content: text.length > 0 ? text : NEXT_STEPS_STRIPPED_PLACEHOLDER };
  } else {
    const blocks = msg.content
      .map((b) =>
        b.type === 'text' && b.text.includes('<nextsteps')
          ? { ...b, text: b.text.replace(NEXT_STEPS_BLOCK_RE, '').trimEnd() }
          : b,
      )
      // A block that was ONLY the nextsteps tag becomes empty — drop it;
      // Anthropic rejects empty text blocks on the wire.
      .filter((b) => b.type !== 'text' || b.text.trim().length > 0);
    clone = {
      ...msg,
      content:
        blocks.length > 0 ? blocks : [{ type: 'text', text: NEXT_STEPS_STRIPPED_PLACEHOLDER }],
    };
  }
  strippedNextStepsCache.set(msg, clone);
  return clone;
}
