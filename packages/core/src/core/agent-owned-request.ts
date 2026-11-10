/**
 * The request for a provider that keeps its own context
 * (`Capabilities.keepsOwnContext`): an ACP agent or WrongForge leading the
 * session. Those providers forward the trailing user message's text to an
 * agent that runs its own system prompt, tools and history, so everything
 * WrongStack composes around a request for a model — the system prompt, the
 * tool schemas, the live-context tail (plan, glossary, ledger, continuity,
 * memory evidence) and the request middleware (memory recall, skill blocks) —
 * either never reaches it or, riding the user message, reaches it as if the
 * user had typed it.
 *
 * The request carries the conversation and only two deliberate additions on
 * its trailing user message: raw mail delivered to the leader (request-scoped,
 * the only route mail has) and the next-steps gate, which is what makes the
 * agent offer the suggestions the TUI and WebUI show. Nothing is measured for
 * the residency report; the turn's point is the agent's own report.
 */
import type { ContentBlock, TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Request } from '@wrongstack/contracts/types/provider';
import { bindRequestHistoryVersion } from '../utils/context-history-version.js';
import { forgetRequestLayout } from '../utils/request-layout.js';
import type { AgentInternals } from './agent-internals.js';
import { agentSessionKey } from './agent-owned-context.js';
import { bindRequestPromptBasis, type RequestPromptBasis } from './context-usage-anchor.js';
import { stripDeliveredNextSteps } from './delivered-next-steps.js';
import { buildLiveNextStepsGateBlock } from './next-steps-gate.js';
import { readNextStepsMode } from './next-steps-required.js';
import { bindRequestConversation } from './request-conversation-binding.js';
import { bindRequestProvider } from './request-provider-binding.js';
import { requestScopedEntries } from './request-scoped-context.js';

export function buildAgentOwnedRequest(
  a: AgentInternals,
  provider: Provider,
  model: string,
  historyVersion: number,
  promptBasis: RequestPromptBasis,
): Request {
  const ctx = a.ctx;
  // The previous route's measurement would otherwise stand in for this one.
  forgetRequestLayout(ctx);
  const additions: TextBlock[] = requestScopedEntries(ctx).map((entry) => entry.block);
  // The agent never sees WrongStack's system prompt, so the gate carries the
  // whole policy, and it cannot call WrongStack's `nextsteps` tool directly.
  const gate = buildLiveNextStepsGateBlock({ ...ctx, tools: [] }, readNextStepsMode(a), false);
  if (gate) additions.push(gate);
  const sessionId = agentSessionKey(ctx);
  const threadId = ctx.activeRunSessionId ?? ctx.session?.id;
  const request: Request = {
    model,
    messages: withTrailingBlocks(stripDeliveredNextSteps(ctx.messages), additions),
    cache: { sessionId, threadId },
  };
  bindRequestConversation(request, { meta: ctx.meta, sessionId });
  bindRequestProvider(request, provider);
  bindRequestHistoryVersion(request, historyVersion);
  bindRequestPromptBasis(request, promptBasis);
  return request;
}

/** The blocks after the trailing user message's own content, or as one of their own. */
function withTrailingBlocks(history: readonly Message[], blocks: readonly TextBlock[]): Message[] {
  const out = history.slice();
  if (blocks.length === 0) return out;
  const fresh = blocks.map((block): TextBlock => ({ type: 'text', text: block.text }));
  const last = out[out.length - 1];
  if (last?.role !== 'user') {
    out.push({ role: 'user', content: fresh });
    return out;
  }
  const content: ContentBlock[] =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : last.content.slice();
  out[out.length - 1] = { ...last, content: [...content, ...fresh] };
  return out;
}
