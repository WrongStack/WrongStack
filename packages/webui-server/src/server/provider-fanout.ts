/**
 * Give every conversation the rebuilt provider.
 *
 * A WrongProxy toggle and a credential hot-reload are PROJECT-wide facts: the
 * same provider, rebuilt with a different base URL or a new key. Both used to
 * assign the result to the root context alone.
 *
 * That is enough for a host with one conversation and wrong for four. A
 * session's `Context` is created with the root's provider REFERENCE, so every
 * tab opened before the toggle kept running the old object — routed the old
 * way, authenticated with the old key — while the leader used the new one.
 * Nothing on screen distinguishes them, and the divergence lasts until each
 * tab happens to switch models.
 *
 * The fan-out is deliberately conservative: only contexts still pointing at
 * the exact provider object being replaced are moved. A tab that chose its own
 * model owns its own provider and must keep it — that choice is per
 * conversation, and overwriting it here would be the very cross-tab write this
 * exists to prevent.
 *
 * @module provider-fanout
 */

import type { Context } from '@wrongstack/core/agent';
import type { Provider } from '@wrongstack/core/types';

export interface ProviderFanoutInput {
  /** Conversations holding a live agent; absent on single-conversation hosts. */
  sessionAgentIds?: (() => string[]) | undefined;
  /** Read-only agent lookup — must never materialise one. */
  peekAgent?: ((sessionId?: string) => { ctx: Context } | undefined) | undefined;
  /** The provider object being replaced. */
  previous: Provider | undefined;
  /** The rebuilt provider. */
  next: Provider;
  /** The context that already received `next` and must not be revisited. */
  applied: Context;
}

/**
 * Move every other conversation off `previous` and onto `next`.
 *
 * Returns the session ids that were moved, for logging and tests.
 */
export function fanOutProviderRebuild(input: ProviderFanoutInput): string[] {
  const { sessionAgentIds, peekAgent, previous, next, applied } = input;
  if (!sessionAgentIds || !peekAgent || !previous || previous === next) return [];
  const moved: string[] = [];
  for (const sessionId of sessionAgentIds()) {
    const ctx = peekAgent(sessionId)?.ctx;
    if (!ctx || ctx === applied) continue;
    if (ctx.provider !== previous) continue;
    ctx.provider = next;
    moved.push(sessionId);
  }
  return moved;
}
