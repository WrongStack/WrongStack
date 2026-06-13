/**
 * Agent loop handler — extracted from Agent class.
 * Contains runInner (the main iteration loop), checkIterationLimit,
 * compactContextIfNeeded, emitContextPct, and injectPendingBtwNotes.
 */
import type { Request, Response } from '../types/provider.js';
import type { ContentBlock, TextBlock } from '../types/blocks.js';
import { isToolUseBlock } from '../types/blocks.js';
import { toWrongStackError } from '../types/errors.js';
import { estimateRequestTokens, estimateRequestTokensCalibrated, getCalibrationState, recordActualUsage } from '../utils/token-estimate.js';
import { consumeAutonomousContinue } from './continue-to-next-iteration.js';
import { buildBtwBlock, consumeBtwNotes } from './btw.js';
import { buildQueuedMessagesBlock, consumeQueuedMessagesUpdate } from './queued-messages.js';
import { attachMailboxChecker } from '../mailbox-attach.js';
import { injectPendingMailboxMessages } from './mailbox-loop.js';
import { runProviderWithRetry } from './provider-runner.js';
import { requestLimitExtension } from './iteration-limit.js';
import { TOKENS } from '../kernel/tokens.js';
import type { RunController } from '../kernel/run-controller.js';
import type { RunOptions } from './context.js';
import type { RunResult, UserInputPayload } from './agent-types.js';
import type { AgentInternals } from './agent-internals.js';
import type { AgentToolHandler } from './agent-tools.js';
import type { AgentResponseHandler } from './agent-response.js';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Extract a human-readable reason from an AbortSignal. */
export function signalAbortReason(signal: AbortSignal): string {
  const r = signal.reason;
  if (r instanceof Error) return r.message || r.name;
  if (typeof r === 'string' && r.length > 0) return r;
  return 'aborted';
}

interface LoopHandlers {
  tools: AgentToolHandler;
  response: AgentResponseHandler;
}

export interface AgentLoopHandler {
  runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult>;
}

export function createAgentLoopHandler(
  a: AgentInternals,
  handlers: LoopHandlers,
): AgentLoopHandler {
  // Mailbox checker — created once, reused every iteration. Derives
  // mailbox path from the session transcript directory. Ephemeral
  // sessions (no transcriptPath) get a no-op that returns [].
  const checkMailbox = attachMailboxChecker(a);

  /** Run context window pipeline. */
  async function compactContextIfNeeded(): Promise<void> {
    await a.pipelines.contextWindow.run(a.ctx);
  }

  /** Per-(provider,model) calibration bucket so a model-switching or fleet
   *  process doesn't collapse every tokenizer onto one shared ratio. */
  const calibrationKey = (model: string = a.ctx.model): string =>
    `${a.ctx.provider?.id ?? 'unknown'}/${model}`;

  /** Emit ctx.pct event for live context-fill bar in UIs. */
  function emitContextPct(): void {
    // In autonomous idle loops the conversation doesn't grow between
    // iterations — skip the expensive token estimation and event emission
    // when nothing has changed since the last emit.
    const msgCount = a.ctx.messages.length;
    const toolCount = (a.ctx.tools ?? []).length;
    if (msgCount === _lastEmittedMsgCount && toolCount === _lastEmittedToolCount && _maxContext > 0) {
      return;
    }
    _lastEmittedMsgCount = msgCount;
    _lastEmittedToolCount = toolCount;

    // H1: the pre-flight stash is stale if tool results have been appended
    // since. Recompute and refresh so the bar and the next middleware
    // invocation see the same number.
    if (msgCount !== _lastPreFlightMsgCount) {
      a.ctx.lastRequestTokens = estimateRequestTokens(
        a.ctx.messages,
        a.ctx.systemPrompt,
        a.ctx.tools ?? [],
      ).total;
      _lastPreFlightMsgCount = msgCount;
      a.ctx.meta['lastRequestTokensAt'] = { msgCount, toolCount };
    }

    // Mirror the denominator AutoCompactionMiddleware uses: an explicit
    // effectiveMaxContext override (ctx.meta) wins, then the provider window,
    // then a safe default. Avoids divide-by-zero when the window is unknown (0).
    // Cached — maxContext does not change during a session run.
    if (!_maxContext) {
      const metaLimit = a.ctx.meta?.['effectiveMaxContext'];
      const providerMax = a.ctx.provider.capabilities.maxContext;
      _maxContext =
        typeof metaLimit === 'number' && metaLimit > 0
          ? metaLimit
          : typeof providerMax === 'number' && providerMax > 0
            ? providerMax
            : 200_000;
    }
    // H1: prefer the pre-flight stash so the bar and the middleware see
    // the same number. Fall back to a fresh compute only on cold start
    // (no pre-flight yet) — emitContextPct is called at the end of an
    // iteration, after the pre-flight has always run.
    let total: number;
    const stashed = a.ctx.lastRequestTokens;
    if (typeof stashed === 'number' && stashed > 0) {
      const cal = getCalibrationState(calibrationKey());
      total = cal.calibrated
        ? Math.round(stashed * Math.min(1.5, Math.max(0.5, cal.ratio)))
        : stashed;
    } else {
      const est = estimateRequestTokensCalibrated(
        a.ctx.messages,
        a.ctx.systemPrompt,
        a.ctx.tools ?? [],
        calibrationKey(),
      );
      total = est.total;
    }
    a.events.emit('ctx.pct', { load: total / _maxContext, tokens: total, maxContext: _maxContext });
  }
  let _maxContext = 0;
  let _lastEmittedMsgCount = -1;
  let _lastEmittedToolCount = -1;
  // H1: tracks the message count at the most recent pre-flight. emitContextPct
  // uses it to detect when tool results have been appended since the
  // pre-flight and the stash needs a restash. -1 = no pre-flight yet.
  let _lastPreFlightMsgCount = -1;

  /**
   * Append an informational block to the conversation, merging into the
   * trailing user message when there is one (keeps user/assistant
   * alternation intact between tool batches).
   */
  function foldBlockIntoConversation(block: TextBlock): void {
    const messages = a.ctx.messages;
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      const content: ContentBlock[] =
        typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }, block]
          : [...last.content, block];
      a.ctx.state.replaceMessages([...messages.slice(0, -1), { ...last, content }]);
    } else {
      a.ctx.state.appendMessage({ role: 'user', content: [block] });
    }
  }

  /** Fold pending /btw notes into conversation before each iteration. */
  function injectPendingBtwNotes(): void {
    const notes = consumeBtwNotes(a.ctx);
    if (notes.length === 0) return;
    foldBlockIntoConversation({ type: 'text', text: buildBtwBlock(notes) });
  }

  /**
   * Surface the host's pending-message queue (messages typed while this run
   * was busy) when it changed since the model last saw it. Informational
   * only — the queued messages still arrive later as their own user turns;
   * this just lets the model factor the backlog into in-flight decisions.
   * See {@link ./queued-messages.ts}.
   */
  function injectQueueAwareness(): void {
    const items = consumeQueuedMessagesUpdate(a.ctx);
    if (!items) return;
    foldBlockIntoConversation({ type: 'text', text: buildQueuedMessagesBlock(items) });
  }

  /**
   * Check if iteration limit reached and request extension if needed.
   */
  async function checkIterationLimit(
    iterationIndex: number,
    limit: number,
    hasHardLimit: boolean,
    currentIterations: number,
    delegateSummaries: Array<{ summary: string; ok: boolean }>,
  ): Promise<{ limit: number; exit?: RunResult | undefined }> {
    if (hasHardLimit && iterationIndex >= limit) {
      const extendBy = await requestLimitExtension({
        events: a.events,
        currentIterations,
        currentLimit: limit,
        autoExtend: a.autoExtendLimit,
      });
      if (extendBy > 0) {
        const newLimit = limit + extendBy;
        a.logger.info(`Iteration limit extended by ${extendBy} (new limit: ${newLimit})`);
        return { limit: newLimit };
      }
      return { limit, exit: { status: 'max_iterations', iterations: currentIterations, delegateSummaries } };
    }
    return { limit };
  }

  async function runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult> {
    await a.pipelines.userInput.run(inputPayload);
    a.ctx.state.appendMessage({ role: 'user', content: inputPayload.content });
    await a.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: inputPayload.content,
    });
    // Ensure user input is durable before we make the (expensive) LLM call.
    // Without this, a SIGKILL mid-run leaves the user's message in the buffer
    // and the resumed session shows only orphaned tool_call_end events.
    await a.ctx.session.flush();

    const promptIndex = a.ctx.messages.filter((m) => m.role === 'user').length - 1;
    const preview = inputPayload.text.slice(0, 80) + (inputPayload.text.length > 80 ? '…' : '');
    await a.ctx.session.writeCheckpoint(promptIndex, preview);

    let finalText = '';
    let iterations = 0;
    const delegateSummaries: Array<{ summary: string; ok: boolean }> = [];
    let effectiveLimit = opts.maxIterations ?? a.maxIterations;
    const hasHardLimit = effectiveLimit > 0 && Number.isFinite(effectiveLimit);
    let recoveryRetries = 0;

    const onSubagentDone = ({ summary, ok }: { summary: string; ok: boolean }) => {
      delegateSummaries.push({ summary, ok });
    };
    const offSubagentDone = a.events.on('subagent.done', onSubagentDone);

    // Build the base provider runner
    const diRunner = a.container.has(TOKENS.ProviderRunner)
      ? a.container.resolve(TOKENS.ProviderRunner)
      : null;

    const baseRunner = diRunner
      ? (ctx: typeof a.ctx, req: Request) =>
          diRunner.run({
            provider: ctx.provider, request: req, signal: controller.signal,
            ctx, events: a.events, retry: a.retry, logger: a.logger, tracer: a.tracer,
          })
      : async (ctx: typeof a.ctx, req: Request) =>
          runProviderWithRetry({
            provider: ctx.provider, request: req, signal: controller.signal,
            ctx, events: a.events, retry: a.retry, logger: a.logger, tracer: a.tracer,
          });

    const customRunner = a.extensions.wrapProviderRunner(baseRunner);

    try {
      for (let i = 0; ; i++) {
        iterations = i + 1;
        if (controller.signal.aborted) {
          return { status: 'aborted', iterations, abortReason: signalAbortReason(controller.signal) };
        }

        await a.ctx.session
          .writeInFlightMarker(`iteration ${i} / max ${a.maxIterations}`)
          .catch((err) => {
            (a.logger.debug ?? a.logger.warn)?.(
              `in-flight marker write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });

        if (autonomousContinue) {
          consumeAutonomousContinue(a.ctx);
        }

        const limitCheck = await checkIterationLimit(
          i, effectiveLimit, hasHardLimit, iterations, delegateSummaries,
        );
        effectiveLimit = limitCheck.limit;
        if (limitCheck.exit) {
          return { ...limitCheck.exit, finalText };
        }

        await a.extensions.runBeforeIteration(a.ctx, i);
        a.events.emit('iteration.started', { ctx: a.ctx, index: i });

        injectPendingBtwNotes();
        injectQueueAwareness();

        // Check inter-agent mailbox for steer/btw messages from other agents.
        // Non-blocking best-effort — a broken mailbox must not stop the agent.
        await injectPendingMailboxMessages(checkMailbox, foldBlockIntoConversation, {
          // Cast to the broad parameter type — injectPendingMailboxMessages only
          // calls emit('mailbox.received', ...) and uses logger.debug optionally.
          events: a.events as unknown as { emit: (type: string, payload: unknown) => void },
          logger: a.logger as unknown as { debug?: (...args: unknown[]) => void },
        });

        const req = await handlers.response.buildAndRunRequestPipeline(opts);

        // H1: compute once, share with the middleware + context bar.
        // Previously this estimate was repeated three times per iteration
        // (pre-flight, emitContextPct, AutoCompactionMiddleware), each
        // walking the same messages/system/tools arrays. Now the result
        // is stashed on ctx and the other two call sites consult it.
        const preFlight = estimateRequestTokens(req.messages, req.system, req.tools ?? []);

        // Stash the uncalibrated total on ctx so the middleware and the
        // context bar (emitContextPct) can read it without re-walking the
        // messages. The middleware applies its own per-(provider,model)
        // calibration ratio on read so the value it sees matches the
        // calibrated figure the compaction decision was made on.
        a.ctx.lastRequestTokens = preFlight.total;
        _lastPreFlightMsgCount = req.messages.length;
        // Companion meta entry: the (msg, tool) count snapshot the stash
        // was computed at, so the middleware can detect when tool results
        // were appended between pre-flight and compaction and refuse the
        // stale value. See AutoCompactionMiddleware.tryStashedTokens.
        a.ctx.meta['lastRequestTokensAt'] = {
          msgCount: req.messages.length,
          toolCount: (req.tools ?? []).length,
        };

        await a.ctx.session.append({
          type: 'llm_request',
          ts: new Date().toISOString(),
          model: req.model,
          messageCount: req.messages.length,
          estimatedInputTokens: preFlight.total,
          toolCount: (req.tools ?? []).length,
        }).catch(() => { /* best-effort */ });

        let res: Response;
        try {
          res = await customRunner(a.ctx, req);
          // Derive the calibrated estimate from the pre-flight result instead
          // of calling estimateRequestTokensCalibrated() which would re-walk
          // the same messages/system/tools arrays. The calibration ratio is
          // the same per-(provider,model) bucket — applying it to the raw
          // total is equivalent to the per-component rounding in the full
          // calibrated function.
          const key = calibrationKey(req.model);
          const cal = getCalibrationState(key);
          const calibratedTotal = cal.calibrated
            ? Math.round(preFlight.total * Math.min(1.5, Math.max(0.5, cal.ratio)))
            : preFlight.total;
          recordActualUsage(res.usage.input, calibratedTotal, key);
          recoveryRetries = 0;
        } catch (err) {
          if (controller.signal.aborted) {
            a.events.emit('error', { err: toError(err), phase: 'provider' });
            return { status: 'aborted', iterations, error: toWrongStackError(err, 'AGENT_ABORTED'), abortReason: signalAbortReason(controller.signal) };
          }

          const extDecision = await a.extensions.runOnError(a.ctx, err, 'provider', i);
          if (extDecision) {
            if (extDecision.action === 'fail') {
              a.events.emit('error', { err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
            }
            if (extDecision.action === 'continue') {
              await a.extensions.runAfterIteration(a.ctx, i);
              continue;
            }
            if (extDecision.action === 'retry') {
              recoveryRetries++;
              if (recoveryRetries > 2) {
                a.events.emit('error', { err: toError(err), phase: 'provider' });
                return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
              }
              if (extDecision.model) a.ctx.model = extDecision.model;
              a.logger.info('Extension requested retry; retrying turn');
              continue;
            }
          }

          const recovered = await a.errorHandler.recover(err, a.ctx);
          if (!recovered || recovered.action === 'fail') {
            a.events.emit('error', { err: toError(err), phase: 'provider' });
            return {
              status: 'failed', iterations,
              error: toWrongStackError(recovered?.error ?? err),
              delegateSummaries,
            };
          }
          if (recovered.action === 'retry') {
            recoveryRetries++;
            if (recoveryRetries > 2) {
              a.events.emit('error', { err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err) };
            }
            if (recovered.model) a.ctx.model = recovered.model;
            a.logger.info(`Recovered provider error via ${recovered.reason}; retrying turn`);
            continue;
          }
          recoveryRetries = 0;
          res = recovered.response;
        }

        const responseResult = await handlers.response.processResponse(res, req);
        if (responseResult.aborted) {
          return { status: 'aborted', iterations, finalText: responseResult.finalText, delegateSummaries, abortReason: signalAbortReason(controller.signal) };
        }
        if (responseResult.done) {
          return { status: 'done', iterations, finalText: responseResult.finalText, delegateSummaries };
        }

        finalText = responseResult.finalText;

        const toolUses = res.content.filter(isToolUseBlock);
        if (toolUses.length === 0) {
          emitContextPct();
          a.events.emit('iteration.completed', { ctx: a.ctx, index: i });
          if (autonomousContinue && responseResult.directive === 'continue') {
            await compactContextIfNeeded();
            await a.extensions.runAfterIteration(a.ctx, i);
            continue;
          }
          if (autonomousContinue && responseResult.directive === 'stop') {
            return { status: 'done', iterations, finalText, delegateSummaries };
          }
          return { status: 'done', iterations, finalText, delegateSummaries };
        }

        // Wrap tool execution so an abort mid-tool surfaces as 'aborted'
        // rather than AGENT_RUN_FAILED in the outer agent.run() catch block.
        try {
          await handlers.tools.executeTools(toolUses);
        } catch (toolErr) {
          if (controller.signal.aborted) {
            return { status: 'aborted', iterations, finalText, delegateSummaries, abortReason: signalAbortReason(controller.signal) };
          }
          throw toolErr;
        }

        if (autonomousContinue && consumeAutonomousContinue(a.ctx)) {
          emitContextPct();
          a.events.emit('iteration.completed', { ctx: a.ctx, index: i });
          await compactContextIfNeeded();
          await a.extensions.runAfterIteration(a.ctx, i);
          continue;
        }

        emitContextPct();
        a.events.emit('iteration.completed', { ctx: a.ctx, index: i });
        await compactContextIfNeeded();
        await a.extensions.runAfterIteration(a.ctx, i);

        if (autonomousContinue && responseResult.directive === 'continue') {
          continue;
        }
        if (autonomousContinue && responseResult.directive === 'stop') {
          return { status: 'done', iterations, finalText, delegateSummaries };
        }
      }
    } finally {
      offSubagentDone();
      const reason: 'clean' | 'aborted' = controller.signal.aborted ? 'aborted' : 'clean';
      await a.ctx.session
        .clearInFlightMarker(reason)
        .catch((err) => {
          (a.logger.debug ?? a.logger.warn)?.(
            `in-flight marker clear failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  return { runInner };
}
