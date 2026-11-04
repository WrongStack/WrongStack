import type { HistoryRetention, RequestResidency } from '@wrongstack/core/utils/residency-labels';
import type { ComponentType } from 'react';

/** The engine's `context.debug` reply: what the next request would send, by source. */
export interface ContextDebugPayload {
  total: number;
  mode?: string | undefined;
  policy?: unknown | undefined;
  systemPrompt: number;
  tools: {
    total: number;
    count: number;
    breakdown: Array<{ name: string; tokens: number }>;
  };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
  residency?: RequestResidency | undefined;
  retention?: HistoryRetention | undefined;
}

/** One agent's share of its own context window. */
export interface ContextAgent {
  id: string;
  name?: string | undefined;
  ctxPct: number;
  ctxTokens: number;
  maxContext: number;
}

/** The conversation the dashboard describes, as the application last heard it. */
export interface ContextSession {
  /** Prompt tokens of the latest request the model saw. */
  lastInputTokens: number;
  /** The active model's context window; 0 when it is not known. */
  maxContext: number;
  model: string;
  provider: string;
  mode: string;
  contextMode: string;
  /** When the conversation started (epoch ms); null when not known. */
  startTime: number | null;
  /** The running turn's iteration; null between turns. */
  iteration: { index: number; max: number } | null;
  projectName: string;
  cwd: string;
}

/** What the context dashboard reads, fed by each application. */
export interface ContextFeed {
  useSessionId(): string | null;
  useSession(): ContextSession;
  /** The conversation's agents with a context footprint (the leader included, when known). */
  useAgents(): readonly ContextAgent[];
  /** A value whose change means the connection was replaced and the breakdown is read again. */
  useConnectionKey?(): string;
  /** Asks the engine for the current breakdown; rejects with a message to show. */
  requestDebug(signal: AbortSignal): Promise<ContextDebugPayload>;
  /** The application's memory panels for this conversation. */
  Memory?: ComponentType | undefined;
  back?(): void;
}
