import type { Container, Token } from '@wrongstack/contracts/kernel/container';
import type { ArchitectureDecisionContextPort } from '@wrongstack/contracts/types/architecture-decision-context';
import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { ChronicleFileLineageReader } from '@wrongstack/contracts/types/chronicle-metrics';
import type { FleetConfig } from '@wrongstack/contracts/types/config';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { MailboxHqPublisherFactory } from '@wrongstack/contracts/types/hq-mailbox-publisher';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type {
  ChimeraReportSessionResolverFactory,
  MailboxMessage,
} from '@wrongstack/contracts/types/mailbox';

/**
 * Coordination the agent loop drives every iteration: the inbox checker,
 * session-note fan-in, the fleet pulse and leader deliveries.
 *
 * The loop must not import the implementation — the attach modules
 * (`mailbox-attach.ts`, `session-note-attach.ts`, `leader-delivery-attach.ts`)
 * live in `@wrongstack/coordination`, above core. The host binds
 * `AGENT_COORDINATION` instead: `createDefaultContainer` in
 * `@wrongstack/runtime` binds `defaultAgentCoordination` from
 * `@wrongstack/coordination`. With no binding the loop runs without
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

/**
 * Chronicle file-lineage lookup used for review provenance. Chronicle lives
 * above the review plugins, so hosts bind it; unbound means no provenance.
 */
export const CHRONICLE_FILE_LINEAGE = Symbol.for(
  '@wrongstack/core/agent#ChronicleFileLineage',
) as Token<ChronicleFileLineageReader>;

export function resolveChronicleFileLineage(
  container: Pick<Container, 'has' | 'resolve'> | undefined,
): ChronicleFileLineageReader | undefined {
  try {
    return typeof container?.has === 'function' && container.has(CHRONICLE_FILE_LINEAGE)
      ? container.resolve(CHRONICLE_FILE_LINEAGE)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chimera report → session lookup for the mailbox session-affinity filter.
 * The report store lives in `@wrongstack/builtin-plugins`, so hosts bind the
 * factory; unbound, report-scoped mail without a session id stays unresolved.
 */
export const CHIMERA_REPORT_SESSION_RESOLVER = Symbol.for(
  '@wrongstack/core/agent#ChimeraReportSessionResolver',
) as Token<ChimeraReportSessionResolverFactory>;

export function resolveChimeraReportSessionResolver(
  container: Pick<Container, 'has' | 'resolve'> | undefined,
): ChimeraReportSessionResolverFactory | undefined {
  try {
    return typeof container?.has === 'function' && container.has(CHIMERA_REPORT_SESSION_RESOLVER)
      ? container.resolve(CHIMERA_REPORT_SESSION_RESOLVER)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accepted architecture decisions and their check results for each request.
 * The ADR registry lives in core's storage layer, which the agent loop may not
 * import, so hosts bind it; unbound means no ADR context reaches the request.
 */
export const ARCHITECTURE_DECISION_CONTEXT = Symbol.for(
  '@wrongstack/core/agent#ArchitectureDecisionContext',
) as Token<ArchitectureDecisionContextPort>;

export function resolveArchitectureDecisionContext(
  container: Pick<Container, 'has' | 'resolve'> | undefined,
): ArchitectureDecisionContextPort | undefined {
  try {
    return typeof container?.has === 'function' && container.has(ARCHITECTURE_DECISION_CONTEXT)
      ? container.resolve(ARCHITECTURE_DECISION_CONTEXT)
      : undefined;
  } catch {
    return undefined;
  }
}
