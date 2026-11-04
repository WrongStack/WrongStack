import type { AgentTranscriptEntry, SubagentView } from './types';

/**
 * The subagent fleet's wire events and the transcript helpers its fold uses. The WebUI fleet
 * store and the desktop engine state fold the same `subagent.event` frames with them.
 */

/** Discriminated payload mirroring the subagent.* events the backend forwards. */
export interface SubagentEvent {
  kind:
    | 'spawned'
    | 'task_started'
    | 'tool_executed'
    | 'iteration_summary'
    | 'budget_warning'
    | 'budget_extended'
    | 'ctx_pct'
    | 'task_completed'
    | 'removed'
    | 'session_stopped'
    | 'leader_updated';
  subagentId?: string | undefined;
  /** Session this agent belongs to — forwarded from the server on every subagent event. */
  sessionId?: string | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  description?: string | undefined;
  taskId?: string | undefined;
  toolName?: string | undefined;
  iteration?: number | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
  currentTool?: string | undefined;
  load?: number | undefined;
  rawLoad?: number | undefined;
  tokens?: number | undefined;
  maxContext?: number | undefined;
  totalExtensions?: number | undefined;
  /** Budget warning details from subagent.budget_warning. */
  budgetKind?: string | undefined;
  used?: number | undefined;
  limit?: number | undefined;
  status?: 'success' | 'failed' | 'timeout' | 'stopped' | undefined;
  iterations?: number | undefined;
  error?: { kind: string | undefined; message: string };
  /** Tool execution result (tool_executed event). */
  ok?: boolean | undefined;
  /** Tool execution duration in ms (tool_executed event). */
  durationMs?: number | undefined;
  /** Accumulated partial text (iteration_summary event). */
  partialText?: string | undefined;
  /** Final output text (task_completed event). */
  finalText?: string | undefined;
  /** Failure reason for task_completed with failed/timeout status. */
  failureReason?: string | undefined;
  /** Lifecycle removal reason, when kind is removed. */
  reason?: string | undefined;
  /** True when this event marks the agent as the leader. */
  isLeader?: boolean | undefined;
  /** Tokens in/out for fleet-wide aggregation (from ctx_pct event). */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
}

/** A single entry in the Fleet Monitor event timeline. */
export interface FleetTimelineEvent {
  id: string;
  kind:
    | 'spawned'
    | 'task_started'
    | 'tool_executed'
    | 'iteration_summary'
    | 'budget_warning'
    | 'budget_extended'
    | 'task_completed'
    | 'ctx_pct'
    | 'leader_updated';
  agentId: string;
  agentName: string;
  timestamp: number;
  message: string;
  /** Numeric value for sorting/display (e.g. duration, cost delta). */
  value?: number | undefined;
}

// ── Fleet store (live subagent roster; not persisted) ───────────────────────

export const SPARKLINE_BINS = 12;

export const MAX_TIMELINE = 20;

export const MAX_AGENT_TRANSCRIPT = 1000;

export function blankAgent(
  id: string,
  name?: string,
  sessionId?: string,
  startedAt = Date.now(),
): SubagentView {
  return {
    id,
    name: name?.trim() || id,
    sessionId,
    status: 'running',
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt,
    toolLog: [],
    sparklineBins: Array(SPARKLINE_BINS).fill(0),
  };
}

export function pushTimeline(
  timeline: FleetTimelineEvent[],
  event: FleetTimelineEvent,
): FleetTimelineEvent[] {
  return [event, ...timeline].slice(0, MAX_TIMELINE);
}

export function canMergeTranscriptEntry(a: AgentTranscriptEntry, b: AgentTranscriptEntry): boolean {
  if (a.subagentId !== b.subagentId) return false;
  if (a.kind !== b.kind) return false;
  if (a.iteration !== b.iteration) return false;
  if (a.toolName !== b.toolName) return false;
  if (a.toolOk !== b.toolOk) return false;
  return a.kind === 'text' || a.kind === 'thinking';
}

export function appendTranscriptEntry(
  entries: AgentTranscriptEntry[],
  entry: AgentTranscriptEntry,
): AgentTranscriptEntry[] {
  const last = entries[entries.length - 1];
  if (last && canMergeTranscriptEntry(last, entry)) {
    return [
      ...entries.slice(0, -1),
      { ...last, content: `${last.content}${entry.content}`, ts: entry.ts },
    ].slice(-MAX_AGENT_TRANSCRIPT);
  }
  return [...entries, entry].slice(-MAX_AGENT_TRANSCRIPT);
}

/** Update sparkline bins for an agent — bump bin 0 and shift left.
 *  The bins array has index 0 as the most recent bucket.
 *  Each event bumps bin 0, then the array is truncated to SPARKLINE_BINS. */
export function bumpSparkline(bins: number[]): number[] {
  // `?? 0`: an agent whose bins never got seeded (rehydrated state, or a
  // tool/iteration event arriving before 'spawned') made this `undefined + 1`
  // = NaN — and the shift below then carries that NaN through every later
  // bump, so the sparkline stays broken for the life of the agent.
  return [(bins[0] ?? 0) + 1, ...bins.slice(0, SPARKLINE_BINS - 1)];
}

export function clampContextPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}
