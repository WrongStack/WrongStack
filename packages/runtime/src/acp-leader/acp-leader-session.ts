/**
 * One WrongStack conversation led by an ACP agent: the persistent agent
 * session and what belongs to it. Shared by the provider and the modules it
 * is split into (session setup, prompt blocks, call approvals).
 */
import type { ACPSession } from '@wrongstack/acp';
import type { LeaderContext } from './acp-leader-context.js';
import type { FleetEndpoint } from './acp-leader-fleet.js';

/** `@wrongstack/acp`, as the provider loads it on first use. */
export type AcpModule = typeof import('@wrongstack/acp');

/** The project services served to one leader session over loopback HTTP. */
export interface LeaderProjectMcp {
  revoke(): void | Promise<void>;
}

export interface LeaderSession {
  runtimeConfigured?: boolean;
  runtimeUpdate?: Promise<unknown> | undefined;
  agentId: string;
  session: ACPSession;
  context: LeaderContext;
  promptPrefix?: string | undefined;
  /** This session's fleet tools endpoint, when the leader has fleet tools. */
  fleet?: FleetEndpoint | undefined;
  /**
   * The project services this process serves to the session over loopback HTTP
   * (`acp-leader-session-setup.ts`). Revoked with the session.
   */
  projectMcp?: LeaderProjectMcp | undefined;
  /**
   * The agent already has this conversation: it resumed its earlier session,
   * or had a turn here. Until then its first turn carries the earlier one.
   */
  joined?: boolean;
}
