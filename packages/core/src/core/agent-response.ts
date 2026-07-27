/**
 * Response processing handler — extracted from Agent class.
 * Handles provider response pipeline, event emission, session
 * persistence, text rendering, and autonomous continuation parsing.
 */

import { isTextBlock, type TextBlock } from '../types/blocks.js';
import type { Provider, Request, Response } from '../types/provider.js';
import { deriveCachePrefixKey } from '../utils/cache-key.js';
import {
  buildCompletedWorkLedgerBlock,
  markAssistantReferencedEvidence,
} from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { hasMeaningfulContent, repairToolUseAdjacency } from '../utils/message-invariants.js';
import type { AgentInternals } from './agent-internals.js';
import { type Context, resolveEventSessionId, type RunOptions } from './context.js';
import { type ContinueDirective, parseContinueDirective } from './continue-to-next-iteration.js';
import { bindRequestProvider } from './request-provider-binding.js';

interface ProcessResponseResult {
  finalText: string;
  aborted: boolean;
  done: boolean;
  directive?: ContinueDirective | undefined;
}

export interface AgentResponseHandler {
  buildAndRunRequestPipeline(opts: RunOptions): Promise<{ request: Request; provider: Provider }>;
  processResponse(
    raw: Response,
    req: Request,
    requestProvider?: Provider,
  ): Promise<ProcessResponseResult>;
}

const MAX_TODO_SNAPSHOT_ITEMS = 10;
const MAX_TODO_SNAPSHOT_CONTENT = 180;

/**
 * Build the leader-only, per-request decision gate for `<nextsteps>`.
 *
 * The base system prompt is intentionally frozen for provider caching, while
 * todos change during tool execution. Keeping this block volatile makes the
 * final-response contract follow the live todo state on every iteration.
 */
export function buildLiveNextStepsGateBlock(
  ctx: Pick<Context, 'agentId' | 'todos'>,
): TextBlock | undefined {
  if (ctx.agentId !== 'leader') return undefined;

  const openTodos = ctx.todos.filter(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  );

  if (openTodos.length === 0) {
    return {
      type: 'text',
      text: [
        '[nextsteps_gate]',
        'Authoritative live state for this request: open todos = 0.',
        'On the final response, you MUST take exactly one branch:',
        '1. If at least one genuinely useful follow-on action exists, include a balanced <nextsteps> block containing 1-4 exact prompt messages that can be submitted back to you through the current TUI or WebUI input.',
        'Every item must ask the agent to perform work. Never put a human-only chore or an instruction addressed to the user inside <nextsteps>; natural-language agent-directed imperatives are valid and need not be shell commands.',
        '2. If no useful follow-on action truly exists, omit <nextsteps> and explicitly tell the user in normal prose that no further steps are needed for this task.',
        'Silently omitting both is invalid. Do not decide by chance, tone, or response length, and do not invent filler suggestions.',
        '[/nextsteps_gate]',
      ].join('\n'),
      cache_control: { type: 'ephemeral' },
    };
  }

  const todoSnapshot = openTodos.slice(0, MAX_TODO_SNAPSHOT_ITEMS).map((todo) => {
    const normalized = todo.content.replace(/\s+/g, ' ').trim();
    const content =
      normalized.length > MAX_TODO_SNAPSHOT_CONTENT
        ? `${normalized.slice(0, MAX_TODO_SNAPSHOT_CONTENT - 1)}…`
        : normalized;
    return `- [${todo.status}] ${content}`;
  });
  const omitted = openTodos.length - todoSnapshot.length;
  if (omitted > 0) todoSnapshot.push(`- …and ${omitted} more open todo(s)`);

  return {
    type: 'text',
    text: [
      '[nextsteps_gate]',
      `Authoritative live state for this request: open todos = ${openTodos.length}.`,
      'You MUST omit <nextsteps> entirely while these todos remain open. Continue or finish the tracked work; do not propose unrelated follow-on work.',
      'Open todo snapshot:',
      ...todoSnapshot,
      '[/nextsteps_gate]',
    ].join('\n'),
    cache_control: { type: 'ephemeral' },
  };
}

export function createAgentResponseHandler(a: AgentInternals): AgentResponseHandler {
  // Each assigned prompt array is one explicit cache epoch. Freeze it at the
  // first request boundary so turn-time code cannot silently invalidate the
  // provider prefix by pushing/replacing blocks in place. Lifecycle actions
  // such as a mode switch may assign a new array, which becomes a new epoch.
  const stabilizedPromptEpochs = new WeakSet<TextBlock[]>();

  function stabilizePromptEpoch(): void {
    const prompt = a.ctx.systemPrompt;
    if (stabilizedPromptEpochs.has(prompt)) return;
    for (const block of prompt) {
      if (block.cache_control) Object.freeze(block.cache_control);
      Object.freeze(block);
    }
    Object.freeze(prompt);
    stabilizedPromptEpochs.add(prompt);
  }

  async function buildAndRunRequestPipeline(
    opts: RunOptions,
  ): Promise<{ request: Request; provider: Provider }> {
    // Only scan for tool-use adjacency issues when tool content has been
    // added since the last scan. Pure text responses and iterations without
    // tool calls don't introduce new adjacency problems — skipping the O(n)
    // message-array walk saves ~1-3ms per iteration on large contexts.
    if (a.ctx.toolAdjacencyDirty) {
      const repaired = repairToolUseAdjacency(a.ctx.messages);
      a.ctx.toolAdjacencyDirty = false;
      if (repaired.report.changed) {
        a.ctx.state.replaceMessages(repaired.messages);
        a.events.emit('context.repaired', {
          sessionId: resolveEventSessionId(a.ctx),
          ctx: a.ctx,
          ...repaired.report,
        });
        a.logger.warn(
          `Repaired context tool adjacency: removed ${repaired.report.removedToolUses.length} tool_use block(s), ` +
            `${repaired.report.removedToolResults.length} tool_result block(s), ` +
            `${repaired.report.removedMessages} empty message(s)`,
        );
      }
    }
    stabilizePromptEpoch();
    const volatileLedger = buildCompletedWorkLedgerBlock(a.ctx);
    const liveNextStepsGate = buildLiveNextStepsGateBlock(a.ctx);
    const volatileBlocks = [volatileLedger, liveNextStepsGate].filter(
      (block): block is TextBlock => block !== undefined,
    );
    const system =
      volatileBlocks.length > 0 ? [...a.ctx.systemPrompt, ...volatileBlocks] : a.ctx.systemPrompt;
    // A picker/WebUI switch can still be building a provider while
    // auto-continue prepares the next iteration. Wait immediately before
    // capturing the request identity so that iteration cannot retain the old
    // model by racing the switch.
    await a.ctx.waitForModelTransition();
    // Capture provider and model as one request identity. A live /model switch
    // may replace ctx.provider while the async request pipeline or provider
    // call is pending; this request must still finish under the identity it
    // started with.
    const provider = a.ctx.provider;
    const baseReq: Request = {
      model: opts.model ?? a.ctx.model,
      system,
      messages: a.ctx.messages,
      tools: a.tools.list(),
      // `maxTokens` is deliberately NOT set here. The provider adapter
      // resolves the ceiling from the catalog entry for the model in
      // `req.model`, which is the only source that stays correct across a
      // `/model` switch, a fallback hop, or a subagent on a model-matrix
      // entry — `provider.capabilities` is resolved once, for the model the
      // session booted on, and pinning it here would override the accurate
      // per-request value with a stale one. Callers that genuinely want a
      // smaller response (one-shot LLM helpers, compaction, the brain) still
      // set `maxTokens` on their own Request and keep priority over the
      // catalog.
      // Provider-agnostic cache-partition key from the stable prompt epoch.
      // Wires that support prompt caching (OpenAI `prompt_cache_key`) read it;
      // the config `ttl` is merged over this by the ModelRuntime middleware.
      cache: { key: deriveCachePrefixKey(a.ctx.systemPrompt) },
    };
    const request = await a.pipelines.request.run(baseReq);
    bindRequestProvider(request, provider);
    return { request, provider };
  }

  async function processResponse(
    raw: Response,
    req: Request,
    requestProvider: Provider = a.ctx.provider,
  ): Promise<ProcessResponseResult> {
    let res = raw;
    res = await a.pipelines.response.run(res);
    a.events.emit('provider.response', {
      sessionId: resolveEventSessionId(a.ctx),
      ctx: a.ctx,
      model: req.model,
      content: res.content,
      usage: res.usage,
      stopReason: res.stopReason,
    });
    a.ctx.tokenCounter.account(res.usage, req.model, requestProvider.id);

    // Issue #271: never append or persist a semantically empty assistant
    // response (e.g. a stream interrupted before the first meaningful delta,
    // which the response builders represent as a single empty text block).
    // Strict providers reject empty assistant turns on the next request, and
    // once journaled, the malformed turn survived every repair path. Partial
    // text, tool calls, and thinking content remain meaningful and are kept.
    if (hasMeaningfulContent(res.content)) {
      // Persist the semantic provider response before its exact-state
      // projection. The conversation journal drains independently, so state
      // mutation first can race `message_appended` ahead of `llm_response`.
      await a.ctx.session.append({
        type: 'llm_response',
        ts: new Date().toISOString(),
        content: res.content,
        stopReason: res.stopReason,
        usage: res.usage,
      });
      a.ctx.state.appendMessage({ role: 'assistant', content: res.content });
      // If the assistant emitted tool_use blocks, mark the message adjacency
      // as potentially needing repair before the next provider request.
      if (!a.ctx.toolAdjacencyDirty) {
        for (const block of res.content) {
          if (block.type === 'tool_use') {
            a.ctx.toolAdjacencyDirty = true;
            break;
          }
        }
      }
      // Tool execution is a side-effect boundary: ensure the response containing
      // its tool_use blocks has reached the session writer before any tool runs.
      // FileSessionWriter keeps failed batches queued for retry; alternate
      // writers may reject, which is logged without masking the provider result.
      try {
        await a.ctx.flushConversationJournal();
        await a.ctx.session.flush();
      } catch (err) {
        (a.logger.debug ?? a.logger.warn)?.(`LLM response flush failed: ${toErrorMessage(err)}`);
      }
    } else {
      a.logger.warn('Empty assistant response — not appended to context or session', {
        model: req.model,
        stopReason: res.stopReason,
        aborted: a.ctx.signal.aborted,
      });
    }

    if (a.ctx.signal.aborted) {
      // M3: collect into an array and join at the end. `finalText += block.text`
      // is O(n²) on V8 for many concatenations because each `+=` may allocate
      // a new backing string. For a typical 4-block response this is moot,
      // but the streaming-text path concatenates the *full* response in chunks
      // — and long autonomous loops with verbose reasoning can hit dozens of
      // chunks, making the cost visible. `Array.push` + single `join('')` is
      // amortized O(n).
      const parts: string[] = [];
      for (const block of res.content) {
        if (isTextBlock(block)) parts.push(block.text);
      }
      return { finalText: parts.join(''), aborted: true, done: false };
    }

    const parts: string[] = [];
    const streamed = requestProvider.capabilities.streaming;
    for (const block of res.content) {
      if (isTextBlock(block)) {
        const rendered = await a.pipelines.assistantOutput.run(block);
        parts.push(rendered.text);
        if (!streamed) a.renderer?.write(rendered);
      }
    }
    const finalText = parts.join('');
    markAssistantReferencedEvidence(a.ctx, finalText);

    let directive: ContinueDirective = 'none';
    if (finalText) {
      directive = parseContinueDirective(finalText);
    }

    return { finalText, aborted: false, done: false, directive };
  }

  return { buildAndRunRequestPipeline, processResponse };
}
