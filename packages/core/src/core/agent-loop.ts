import type { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import { attachFleetPulse, attachMailboxChecker } from '../mailbox-attach.js';
import type { ContentBlock, TextBlock } from '../types/blocks.js';
import { isTextBlock, isToolUseBlock } from '../types/blocks.js';
import { toWrongStackError } from '../types/errors.js';
import type { Request, Response } from '../types/provider.js';
import { effectiveInputTokens } from '../types/provider.js';
import { recordUserIntentEvidence } from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import {
  estimateMessageTokens,
  estimateRequestTokens,
  getCalibrationState,
  type RequestTokenBreakdown,
  realAnchoredInputTokens,
  recordActualUsage,
} from '../utils/token-estimate.js';
import type { AgentInternals } from './agent-internals.js';
import type { AgentResponseHandler } from './agent-response.js';
import type { AgentToolHandler } from './agent-tools.js';
import type { RunResult, UserInputPayload } from './agent-types.js';
import { buildBtwBlock, consumeBtwNotes } from './btw.js';
import type { RunOptions } from './context.js';
import { consumeAutonomousContinue } from './continue-to-next-iteration.js';
import { requestLimitExtension } from './iteration-limit.js';
import { injectPendingMailboxMessages, removeInjectedMailboxBlocks } from './mailbox-loop.js';
import { runProviderWithRetry } from './provider-runner.js';
import { buildQueuedMessagesBlock, consumeQueuedMessagesUpdate } from './queued-messages.js';
import { providerBoundToRequest } from './request-provider-binding.js';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
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

  async function compactContextIfNeeded(): Promise<boolean> {
    const msgCount = a.ctx.messages.length;
    const maxContext = currentMaxContext();
    const revision = a.ctx.state.revision;
    const toolsRef = a.ctx.tools;
    const systemRef = a.ctx.systemPrompt;
    const requestTokens = a.ctx.lastRequestTokens;
    if (
      _lastCompactionMsgCount === msgCount &&
      _lastCompactionRevision === revision &&
      _lastCompactionToolsRef === toolsRef &&
      _lastCompactionSystemRef === systemRef &&
      _lastCompactionRequestTokens === requestTokens &&
      _lastCompactionWasNoop &&
      _lastCompactionMaxContext === maxContext &&
      maxContext > 0
    ) {
      return false;
    }
    const beforeMessages = a.ctx.messages;
    const beforeMsgCount = a.ctx.messages.length;
    await a.pipelines.contextWindow.run(a.ctx);
    _lastCompactionMsgCount = a.ctx.messages.length;
    _lastCompactionRevision = a.ctx.state.revision;
    _lastCompactionToolsRef = a.ctx.tools;
    _lastCompactionSystemRef = a.ctx.systemPrompt;
    _lastCompactionMaxContext = maxContext;
    const changed = a.ctx.messages !== beforeMessages || a.ctx.messages.length !== beforeMsgCount;
    const tokens = refreshContextRequestTokenStash({ force: changed });
    _lastCompactionRequestTokens = tokens;
    const load = maxContext > 0 ? tokens / maxContext : 0;
    _lastCompactionWasNoop = tokens > 0 && load < 0.5;
    if (changed) {
      _lastEmittedMsgCount = -1;
      _lastEmittedToolCount = -1;
      _lastEmittedMaxContext = -1;
    }
    return changed;
  }

  const calibrationKey = (model: string = a.ctx.model): string =>
    `${a.ctx.provider?.id ?? 'unknown'}/${model}`;

  let _cachedSysRef: unknown = null;
  let _cachedToolsRef: readonly unknown[] | null = null;
  let _cachedOverheadTokens = 0;

  function systemAndToolsOverhead(): number {
    const sysRef = a.ctx.systemPrompt;
    const toolsRef = a.ctx.tools;
    if (sysRef === _cachedSysRef && toolsRef === _cachedToolsRef && _cachedOverheadTokens > 0) {
      return _cachedOverheadTokens;
    }
    const breakdown = estimateRequestTokens([], sysRef, toolsRef ?? [], calibrationKey());
    _cachedSysRef = sysRef;
    _cachedToolsRef = toolsRef;
    _cachedOverheadTokens = breakdown.systemPrompt + breakdown.tools;
    return _cachedOverheadTokens;
  }

  function stashRequestTokens(req: Request): RequestTokenBreakdown {
    const preFlight = estimateRequestTokens(
      req.messages,
      req.system,
      req.tools ?? [],
      calibrationKey(req.model),
    );

    a.ctx.lastRequestTokens = preFlight.total;
    _lastPreFlightMsgCount = req.messages.length;
    _cachedSysRef = req.system;
    _cachedToolsRef = req.tools ?? [];
    _cachedOverheadTokens = preFlight.systemPrompt + preFlight.tools;
    a.ctx.meta['lastRequestTokensAt'] = {
      msgCount: req.messages.length,
      toolCount: (req.tools ?? []).length,
    };

    return preFlight;
  }

  function refreshContextRequestTokenStash(opts: { force?: boolean | undefined } = {}): number {
    const msgCount = a.ctx.messages.length;
    const toolCount = (a.ctx.tools ?? []).length;
    const stashed = a.ctx.lastRequestTokens;
    const stashedAt = a.ctx.meta?.['lastRequestTokensAt'];
    if (
      !opts.force &&
      typeof stashed === 'number' &&
      stashed > 0 &&
      typeof stashedAt === 'object' &&
      stashedAt !== null
    ) {
      const meta = stashedAt as { msgCount?: unknown; toolCount?: unknown };
      if (
        meta.msgCount === msgCount &&
        (typeof meta.toolCount !== 'number' || meta.toolCount === toolCount)
      ) {
        return stashed;
      }
    }

    const refreshed = estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
    a.ctx.lastRequestTokens = refreshed;
    _lastPreFlightMsgCount = msgCount;
    a.ctx.meta['lastRequestTokensAt'] = { msgCount, toolCount };
    return refreshed;
  }

  async function buildRequestWithPreflightCompaction(opts: RunOptions): Promise<{
    req: Request;
    provider: import('../types/provider.js').Provider;
    preFlight: RequestTokenBreakdown;
  }> {
    let prepared = await handlers.response.buildAndRunRequestPipeline(opts);
    let req = prepared.request;
    let preFlight = stashRequestTokens(req);

    if (await compactContextIfNeeded()) {
      prepared = await handlers.response.buildAndRunRequestPipeline(opts);
      req = prepared.request;
      preFlight = stashRequestTokens(req);
    }

    return { req, provider: prepared.provider, preFlight };
  }

  function emitContextPct(): void {
    const msgCount = a.ctx.messages.length;
    const toolCount = (a.ctx.tools ?? []).length;
    const maxContext = currentMaxContext();
    const revision = a.ctx.state.revision;
    if (
      msgCount === _lastEmittedMsgCount &&
      toolCount === _lastEmittedToolCount &&
      revision === _lastEmittedRevision &&
      maxContext === _lastEmittedMaxContext &&
      maxContext > 0
    ) {
      return;
    }
    _lastEmittedMsgCount = msgCount;
    _lastEmittedToolCount = toolCount;
    _lastEmittedRevision = revision;
    _lastEmittedMaxContext = maxContext;

    if (msgCount !== _lastPreFlightMsgCount) {
      const stashed = a.ctx.lastRequestTokens;
      if (
        typeof stashed === 'number' &&
        stashed > 0 &&
        _lastPreFlightMsgCount >= 0 &&
        _lastPreFlightMsgCount < msgCount
      ) {
        const delta = estimateMessageTokens(a.ctx.messages.slice(_lastPreFlightMsgCount));
        a.ctx.lastRequestTokens = stashed + delta;
      } else {
        a.ctx.lastRequestTokens = estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
      }
      _lastPreFlightMsgCount = msgCount;
      a.ctx.meta['lastRequestTokensAt'] = { msgCount, toolCount };
    }

    let total: number;
    const anchored = realAnchoredInputTokens(
      a.ctx.messages,
      a.ctx.lastRealInputTokens,
      typeof a.ctx.meta?.['realAnchorMsgCount'] === 'number'
        ? (a.ctx.meta['realAnchorMsgCount'] as number)
        : undefined,
    );
    const stashed = a.ctx.lastRequestTokens;
    if (anchored !== null) {
      total = anchored;
    } else if (typeof stashed === 'number' && stashed > 0) {
      const cal = getCalibrationState(calibrationKey());
      total = cal.calibrated
        ? Math.round(stashed * Math.min(1.5, Math.max(0.5, cal.ratio)))
        : stashed;
    } else {
      const raw = estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
      a.ctx.lastRequestTokens = raw;
      _lastPreFlightMsgCount = msgCount;
      const cal = getCalibrationState(calibrationKey());
      total = cal.calibrated ? Math.round(raw * Math.min(1.5, Math.max(0.5, cal.ratio))) : raw;
    }
    const rawLoad = maxContext > 0 ? total / maxContext : 0;
    const load = Math.max(0, Math.min(1, rawLoad));
    a.events.emit('ctx.pct', {
      sessionId: a.ctx.session.id,
      load,
      rawLoad,
      tokens: total,
      maxContext,
    });
  }

  function currentMaxContext(): number {
    const metaLimit = a.ctx.meta?.['effectiveMaxContext'];
    const providerMax = a.ctx.provider.capabilities.maxContext;
    return typeof metaLimit === 'number' && metaLimit > 0
      ? metaLimit
      : typeof providerMax === 'number' && providerMax > 0
        ? providerMax
        : 200_000;
  }

  let _lastEmittedMsgCount = -1;
  let _lastEmittedToolCount = -1;
  let _lastEmittedRevision = -1;
  let _lastEmittedMaxContext = -1;
  let _lastPreFlightMsgCount = -1;
  let _lastCompactionMsgCount = -1;
  let _lastCompactionRevision = -1;
  let _lastCompactionToolsRef: unknown = null;
  let _lastCompactionSystemRef: unknown = null;
  let _lastCompactionRequestTokens: number | undefined;
  let _lastCompactionMaxContext = -1;
  let _lastCompactionWasNoop = false;

  function foldBlockIntoConversation(block: TextBlock): void {
    if (!a.ctx.state.appendBlockToLastUserMessage(block)) {
      a.ctx.state.appendMessage({ role: 'user', content: [block] });
    }
  }

  function iterationFingerprint(blocks: ContentBlock[]): string {
    const toolUses = blocks.filter(isToolUseBlock);
    const texts = blocks.filter(isTextBlock);

    const toolNameSet = Array.from(new Set(toolUses.map((u) => u.name))).sort();
    const firstInputHash = toolUses[0] ? hashSmall(stableStringify(toolUses[0].input ?? {})) : '';
    const textBlob = texts
      .map((t) => t.text)
      .join('')
      .slice(0, 512);

    const hasContent = toolNameSet.length > 0 || textBlob.length > 0;
    if (!hasContent) return '__empty__';

    return [
      `tools=${toolNameSet.join('+') || '-'}`,
      `in0=${firstInputHash}`,
      `txt=${textBlob}`,
    ].join('\n');
  }

  function stableStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
  }

  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
      return out;
    }
    return value;
  }

  function hashSmall(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
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
        sessionId: a.ctx.session.id,
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
    await a.pipelines.userInput.run(inputPayload);
    recordUserIntentEvidence(a.ctx, inputPayload.text);
    await a.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: inputPayload.content,
    });
    a.ctx.state.appendMessage({ role: 'user', content: inputPayload.content });
    const promptIndex = a.ctx.messages.filter((m) => m.role === 'user').length - 1;
    const preview = inputPayload.text.slice(0, 80) + (inputPayload.text.length > 80 ? '…' : '');
    await a.ctx.session.writeCheckpoint(promptIndex, preview);
    try {
      await a.ctx.flushConversationJournal();
      await a.ctx.session.flush();
    } catch (err) {
      (a.logger.debug ?? a.logger.warn)?.(`session boundary flush failed: ${toErrorMessage(err)}`);
    }

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
        refreshContextRequestTokenStash({ force: true });
      }
    }

    const loopCfg = a.loopDetection;
    let lastToolSignature = '';
    let toolLoopCount = 0;
    let iterationSteerDone = false;
    const recentCallKeys: string[] = [];
    const steeredCallKeys = new Set<string>();
    let pendingLoopSteer: string | null = null;

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
          await a.ctx.session.flush();
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
        a.events.emit('iteration.started', { sessionId: a.ctx.session.id, ctx: a.ctx, index: i });

        injectPendingBtwNotes((block) => pendingMailboxBlocks.push(block));
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
        } = await buildRequestWithPreflightCompaction(opts);
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
          const key = calibrationKey(req.model);
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
              _lastPreFlightMsgCount < previousAnchorMsgCount);
          if (realInputTokens > 0 && anchorIsPlausible && anchorAdvanced) {
            a.ctx.lastRealInputTokens = realInputTokens;
            a.ctx.meta['realAnchorMsgCount'] = _lastPreFlightMsgCount;
          }
          recoveryRetries = 0;
        } catch (err) {
          if (controller.signal.aborted) {
            a.events.emit('error', {
              sessionId: a.ctx.session.id,
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
                sessionId: a.ctx.session.id,
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
                  sessionId: a.ctx.session.id,
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
              continue;
            }
          }

          const recovered = await a.errorHandler.recover(err, a.ctx);
          if (!recovered || recovered.action === 'fail') {
            a.events.emit('error', {
              sessionId: a.ctx.session.id,
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
                sessionId: a.ctx.session.id,
                err: toError(err),
                phase: 'provider',
              });
              return { status: 'failed', iterations, error: toWrongStackError(err) };
            }
            if (recovered.model) a.ctx.model = recovered.model;
            a.logger.info(`Recovered provider error via ${recovered.reason}; retrying turn`);
            continue;
          }
          recoveryRetries = 0;
          res = recovered.response;
        }

        clearEvaluatedMailboxBlocks();

        const responseResult = await handlers.response.processResponse(
          res,
          req,
          providerBoundToRequest(req) ?? requestProvider,
        );
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

        if (loopCfg.mode !== 'off') {
          const sig = iterationFingerprint(res.content);
          if (sig !== '__empty__') {
            if (sig === lastToolSignature) {
              toolLoopCount++;
            } else {
              lastToolSignature = sig;
              toolLoopCount = 1;
              iterationSteerDone = false;
            }

            const names = toolUses.map((t) => t.name).join(', ');
            const hasText = res.content.some(isTextBlock);
            const kind: 'tool' | 'message' | 'mixed' =
              toolUses.length > 0 && hasText ? 'mixed' : toolUses.length > 0 ? 'tool' : 'message';
            const observationRepeat =
              loopCfg.mode === 'steer-then-cut' &&
              toolUses.length > 0 &&
              toolUses.every((use) => {
                const tool = a.tools.get(use.name);
                return (
                  tool?.mutating === false &&
                  (tool.riskTier === 'safe' || (tool.capabilities?.length ?? 0) > 0)
                );
              });
            const repeatMultiplier = observationRepeat ? 2 : 1;
            const detail =
              kind === 'tool'
                ? `"${names}" called with effectively identical inputs ${toolLoopCount} times in a row`
                : kind === 'mixed'
                  ? `"${names}" + same text repeated ${toolLoopCount} times in a row`
                  : `same assistant text repeated ${toolLoopCount} times in a row`;

            const cutAt =
              (loopCfg.mode === 'cut' ? loopCfg.steerThreshold : loopCfg.cutThreshold) *
              repeatMultiplier;
            if (toolLoopCount >= cutAt) {
              a.logger.warn(`Loop detected: ${detail} — stopping to prevent infinite loop.`);
              a.events.emit('tool.loop_detected', {
                sessionId: a.ctx.session.id,
                ctx: a.ctx,
                tools: names,
                repeatCount: toolLoopCount,
                iteration: i,
                kind,
                action: 'cut',
                scope: 'iteration',
              });
              const summary =
                kind === 'message'
                  ? `[Loop detected: same assistant message repeated ${toolLoopCount}× — stopping to prevent infinite repetition.]`
                  : `[Loop detected: ${detail} — stopping to prevent infinite repetition.]`;
              return {
                status: 'max_iterations',
                iterations,
                finalText: finalText || summary,
                delegateSummaries,
              };
            }

            if (
              loopCfg.mode === 'steer-then-cut' &&
              toolLoopCount >= loopCfg.steerThreshold * repeatMultiplier &&
              !iterationSteerDone
            ) {
              iterationSteerDone = true;
              a.logger.warn(`Loop detected: ${detail} — steering the model to change approach.`);
              a.events.emit('tool.loop_detected', {
                sessionId: a.ctx.session.id,
                ctx: a.ctx,
                tools: names,
                repeatCount: toolLoopCount,
                iteration: i,
                kind,
                action: 'steer',
                scope: 'iteration',
              });
              queueLoopSteer(
                `[loop-detector] Your last ${toolLoopCount} responses were effectively identical (${detail}). ` +
                  'This approach is not working. Change strategy: use a different tool, different arguments, ' +
                  'or a different plan — or explain what is blocking you and stop. ' +
                  `Repeating the same response ${cutAt - toolLoopCount} more time(s) will terminate the turn.`,
              );
            }
          } else {
            lastToolSignature = '';
            toolLoopCount = 0;
            iterationSteerDone = false;
          }

          if (loopCfg.mode === 'steer-then-cut') {
            for (const u of toolUses) {
              const key = `${u.name}:${hashSmall(stableStringify(u.input ?? {}))}`;
              recentCallKeys.push(key);
              if (recentCallKeys.length > loopCfg.windowSize) recentCallKeys.shift();
              if (steeredCallKeys.has(key)) continue;
              let count = 0;
              for (const k of recentCallKeys) if (k === key) count++;
              const tool = a.tools.get(u.name);
              const observationThreshold =
                tool?.mutating === false &&
                (tool.riskTier === 'safe' || (tool.capabilities?.length ?? 0) > 0)
                  ? loopCfg.callRepeatThreshold * 2
                  : loopCfg.callRepeatThreshold;
              if (count < observationThreshold) continue;
              steeredCallKeys.add(key);
              const preview = JSON.stringify(u.input ?? {}).slice(0, 160);
              a.logger.warn(
                `Loop detected: "${u.name}" called with identical arguments ${count}× within the last ${loopCfg.windowSize} tool calls — steering the model to change approach.`,
              );
              a.events.emit('tool.loop_detected', {
                sessionId: a.ctx.session.id,
                ctx: a.ctx,
                tools: u.name,
                repeatCount: count,
                iteration: i,
                kind: 'tool',
                action: 'steer',
                scope: 'call',
              });
              queueLoopSteer(
                `[loop-detector] You have called ${u.name}(${preview}) ${count} times with identical arguments ` +
                  `within the last ${loopCfg.windowSize} tool calls. The result will not change. Do not repeat ` +
                  'this call — use what you already know, try a different approach, or explain the blocker.',
              );
            }
          }
        }

        if (toolUses.length === 0) {
          await compactContextIfNeeded();
          emitContextPct();
          a.events.emit('iteration.completed', {
            sessionId: a.ctx.session.id,
            ctx: a.ctx,
            index: i,
          });
          if (autonomousContinue && responseResult.directive === 'continue') {
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
          await compactContextIfNeeded();
          emitContextPct();
          a.events.emit('iteration.completed', {
            sessionId: a.ctx.session.id,
            ctx: a.ctx,
            index: i,
          });
          await a.extensions.runAfterIteration(a.ctx, i);
          continue;
        }

        await compactContextIfNeeded();
        emitContextPct();
        a.events.emit('iteration.completed', { sessionId: a.ctx.session.id, ctx: a.ctx, index: i });
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
