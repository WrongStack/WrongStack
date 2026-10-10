import { randomUUID } from 'node:crypto';
import type { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import { attachFleetPulse, attachMailboxChecker } from '../mailbox-attach.js';
import { attachSessionNotes } from '../session-note-attach.js';
import { armRequiredSkills } from '../skills/required-skill-gate.js';
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
import { createAgentLoopInjectors } from './agent-loop-injectors.js';
import {
  abortedRunError,
  recordAutonomousContinue,
  recordSelfHealingRetry,
  signalAbortReason,
  toError,
} from './agent-loop-retry.js';
import type { AgentResponseHandler } from './agent-response.js';
import type { AgentToolHandler } from './agent-tools.js';
import type { RunResult, UserInputPayload } from './agent-types.js';
import { type RunOptions, resolveEventSessionId } from './context.js';
import { contextHistoryVersion, requestHistoryVersion } from './context-history-version.js';
import { recordContextUsageAnchor, requestPromptStillCurrent } from './context-usage-anchor.js';
import { consumeAutonomousContinue } from './continue-to-next-iteration.js';
import { injectPendingMailboxMessages, removeInjectedMailboxBlocks } from './mailbox-loop.js';
import { clearPendingNextSteps } from './next-steps-slot.js';
import { runProviderWithRetry } from './provider-runner.js';
import { providerBoundToRequest } from './request-provider-binding.js';
import { isSealedAgent } from './sealed-agent.js';
import { createToolCoach, isToolCoachEnabled } from './tool-coach.js';
import { createTurnToolGuidance } from './turn-tool-guidance.js';

export { signalAbortReason } from './agent-loop-retry.js';

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
  // A sealed companion takes input only from its host's task (sealed-agent.ts).
  const sealed = isSealedAgent(a.ctx);
  const checkMailbox = sealed ? async () => [] : attachMailboxChecker(a);
  if (!sealed) attachSessionNotes(a);

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

  const {
    foldBlockIntoConversation,
    injectPendingBtwNotes,
    injectPendingSessionNotes,
    injectPendingDeliveries,
    injectQueueAwareness,
    ownSessionIds,
    checkIterationLimit,
  } = createAgentLoopInjectors(a);

  async function runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult> {
    // A host may select another session while middleware/provider work awaits.
    // Every write and recovery marker in this run belongs to its starting writer.
    const sessionWriter = a.ctx.activeRunSessionWriter ?? a.ctx.session;
    a.ctx.meta['subagentsPolicyLocked'] = true;
    await a.pipelines.userInput.run(inputPayload);
    recordUserIntentEvidence(a.ctx, inputPayload.text);
    await sessionWriter.append({
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
    // Every host's user turn passes here, so this one call arms the gate for
    // the CLI, TUI and WebUI alike. Runtime-injected context never arms it.
    if (inputOrigin === 'user_input') armRequiredSkills(a.ctx, inputPayload.text);
    const promptIndex = a.ctx.messages.filter((m) => m.role === 'user').length - 1;
    const preview = inputPayload.text.slice(0, 80) + (inputPayload.text.length > 80 ? '…' : '');
    await sessionWriter.writeCheckpoint(promptIndex, preview);
    try {
      await a.ctx.flushConversationJournal();
      await sessionWriter.flush();
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
    /** Auto-grants spent on this run; capped by `a.maxAutoExtensions`. */
    let limitExtensionsUsed = 0;
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
    const toolCoach = createToolCoach(
      a.ctx.catalogTools.length > 0 ? a.ctx.catalogTools : a.ctx.tools,
    );
    const toolCoachEnabled = () =>
      isToolCoachEnabled(
        a.ctx.meta,
        a.container.safeResolve(TOKENS.ConfigStore)?.get().features.toolCoach,
      );
    const initialToolAdvice =
      inputOrigin === 'user_input' && toolCoachEnabled()
        ? toolCoach.initialNote(inputPayload.text)
        : null;
    const turnToolGuidance =
      inputOrigin === 'user_input' && toolCoachEnabled()
        ? await createTurnToolGuidance({
            task: inputPayload.text,
            projectRoot: a.ctx.projectRoot,
            signal: controller.signal,
            tools: a.ctx.catalogTools.length > 0 ? a.ctx.catalogTools : a.ctx.tools,
            getTool: (name) => a.tools.get(name),
            autoAllowed: async (tool, input) =>
              (await a.permission.evaluate(tool, input, a.ctx)).permission === 'auto',
          })
        : null;
    let pendingLoopSteer: string | null = null;
    let todoReconcileSteers = 0;

    function queueLoopSteer(text: string): void {
      pendingLoopSteer = pendingLoopSteer ? `${pendingLoopSteer}\n${text}` : text;
    }

    const onSubagentDone = ({
      sessionId,
      summary,
      ok,
    }: {
      sessionId?: string | undefined;
      summary: string;
      ok: boolean;
    }) => {
      // The host bus is shared by every tab; only this run's session counts.
      if (sessionId && !ownSessionIds().includes(sessionId)) return;
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
    // One id per loop iteration, shared by every attempt at that step —
    // provider retries AND the fallback extension's hops, which call back into
    // this runner — so a retried step is attributed as one logical request.
    let stepRequestId: string | undefined;
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
            ...(stepRequestId ? { logicalRequestId: stepRequestId } : {}),
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
            ...(stepRequestId ? { logicalRequestId: stepRequestId } : {}),
          });

    const customRunner = a.extensions.wrapProviderRunner(baseRunner);

    try {
      for (let i = 0; ; i++) {
        iterations = i + 1;
        if (controller.signal.aborted) {
          return {
            status: 'aborted',
            iterations,
            error: abortedRunError(controller.signal.reason ?? 'aborted'),
            abortReason: signalAbortReason(controller.signal),
          };
        }

        try {
          await sessionWriter.writeInFlightMarker(`iteration ${i} / max ${a.maxIterations}`);
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
          limitExtensionsUsed,
        );
        effectiveLimit = limitCheck.limit;
        if (limitCheck.extended) limitExtensionsUsed++;
        if (limitCheck.exit) {
          return { ...limitCheck.exit, finalText };
        }

        await a.extensions.runBeforeIteration(a.ctx, i);
        a.events.emit('iteration.started', {
          sessionId: resolveEventSessionId(a.ctx),
          ctx: a.ctx,
          index: i,
        });

        if (!sealed) {
          injectPendingBtwNotes((block) => pendingMailboxBlocks.push(block));
          injectPendingSessionNotes();
          await injectPendingDeliveries();
          injectQueueAwareness();
        }
        if (i === 0 && initialToolAdvice) {
          foldBlockIntoConversation({ type: 'text', text: initialToolAdvice });
        }
        if (i === 0 && toolCoachEnabled() && turnToolGuidance?.initialNote) {
          foldBlockIntoConversation({ type: 'text', text: turnToolGuidance.initialNote });
        }

        if (pendingLoopSteer) {
          foldBlockIntoConversation({ type: 'text', text: pendingLoopSteer });
          pendingLoopSteer = null;
        }

        if (!sealed && !backgroundCoordination() && (i % pulseEveryN === 1 || pulseEveryN === 1)) {
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
        await sessionWriter
          .append({
            type: 'llm_request',
            ts: new Date().toISOString(),
            model: req.model,
            messageCount: req.messages.length,
            estimatedInputTokens: preFlight.total,
            toolCount: (req.tools ?? []).length,
            systemVariant: String(a.ctx.meta['systemPromptVariant'] ?? '') || undefined,
          })
          .catch(() => {});

        let res: Response;
        try {
          const historyVersion = requestHistoryVersion(req) ?? contextHistoryVersion(a.ctx);
          stepRequestId = randomUUID();
          res = await customRunner(a.ctx, req);
          // Usage belongs to the route captured for this request, even if the
          // user switched providers while its response was in flight.
          const key = `${requestProvider.id}/${req.model}`;
          const cal = getCalibrationState(key);
          const calibratedTotal = cal.calibrated
            ? Math.round(preFlight.total * Math.min(1.5, Math.max(0.5, cal.ratio)))
            : preFlight.total;
          const realInputTokens = effectiveInputTokens(res.usage);
          // Calibration learns actual/raw, not actual/already-calibrated:
          // feeding back the multiplier makes it converge to sqrt(actual/raw).
          recordActualUsage(realInputTokens, preFlight.total, key);
          const anchorIsPlausible = realInputTokens >= calibratedTotal * 0.5;
          const routeStillActive =
            a.ctx.provider.id === requestProvider.id && a.ctx.model === req.model;
          // Every plausible authoritative response consumes the latest prefix,
          // including responses with equal or lower usage than the last turn.
          const historyStillCurrent = contextHistoryVersion(a.ctx) === historyVersion;
          if (
            realInputTokens > 0 &&
            anchorIsPlausible &&
            routeStillActive &&
            historyStillCurrent &&
            requestPromptStillCurrent(a.ctx, req)
          ) {
            recordContextUsageAnchor(
              a.ctx,
              req,
              realInputTokens,
              loopContext.lastPreFlightMsgCount,
            );
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
              error: abortedRunError(err),
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

        const loopCheck =
          toolUses.length === 0
            ? loopDetector.checkIteration(i, res.content, toolUses, queueLoopSteer)
            : { cut: false };
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
          const toolExecution = await handlers.tools.executeTools(toolUses);
          const completedLoopCheck = controller.signal.aborted
            ? { cut: false }
            : loopDetector.checkIteration(
                i,
                res.content,
                toolUses,
                queueLoopSteer,
                toolExecution.results,
              );
          if (completedLoopCheck.cut) {
            return {
              status: 'max_iterations',
              iterations,
              finalText: finalText || completedLoopCheck.cutSummary || '',
              delegateSummaries,
            };
          }
          const advice = toolCoachEnabled()
            ? toolCoach.afterTools(toolUses, toolExecution.results, toolExecution.settlements)
            : null;
          if (advice) queueLoopSteer(advice);
          if (toolCoachEnabled() && turnToolGuidance) {
            const kitAdvice = await turnToolGuidance.afterTools(
              toolUses,
              toolExecution.results,
              toolExecution.settlements,
            );
            if (kitAdvice) queueLoopSteer(kitAdvice);
          }
        } catch (toolErr) {
          if (controller.signal.aborted) {
            a.events.emit('error', {
              sessionId: resolveEventSessionId(a.ctx),
              err: toError(toolErr),
              phase: 'tool',
            });
            return {
              status: 'aborted',
              iterations,
              error: abortedRunError(toolErr),
              finalText,
              delegateSummaries,
              abortReason: signalAbortReason(controller.signal),
            };
          }
          throw toolErr;
        }

        if (controller.signal.aborted) {
          const abortErr = toError(controller.signal.reason ?? 'aborted');
          a.events.emit('error', {
            sessionId: resolveEventSessionId(a.ctx),
            err: abortErr,
            phase: 'tool',
          });
          return {
            status: 'aborted',
            iterations,
            error: abortedRunError(controller.signal.reason ?? 'aborted'),
            finalText,
            delegateSummaries,
            abortReason: signalAbortReason(controller.signal),
          };
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
        await sessionWriter.clearInFlightMarker(reason);
        await sessionWriter.flush();
      } catch (err) {
        (a.logger.debug ?? a.logger.warn)?.(
          `in-flight marker clear failed: ${toErrorMessage(err)}`,
        );
      }
    }
  }

  return { runInner };
}
