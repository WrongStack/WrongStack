/**
 * Context held by an agent provider (`Capabilities.keepsOwnContext`): an ACP
 * agent leading the session runs its own conversation, tool results and
 * compaction. WrongStack's messages are a transcript of it, so neither their
 * size nor the turn's usage (the sum of every model call the agent made) says
 * how full the agent's window is. The agent's own report does, and it is the
 * one number the context bar, `/context` and `ctx.pct` show for that route.
 */
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { AgentContextUsage, Provider } from '@wrongstack/contracts/types/provider';

/** In memory only: a resumed session starts a fresh agent, so a stored reading would be stale. */
const reported = new WeakMap<object, AgentContextUsage>();

export function keepsOwnContext(provider: Pick<Provider, 'capabilities'> | undefined): boolean {
  return provider?.capabilities?.keepsOwnContext === true;
}

/** Remember what the agent reported after a response, and show it as the request's size. */
export function recordAgentContext(
  ctx: Pick<AgentContext, 'tokenCounter'>,
  usage: AgentContextUsage | undefined,
): void {
  if (!usage || !Number.isFinite(usage.used) || usage.used < 0) return;
  reported.set(ctx, usage);
  // The per-request snapshot the statusline falls back to: the agent's
  // context, not the turn's summed spend.
  ctx.tokenCounter?.setCurrentRequestTokens?.(usage.used);
}

/** The agent's last report for this context, when the active route keeps its own context. */
export function readAgentContext(
  ctx: Pick<AgentContext, 'provider'>,
): AgentContextUsage | undefined {
  return keepsOwnContext(ctx.provider) ? reported.get(ctx) : undefined;
}

/**
 * The key an agent provider holds this conversation's agent under: the
 * request's `cache.sessionId`, derived as agent-response derives it.
 */
export function agentSessionKey(
  ctx: Pick<AgentContext, 'meta' | 'activeRunSessionId' | 'session'>,
): string {
  const owning = ctx.meta?.['sessionId'];
  if (typeof owning === 'string' && owning.length > 0) return owning;
  return ctx.activeRunSessionId ?? ctx.session?.id ?? 'default';
}
