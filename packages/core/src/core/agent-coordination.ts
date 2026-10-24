import type { Container, Token } from '@wrongstack/contracts/kernel/container';
import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { FleetConfig } from '@wrongstack/contracts/types/config';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { MailboxHqPublisherFactory } from '@wrongstack/contracts/types/hq-mailbox-publisher';
import type { MailboxMessage } from '@wrongstack/contracts/types/mailbox';

/**
 * Coordination the agent loop drives every iteration: the inbox checker,
 * session-note fan-in, the fleet pulse and leader deliveries.
 *
 * The loop must not import the implementation — the composition-root attach
 * modules (`mailbox-attach.ts`, `session-note-attach.ts`,
 * `leader-delivery-attach.ts`) reach into coordination, hq and plugins. The
 * host binds `AGENT_COORDINATION` instead: `createDefaultContainer` in
 * `@wrongstack/runtime` binds `defaultAgentCoordination` from
 * `@wrongstack/core/agent-coordination`. With no binding the loop runs without
 * coordination (no inbox, notes, pulse or deliveries).
 *
 * `A` is the agent-internals handle. The members are METHODS so an
 * implementation typed for `AgentInternals` binds to the token's `unknown`
 * handle; naming `AgentInternals` here would tie this module to the
 * agent-loop type graph (the architecture gate fails on new type cycles).
 */
export interface AgentCoordinationPort<A = unknown> {
  attachMailboxChecker(a: A): () => Promise<MailboxMessage[]>;
  attachSessionNotes(a: A): void;
  attachFleetPulse(
    a: A,
    cfg?: FleetConfig['pulse'],
  ): () => Promise<{ type: 'text'; text: string } | null>;
  drainLeaderDeliveries(
    a: { readonly ctx: AgentContext; readonly logger: Logger },
    sessionIds: readonly string[],
    fold: (block: TextBlock) => void,
  ): Promise<number>;
}

export const AGENT_COORDINATION = Symbol.for(
  '@wrongstack/core/agent#AgentCoordination',
) as Token<AgentCoordinationPort>;

/**
 * The bound coordination port, or `undefined`. Tolerates the partial
 * containers test doubles and thin hosts hand to `Agent`.
 */
export function resolveAgentCoordination(
  container: Pick<Container, 'has' | 'resolve'> | undefined,
): AgentCoordinationPort | undefined {
  try {
    return typeof container?.has === 'function' && container.has(AGENT_COORDINATION)
      ? container.resolve(AGENT_COORDINATION)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Factory for the HQ publisher that mirrors the project mailbox. The publisher
 * lives in `@wrongstack/hq`, above core, so the mailbox wiring resolves it from
 * the container; unbound means HQ mirroring is off.
 */
export const HQ_MAILBOX_PUBLISHER_FACTORY = Symbol.for(
  '@wrongstack/core/agent#HqMailboxPublisherFactory',
) as Token<MailboxHqPublisherFactory>;

export function resolveHqMailboxPublisherFactory(
  container: Pick<Container, 'has' | 'resolve'> | undefined,
): MailboxHqPublisherFactory | undefined {
  try {
    return typeof container?.has === 'function' && container.has(HQ_MAILBOX_PUBLISHER_FACTORY)
      ? container.resolve(HQ_MAILBOX_PUBLISHER_FACTORY)
      : undefined;
  } catch {
    return undefined;
  }
}
