/**
 * Hybrid stats source for the auto-thinning pipeline. The Chronicle rollup
 * (`tool_daily`) is the cross-session source of truth; the in-process bridge
 * Map fills the gap when Chronicle is unavailable (no node:sqlite at runtime)
 * or hasn't been refreshed yet. The source returns a unified
 * `UnderusedToolCandidate[]` so the policy layer never has to branch on
 * which backend answered.
 *
 * The resolver prefers Chronicle whenever it has at least one row in the
 * requested window — even when the in-process Map also has data, because the
 * cross-session history is what the user actually wants to thin against.
 */

import type {
  ChronicleMetricsStore,
  ChronicleUnderusedToolRow,
} from '../chronicle/metrics-store.js';
import type { ToolUsageSnapshot } from './event-bridge.js';

export interface UnderusedToolCandidate {
  /** Stable tool name. For MCP names, this is the full `mcp__server__tool` form. */
  name: string;
  invocations: number;
  failures: number;
  durationMsTotal: number;
  /** Epoch ms; null when the tool has never been observed in the source's window. */
  lastInvokedAt: number | null;
  /** Calendar days since `lastInvokedAt`; null when the tool was never observed. */
  daysSinceLastUse: number | null;
  /** Which backend produced the row — useful for the slash command's "source" badge. */
  source: 'chronicle' | 'in-process';
}

export interface UnderusedQueryOptions {
  /** Calendar days of inactivity. Tools not invoked in this window are candidates. */
  idleDays: number;
  /** Tools with `invocations <= minInvocations` in the window are candidates. */
  minInvocations: number;
  /** Inclusive lower bound on the Chronicle day range (YYYY-MM-DD). */
  fromDay?: string;
  /** Inclusive upper bound on the Chronicle day range (YYYY-MM-DD). */
  toDay?: string;
  /** Cap on the returned candidate set. Default 500. */
  limit?: number;
}

export interface ToolUsageSource {
  kind: 'chronicle' | 'in-process';
  candidates(opts: UnderusedQueryOptions): Promise<UnderusedToolCandidate[]>;
  /** Force Chronicle to fold any new journal bytes before answering. */
  refresh?(): Promise<void>;
}

export interface CreateToolUsageSourceDeps {
  chronicle?: ChronicleMetricsStore | undefined;
  bridge?: ToolUsageSnapshot | undefined;
  /**
   * Wall-clock anchor for "days since last use". Defaults to `Date.now()`. Tests
   * pass a fixed value to make the boundary deterministic.
   */
  now?: () => number;
}

const DEFAULT_LIMIT = 500;

function daysBetween(later: number, earlier: number): number {
  return Math.max(0, Math.floor((later - earlier) / 86_400_000));
}

function chronicleCandidates(
  store: ChronicleMetricsStore,
  opts: UnderusedQueryOptions,
  now: number,
): UnderusedToolCandidate[] {
  const rows: ChronicleUnderusedToolRow[] = store.underusedTools({
    ...(opts.fromDay !== undefined ? { from: opts.fromDay } : {}),
    ...(opts.toDay !== undefined ? { to: opts.toDay } : {}),
    limit: opts.limit ?? DEFAULT_LIMIT,
  });
  return rows.map((row) => ({
    name: row.toolName,
    invocations: row.invocations,
    failures: row.failures,
    durationMsTotal: row.durationMsTotal,
    lastInvokedAt: row.lastInvokedAt,
    daysSinceLastUse: row.lastInvokedAt === null ? null : daysBetween(now, row.lastInvokedAt),
    source: 'chronicle' as const,
  }));
}

function inProcessCandidates(
  usage: ToolUsageSnapshot,
  opts: UnderusedQueryOptions,
  now: number,
): UnderusedToolCandidate[] {
  const windowStart = now - opts.idleDays * 86_400_000;
  const out: UnderusedToolCandidate[] = [];
  for (const [name, rec] of usage) {
    // The in-process Map records absolute wall-clock times; "in the window"
    // means `firstInvokedAt` falls before the window's right edge AND the
    // tool is older than `idleDays` since its last use. A tool invoked in
    // the last `idleDays` is NOT underused regardless of count.
    if (rec.lastInvokedAt >= windowStart) continue;
    out.push({
      name,
      invocations: rec.invocations,
      failures: rec.failures,
      durationMsTotal: rec.durationMsTotal,
      lastInvokedAt: rec.lastInvokedAt,
      daysSinceLastUse: daysBetween(now, rec.lastInvokedAt),
      source: 'in-process' as const,
    });
  }
  out.sort((a, b) => a.invocations - b.invocations || a.name.localeCompare(b.name));
  return out.slice(0, opts.limit ?? DEFAULT_LIMIT);
}

export function createToolUsageSource(deps: CreateToolUsageSourceDeps): ToolUsageSource {
  const now = deps.now ?? (() => Date.now());

  if (deps.chronicle) {
    const store = deps.chronicle;
    return {
      kind: 'chronicle',
      async candidates(opts: UnderusedQueryOptions): Promise<UnderusedToolCandidate[]> {
        await store.refresh();
        return chronicleCandidates(store, opts, now());
      },
      async refresh(): Promise<void> {
        await store.refresh();
      },
    };
  }

  if (deps.bridge) {
    const usage = deps.bridge;
    return {
      kind: 'in-process',
      async candidates(opts: UnderusedQueryOptions): Promise<UnderusedToolCandidate[]> {
        return inProcessCandidates(usage, opts, now());
      },
    };
  }

  // No backend at all — return an empty list rather than throwing, so a host
  // that boots without Chronicle and without the metrics flag still has a
  // valid (empty) source for the policy layer to no-op against.
  return {
    kind: 'in-process',
    async candidates(): Promise<UnderusedToolCandidate[]> {
      return [];
    },
  };
}

/**
 * Apply the auto-thinning policy to a candidate set: keep only tools that
 *   - have been seen (or never seen but the source is in-process),
 *   - sit at or below `minInvocations` in the window, AND
 *   - have not been invoked in the last `idleDays` days.
 *
 * Pure function so the policy is testable without I/O.
 */
export function filterUnderused(
  candidates: readonly UnderusedToolCandidate[],
  opts: UnderusedQueryOptions,
  now: number = Date.now(),
): UnderusedToolCandidate[] {
  const windowStart = now - opts.idleDays * 86_400_000;
  return candidates.filter((c) => {
    if (c.invocations > opts.minInvocations) return false;
    if (c.lastInvokedAt === null) return true;
    return c.lastInvokedAt < windowStart;
  });
}
