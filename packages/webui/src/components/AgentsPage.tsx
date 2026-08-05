import type { SubagentView } from '@/stores';
import { bucketActivity, fmtCost, fmtDuration, fmtElapsed, sparkline } from './AgentsPage/format';

// Pure formatters live in ./AgentsPage/format. Re-exported here so existing
// imports from '../AgentsPage' keep resolving (e.g. agents-page.test.ts).
export { bucketActivity, fmtCost, fmtDuration, fmtElapsed, sparkline };

// ── Leader entry (Agent #0) synthesised from session data ──────────────

interface LeaderEntry {
  id: 'leader';
  name: string;
  /** Session this leader belongs to. */
  sessionId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  status: 'running' | 'idle';
  iterations: number;
  toolCalls: number;
  costUsd: number;
  ctxPct: number;
  ctxTokens: number;
  maxContext: number;
  startedAt: number;
  lastEventAt: number;
  extensions: number;
  currentTool?: string | undefined;
  toolLog: SubagentView['toolLog'];
  partialText?: string | undefined;
  finalText?: string | undefined;
  error?: { kind: string | undefined; message: string } | undefined;
  /** Human-readable description of the current task. */
  description?: string | undefined;
  /** Budget warning if hitting a soft limit. */
  budgetWarning?: { kind: string; used: number; limit: number } | undefined;
  /** Per-agent token usage. */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  /** Sparkline bins for activity visualization. */
  sparklineBins?: number[];
}

type AgentView = SubagentView | LeaderEntry;

export function getLastEventAt(a: AgentView): number {
  if (a.id === 'leader') return (a as LeaderEntry).lastEventAt;
  return (a as SubagentView).completedAt ?? (a as SubagentView).startedAt;
}

export function getIterations(a: AgentView): number {
  if (a.id === 'leader') return (a as LeaderEntry).iterations;
  return (a as SubagentView).iteration;
}
