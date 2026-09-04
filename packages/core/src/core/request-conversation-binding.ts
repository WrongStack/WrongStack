/**
 * The conversation that owns one concrete LLM request.
 *
 * The request pipeline is SHARED: one instance serves every conversation the
 * process is running, and its payload is a bare `Request` with no session on
 * it. That was fine when a process meant a conversation. With four WebUI tabs
 * it means a middleware can only answer "what did the project configure",
 * never "what did THIS tab configure" — which is how a reasoning effort chosen
 * in one tab ended up on every other tab's next request.
 *
 * A side-channel rather than a field on `Request`, for the same reason
 * `request-provider-binding.ts` is one: `Request` is the wire shape, and
 * adding non-wire fields to it invites providers to serialise them.
 *
 * Binding is best-effort by design. A request built outside the agent loop
 * (compaction, one-shot helpers, the brain) carries no conversation, and every
 * reader must fall back to the process-wide answer — which is exactly the
 * behaviour those callers had before.
 *
 * @module request-conversation-binding
 */

import type { Request } from '../types/provider.js';

/** The slice of a conversation a request-pipeline middleware may consult. */
export interface RequestConversation {
  /** The conversation's own meta bag — per-session preferences live here. */
  meta: Record<string, unknown>;
  /**
   * Stable identifier for the conversation that owns this request.
   *
   * This stays in the side-channel rather than on `Request`: adapters can use
   * it for transport metadata without accidentally serialising a local
   * WrongStack session id into a model request body.
   */
  sessionId?: string | undefined;
}

const requestConversations = new WeakMap<Request, RequestConversation>();

export function bindRequestConversation(request: Request, conversation: RequestConversation): void {
  requestConversations.set(request, conversation);
}

export function conversationBoundToRequest(request: Request): RequestConversation | undefined {
  return requestConversations.get(request);
}

/**
 * Carry the binding onto a request a middleware just copied.
 *
 * Middleware conventionally returns `{ ...req }`, which is a NEW object and
 * therefore unbound — so the middleware after it would see no conversation.
 */
export function inheritRequestConversation(from: Request, to: Request): void {
  if (from === to) return;
  const conversation = requestConversations.get(from);
  if (conversation) requestConversations.set(to, conversation);
}
