import type {
  AgentTranscriptEntry,
  LiveSession,
  MailboxAgent,
  MailboxMessage,
  SubagentView,
  VizEvent,
} from './types';

/** What the conversation reported about itself (`client.status_update`). */
export interface OfficeCurrentSession {
  clientType?: string | undefined;
  agentCount?: number | undefined;
  model?: string | undefined;
  mode?: string | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
}

/**
 * The live data the office surfaces render. Each member is a hook so a host keeps the
 * components' fine-grained subscriptions (the WebUI reads its stores; the desktop reads the
 * project's frames).
 */
export interface OfficeFeed {
  /** The project session registry snapshot (`sessions.status_update`). */
  useLiveSessions(): LiveSession[];
  useCurrentSession(): OfficeCurrentSession;
  /** Spawned agents by id (`subagent.event`, `delegate.*`). */
  useFleetAgents(): ReadonlyMap<string, SubagentView>;
  useAgentTranscripts(): ReadonlyMap<string, AgentTranscriptEntry[]>;
  useLeaderId(): string | undefined;
  /** Open mailbox messages, newest first, and the registered agents. */
  useMailboxMessages(): MailboxMessage[];
  useMailboxAgents(): MailboxAgent[];
  /** The activity feed, newest first, and its tool events. */
  useVizEvents(): VizEvent[];
  useToolEvents(): VizEvent[];
  useProjectName(): string | undefined;
  /** How the office names the application it runs in, when no session reports it yet. */
  self?: OfficeSelf | undefined;
}

export interface OfficeSelf {
  label: string;
  sublabel: string;
}
