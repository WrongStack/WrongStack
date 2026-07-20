/**
 * Tool execution handler — extracted from Agent class for testability.
 * Handles batch tool execution, confirmation flow, and post-execution
 * pipeline/session/event emission.
 */
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { PermissionDecision } from '../types/permission.js';
import type { SessionEvent } from '../types/session.js';
import type { RiskTier, Tool } from '../types/tool.js';
import { recordToolOutputEvidence } from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { sizeSignals, truncateForEvent } from '../utils/tool-output-serializer.js';
import type { AgentInternals } from './agent-internals.js';

/**
 * Tools whose serialized output is a unified diff that UIs render as a
 * colored diff block (TUI `DiffBlock`, WebUI `DiffView`). The default
 * 400-char event-preview cap slices the last visible diff line mid-word
 * (a stray `…`), so these tools get a much larger budget. The serializer
 * already compacts large diffs (≤260 lines via `compactDiff`) and the
 * renderers cap the number of visible rows, so this only needs to be big
 * enough that the shown hunk survives intact.
 */
const DIFF_TOOL_NAMES = new Set(['edit', 'write', 'replace', 'patch', 'diff']);
const DIFF_TOOL_EVENT_PREVIEW_MAX = 16_000;

type ConfirmationChoice = 'yes' | 'no' | 'always' | 'deny' | 'abort';
type ConfirmationResolver = 'user' | 'headless' | 'abort';
interface PendingConfirmationInfo {
  tool: Tool;
  input: unknown;
  toolUseId: string;
  suggestedPattern: string;
  decisionSource?: PermissionDecision['source'] | undefined;
  riskTier?: RiskTier | undefined;
  boundaryReason?: string | undefined;
}

export interface AgentToolHandler {
  executeTools(toolUses: ToolUseBlock[]): Promise<ToolResultBlock[]>;
  executeSingleWithDecision(
    tool: Tool,
    use: { id: string; name: string; input: unknown },
  ): Promise<{ result: ToolResultBlock; durationMs: number }>;
}

export function createAgentToolHandler(a: AgentInternals): AgentToolHandler {
  async function executeSingleWithDecision(
    tool: Tool,
    use: { id: string; name: string; input: unknown },
  ): Promise<{ result: ToolResultBlock; durationMs: number }> {
    const start = Date.now();
    try {
      // The provider always sends properly typed tool_use blocks through
      // JSON deserialization. The executor needs the `type: 'tool_use'`
      // discriminant and `input: Record<string, unknown>`, so we construct
      // the full shape explicitly rather than using a blind `as ToolUseBlock`
      // cast that would silence a missing `type` field.
      const result = await a.toolExecutor.executeTool(
        tool,
        {
          type: 'tool_use' as const,
          id: use.id,
          name: use.name,
          input: use.input as Record<string, unknown>,
        },
        a.ctx,
        a.perIterationOutputCapBytes,
      );
      // H2: `result` is now { block, bytes }. The executeTools caller
      // gets the block; the `bytes` field is for budget accounting
      // (caller of *this* function already has the budget, so we
      // surface `block` only here and let it handle the bytes).
      return { result: result.block, durationMs: Date.now() - start };
    } catch (err) {
      const msg = toErrorMessage(err);
      return {
        result: {
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Tool "${tool.name}" threw: ${msg}`,
          is_error: true,
        },
        durationMs: Date.now() - start,
      };
    }
  }

  function emitConfirmationResolved(
    info: PendingConfirmationInfo,
    choice: ConfirmationChoice,
    resolver: ConfirmationResolver,
  ): void {
    a.events.emit('permission.confirmation_resolved', {
      sessionId: a.ctx.session.id,
      ...(a.ctx.traceId ? { traceId: a.ctx.traceId } : {}),
      ...(a.ctx.agentId ? { agentId: a.ctx.agentId } : {}),
      name: info.tool.name,
      id: info.toolUseId,
      choice,
      resolution:
        choice === 'yes' || choice === 'always'
          ? 'approved'
          : choice === 'abort'
            ? 'cancelled'
            : 'denied',
      resolver,
      decisionSource: info.decisionSource,
      riskTier: info.riskTier,
      boundaryReason: info.boundaryReason,
    });
  }

  function waitForConfirm(info: PendingConfirmationInfo): Promise<ConfirmationChoice> {
    // Headless deadlock guard (P1 #4, before-release.md): if no UI layer has
    // subscribed to `tool.confirm_needed`, emitting the event leaves the
    // resolver promise pending forever — the tool neither executes nor fails
    // and the agent appears stuck. This happens in headless/CI/test runs that
    // construct a minimal agent without wiring a TUI/WebUI confirm handler.
    // Fall back to `deny` so the tool surfaces an error the model can react
    // to, instead of hanging silently.
    if (a.events.listenerCount('tool.confirm_needed') === 0) {
      // Structured warning to stdout — matches the observability skill's JSON
      // log convention. Kept off the session store to avoid coupling the
      // permission fallback to SessionWriter availability.
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'confirm.headless_fallback',
          tool: info.tool.name,
          toolUseId: info.toolUseId,
          message: `No tool.confirm_needed listener — auto-denying "${info.tool.name}" to avoid headless deadlock.`,
        }),
      );
      emitConfirmationResolved(info, 'deny', 'headless');
      return Promise.resolve('deny' as const);
    }
    return new Promise<ConfirmationChoice>((resolve) => {
      // Abort-awareness: /interrupt, Esc, or a parent abort must not leave the
      // run blocked on a confirmation nobody will answer. Resolve as 'abort'
      // — NOT 'no' — so the caller skips the denyOnce side effect (a
      // session-scoped deny minted by an interrupt would silently block this
      // tool+pattern for the rest of the session). The settlement guard also
      // prevents a late UI answer from emitting a second resolution event.
      const signal = a.ctx.signal;
      let settled = false;
      const settle = (choice: ConfirmationChoice, resolver: ConfirmationResolver): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        emitConfirmationResolved(info, choice, resolver);
        resolve(choice);
      };
      const onAbort = () => settle('abort', 'abort');
      if (signal.aborted) {
        settle('abort', 'abort');
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      a.events.emit('tool.confirm_needed', {
        sessionId: a.ctx.session.id,
        tool: info.tool,
        input: info.input,
        toolUseId: info.toolUseId,
        suggestedPattern: info.suggestedPattern,
        decisionSource: info.decisionSource,
        riskTier: info.riskTier,
        boundaryReason: info.boundaryReason,
        resolve: (choice) => settle(choice, 'user'),
      });
    });
  }

  function emitToolExecuted(
    toolUseId: string,
    toolName: string,
    durationMs: number,
    ok: boolean,
    input: unknown,
    content: string,
  ): void {
    const sig = sizeSignals(toolName, content);
    const metadata = recordToolOutputEvidence(a.ctx, {
      toolUseId,
      toolName,
      input,
      content,
      ok,
      outputBytes: sig.outputBytes,
      outputTokens: sig.outputTokens,
      outputLines: sig.outputLines,
    });
    a.events.emit('tool.executed', {
      sessionId: a.ctx.session.id,
      ...(a.ctx.traceId ? { traceId: a.ctx.traceId } : {}),
      agentId: a.ctx.agentId,
      agentName: a.ctx.agentName,
      id: toolUseId,
      name: toolName,
      durationMs,
      ok,
      input,
      output: truncateForEvent(
        content,
        DIFF_TOOL_NAMES.has(toolName) ? DIFF_TOOL_EVENT_PREVIEW_MAX : undefined,
      ),
      outputBytes: sig.outputBytes,
      outputTokens: sig.outputTokens,
      outputLines: sig.outputLines,
      metadata,
    });
  }

  async function executeTools(toolUses: ToolUseBlock[]): Promise<ToolResultBlock[]> {
    const selectedToolUses = await a.extensions.runBeforeToolExecution(a.ctx, toolUses);

    const { outputs } = await a.toolExecutor.executeBatch(
      selectedToolUses,
      a.ctx,
      a.executionStrategy,
    );

    const useById = new Map(selectedToolUses.map((u) => [u.id, u]));
    const resultsForMessage: ToolResultBlock[] = [];
    const sessionEvents: SessionEvent[] = [];

    for (const { result, tool, durationMs } of outputs) {
      if (result.type === 'tool_confirm_pending' && tool) {
        const decision = await waitForConfirm({
          tool: tool,
          input: result.input,
          toolUseId: result.toolUseId,
          suggestedPattern: result.suggestedPattern,
          decisionSource: result.decisionSource,
          riskTier: result.riskTier,
          boundaryReason: result.boundaryReason,
        });

        // Persist trust/deny rules
        if (decision === 'always') {
          try {
            await a.permission.trust({ tool: tool.name, pattern: result.suggestedPattern });
            a.events.emit('trust.persisted', {
              sessionId: a.ctx.session.id,
              tool: tool.name,
              pattern: result.suggestedPattern,
              decision,
            });
          } catch {
            /* best-effort */
          }
        } else if (decision === 'deny') {
          try {
            await a.permission.deny({ tool: tool.name, pattern: result.suggestedPattern });
            a.events.emit('trust.persisted', {
              sessionId: a.ctx.session.id,
              tool: tool.name,
              pattern: result.suggestedPattern,
              decision,
            });
          } catch {
            /* best-effort */
          }
        }

        // Soft allow/deny for session-scoped retry prevention
        if (decision === 'yes') {
          const p = a.permission as never as {
            allowOnce?(r: { tool: string; pattern: string }): void;
          };
          p.allowOnce?.({ tool: tool.name, pattern: result.suggestedPattern });
        } else if (decision === 'no') {
          const p = a.permission as never as {
            denyOnce?(r: { tool: string; pattern: string }): void;
          };
          p.denyOnce?.({ tool: tool.name, pattern: result.suggestedPattern });
        }

        const reRunResult =
          decision === 'yes' || decision === 'always'
            ? await executeSingleWithDecision(tool, {
                id: result.toolUseId,
                name: tool.name,
                input: result.input,
              })
            : {
                result: {
                  type: 'tool_result' as const,
                  tool_use_id: result.toolUseId,
                  content:
                    decision === 'abort'
                      ? `Tool "${tool.name}" was not executed — the run was aborted while awaiting confirmation.`
                      : decision === 'deny'
                        ? `Tool "${tool.name}" denied and blocked for this pattern.`
                        : `Tool "${tool.name}" denied by user.`,
                  is_error: true,
                },
                durationMs: 0,
              };

        const use = useById.get(reRunResult.result.tool_use_id);
        if (use) {
          await a.pipelines.toolCall.run({
            toolUse: use,
            result: reRunResult.result,
            ctx: a.ctx,
            tool,
          });
          sessionEvents.push({
            type: 'tool_result',
            ts: new Date().toISOString(),
            id: reRunResult.result.tool_use_id,
            content: reRunResult.result.content,
            isError: !!reRunResult.result.is_error,
          });
          emitToolExecuted(
            reRunResult.result.tool_use_id,
            tool.name,
            reRunResult.durationMs,
            !reRunResult.result.is_error,
            result.input,
            reRunResult.result.content,
          );
        }
        resultsForMessage.push(reRunResult.result);
        continue;
      }

      // Non-pending: already a resolved tool_result
      if (result.type !== 'tool_result') continue;
      resultsForMessage.push(result);
      const use = useById.get(result.tool_use_id);
      if (!use) continue;
      await a.pipelines.toolCall.run({ toolUse: use, result, ctx: a.ctx, tool: tool ?? undefined });
      sessionEvents.push({
        type: 'tool_result',
        ts: new Date().toISOString(),
        id: result.tool_use_id,
        content: result.content,
        isError: !!result.is_error,
      });
      emitToolExecuted(
        result.tool_use_id,
        use.name,
        durationMs,
        !result.is_error,
        use.input,
        result.content,
      );
    }

    // Batch-append all tool_result events to the session log in one call.
    // This replaces N sequential append() calls (one per tool result) with a
    // single batch write, avoiding N-1 function calls, scrub/observe cycles,
    // and timer rescheduling overhead.
    if (sessionEvents.length > 0) {
      await a.ctx.session.appendBatch(sessionEvents);
    }

    // Merge any pending PostToolUse separate context as a leading text block
    // in the same user message as the tool results — this keeps tool-use/
    // tool-result adjacency intact. The context text was stored on ctx by
    // the tool executor when a PostToolUse hook returned contextAs='separate'.
    const pendingContext = a.ctx.pendingPostToolContext;
    a.ctx.pendingPostToolContext = undefined;
    const contentBlocks: ContentBlock[] = pendingContext
      ? [{ type: 'text', text: pendingContext }, ...resultsForMessage]
      : resultsForMessage;
    a.ctx.state.appendMessage({ role: 'user', content: contentBlocks });
    // Tool results were added — mark adjacency as potentially needing repair
    // before the next provider request.
    if (contentBlocks.length > 0) {
      a.ctx.toolAdjacencyDirty = true;
    }
    // A completed tool may already have changed the filesystem. Persist the
    // legacy tool_result records AND the exact combined user message (including
    // PostToolUse context) before another provider call or crash can observe a
    // half-journaled conversation.
    try {
      await a.ctx.flushConversationJournal();
      await a.ctx.session.flush();
    } catch (err) {
      (a.logger.debug ?? a.logger.warn)?.(
        `tool result boundary flush failed: ${toErrorMessage(err)}`,
      );
    }
    await a.extensions.runAfterToolExecution(a.ctx, outputs);
    return resultsForMessage;
  }

  return { executeTools, executeSingleWithDecision };
}
