import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { SessionWriter } from '@wrongstack/contracts/types/session';
import { requireSessionId } from '@wrongstack/primitives';

/**
 * Session id that events of the in-flight run must be stamped with: the
 * run-pinned id (`Context.activeRunSessionId`) when a run is active,
 * otherwise the live session id. Reads properties defensively because
 * tests and lightweight embedders stub Context with partial objects whose
 * `session` may be missing despite the non-optional type.
 */
export function resolveEventSessionId(
  ctx: Pick<AgentContext, 'activeRunSessionId' | 'session'>,
): string {
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
