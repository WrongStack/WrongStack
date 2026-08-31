import type { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import { attachFleetPulse, attachMailboxChecker } from '../mailbox-attach.js';
import { recordPromptJournalEntry } from '../prompts/prompt-journal.js';
import { attachSessionNotes } from '../session-note-attach.js';
import type { TextBlock } from '../types/blocks.js';
import { isToolUseBlock } from '../types/blocks.js';
import { toWrongStackError } from '../types/errors.js';
import type { Request, Response } from '../types/provider.js';
import { effectiveInputTokens } from '../types/provider.js';
import { isRuntimeContextInput, recordUserIntentEvidence } from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { formatTodosForModel, hasKanbanBoundTodos, hasOpenTodos } from '../utils/todos-format.js';
import { getCalibrationState, recordActualUsage } from '../utils/token-estimate.js';
import type { AgentInternals } from './agent-internals.js';
import { createAgentLoopContextManager } from './agent-loop-context.js';
import { AgentLoopDetector } from './agent-loop-detector.js';
import type { AgentResponseHandler } from './agent-response.js';
import type { AgentToolHandler } from './agent-tools.js';
import type { RunResult, UserInputPayload } from './agent-types.js';
import { buildBtwBlock, consumeBtwNotes } from './btw.js';
import { type RunOptions, resolveEventSessionId } from './context.js';
import { consumeAutonomousContinue } from './continue-to-next-iteration.js';
import { requestLimitExtension } from './iteration-limit.js';
import { injectPendingMailboxMessages, removeInjectedMailboxBlocks } from './mailbox-loop.js';
import { clearPendingNextSteps } from './next-steps-slot.js';
import { runProviderWithRetry } from './provider-runner.js';
import { buildQueuedMessagesBlock, consumeQueuedMessagesUpdate } from './queued-messages.js';
import { providerBoundToRequest } from './request-provider-binding.js';
import { buildSessionNoteBlock, consumeSessionNotes } from './session-notes.js';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Best-effort journal record for a recovered provider error (self-healing
 * retry). Mirrors the CLI recorder's guard: only writes when the context has a
 * project root, and failures are swallowed — journal I/O must never block the
 * loop.
 */
function recordSelfHealingRetry(a: AgentInternals, err: unknown, reason: string): void {
  const projectRoot = a.ctx.projectRoot;
  if (!projectRoot) return;
  void recordPromptJournalEntry({
    projectRoot,
    sessionId: resolveEventSessionId(a.ctx),
    category: 'self_healing_retry',
    content: toErrorMessage(err),
    decisionReason: reason,
    model: a.ctx.model,
    provider: a.ctx.provider?.id,
    activeTools: a.ctx.tools?.map((tool) => tool.name) ?? [],
  }).catch(() => {});
}

/**
 * Best-effort journal record for a text-marker autonomous continue
 * (`[continue]` / `[next step]` / `[proceed]` emitted as final text without
 * the `continue_to_next_iteration` tool call). Same guard as
 * `recordSelfHealingRetry` — only writes when the context has a project root,
 * and failures are swallowed so journal I/O never blocks the loop.
 */
function recordAutonomousContinue(a: AgentInternals, text: string): void {
  const projectRoot = a.ctx.projectRoot;
  if (!projectRoot) return;
  void recordPromptJournalEntry({
    projectRoot,
    sessionId: resolveEventSessionId(a.ctx),
    category: 'autonomous_next_step',
    content: text,
    decisionReason: 'text-marker autonomous continue',
    model: a.ctx.model,
    provider: a.ctx.provider?.id,
    activeTools: a.ctx.tools?.map((tool) => tool.name) ?? [],
  }).catch(() => {});
}

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
  const checkMailbox = attachMailboxChecker(a);
  attachSessionNotes(a);

  const fleetPulseCfg = (() => {
    try {
      return typeof a.container?.has === 'function' && a.container.has(TOKENS.ConfigStore)
        ? a.container.resolve(TOKENS.ConfigStore).get().fleet?.pulse
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const getFleetPulse = attachFleetPulse(a, fleetPulseCfg);
  const pulseEveryN = Math.max(1, fleetPulseCfg?.everyNIterations ?? 5);
  const backgroundCoordination = () => a.ctx.meta['coordinationContextMode'] === 'background';

  const loopContext = createAgentLoopContextManager(a, handlers);

  function foldBlockIntoConversation(block: TextBlock): void {
    if (!a.ctx.state.appendBlockToLastUserMessage(block)) {
      a.ctx.state.appendMessage({ role: 'user', content: [block], origin: 'runtime' });
    }
  }

  function injectPendingBtwNotes(onMailboxBlock?: (block: TextBlock) => void): void {
    const notes = consumeBtwNotes(a.ctx);
    if (notes.length === 0) return;
    const mailboxNotes = notes.filter((note) => note.startsWith('[MAILBOX BTW]'));
    const regularNotes = notes.filter((note) => !note.startsWith('[MAILBOX BTW]'));
    if (regularNotes.length > 0) {
      foldBlockIntoConversation({ type: 'text', text: buildBtwBlock(regularNotes) });
    }
    if (mailboxNotes.length > 0) {
      const block: TextBlock = { type: 'text', text: buildBtwBlock(mailboxNotes) };
      foldBlockIntoConversation(block);
      onMailboxBlock?.(block);
    }
  }

  function injectPendingSessionNotes(): void {
    const notes = consumeSessionNotes(a.ctx);
    if (notes.length === 0) return;
    foldBlockIntoConversation({ type: 'text', text: buildSessionNoteBlock(notes) });
  }

  function injectQueueAwareness(): void {
    const items = consumeQueuedMessagesUpdate(a.ctx);
    if (!items) return;
    foldBlockIntoConversation({ type: 'text', text: buildQueuedMessagesBlock(items) });
  }

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
        sessionId: resolveEventSessionId(a.ctx),
        currentIterations,
        currentLimit: limit,
        autoExtend: a.autoExtendLimit,
      });
      if (extendBy > 0) {
        const newLimit = limit + extendBy;
        a.logger.info(`Iteration limit extended by ${extendBy} (new limit: ${newLimit})`);
        return { limit: newLimit };
      }
      return {
        limit,
        exit: { status: 'max_iterations', iterations: currentIterations, delegateSummaries },
      };
    }
    return { limit };
  }

  async function runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult> {
    a.ctx.meta['subagentsPolicyLocked'] = true;
    await a.pipelines.userInput.run(inputPayload);
    recordUserIntentEvidence(a.ctx, inputPayload.text);
    await a.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: inputPayload.content,
    });
    const inputOrigin = isRuntimeContextInput(inputPayload.text) ? 'runtime' : 'user_input';
    a.ctx.state.appendMessage({
      role: 'user',
      content: inputPayload.content,
      origin: inputOrigin,
    });
    const promptIndex = a.ctx.messages.filter((m) => m.role === 'user').length - 1;
    const preview = inputPayload.text.slice(0, 80) + (inputPayload.text.length > 80 ? '…' : '');
    await a.ctx.session.writeCheckpoint(promptIndex, preview);
    try {
      await a.ctx.flushConversationJournal();
      await a.ctx.session.flush();
    } catch (err) {
      (a.logger.debug ?? a.logger.warn)?.(`session boundary flush failed: ${toErrorMessage(err)}`);
    }

    clearPendingNextSteps(a.ctx);

    let finalText = '';
    let iterations = 0;
    const delegateSummaries: Array<{ summary: string; ok: boolean }> = [];
    let effectiveLimit = opts.maxIterations ?? a.maxIterations;
    const hasHardLimit = effectiveLimit > 0 && Number.isFinite(effectiveLimit);
    let recoveryRetries = 0;
    const pendingMailboxBlocks: TextBlock[] = [];

    function clearEvaluatedMailboxBlocks(): void {
      if (pendingMailboxBlocks.length === 0) return;
      const cleaned = removeInjectedMailboxBlocks(a.ctx.messages, pendingMailboxBlocks);
      pendingMailboxBlocks.length = 0;
      if (cleaned.changed) {
        a.ctx.state.replaceMessages(cleaned.messages);
        a.ctx.lastRealInputTokens = undefined;
        delete a.ctx.meta['realAnchorMsgCount'];
        loopContext.refreshContextRequestTokenStash({ force: true });
      }
    }

    const loopDetector = new AgentLoopDetector(a);
    let pendingLoopSteer: string | null = null;
    let todoReconcileSteers = 0;

    function queueLoopSteer(text: string): void {
      pendingLoopSteer = pendingLoopSteer ? `${pendingLoopSteer}\n${text}` : text;
    }

    const onSubagentDone = ({ summary, ok }: { summary: string; ok: boolean }) => {
      delegateSummaries.push({ summary, ok });
    };
    const offSubagentDone = a.events.on('subagent.done', onSubagentDone);

    const diRunner = a.container.has(TOKENS.ProviderRunner)
      ? a.container.resolve(TOKENS.ProviderRunner)
      : null;
    // The waiting room, threaded down to the wire funnel. Selection-time
    // filters (fallback chain, model matrix, spawn) all consult the same
    // tracker, but only this hand-off stops a request that was already in
    // flight through a path with no fallback extension attached.
    const statusTracker = a.container.safeResolve(TOKENS.ProviderModelStatusTracker);
    const baseRunner = diRunner
      ? (ctx: typeof a.ctx, req: Request) =>
          diRunner.run({
            provider: providerBoundToRequest(req) ?? ctx.provider,
            request: req,
            signal: controller.signal,
            ctx,
            events: a.events,
            retry: a.retry,
            logger: a.logger,
            tracer: a.tracer,
            ...(statusTracker ? { statusTracker } : {}),
          })
      : async (ctx: typeof a.ctx, req: Request) =>
          runProviderWithRetry({
            provider: providerBoundToRequest(req) ?? ctx.provider,
            request: req,
            signal: controller.signal,
            ctx,
            events: a.events,
            retry: a.retry,
            logger: a.logger,
            tracer: a.tracer,
            ...(statusTracker ? { statusTracker } : {}),
          });

    const customRunner = a.extensions.wrapProviderRunner(baseRunner);

    try {
      for (let i = 0; ; i++) {
        iterations = i + 1;
        if (controller.signal.aborted) {
          return {
            status: 'aborted',
            iterations,
            abortReason: signalAbortReason(controller.signal),
          };
        }

        try {
          await a.ctx.session.writeInFlightMarker(`iteration ${i} / max ${a.maxIterations}`);
        } catch (err) {
          (a.logger.debug ?? a.logger.warn)?.(
            `in-flight marker write failed: ${toErrorMessage(err)}`,
          );
        }

        if (autonomousContinue) {
          consumeAutonomousContinue(a.ctx);
        }

        const limitCheck = await checkIterationLimit(
          i,
          effectiveLimit,
          hasHardLimit,
          iterations,
          delegateSummaries,
        );
        effectiveLimit = limitCheck.limit;
        if (limitCheck.exit) {
          return { ...limitCheck.exit, finalText };
        }

        await a.extensions.runBeforeIteration(a.ctx, i);
        a.events.emit('iteration.started', {
          sessionId: resolveEventSessionId(a.ctx),
          ctx: a.ctx,
          index: i,
        });

        injectPendingBtwNotes((block) => pendingMailboxBlocks.push(block));
        injectPendingSessionNotes();
        injectQueueAwareness();

        if (pendingLoopSteer) {
          foldBlockIntoConversation({ type: 'text', text: pendingLoopSteer });
          pendingLoopSteer = null;
        }

        if (!backgroundCoordination() && (i % pulseEveryN === 1 || pulseEveryN === 1)) {
          try {
            const pulse = await getFleetPulse();
            if (pulse) foldBlockIntoConversation(pulse);
          } catch {}
        }

        const mailboxResult = await injectPendingMailboxMessages(
          checkMailbox,
          (block) => {
            foldBlockIntoConversation(block);
            pendingMailboxBlocks.push(block);
          },
          {
            events: {
              emit: (type, payload) => {
                a.events.emit(type as never, payload as never);
              },
            },
            logger: a.logger as never as { debug?: (...args: unknown[]) => void },
          },
          backgroundCoordination() ? 'background' : 'inline',
        );
        if (mailboxResult.interrupt) {
          const reason = `interrupted: ${mailboxResult.interruptReason ?? 'operator request'}`;
          return { status: 'aborted', iterations, abortReason: reason, finalText };
        }

        const {
          req,
          provider: requestProvider,
          preFlight,
        } = await loopContext.buildRequestWithPreflightCompaction(opts);
        await a.ctx.session
          .append({
            type: 'llm_request',
            ts: new Date().toISOString(),
            model: req.model,
            messageCount: req.messages.length,
            estimatedInputTokens: preFlight.total,
            toolCount: (req.tools ?? []).length,
          })
          .catch(() => {});

        let res: Response;
        try {
          res = await customRunner(a.ctx, req);
          const key = loopContext.calibrationKey(req.model);
          const cal = getCalibrationState(key);
          const calibratedTotal = cal.calibrated
            ? Math.round(preFlight.total * Math.min(1.5, Math.max(0.5, cal.ratio)))
            : preFlight.total;
          const realInputTokens = effectiveInputTokens(res.usage);
          recordActualUsage(realInputTokens, calibratedTotal, key);
          const previousRealInput = a.ctx.lastRealInputTokens;
          const previousAnchorMsgCount =
            typeof a.ctx.meta?.['realAnchorMsgCount'] === 'number'
              ? (a.ctx.meta['realAnchorMsgCount'] as number)
              : undefined;
          const anchorIsPlausible = realInputTokens >= calibratedTotal * 0.5;
          const anchorAdvanced =
            previousRealInput === undefined ||
            realInputTokens > previousRealInput ||
            (previousAnchorMsgCount !== undefined &&
              loopContext.lastPreFlightMsgCount < previousAnchorMsgCount);
          if (realInputTokens > 0 && anchorIsPlausible && anchorAdvanced) {
            a.ctx.lastRealInputTokens = realInputTokens;
            a.ctx.meta['realAnchorMsgCount'] = loopContext.lastPreFlightMsgCount;
          }
          recoveryRetries = 0;
        } catch (err) {
          if (controller.signal.aborted) {
            a.events.emit('error', {
              sessionId: resolveEventSessionId(a.ctx),
              err: toError(err),
              phase: 'provider',
            });
            return {
              status: 'aborted',
              iterations,
              error: toWrongStackError(err, 'AGENT_ABORTED'),
              abortReason: signalAbortReason(controller.signal),
            };
          }

          const extDecision = await a.extensions.runOnError(a.ctx, err, 'provider', i);
          if (extDecision) {
            if (extDecision.action === 'fail') {
              a.events.emit('error', {
                sessionId: resolveEventSessionId(a.ctx),
                err: toError(err),
                phase: 'provider',
              });
              return {
                status: 'failed',
                iterations,
                error: toWrongStackError(err),
                delegateSummaries,
              };
            }
            if (extDecision.action === 'continue') {
              await a.extensions.runAfterIteration(a.ctx, i);
              continue;
            }
            if (extDecision.action === 'retry') {
              recoveryRetries++;
              if (recoveryRetries > 2) {
                a.events.emit('error', {
                  sessionId: resolveEventSessionId(a.ctx),
                  err: toError(err),
                  phase: 'provider',
                });
                return {
                  status: 'failed',
                  iterations,
                  error: toWrongStackError(err),
                  delegateSummaries,
                };
              }
              if (extDecision.model) a.ctx.model = extDecision.model;
              a.logger.info('Extension requested retry; retrying turn');
              recordSelfHealingRetry(a, err, 'extension-requested provider retry');
              continue;
            }
          }

          const recovered = await a.errorHandler.recover(err, a.ctx);
          if (!recovered || recovered.action === 'fail') {
            a.events.emit('error', {
              sessionId: resolveEventSessionId(a.ctx),
              err: toError(err),
              phase: 'provider',
            });
            return {
              status: 'failed',
              iterations,
              error: toWrongStackError(recovered?.error ?? err),
              delegateSummaries,
            };
          }
          if (recovered.action === 'retry') {
            recoveryRetries++;
            if (recoveryRetries > 2) {
              a.events.emit('error', {
                sessionId: resolveEventSessionId(a.ctx),
                err: toError(err),
                phase: 'provider',
              });
              return { status: 'failed', iterations, error: toWrongStackError(err) };
            }
            if (recovered.model) a.ctx.model = recovered.model;
            a.logger.info(`Recovered provider error via ${recovered.reason}; retrying turn`);
            recordSelfHealingRetry(a, err, recovered.reason);
            continue;
          }
          recoveryRetries = 0;
          res = recovered.response;
        }

        clearEvaluatedMailboxBlocks();

        const responseProvider = providerBoundToRequest(req) ?? requestProvider;
        const responseResult = await handlers.response.processResponse(res, req, responseProvider);
        await loopContext.refreshProviderContextLimit(responseProvider, req.model, {
          probe: false,
        });
        if (responseResult.finalText) {
          a.ctx.meta['lastAgentOutput'] = responseResult.finalText;
        }
        if (responseResult.aborted) {
          return {
            status: 'aborted',
            iterations,
            finalText: responseResult.finalText,
            delegateSummaries,
            abortReason: signalAbortReason(controller.signal),
          };
        }
        if (responseResult.done) {
          return {
            status: 'done',
            iterations,
            finalText: responseResult.finalText,
            delegateSummaries,
          };
        }

        finalText = responseResult.finalText;

        const toolUses = res.content.filter(isToolUseBlock);

        const loopCheck = loopDetector.checkIteration(i, res.content, toolUses, queueLoopSteer);
        if (loopCheck.cut) {
          return {
            status: 'max_iterations',
            iterations,
            finalText: finalText || loopCheck.cutSummary || '',
            delegateSummaries,
          };
        }

        if (toolUses.length === 0) {
          await loopContext.compactContextIfNeeded();
          loopContext.emitContextPct();
          a.events.emit('iteration.completed', {
            sessionId: resolveEventSessionId(a.ctx),
            ctx: a.ctx,
            index: i,
          });
          if (
            a.ctx.agentId === 'leader' &&
            a.tools.get('todo') !== undefined &&
            hasOpenTodos(a.ctx.todos) &&
            todoReconcileSteers < 2
          ) {
            todoReconcileSteers++;
            queueLoopSteer(
              '[todo-reconciliation] The live todo/Kanban list still has open work, but you tried to end the turn without reconciling it. ' +
                'Call the `todo` tool now with the complete current list. Mark work you actually finished as completed, put the one item you are actively working on in_progress, and leave the rest pending. ' +
                'If the current item is genuinely unfinished, continue doing the work before answering; do not merely repeat the previous final response or emit <nextsteps>.\n' +
                'Canonical live list:\n' +
                formatTodosForModel(a.ctx.todos) +
                (hasKanbanBoundTodos(a.ctx.todos)
                  ? '\nEach <kanban board/task> binding must be resent verbatim as `kanbanBoardId`/`kanbanTaskId`; a row without it is not applied to its card.'
                  : ''),
            );
            await a.extensions.runAfterIteration(a.ctx, i);
            continue;
          }
          if (autonomousContinue && responseResult.directive === 'continue') {
            recordAutonomousContinue(a, finalText);
            await a.extensions.runAfterIteration(a.ctx, i);
            continue;
          }
          if (autonomousContinue && responseResult.directive === 'stop') {
            return { status: 'done', iterations, finalText, delegateSummaries };
          }
          return { status: 'done', iterations, finalText, delegateSummaries };
        }

        try {
          await handlers.tools.executeTools(toolUses);
        } catch (toolErr) {
          if (controller.signal.aborted) {
            return {
              status: 'aborted',
              iterations,
              finalText,
              delegateSummaries,
              abortReason: signalAbortReason(controller.signal),
            };
          }
          throw toolErr;
        }

        if (autonomousContinue && consumeAutonomousContinue(a.ctx)) {
          await loopContext.compactContextIfNeeded();
          loopContext.emitContextPct();
          a.events.emit('iteration.completed', {
            sessionId: resolveEventSessionId(a.ctx),
            ctx: a.ctx,
            index: i,
          });
          await a.extensions.runAfterIteration(a.ctx, i);
          continue;
        }

        await loopContext.compactContextIfNeeded();
        loopContext.emitContextPct();
        a.events.emit('iteration.completed', {
          sessionId: resolveEventSessionId(a.ctx),
          ctx: a.ctx,
          index: i,
        });
        await a.extensions.runAfterIteration(a.ctx, i);

        if (autonomousContinue && responseResult.directive === 'continue') {
          continue;
        }
        if (autonomousContinue && responseResult.directive === 'stop') {
          return { status: 'done', iterations, finalText, delegateSummaries };
        }
      }
    } finally {
      clearEvaluatedMailboxBlocks();
      offSubagentDone();
      const reason: 'clean' | 'aborted' = controller.signal.aborted ? 'aborted' : 'clean';
      try {
        await a.ctx.session.clearInFlightMarker(reason);
        await a.ctx.session.flush();
      } catch (err) {
        (a.logger.debug ?? a.logger.warn)?.(
          `in-flight marker clear failed: ${toErrorMessage(err)}`,
        );
      }
    }
  }

  return { runInner };
}
