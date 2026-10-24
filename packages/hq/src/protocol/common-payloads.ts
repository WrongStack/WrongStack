export interface HqUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Provider id that produced this usage (e.g. 'anthropic'), when known. */
  provider?: string;
  /** Model id the cost was priced against, when known. */
  model?: string;
  /** Cache-read (prompt-cache hit) tokens, when reported. */
  cacheRead?: number;
  /** Cache-write tokens, when reported. */
  cacheWrite?: number;
}

/** A physical machine, aggregated by HQ from connected clients' machineId. */
export interface HqMachineRecord {
  machineId: string;
  hostname?: string;
  clientCount: number;
  sessionCount: number;
  agentCount: number;
  projectIds: readonly string[];
  lastActivityAt: string;
}

export interface HqSubagentSummary {
  subagentId: string;
  role?: string;
  status: 'pending' | 'running' | 'idle' | 'completed' | 'failed' | 'stopped';
  task?: string;
  currentTool?: string;
  runtimeMs?: number;
  costUsd?: number;
  lastActivityAt?: string;
  /**
   * The provider/model this worker actually runs on, `provider/model` when the
   * provider is known. `FleetTelemetryBridge` has always put it on the wire —
   * the field was missing from this contract, so a consumer could not read it
   * type-safely. It is the answer to "did my per-session model routing take
   * effect", which is otherwise invisible from HQ.
   */
  model?: string;
}
