/**
 * Who signed a thinking block — and keeping blocks away from a service that
 * would reject them.
 *
 * Every Anthropic-compatible service returns `thinking` blocks with a
 * `signature`, and the Messages contract replays them verbatim on the next
 * turn. The signatures are not interchangeable: Anthropic's are cryptographic
 * and verified (a foreign one is a 400 "Invalid `signature` in `thinking`
 * block"), Z.AI's are 24-hex-char record ids it does not verify (a fake one is
 * accepted — checked live 2026-09-30). A session that ran on Z.AI or MiniMax
 * and then switches, or falls back, to Claude used to replay the other
 * service's signatures to Anthropic and fail the turn.
 *
 * The official ZCode client handles this in two layers
 * (`reasoning-history-normalization.ts`): it strips reasoning produced by a
 * different provider before sending, and on a signature rejection it removes
 * the signed blocks and retries once. This module is the same for every
 * Anthropic-wire transport:
 *
 * 1. **Stamp** — the signer is recorded on the block (`providerMeta`) as the
 *    signature arrives, so provenance survives the session journal.
 * 2. **Filter** — before a request, blocks stamped by another signer are
 *    dropped. Anthropic additionally never accepts an unsigned `thinking`
 *    block (reasoning carried over from a Chat Completions provider), so
 *    those go too when the target is Anthropic.
 * 3. **Repair** — a signature rejection that still gets through (a block from
 *    before stamping existed) is retried once with every signed block removed.
 *
 * @module thinking-signer
 */

import type {
  ContentBlock,
  Message,
  Request,
  StreamEvent,
  ThinkingBlock,
} from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import { ANTHROPIC_REDACTED_THINKING_META } from './presets/anthropic.js';
import { upstreamHost } from './proxy-upstream.js';

/** `providerMeta` key naming the service that signed a thinking block. */
const THINKING_SIGNER_META = 'thinkingSigner';

/** Signer id for Anthropic itself — the only one that verifies signatures. */
export const ANTHROPIC_SIGNER = 'anthropic';

/** Stand-in text for an assistant turn whose only content was removed reasoning (ZCode's wording). */
const THINKING_REMOVED = '[Thinking removed]';

/**
 * The signer an Anthropic-wire endpoint stamps its blocks with: `anthropic`
 * for Anthropic's own hosts, else the upstream host (seen through the trace
 * proxy), so two regions of one vendor are distinct signers.
 */
export function anthropicWireSigner(baseUrl: string | undefined): string {
  const host = upstreamHost(baseUrl);
  if (host === undefined) return 'unknown';
  if (host === 'anthropic.com' || host.endsWith('.anthropic.com')) return ANTHROPIC_SIGNER;
  return host;
}

function signerOf(block: ThinkingBlock): string | undefined {
  const value = block.providerMeta?.[THINKING_SIGNER_META];
  return typeof value === 'string' ? value : undefined;
}

function isRedacted(block: ThinkingBlock): boolean {
  return block.providerMeta?.[ANTHROPIC_REDACTED_THINKING_META] !== undefined;
}

/**
 * Record `signer` on every thinking block of a stream: a `thinking_meta`
 * event right after each signature, which the response builders merge into
 * the block in flight.
 */
export async function* stampThinkingSigner(
  events: AsyncIterable<StreamEvent>,
  signer: string,
): AsyncIterable<StreamEvent> {
  for await (const ev of events) {
    yield ev;
    if (ev.type === 'thinking_signature') {
      yield { type: 'thinking_meta', providerMeta: { [THINKING_SIGNER_META]: signer } };
    }
  }
}

/** Replace one assistant message's content, keeping it non-empty. */
function withContent(message: Message, content: ContentBlock[]): Message {
  return {
    ...message,
    content: content.length > 0 ? content : [{ type: 'text', text: THINKING_REMOVED }],
  };
}

/**
 * Drop the thinking blocks `keep` rejects from assistant messages.
 * Copy-on-write: returns `undefined` when nothing was dropped, and reports
 * whether the LAST assistant message lost a block.
 */
function dropThinking(
  messages: readonly Message[],
  keep: (block: ThinkingBlock) => boolean,
): { messages: Message[]; lastAssistantChanged: boolean } | undefined {
  let out: Message[] | undefined;
  let lastAssistantChanged = false;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  messages.forEach((message, i) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return;
    const content = message.content.filter((b) => b.type !== 'thinking' || keep(b));
    if (content.length === message.content.length) return;
    out ??= messages.slice();
    out[i] = withContent(message, content);
    if (i === lastAssistant) lastAssistantChanged = true;
  });
  return out ? { messages: out, lastAssistantChanged } : undefined;
}

/**
 * A request `signer` will accept: thinking stamped by another signer removed,
 * and for Anthropic also unsigned thinking. Returns `req` itself when nothing
 * had to change.
 *
 * Anthropic requires a tool-use continuation's final assistant turn to open
 * with a thinking block while thinking is on. When that turn's thinking came
 * from another service and had to go, the continuation is sent with thinking
 * off for this one request — the alternative is a guaranteed 400.
 */
export function prepareThinkingForSigner(req: Request, signer: string): Request {
  const strict = signer === ANTHROPIC_SIGNER;
  const result = dropThinking(req.messages, (block) => {
    const stamped = signerOf(block);
    if (stamped !== undefined) return stamped === signer;
    // Unstamped: a block from before stamping, or reasoning from a Chat
    // Completions provider. Only Anthropic is known to refuse the unsigned kind.
    return !strict || block.signature !== undefined || isRedacted(block);
  });
  if (!result) return req;
  const next: Request = { ...req, messages: result.messages };
  if (strict && result.lastAssistantChanged && needsLeadingThinking(result.messages, req)) {
    next.reasoning = { ...req.reasoning, enabled: false };
  }
  return next;
}

/**
 * True when thinking is requested and the final assistant turn is a tool-use
 * continuation (it has tool_use, a tool_result follows) left without any
 * thinking block.
 */
function needsLeadingThinking(messages: readonly Message[], req: Request): boolean {
  const r = req.reasoning;
  if (!r || r.enabled === false || r.effort === 'none') return false;
  if (r.enabled !== true && r.effort === undefined) return false;
  const last = messages.at(-1);
  const assistant = messages.at(-2);
  if (last?.role !== 'user' || assistant?.role !== 'assistant') return false;
  if (typeof assistant.content === 'string') return false;
  const hasToolUse = assistant.content.some((b) => b.type === 'tool_use');
  const hasThinking = assistant.content.some((b) => b.type === 'thinking');
  return hasToolUse && !hasThinking;
}

/**
 * True for a 400 whose message says a thinking block's signature was refused
 * (Anthropic: "messages.1.content.0: Invalid `signature` in `thinking` block").
 */
export function isThinkingSignatureRejection(err: unknown): boolean {
  if (!ProviderError.isProviderError(err) || err.status !== 400) return false;
  const text = [err.body?.message, err.body?.raw, err.message].filter(Boolean).join('\n');
  return /signature/i.test(text) && /thinking/i.test(text);
}

/**
 * Stream `req` through `run` for an Anthropic-wire endpoint whose blocks are
 * signed by `signer`: filtered before, stamped during, and retried once with
 * every signed block removed when a signature is still refused. Nothing is
 * retried once output has been delivered.
 */
export async function* streamWithThinkingSigner(
  req: Request,
  opts: { signal: AbortSignal },
  signer: string,
  run: (req: Request) => AsyncIterable<StreamEvent>,
): AsyncIterable<StreamEvent> {
  const prepared = prepareThinkingForSigner(req, signer);
  let emitted = false;
  let repaired: Request | undefined;
  try {
    for await (const ev of stampThinkingSigner(run(prepared), signer)) {
      emitted = true;
      yield ev;
    }
    return;
  } catch (err) {
    if (emitted || opts.signal.aborted || !isThinkingSignatureRejection(err)) throw err;
    const stripped = dropThinking(
      prepared.messages,
      (block) => block.signature === undefined && !isRedacted(block),
    );
    if (!stripped) throw err;
    repaired = { ...prepared, messages: stripped.messages };
    if (stripped.lastAssistantChanged && needsLeadingThinking(stripped.messages, prepared)) {
      repaired.reasoning = { ...prepared.reasoning, enabled: false };
    }
  }
  yield* stampThinkingSigner(run(repaired), signer);
}
