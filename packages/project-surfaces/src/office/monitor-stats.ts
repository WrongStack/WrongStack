import type { ClientCounts, LiveSession } from './types';

/** Project-wide totals summed across every live session's agents. */
export interface FleetAggregate {
  toolCalls: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** Map a registry surface to one of the office-map client buckets. CLI/REPL
 *  sessions land in the `repl` bucket; anything unknown defaults to `webui`. */
export function clientBucket(clientType: string | undefined): keyof ClientCounts {
  switch (clientType) {
    case 'tui':
      return 'tui';
    case 'cli':
    case 'repl':
      return 'repl';
    case 'webui':
      return 'webui';
    default:
      return 'webui';
  }
}

/** Derive client counts, agent totals, and project-wide cost/token/tool
 *  aggregates from a live-session snapshot. */
export function deriveMonitorStats(sessions: LiveSession[]): {
  clientCounts: ClientCounts;
  totalAgents: number;
  activeAgents: number;
  aggregate: FleetAggregate;
} {
  const clientCounts: ClientCounts = { tui: 0, webui: 0, repl: 0 };
  let totalAgents = 0;
  let activeAgents = 0;
  const aggregate: FleetAggregate = { toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
  for (const s of sessions) {
    clientCounts[clientBucket(s.clientType)] += 1;
    for (const a of s.agents) {
      totalAgents += 1;
      if (a.status === 'running' || a.status === 'streaming') activeAgents += 1;
      aggregate.toolCalls += a.toolCalls ?? 0;
      aggregate.costUsd += a.costUsd ?? 0;
      aggregate.tokensIn += a.tokensIn ?? 0;
      aggregate.tokensOut += a.tokensOut ?? 0;
    }
  }
  return { clientCounts, totalAgents, activeAgents, aggregate };
}
