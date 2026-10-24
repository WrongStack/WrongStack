import type { ContextBreakdown } from '@wrongstack/core/agent';
import type { HistoryRetention, RequestResidency } from '@wrongstack/core/utils';
import type { MemoryContextMonitorState } from '../memory-context-monitor.js';
// The bracket-style `[000o····]` meter is the statusline's context bar; reuse
// it here so the panel's fill bars mirror the statusline instead of using a
// second (block `█░`) visual language.

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContextPanelData {
  ctxPct: number | undefined;
  ctxTokens: number | undefined;
  ctxMaxTokens: number | undefined;
  provider: string;
  model: string;
  mode: string;
  uptime: string;
  /**
   * Cumulative prompt-cache stats from the per-session TokenCounter.
   * Surfaced in the panel so `/context` answers "how much of my spend
   * is hitting the cache" without asking the user to chase the CLI
   * `/context cache` subcommand.
   *
   * `savedUsd` is the gross read-discount USD figure computed by the
   * counter (cache-read tokens × (input price − cache-read price)).
   * `cacheWrite5m` / `cacheWrite1h` are present when the upstream exposed
   * an Anthropic-style TTL split (Anthropic family, including MiniMax
   * routed through the Anthropic Messages surface); OpenAI-family
   * gateways emit only the aggregate and leave them undefined.
   */
  cacheStats?:
    | {
        readTokens: number;
        writeTokens: number;
        cacheWrite5m?: number | undefined;
        cacheWrite1h?: number | undefined;
        hitRatio: number;
        savedUsd: number;
        /** Last provider-reported request on its own; `hitRatio` is cumulative. */
        last?: { hitRatio: number } | undefined;
      }
    | undefined;
  /**
   * How far the cached prefix reaches through the live request, in
   * tokens. Drawn on the per-request coverage meter so users see the
   * exact extent of the cache, not just a percentage.
   */
  cacheCoverageTokens?: number | undefined;
  /** Session cache telemetry split by provider, including fallback/model switches. */
  providerCacheStats?:
    | Array<{
        provider: string;
        input: number;
        cacheRead: number;
        cacheWrite: number;
        cacheWrite5m?: number | undefined;
        cacheWrite1h?: number | undefined;
        hitRatio: number;
      }>
    | undefined;
  /**
   * Real, measured per-category token accounting for the live request. When
   * present the Composition tab shows honest numbers; when absent (no request
   * has been assembled yet) the tab shows an empty state instead of fabricated
   * percentages.
   */
  breakdown: ContextBreakdown | undefined;
  /**
   * Cache residency of the last request — which segments were served from the
   * prompt cache, written, or never cached, and what broke the cache. Absent
   * before the first request.
   */
  residency?: RequestResidency | undefined;
  /** Which history survives the next compaction (preserve window, elision). */
  retention?: HistoryRetention | undefined;
  fleetEntries: Array<{
    name: string;
    status: string;
    currentTool: string | undefined;
    ctxPct: number | undefined;
  }>;
  leaderIterations: number;
  leaderToolCalls: number;
  leaderStatus: string;
  memoryContext: MemoryContextMonitorState;
}
