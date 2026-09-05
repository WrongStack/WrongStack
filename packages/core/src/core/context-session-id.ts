import { requireSessionId } from '@wrongstack/primitives';
import type { AgentContext } from '../types/context.js';
import type { SessionWriter } from '../types/session.js';

/**
 * Session id that events of the in-flight run must be stamped with: the
 * run-pinned id (`Context.activeRunSessionId`) when a run is active,
 * otherwise the live session id. Reads properties defensively because
 * tests and lightweight embedders stub Context with partial objects whose
 * `session` may be missing despite the non-optional type.
 */
export function resolveEventSessionId(ctx: AgentContext): string {
  if (ctx.activeRunSessionId) {
    return requireSessionId(ctx.activeRunSessionId, 'agent event emission');
  }
  const session: SessionWriter | undefined = ctx.session;
  return requireSessionId(session?.id, 'agent event emission');
}

/**
 * Session that OWNS this agent — the conversation a surface is showing.
 */
export function resolveOwningSessionId(ctx: AgentContext): string {
  const owning = ctx.meta?.['sessionId'];
  if (typeof owning === 'string' && owning.length > 0) return owning;
  return resolveEventSessionId(ctx);
}
