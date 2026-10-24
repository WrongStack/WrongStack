/**
 * Tool execution handler — extracted from Agent class for testability.
 * Handles batch tool execution, confirmation flow, and post-execution
 * pipeline/session/event emission.
 */

import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type {
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@wrongstack/contracts/types/blocks';
import type { NestedToolCaller } from '@wrongstack/contracts/types/context';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import type { Tool, ToolSettlement } from '@wrongstack/contracts/types/tool';
import type { BrainRisk } from '../brain/brain.js';
import { describeWriteTargets } from '../security/permission-helpers.js';
import {
  approvalRecord,
  DEFAULT_ALWAYS_TRUST_TTL_MS,
  isPersistentApproval,
  userRuleAnswer,
} from '../security/scoped-approval.js';
import { recordToolOutputEvidence } from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { capSageLines, splitSageOutputBlock } from '../utils/sage-output-block.js';
import { sizeSignals, truncateForEvent } from '../utils/tool-output-serializer.js';
import { programmaticOutput } from '../utils/tool-programmatic-output.js';
import type { AgentInternals } from './agent-internals.js';
import { confirmObserverCount } from './confirm-observers.js';
import { resolveEventSessionId } from './context.js';

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

/**
 * Budget for the SAGE memory block travelling in `tool.executed.sage`. It is
 * kept OUT of the `output` preview budget on purpose: the block is memory, not
 * tool output, and sharing one cap is what used to cut a memory line in half
 * and leak the fragment into the tool body (see `utils/sage-output-block.ts`).
 * The injector itself caps a block at 2800 chars, so this only trims the
 * largest blocks — always by whole memory lines.
 */
const SAGE_EVENT_MAX = 2_000;

/** Human gets this full window before Brain becomes the approval authority. */
export const HUMAN_APPROVAL_TIMEOUT_MS = 120_000;

function approvalBrainRisk(
  riskTier: import('@wrongstack/contracts/types/tool').RiskTier | undefined,
  boundaryReason: string | undefined,
): BrainRisk {
  if (boundaryReason || riskTier === 'destructive') return 'critical';
  if (riskTier === 'safe') return 'low';
  return 'medium';
}

export interface AgentToolHandler {
  executeTools(toolUses: ToolUseBlock[]): Promise<{
    results: ToolResultBlock[];
    settlements: ReadonlyMap<string, ToolSettlement>;
  }>;
  executeSingleWithDecision(
    tool: Tool,
    use: { id: string; name: string; input: unknown; _resultFormat?: 'data' | undefined },
    preToolContext?: { text: string; contextAs: 'inline' | 'separate' },
  ): Promise<{ result: ToolResultBlock; durationMs: number }>;
}

export function createAgentToolHandler(a: AgentInternals): AgentToolHandler {
  async function executeSingleWithDecision(
    tool: Tool,
    use: { id: string; name: string; input: unknown; _resultFormat?: 'data' | undefined },
    preToolContext?: { text: string; contextAs: 'inline' | 'separate' },
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
          ...(use._resultFormat ? { _resultFormat: use._resultFormat } : {}),
        },
        a.ctx,
        a.perIterationOutputCapBytes,
        preToolContext,
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

  function waitForConfirm(info: {
    tool: Tool;
    input: unknown;
    toolUseId: string;
    suggestedPattern: string;
    decisionSource?:
      | import('@wrongstack/contracts/types/permission').PermissionDecision['source']
      | undefined;
    riskTier?: import('@wrongstack/contracts/types/tool').RiskTier | undefined;
    boundaryReason?: string | undefined;
    writeTargets?: string[] | undefined;
  }): Promise<
    'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny' | 'abort'
  > {
    // Headless deadlock guard (P1 #4, before-release.md): if no UI layer has
    // subscribed to `tool.confirm_needed`, emitting the event leaves the
    // resolver promise pending forever — the tool neither executes nor fails
    // and the agent appears stuck. This happens in headless/CI/test runs that
    // construct a minimal agent without wiring a TUI/WebUI confirm handler.
    // Fall back to `no` so the tool surfaces an error the model can react
    // to, instead of hanging silently. Not `deny`: that is the user's
    // "block this pattern forever" answer and writes a permanent trust-file
    // rule — a CI run nobody watched must not leave deny rules behind.
    //
    // Passive observers are subtracted: the HQ approval bridge subscribes to
    // MIRROR prompts a local surface raised, and can never answer on its own.
    // Counting it would have turned every headless auto-deny into a
    // 120-second wait for nobody, just because HQ was connected.
    if (a.events.listenerCount('tool.confirm_needed') - confirmObserverCount() <= 0) {
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
      return Promise.resolve('no' as const);
    }
    return new Promise((resolve) => {
      let settled = false;
      const deadlineAt = Date.now() + HUMAN_APPROVAL_TIMEOUT_MS;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      // Abort-awareness: /interrupt, Esc, or a parent abort must not leave the
      // run blocked on a confirmation nobody will answer. Resolve as 'abort'
      // — NOT 'no' — so the caller skips the denyOnce side effect (a
      // session-scoped deny minted by an interrupt would silently block this
      // tool+pattern for the rest of the session). Resolving twice is a
      // harmless no-op, so a late UI answer after abort is safely ignored.
      const signal = a.ctx.signal;
      const settle = (
        choice:
          | 'yes'
          | 'no'
          | 'always'
          | 'always-exact'
          | 'always-command'
          | 'always-tool'
          | 'deny'
          | 'abort',
        source: 'brain_timeout' | 'abort' | 'user' = 'user',
        rationale?: string,
      ) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        // Emitted for EVERY resolution, not just the timeout/abort ones.
        //
        // A prompt is now shown on more than one surface at a time (the local
        // UI and the HQ dashboard), so "someone answered" has to be an event
        // the other surfaces can see — otherwise HQ keeps offering buttons for
        // a decision that was already made at the keyboard. `settled` makes a
        // second resolve a no-op, so first answer wins and the late one is
        // harmlessly ignored.
        a.events.emit('tool.confirm_resolved', {
          sessionId: resolveEventSessionId(a.ctx),
          toolUseId: info.toolUseId,
          toolName: info.tool.name,
          decision: choice,
          source,
          rationale,
        });
        resolve(choice);
      };
      const onAbort = () => settle('abort', 'abort');
      if (signal.aborted) {
        settle('abort', 'abort');
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      // VULN-001 Phase 2: real destinations from Tool.writeTargets so the
      // prompt shows what the call would write, not just its subject key.
      const writeTargets = info.writeTargets ?? describeWriteTargets(info.tool, info.input);
      timeout = setTimeout(() => {
        void (async () => {
          // YOLO asked because the user's own rule forbids this call. Only the
          // user can lift their rule for a call; nobody answered, so it stays
          // refused — the Brain does not overrule what the user forbade.
          if (info.decisionSource === 'yolo_user_rule') {
            settle(
              'no',
              'brain_timeout',
              'A rule you wrote forbids this call and nobody answered; it stays refused.',
            );
            return;
          }
          const brain = a.container.safeResolve(TOKENS.BrainArbiter);
          if (!brain) {
            settle('no', 'brain_timeout', 'No Brain arbiter is available; denied by default.');
            return;
          }

          const rawContext = {
            tool: info.tool.name,
            input: info.input,
            suggestedPattern: info.suggestedPattern,
            decisionSource: info.decisionSource,
            riskTier: info.riskTier,
            boundaryReason: info.boundaryReason,
            writeTargets,
          };
          const scrubber = a.container.safeResolve(TOKENS.SecretScrubber);
          const safeContext = scrubber
            ? scrubber.scrubObject(rawContext)
            : { ...rawContext, input: '[omitted]' };
          let context: string;
          try {
            context = truncateForEvent(JSON.stringify(safeContext, null, 2), 4_000);
          } catch {
            context = `Tool: ${info.tool.name}; input could not be serialized safely.`;
          }

          try {
            const decision = await brain.decide({
              id: `tool-approval-timeout:${info.toolUseId}`,
              sessionId: resolveEventSessionId(a.ctx),
              source: 'tool',
              question: `The human did not answer within 120 seconds. Should tool "${info.tool.name}" run once?`,
              context,
              options: [
                {
                  id: 'approve',
                  label: 'Approve this tool call once',
                  consequence: 'The pending tool call executes with its submitted arguments.',
                  risk: approvalBrainRisk(info.riskTier, info.boundaryReason),
                },
                {
                  id: 'reject',
                  label: 'Reject this tool call',
                  consequence: 'The tool does not execute and the agent must continue safely.',
                  risk: 'low',
                },
              ],
              risk: approvalBrainRisk(info.riskTier, info.boundaryReason),
              fallback: 'ask_human',
              allowHumanEscalation: false,
            });
            const approved = decision.type === 'answer' && decision.optionId === 'approve';
            settle(
              approved ? 'yes' : 'no',
              'brain_timeout',
              decision.type === 'deny' ? decision.reason : decision.rationale,
            );
          } catch (err) {
            settle(
              'no',
              'brain_timeout',
              `Brain approval failed; denied by default: ${toErrorMessage(err)}`,
            );
          }
        })();
      }, HUMAN_APPROVAL_TIMEOUT_MS);
      timeout.unref?.();

      a.events.emit('tool.confirm_needed', {
        sessionId: resolveEventSessionId(a.ctx),
        tool: info.tool,
        input: info.input,
        toolUseId: info.toolUseId,
        suggestedPattern: info.suggestedPattern,
        decisionSource: info.decisionSource,
        riskTier: info.riskTier,
        boundaryReason: info.boundaryReason,
        deadlineAt,
        ...(writeTargets.length > 0 ? { writeTargets } : {}),
        resolve: (choice) => {
          settle(choice);
        },
      });
    });
  }

  /**
   * The typed outcome for a result the executor did not classify: a tool that
   * ran reports `completed` / `failed`, and an error result produced while
   * the run was aborting is `aborted`.
   */
  function derivedSettlement(result: ToolResultBlock): ToolSettlement {
    if (!result.is_error) return 'completed';
    return a.ctx.signal?.aborted ? 'aborted' : 'failed';
  }

  /**
   * Destinations a tool declares through `Tool.writeTargets` (the files inside
   * a `patch` diff, a `format`/`lint --fix` target list). Unlike the
   * permission gate, the input-key heuristic is left out: it only repeats
   * `input.path`, which subscribers already read.
   */
  function declaredWriteTargets(tool: Tool | undefined, input: unknown): string[] {
    if (typeof tool?.writeTargets !== 'function') return [];
    try {
      return tool.writeTargets(input).filter((p) => typeof p === 'string' && p.length > 0);
    } catch {
      return [];
    }
  }

  function emitToolExecuted(
    toolUseId: string,
    toolName: string,
    durationMs: number,
    ok: boolean,
    tool: Tool | undefined,
    input: unknown,
    content: string,
    settlement: ToolSettlement,
  ): void {
    const sig = sizeSignals(toolName, content);
    const writeTargets = ok ? declaredWriteTargets(tool, input) : [];
    // New SAGE retrievals live in Context.memoryEvidence. Keep splitting old
    // inline suffixes so replayed/pre-migration results remain clean.
    const { body, sageLines } = splitSageOutputBlock(content);
    const sage = capSageLines(sageLines, SAGE_EVENT_MAX);
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
      sessionId: resolveEventSessionId(a.ctx),
      ...(a.ctx.traceId ? { traceId: a.ctx.traceId } : {}),
      ...(a.ctx.activeLogicalRequestId ? { logicalRequestId: a.ctx.activeLogicalRequestId } : {}),
      ...(a.ctx.activePromptManifestId ? { promptManifestId: a.ctx.activePromptManifestId } : {}),
      agentId: a.ctx.agentId,
      agentName: a.ctx.agentName,
      id: toolUseId,
      name: toolName,
      durationMs,
      ok,
      settlement,
      mutating: tool?.mutating ?? false,
      input,
      ...(writeTargets.length > 0 ? { writeTargets } : {}),
      output: truncateForEvent(
        body,
        DIFF_TOOL_NAMES.has(toolName) ? DIFF_TOOL_EVENT_PREVIEW_MAX : undefined,
      ),
      ...(sage.length > 0 ? { sage } : {}),
      outputBytes: sig.outputBytes,
      outputTokens: sig.outputTokens,
      outputLines: sig.outputLines,
      metadata,
      taskId: a.ctx.currentKanbanTaskId,
      boardId: a.ctx.currentKanbanBoardId,
      ...(typeof a.ctx.provider === 'object'
        ? { provider: (a.ctx.provider as { id: string }).id }
        : {}),
      ...(a.ctx.model ? { model: a.ctx.model } : {}),
    });
  }

  /**
   * The one gate every tool call goes through, whether the model made it or a
   * script composing tools did: the extension filter, the executor
   * (validation, hooks, permission), a user confirmation when one is needed,
   * the tool-call pipeline and the `tool.executed` event. Returns the results
   * and their journal records; appending them is the caller's.
   */
  async function runGatedCalls(toolUses: ToolUseBlock[]) {
    const selectedToolUses = await a.extensions.runBeforeToolExecution(a.ctx, toolUses);

    const { outputs } = await a.toolExecutor.executeBatch(
      selectedToolUses,
      a.ctx,
      a.executionStrategy,
    );

    const useById = new Map(selectedToolUses.map((u) => [u.id, u]));
    const resultsForMessage: ToolResultBlock[] = [];
    const sessionEvents: SessionEvent[] = [];
    const settlements = new Map<string, ToolSettlement>();

    for (const { result, tool, durationMs, settlement: executorSettlement } of outputs) {
      if (result.type === 'tool_confirm_pending' && tool) {
        const answer = await waitForConfirm({
          tool: tool,
          input: result.input,
          toolUseId: result.toolUseId,
          suggestedPattern: result.suggestedPattern,
          decisionSource: result.decisionSource,
          riskTier: result.riskTier,
          boundaryReason: result.boundaryReason,
          // Forward the executor's single computation rather than re-deriving
          // here (chimera: the field existed but was never forwarded, so the
          // event path re-parsed the diff on every confirm and the two sites
          // could drift). The ?? fallback in waitForConfirm stays as the net
          // for callers that construct the info object directly.
          writeTargets: result.writeTargets,
        });
        const decision = userRuleAnswer(answer, result.decisionSource);

        // Persist trust/deny rules
        if (isPersistentApproval(decision)) {
          try {
            const approval = approvalRecord(
              decision,
              tool,
              result.input,
              a.ctx,
              result.suggestedPattern,
            );
            await a.permission.trust({
              tool: tool.name,
              pattern: approval.pattern,
              ttlMs: DEFAULT_ALWAYS_TRUST_TTL_MS,
            });
            a.events.emit('trust.persisted', {
              sessionId: resolveEventSessionId(a.ctx),
              tool: tool.name,
              ...approval,
              decision: 'always',
            });
          } catch {
            /* best-effort */
          }
        } else if (decision === 'deny') {
          try {
            await a.permission.deny({ tool: tool.name, pattern: result.suggestedPattern });
            a.events.emit('trust.persisted', {
              sessionId: resolveEventSessionId(a.ctx),
              tool: tool.name,
              pattern: result.suggestedPattern,
              decision: 'deny',
            });
          } catch {
            /* best-effort */
          }
        }

        // Soft deny for session-scoped retry prevention.
        //
        // There is deliberately no matching `allowOnce` on 'yes'. The re-run
        // below executes unconditionally and never calls permission.evaluate(),
        // so a one-shot grant issued here would not be consumed by the run it
        // authorizes — it would sit in sessionAllowed and silently approve the
        // NEXT identical call. One approval must mean one execution.
        if (decision === 'no') {
          const p = a.permission as never as {
            denyOnce?(r: { tool: string; pattern: string }): void;
          };
          p.denyOnce?.({ tool: tool.name, pattern: result.suggestedPattern });
        }

        const reRunResult =
          decision === 'yes' || isPersistentApproval(decision)
            ? await executeSingleWithDecision(
                tool,
                {
                  id: result.toolUseId,
                  name: tool.name,
                  input: result.input,
                  ...(useById.get(result.toolUseId)?._resultFormat
                    ? { _resultFormat: 'data' as const }
                    : {}),
                },
                result.preToolContext,
              )
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
        if (!(decision === 'yes' || isPersistentApproval(decision))) {
          await a.toolExecutor.abandonTool?.(
            tool,
            {
              type: 'tool_use' as const,
              id: result.toolUseId,
              name: tool.name,
              input: result.input as Record<string, unknown>,
            },
            a.ctx,
            String(reRunResult.result.content),
          );
        }

        const approved = decision === 'yes' || isPersistentApproval(decision);
        const settlement: ToolSettlement = approved
          ? derivedSettlement(reRunResult.result)
          : decision === 'abort'
            ? 'aborted'
            : 'declined';
        settlements.set(reRunResult.result.tool_use_id, settlement);
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
            settlement,
          });
          emitToolExecuted(
            reRunResult.result.tool_use_id,
            tool.name,
            reRunResult.durationMs,
            !reRunResult.result.is_error,
            tool,
            result.input,
            reRunResult.result.content,
            settlement,
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
      const settlement = executorSettlement ?? derivedSettlement(result);
      settlements.set(result.tool_use_id, settlement);
      sessionEvents.push({
        type: 'tool_result',
        ts: new Date().toISOString(),
        id: result.tool_use_id,
        content: result.content,
        isError: !!result.is_error,
        settlement,
      });
      emitToolExecuted(
        result.tool_use_id,
        use.name,
        durationMs,
        !result.is_error,
        tool ?? undefined,
        use.input,
        result.content,
        settlement,
      );
    }

    return { resultsForMessage, sessionEvents, outputs, settlements };
  }

  async function executeTools(toolUses: ToolUseBlock[]) {
    const { resultsForMessage, sessionEvents, outputs, settlements } =
      await runGatedCalls(toolUses);

    // Batch-append all tool_result events to the session log in one call.
    // This replaces N sequential append() calls (one per tool result) with a
    // single batch write, avoiding N-1 function calls, scrub/observe cycles,
    // and timer rescheduling overhead.
    if (sessionEvents.length > 0) {
      await (a.ctx.activeRunSessionWriter ?? a.ctx.session).appendBatch(sessionEvents);
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
      await (a.ctx.activeRunSessionWriter ?? a.ctx.session).flush();
    } catch (err) {
      (a.logger.debug ?? a.logger.warn)?.(
        `tool result boundary flush failed: ${toErrorMessage(err)}`,
      );
    }
    await a.extensions.runAfterToolExecution(a.ctx, outputs);
    return { results: resultsForMessage, settlements };
  }

  /**
   * One call from inside a running tool, through {@link runGatedCalls}. It is
   * journaled as a call of its own (`tool_use` then `tool_result`, id
   * `<parent>~<n>`), so the session shows it and a rewind covers its file
   * changes; its result goes back to the tool, not into the conversation.
   */
  const runNestedToolCall: NestedToolCaller = async (call) => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      id: `${call.parentToolUseId}~${call.index}`,
      name: call.name,
      ...(call.resultFormat ? { _resultFormat: call.resultFormat } : {}),
      input: (call.input && typeof call.input === 'object' ? call.input : {}) as Record<
        string,
        unknown
      >,
    };
    const writer = a.ctx.activeRunSessionWriter ?? a.ctx.session;
    await writer.append({
      type: 'tool_use',
      ts: new Date().toISOString(),
      id: use.id,
      name: use.name,
      input: use.input,
    });
    const { resultsForMessage, sessionEvents, outputs } = await runGatedCalls([use]);
    if (sessionEvents.length > 0) await writer.appendBatch(sessionEvents);
    await a.extensions.runAfterToolExecution(a.ctx, outputs);
    const result = resultsForMessage[0];
    if (!result) return { content: `Tool "${call.name}" was not run.`, isError: true };
    if (call.resultFormat === 'data' && !result.is_error) {
      const data = programmaticOutput(result);
      if (!data)
        return {
          content: `Structured output for "${call.name}" is unavailable after result policies; inspect tools.call output. The tool already ran, so do not repeat a mutation.`,
          isError: true,
        };
      return { content: String(result.content), isError: false, data: data.value };
    }
    return { content: String(result.content), isError: !!result.is_error };
  };
  a.ctx.nestedToolCall = runNestedToolCall;

  return { executeTools, executeSingleWithDecision };
}
