import type { MailboxMessage, SubagentView } from '../office/types';
import type { ChronicleQuery, ChronicleQueryResult } from './chronicle-types';

/** A memory-injector run, as much of it as the story shows. */
export interface StoryMemoryTrace {
  runId: string;
  at: string;
  outcome: string;
  toolName: string;
  injectedChars: number;
  injected: ReadonlyArray<{ id: string }>;
  sessionId?: string | undefined;
}

/** The conversation the story tells. */
export interface StorySession {
  id: string;
  /** Epoch milliseconds; 0 when unknown. */
  startedAt: number;
}

/**
 * What the Session Story reads from its application. Members named `use…` are React hooks and
 * are called during render; the others are called from effects and handlers.
 */
export interface StoryFeed {
  useSessionId(): string | null;
  useSession(): StorySession | null;
  useProjectRoot(): string;
  /** Whether the conversation is running a turn now. */
  useRunning(): boolean;
  /** The latest request the user sent in the conversation. */
  useLatestRequest(): string | undefined;
  /** Sub-agents known to the application; the story keeps the conversation's own. */
  useAgents(): readonly SubagentView[];
  useMail(): readonly MailboxMessage[];
  useMemoryTraces(): readonly StoryMemoryTrace[];
  /** Whether something asked the story to open on its context timeline; `clear` consumes it. */
  useContextRequest(): { requested: boolean; clear: () => void };
  /** Whether the engine answers Chronicle queries. */
  supportsChronicle(): boolean;
  /**
   * One Chronicle query; rejects with the engine's message when it fails. An aborted query
   * stops waiting for its reply.
   */
  queryChronicle(query: ChronicleQuery, signal: AbortSignal): Promise<ChronicleQueryResult>;
  /** Asks for the recent mailbox messages the story shows. */
  refreshMail(): void;
  /** Returns to the conversation. */
  back(): void;
}
