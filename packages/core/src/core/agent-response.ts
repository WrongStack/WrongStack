/**
 * Response processing handler — extracted from Agent class.
 * Handles provider response pipeline, event emission, session
 * persistence, text rendering, and autonomous continuation parsing.
 */
import type { Request, Response } from '../types/provider.js';
import { isTextBlock, type TextBlock } from '../types/blocks.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { buildCompletedWorkLedgerBlock, markAssistantReferencedEvidence } from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { parseContinueDirective, type ContinueDirective } from './continue-to-next-iteration.js';
import type { Context, RunOptions } from './context.js';
import type { AgentInternals } from './agent-internals.js';

export interface ProcessResponseResult {
  finalText: string;
  aborted: boolean;
  done: boolean;
  directive?: ContinueDirective | undefined;
}

export interface AgentResponseHandler {
  buildAndRunRequestPipeline(opts: RunOptions): Promise<Request>;
  processResponse(raw: Response, req: Request): Promise<ProcessResponseResult>;
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
        '1. If at least one genuinely useful follow-on action exists, include a balanced <nextsteps> block containing 1-4 concrete prompts the user can type.',
        '2. If no useful follow-on action truly exists, omit <nextsteps> and explicitly tell the user in normal prose that no further steps are needed for this task.',
        'Silently omitting both is invalid. Do not decide by chance, tone, or response length, and do not invent filler suggestions.',
        '[/nextsteps_gate]',
      ].join('\n'),
      cache_control: { type: 'ephemeral' },
    };
  }

  const todoSnapshot = openTodos.slice(0, MAX_TODO_SNAPSHOT_ITEMS).map((todo) => {
    const normalized = todo.content.replace(/\s+/g, ' ').trim();
    const content = normalized.length > MAX_TODO_SNAPSHOT_CONTENT
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

  async function buildAndRunRequestPipeline(opts: RunOptions): Promise<Request> {
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
          sessionId: a.ctx.session.id,
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
    const system = volatileBlocks.length > 0
      ? [...a.ctx.systemPrompt, ...volatileBlocks]
      : a.ctx.systemPrompt;
    const baseReq: Request = {
      model: opts.model ?? a.ctx.model,
      system,
      messages: a.ctx.messages,
      tools: a.tools.list(),
      // Default to the provider's model-native output ceiling so subagents
      // (Chimera, etc.) can run long reports up to the model's actual
      // limit. The provider adapter's `buildBody` substitutes its own
      // fallback (`ctx.capabilities.maxOutput ?? 8192`) when this is
      // absent — keeping the field optional at the wire layer is what
      // lets the catalog-driven ceiling reach the API untouched.
      maxTokens: a.ctx.provider.capabilities.maxOutput,
    };
    return a.pipelines.request.run(baseReq);
  }

  async function processResponse(raw: Response, req: Request): Promise<ProcessResponseResult> {
    let res = raw;
    res = await a.pipelines.response.run(res);
    a.events.emit('provider.response', {
      sessionId: a.ctx.session.id,
      ctx: a.ctx,
      model: req.model,
      content: res.content,
      usage: res.usage,
      stopReason: res.stopReason,
    });
    a.ctx.tokenCounter.account(res.usage, req.model);

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
    await a.ctx.session.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: res.content,
      stopReason: res.stopReason,
      usage: res.usage,
    });
    // Tool execution is a side-effect boundary: ensure the response containing
    // its tool_use blocks has reached the session writer before any tool runs.
    // FileSessionWriter keeps failed batches queued for retry; alternate
    // writers may reject, which is logged without masking the provider result.
    try {
      await a.ctx.session.flush();
    } catch (err) {
      (a.logger.debug ?? a.logger.warn)?.(
        `LLM response flush failed: ${toErrorMessage(err)}`,
      );
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
    const streamed = a.ctx.provider.capabilities.streaming;
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
