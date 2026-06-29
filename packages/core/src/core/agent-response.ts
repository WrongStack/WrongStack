/**
 * Response processing handler — extracted from Agent class.
 * Handles provider response pipeline, event emission, session
 * persistence, text rendering, and autonomous continuation parsing.
 */
import type { Request, Response } from '../types/provider.js';
import { isTextBlock } from '../types/blocks.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { markAssistantReferencedEvidence } from '../utils/context-evidence.js';
import { parseContinueDirective, type ContinueDirective } from './continue-to-next-iteration.js';
import type { RunOptions } from './context.js';
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

export function createAgentResponseHandler(a: AgentInternals): AgentResponseHandler {
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
    const baseReq: Request = {
      model: opts.model ?? a.ctx.model,
      system: a.ctx.systemPrompt,
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
    // Drain the LLM response to disk in the background. The write starts
    // immediately so the durability window is only the disk round-trip —
    // not the whole tool execution — but we don't block the next provider
    // request on it. Awaited flushes at end-of-turn and checkpoint
    // boundaries provide the synchronous durability for the SIGKILL-mid-tool
    // case at the points that genuinely need it.
    void a.ctx.session.flush().catch(() => {
      /* best-effort — buffered write is retried at the next boundary flush */
    });

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
