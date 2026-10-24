import type { AgentContext } from '@wrongstack/contracts/types/context';
import { resolveEventSessionId, resolveOwningSessionId } from './context-session-id.js';

/**
 * Span attributes that tie a span to its conversation, so a trace exporter can
 * nest a turn's provider and tool calls under that turn — and a subagent's run
 * under the leader's — instead of reporting every span as a trace of its own.
 *
 * `session.id` is the session a surface is showing. A subagent runs under its
 * own journal, so it also carries `agent.session.id`, which the leader's spans
 * never do. Missing ids (stub contexts, a run with no session yet) just leave
 * the attribute out.
 */
export function spanSessionAttributes(ctx: AgentContext): Record<string, string> {
  const owning = attempt(() => resolveOwningSessionId(ctx));
  if (!owning) return {};
  const own = attempt(() => resolveEventSessionId(ctx));
  return own && own !== owning
    ? { 'session.id': owning, 'agent.session.id': own }
    : { 'session.id': owning };
}

function attempt(read: () => string): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
