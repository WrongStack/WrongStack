import type { SessionSummary } from '@wrongstack/core/types';

/**
 * Stable WebSocket projection for the WebUI history surfaces.
 *
 * Keep this mapping shared by the standalone and CLI-hosted WebUI servers so
 * an initial list, rename refresh, and delete refresh cannot silently expose
 * different session metadata.
 */
export interface SessionHistoryWireEntry {
  id: string;
  title: string;
  name?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  model: string;
  provider: string;
  tokenTotal: number;
  lastActivityAt?: string | undefined;
  messageCount?: number | undefined;
  lastUserMessage?: string | undefined;
  iterationCount?: number | undefined;
  toolCallCount?: number | undefined;
  toolErrorCount?: number | undefined;
  fileChangeCount?: number | undefined;
  toolBreakdown?: Record<string, number> | undefined;
  compactionCount?: number | undefined;
  outcome?: SessionSummary['outcome'];
  isCurrent: boolean;
}

export function toSessionHistoryEntry(
  summary: SessionSummary,
  currentSessionId: string,
): SessionHistoryWireEntry {
  return {
    id: summary.id,
    title: summary.title,
    ...(summary.name !== undefined ? { name: summary.name } : {}),
    startedAt: summary.startedAt,
    ...(summary.endedAt !== undefined ? { endedAt: summary.endedAt } : {}),
    model: summary.model,
    provider: summary.provider,
    tokenTotal: summary.tokenTotal,
    ...(summary.lastActivityAt !== undefined ? { lastActivityAt: summary.lastActivityAt } : {}),
    ...(summary.messageCount !== undefined ? { messageCount: summary.messageCount } : {}),
    ...(summary.lastUserMessage !== undefined ? { lastUserMessage: summary.lastUserMessage } : {}),
    ...(summary.iterationCount !== undefined ? { iterationCount: summary.iterationCount } : {}),
    ...(summary.toolCallCount !== undefined ? { toolCallCount: summary.toolCallCount } : {}),
    ...(summary.toolErrorCount !== undefined ? { toolErrorCount: summary.toolErrorCount } : {}),
    ...(summary.fileChangeCount !== undefined ? { fileChangeCount: summary.fileChangeCount } : {}),
    ...(summary.toolBreakdown !== undefined ? { toolBreakdown: summary.toolBreakdown } : {}),
    ...(summary.compactionCount !== undefined ? { compactionCount: summary.compactionCount } : {}),
    ...(summary.outcome !== undefined ? { outcome: summary.outcome } : {}),
    isCurrent: summary.id === currentSessionId,
  };
}

export function toSessionHistoryEntries(
  summaries: SessionSummary[],
  currentSessionId: string,
): SessionHistoryWireEntry[] {
  return summaries.map((summary) => toSessionHistoryEntry(summary, currentSessionId));
}
