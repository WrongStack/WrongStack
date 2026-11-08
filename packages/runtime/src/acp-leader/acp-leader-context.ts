/**
 * The leading agent's context, as the agent reports it. WrongStack's
 * transcript is not what the agent holds, and a turn's usage is the sum of
 * every model call in it, so neither measures the agent's window. Its own
 * reports do: `usage_update` (`used` / `size`, after each model call) and the
 * result of a compaction, manual or automatic (`preTokens` / `postTokens` on
 * Claude's "Compact conversation" call).
 */
import type { ACPCapturedToolCall } from '@wrongstack/acp';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { AgentContextUsage } from '@wrongstack/contracts/types';

/** A compaction's result, when this settled call is one. */
function compactedTokens(call: ACPCapturedToolCall): number | undefined {
  if (call.status !== 'completed') return undefined;
  const raw = call.rawOutput;
  const post = raw?.postTokens;
  return typeof raw?.preTokens === 'number' &&
    typeof post === 'number' &&
    Number.isFinite(post) &&
    post >= 0
    ? post
    : undefined;
}

export class LeaderContext {
  private reading: AgentContextUsage | undefined;

  /** The agent's last reading. */
  get current(): AgentContextUsage | undefined {
    return this.reading;
  }

  /** A `usage_update`: the context after the agent's latest model call. */
  usage(update: { used: number; size: number }): AgentContextUsage {
    this.reading = { used: update.used, size: update.size || (this.reading?.size ?? 0) };
    return this.reading;
  }

  /** A settled tool call; a compaction resets the context to what it kept. */
  toolCall(call: ACPCapturedToolCall): AgentContextUsage | undefined {
    const post = compactedTokens(call);
    if (post === undefined) return undefined;
    this.reading = { used: post, size: this.reading?.size ?? 0 };
    return this.reading;
  }
}

/**
 * Show a reading mid-turn: the agent's context grows with every tool call of
 * a long turn, and the loop reports the fill only once the turn ends.
 */
export function publishLeaderContext(
  events: EventBus | undefined,
  sessionId: string | undefined,
  reading: AgentContextUsage,
  fallbackMaxContext: number,
): void {
  const maxContext = reading.size || fallbackMaxContext;
  const rawLoad = maxContext > 0 ? reading.used / maxContext : 0;
  events?.emit('ctx.pct', {
    sessionId,
    load: Math.max(0, Math.min(1, rawLoad)),
    rawLoad,
    tokens: reading.used,
    maxContext,
  });
}
