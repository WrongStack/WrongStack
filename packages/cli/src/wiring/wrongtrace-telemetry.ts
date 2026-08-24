/**
 * WrongTrace session telemetry — the session-completion reporting hook.
 *
 * The daemon's /api/telemetry endpoint exists and answers 200 {ok:true}
 * (verified live 2026-08-24), so WrongStack reports one summary per
 * finished session: run id, agent/model/provider identity, token usage,
 * and cost. This is what lets the daemon attribute activity (friction
 * matrices, file lineage) to WrongStack sessions.
 *
 * Fail-open by construction: daemon offline → reportTelemetry returns
 * null and this helper resolves without side effects; any throw is
 * swallowed so session cleanup is never delayed or blocked by it.
 */

import type { WrongTraceTelemetryReport } from '@wrongstack/wrongtrace';

import { getWrongTrace } from './wrongtrace-gate.js';

/** Inputs the session-completion path already has in hand. */
export interface WrongTraceTelemetryInput {
  sessionId: string;
  /** Stable agent identity, e.g. 'wrongstack-cli'. */
  agentName: string;
  model: string;
  provider: string;
  /** Cumulative session usage from tokenCounter.total(). */
  usage: {
    input: number;
    output: number;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  };
  /** Session cost in USD from tokenCounter.estimateCost().total. */
  costUsd: number;
}

/**
 * Pure mapping to the daemon's POST /api/telemetry contract. Cache fields
 * ride along as extras (the payload allows free-form pass-through), so
 * downstream attribution keeps the full token picture.
 */
export function buildWrongTraceTelemetryReport(input: WrongTraceTelemetryInput): WrongTraceTelemetryReport {
  return {
    run_id: input.sessionId,
    agent_name: input.agentName,
    model_name: input.model,
    provider: input.provider,
    prompt_tokens: input.usage.input,
    completion_tokens: input.usage.output,
    cost_usd: input.costUsd,
    intent: 'session_complete',
    cache_read_tokens: input.usage.cacheRead ?? 0,
    cache_write_tokens: input.usage.cacheWrite ?? 0,
    source: 'wrongstack',
  };
}

/**
 * Report session telemetry, best-effort. Never throws: an offline daemon,
 * transport failure, or malformed response resolves silently — telemetry
 * must never delay or fail session cleanup.
 *
 * Optional client injection is a test seam; production uses the singleton.
 */
export async function reportWrongTraceSessionTelemetry(
  input: WrongTraceTelemetryInput,
  opts: { client?: { isAvailable: boolean; reportTelemetry: (r: WrongTraceTelemetryReport) => Promise<{ ok: boolean } | null> } } = {},
): Promise<void> {
  try {
    const wt = opts.client ?? (await getWrongTrace());
    if (!wt.isAvailable) return;
    await wt.reportTelemetry(buildWrongTraceTelemetryReport(input));
  } catch {
    // Fail-open: coordination telemetry is never load-bearing.
  }
}
