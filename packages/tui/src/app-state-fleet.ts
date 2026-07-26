/** Per-subagent state tracked live from the FleetBus. */
export interface FleetEntry {
  id: string;
  name: string;
  provider?: string | undefined;
  model?: string | undefined;
  status: 'idle' | 'running' | 'success' | 'failed' | 'timeout' | 'stopped';
  streamingText: string;
  iterations: number;
  toolCalls: number;
  recentTools: Array<{
    name: string;
    ok?: boolean | undefined;
    durationMs?: number | undefined;
    outputBytes?: number | undefined;
    outputLines?: number | undefined;
    at: number;
  }>;
  recentMessages: Array<{ text: string; at: number }>;
  cost: number;
  startedAt: number;
  lastEventAt: number;
  currentTool?: { name: string; startedAt: number } | undefined;
  transcriptPath?: string | undefined;
  budgetWarning?: { kind: string; used: number; limit: number; at: number } | undefined;
  extensions?: number | undefined;
  ctxPct?: number | undefined;
  ctxTokens?: number | undefined;
  ctxMaxTokens?: number | undefined;
  ctxCost?: number | undefined;
  failureReason?: string | undefined;
}
