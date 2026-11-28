import type { SubagentView } from '@wrongstack/project-surfaces/office/types';
import { compactCount } from './model-picker-details';

/** What an agent row says under its name: model, tokens and tool calls, as far as they are known. */
export interface AgentFacts {
  model?: string | undefined;
  tokens?: string | undefined;
  tools: number;
  /** Share of the agent's context window in use, 0-100; absent when the window is unknown. */
  context?: number | undefined;
}

export function agentFacts(view: SubagentView | undefined): AgentFacts | undefined {
  if (!view) return undefined;
  const tokens = (view.tokensIn ?? 0) + (view.tokensOut ?? 0);
  return {
    model: view.model || undefined,
    tokens: tokens > 0 ? compactCount(tokens) : undefined,
    tools: view.toolCalls,
    context: view.maxContext > 0 ? Math.min(100, Math.max(0, Math.round(view.ctxPct))) : undefined,
  };
}

/** The rail's footer: how many agents still work, how many have settled, and their tokens. */
export function fleetSummary(
  agents: Iterable<SubagentView>,
  leaderId: string | undefined,
  tokensIn: number,
  tokensOut: number,
): { working: number; settled: number; tokens?: string | undefined } {
  let working = 0;
  let settled = 0;
  for (const view of agents) {
    if (view.isLeader || view.id === 'leader' || view.id === leaderId) continue;
    if (view.status === 'running') working += 1;
    else settled += 1;
  }
  const tokens = tokensIn + tokensOut;
  return { working, settled, tokens: tokens > 0 ? compactCount(tokens) : undefined };
}
