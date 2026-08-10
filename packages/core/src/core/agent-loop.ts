import type { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import { attachFleetPulse, attachMailboxChecker } from '../mailbox-attach.js';
import type { ContentBlock, TextBlock } from '../types/blocks.js';
import { isTextBlock, isToolUseBlock } from '../types/blocks.js';
import { toWrongStackError } from '../types/errors.js';
import type { Request, Response } from '../types/provider.js';
import { effectiveInputTokens } from '../types/provider.js';
import {
  isRuntimeContextInput,
  recordUserIntentEvidence,
} from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { hasOpenTodos } from '../utils/todos-format.js';
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
import { type RunOptions, resolveEventSessionId } from './context.js';
import { consumeAutonomousContinue } from './continue-to-next-iteration.js';
import { requestLimitExtension } from './iteration-limit.js';
import { injectPendingMailboxMessages, removeInjectedMailboxBlocks } from './mailbox-loop.js';
import { clearPendingNextSteps } from './next-steps-slot.js';
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

  async function refreshProviderContextLimit(
    provider: import('../types/provider.js').Provider,
    model: string,
    opts: { probe?: boolean } = {},
  ): Promise<void> {
    a.ctx.meta ??= {};
    const routeKey = `${provider.id}/${model}`;
    const previousRouteKey = a.ctx.meta['contextLimitRouteKey'];
    const routeChanged = previousRouteKey !== undefined && previousRouteKey !== routeKey;
    const previousMaxContext = currentMaxContext();

    // Route change (provider or model switch): clear all per-route limit state
    // so the new route starts from its own capability baseline. This runs even
    // when the new provider has no refreshContextLimit, so switching away from
    // a probed Codex route does not leave a stale ceiling in force.
    //
    // We do NOT mutate provider.capabilities.maxContext (see below) so there is
    // no cross-provider contamination to undo — meta cleanup alone resets the
    // effective ceiling to the new provider's native capability.
    if (routeChanged) {
      delete a.ctx.meta['providerOverflowMaxContext'];
      delete a.ctx.meta['contextLimitBaseline'];
      delete a.ctx.meta['providerLimitEffectiveMaxContext'];
      delete a.ctx.meta['effectiveMaxContext'];
      delete a.ctx.meta['effectiveMaxContextSource'];
      delete a.ctx.meta['contextLimitLastEmittedMaxContext'];
      delete a.ctx.meta['contextLimitLastEmittedSource'];
    }
    a.ctx.meta['contextLimitRouteKey'] = routeKey;

    // Read the new route's native capability only after clearing old route
    // metadata. The pre-cleanup value is retained solely as event history.
    //
    // IMPORTANT: we read from the passed `provider` parameter, NOT from
    // currentMaxContext() / a.ctx.provider. During a model transition the
    // agent loop may swap a.ctx.provider to a different object; reading the
    // wrong one would seed the baseline from the wrong provider's ceiling.
    const routeMeta = a.ctx.meta['effectiveMaxContext'];
    const routeProviderCap = provider.capabilities.maxContext;
    const currentEffective =
      typeof routeMeta === 'number' && routeMeta > 0
        ? routeMeta
        : typeof routeProviderCap === 'number' && routeProviderCap > 0
          ? routeProviderCap
          : 200_000;
    const emitEffectiveLimit = (
      effective: number,
      source: 'configured' | 'provider' | 'provider_overflow',
    ): void => {
      const lastEmitted = a.ctx.meta['contextLimitLastEmittedMaxContext'];
      const lastEmittedSource = a.ctx.meta['contextLimitLastEmittedSource'];
      if (lastEmitted === effective && lastEmittedSource === source) return;

      const eventPrevious =
        typeof lastEmitted === 'number' && Number.isFinite(lastEmitted) && lastEmitted > 0
          ? Math.floor(lastEmitted)
          : previousMaxContext;
      a.ctx.meta['contextLimitLastEmittedMaxContext'] = effective;
      a.ctx.meta['contextLimitLastEmittedSource'] = source;
      a.events.emit('ctx.max_context', {
        sessionId: resolveEventSessionId(a.ctx),
        providerId: provider.id,
        modelId: model,
        maxContext: effective,
        ...(eventPrevious > 0 ? { previousMaxContext: eventPrevious } : {}),
        source,
        decreased: eventPrevious > 0 && effective < eventPrevious,
      });
    };
    const emitNativeAfterRouteChange = (): void => {
      if (routeChanged && currentEffective > 0) {
        // Persist the native ceiling in meta so currentMaxContext() — which
        // reads meta first — returns this value even if a.ctx.provider has not
        // been swapped yet by the caller. Without this, the agent loop reads
        // a stale effective from the old route until ctx.provider catches up.
        a.ctx.meta['effectiveMaxContext'] = currentEffective;
        a.ctx.meta['effectiveMaxContextSource'] = 'configured';
        emitEffectiveLimit(currentEffective, 'configured');
      }
    };

    const refresh = provider.refreshContextLimit;
    if (opts.probe === false || !refresh) {
      emitNativeAfterRouteChange();
      return;
    }

    let discovered: Awaited<ReturnType<NonNullable<typeof refresh>>>;
    try {
      discovered = await refresh.call(provider, model, { signal: a.ctx.signal });
    } catch {
      // Capability discovery is advisory. The provider request remains usable
      // when its metadata endpoint is temporarily unavailable.
      emitNativeAfterRouteChange();
      return;
    }
    const providerLimit = discovered?.maxContext;
    if (
      typeof providerLimit !== 'number' ||
      !Number.isFinite(providerLimit) ||
      providerLimit <= 0
    ) {
      emitNativeAfterRouteChange();
      return;
    }
    const providerLimitFloored = Math.floor(providerLimit);

    const existingBaseline = a.ctx.meta['contextLimitBaseline'];
    const lastApplied = a.ctx.meta['providerLimitEffectiveMaxContext'];
    const existingOverflow = a.ctx.meta['providerOverflowMaxContext'];
    const effectiveChangedOutsideProbe =
      typeof lastApplied === 'number' &&
      Number.isFinite(lastApplied) &&
      currentEffective !== Math.floor(lastApplied) &&
      currentEffective !== existingOverflow;
    const baseline =
      effectiveChangedOutsideProbe ||
      typeof existingBaseline !== 'number' ||
      !Number.isFinite(existingBaseline) ||
      existingBaseline <= 0
        ? currentEffective
        : Math.floor(existingBaseline);
    a.ctx.meta['contextLimitBaseline'] = baseline;

    const overflowLimit = a.ctx.meta['providerOverflowMaxContext'];
    const overflowFloored =
      typeof overflowLimit === 'number' && Number.isFinite(overflowLimit) && overflowLimit > 0
        ? Math.floor(overflowLimit)
        : undefined;

    const ceilings: number[] = [baseline, providerLimitFloored];
    if (overflowFloored !== undefined) ceilings.push(overflowFloored);
    const effective = Math.min(...ceilings.filter((limit) => limit > 0));

    // Determine which ceiling actually won, so the source label is accurate.
    let effectiveSource: 'configured' | 'provider' | 'provider_overflow';
    if (overflowFloored !== undefined && effective === overflowFloored) {
      effectiveSource = 'provider_overflow';
    } else if (effective === providerLimitFloored) {
      effectiveSource = 'provider';
    } else {
      effectiveSource = 'configured';
    }

    a.ctx.meta['effectiveMaxContext'] = effective;
    a.ctx.meta['providerLimitEffectiveMaxContext'] = effective;
    a.ctx.meta['effectiveMaxContextSource'] = effectiveSource;
    // Deliberately do NOT mutate provider.capabilities.maxContext. The agent
    // loop reads the effective ceiling via currentMaxContext(), which prefers
    // ctx.meta['effectiveMaxContext']. Mutating the shared provider object
    // would contaminate other models on the same provider and survive across
    // route changes. The ctx.max_context event carries the new limit to all UI
    // consumers (TUI activeMaxContext, WebUI session-store maxContext).
    emitEffectiveLimit(effective, effectiveSource);
  }

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
    const beforeRevision = a.ctx.state.revision;
    await a.pipelines.contextWindow.run(a.ctx);
    _lastCompactionMsgCount = a.ctx.messages.length;
    _lastCompactionRevision = a.ctx.state.revision;
    _lastCompactionToolsRef = a.ctx.tools;
    _lastCompactionSystemRef = a.ctx.systemPrompt;
    _lastCompactionMaxContext = maxContext;
    const changed =
      a.ctx.state.revision !== beforeRevision ||
      a.ctx.messages !== beforeMessages ||
      a.ctx.messages.length !== beforeMsgCount;
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
    _lastPreFlightToolCount = (req.tools ?? []).length;
    _lastPreFlightRevision = a.ctx.state.revision;
    _cachedSysRef = req.system;
    _cachedToolsRef = req.tools ?? [];
    _cachedOverheadTokens = preFlight.systemPrompt + preFlight.tools;
    a.ctx.meta['lastRequestTokensAt'] = {
      msgCount: req.messages.length,
      toolCount: (req.tools ?? []).length,
      revision: a.ctx.state.revision,
    };

    return preFlight;
  }

  function refreshContextRequestTokenStash(opts: { force?: boolean | undefined } = {}): number {
    const msgCount = a.ctx.messages.length;
    const toolCount = (a.ctx.tools ?? []).length;
    const revision = a.ctx.state.revision;
    const stashed = a.ctx.lastRequestTokens;
    const stashedAt = a.ctx.meta?.['lastRequestTokensAt'];
    if (
      !opts.force &&
      typeof stashed === 'number' &&
      stashed > 0 &&
      typeof stashedAt === 'object' &&
      stashedAt !== null
    ) {
      const meta = stashedAt as {
        msgCount?: unknown;
        toolCount?: unknown;
        revision?: unknown;
      };
      if (
        meta.msgCount === msgCount &&
        meta.toolCount === toolCount &&
        meta.revision === revision &&
        _lastPreFlightRevision === revision
      ) {
        return stashed;
      }
    }

    const refreshed = estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
    a.ctx.lastRequestTokens = refreshed;
    _lastPreFlightMsgCount = msgCount;
    _lastPreFlightToolCount = toolCount;
    _lastPreFlightRevision = revision;
    a.ctx.meta['lastRequestTokensAt'] = { msgCount, toolCount, revision };
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

    // Probe the provider's live context limit before each request build.
    // Post-response compaction does NOT re-probe, avoiding a second metadata
    // round-trip per iteration. If compaction triggers a route rebuild,
    // re-probe the new route below.
    let probedRouteKey = `${prepared.provider.id}/${req.model}`;
    await refreshProviderContextLimit(prepared.provider, req.model);

    if (await compactContextIfNeeded()) {
      prepared = await handlers.response.buildAndRunRequestPipeline(opts);
      req = prepared.request;
      preFlight = stashRequestTokens(req);
      // If compaction triggered a model/provider rebuild that changed the
      // route, re-probe the new route so the effective ceiling matches.
      const rebuiltRouteKey = `${prepared.provider.id}/${req.model}`;
      if (rebuiltRouteKey !== probedRouteKey) {
        probedRouteKey = rebuiltRouteKey;
        await refreshProviderContextLimit(prepared.provider, req.model);
        // The re-probe may have discovered a lower ceiling. Re-run compaction
        // against that new limit so the outgoing request does not overflow.
        if (await compactContextIfNeeded()) {
          prepared = await handlers.response.buildAndRunRequestPipeline(opts);
          req = prepared.request;
          preFlight = stashRequestTokens(req);
        }
      }
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

    if (
      msgCount !== _lastPreFlightMsgCount ||
      toolCount !== _lastPreFlightToolCount ||
      revision !== _lastPreFlightRevision
    ) {
      // Any observed state rewrite invalidates the aggregate token stash.
      // Per-message `_estTokens` keep this full sum cheap while avoiding the
      // unsafe assumption that a larger array was append-only.
      refreshContextRequestTokenStash({ force: true });
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
      const raw = refreshContextRequestTokenStash({ force: true });
      const cal = getCalibrationState(calibrationKey());
      total = cal.calibrated ? Math.round(raw * Math.min(1.5, Math.max(0.5, cal.ratio))) : raw;
    }
    const rawLoad = maxContext > 0 ? total / maxContext : 0;
    const load = Math.max(0, Math.min(1, rawLoad));
    a.events.emit('ctx.pct', {
      sessionId: resolveEventSessionId(a.ctx),
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
  let _lastPreFlightToolCount = -1;
  let _lastPreFlightRevision = -1;
  let _lastCompactionMsgCount = -1;
  let _lastCompactionRevision = -1;
  let _lastCompactionToolsRef: unknown = null;
  let _lastCompactionSystemRef: unknown = null;
  let _lastCompactionRequestTokens: number | undefined;
  let _lastCompactionMaxContext = -1;
  let _lastCompactionWasNoop = false;

  function foldBlockIntoConversation(block: TextBlock): void {
    if (!a.ctx.state.appendBlockToLastUserMessage(block)) {
      a.ctx.state.appendMessage({ role: 'user', content: [block], origin: 'runtime' });
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

    // Suggestions belong to the prompt that produced them. Clearing here means a
    // `nextsteps` tool call from the previous turn can never attach its block to
    // this turn's answer — including the auto-submitted turn that a suggestion
    // itself kicked off, which arrives as a fresh `run()`.
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
        a.events.emit('iteration.started', {
          sessionId: resolveEventSessionId(a.ctx),
          ctx: a.ctx,
          index: i,
        });

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
            continue;
          }
          recoveryRetries = 0;
          res = recovered.response;
        }

        clearEvaluatedMailboxBlocks();

        const responseProvider = providerBoundToRequest(req) ?? requestProvider;
        const responseResult = await handlers.response.processResponse(res, req, responseProvider);
        // Fallback may rebind this request after its one preflight metadata probe.
        // Synchronize route-scoped limits before any post-response compaction,
        // but do not perform a second provider metadata request.
        await refreshProviderContextLimit(responseProvider, req.model, { probe: false });
        // Expose the turn's assistant text so post-turn surfaces can re-read it.
        // `/agent-improve <role> capture` reads `lastAgentOutput` to rescan for
        // `## LEARNED` blocks; nothing wrote the key, so the command could only
        // ever report "no blocks found".
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
                sessionId: resolveEventSessionId(a.ctx),
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
                sessionId: resolveEventSessionId(a.ctx),
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
                sessionId: resolveEventSessionId(a.ctx),
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
          // Resolve the provider bound to this request at use time because
          // fallback may have rebound it during response processing.
          await compactContextIfNeeded();
          emitContextPct();
          a.events.emit('iteration.completed', {
            sessionId: resolveEventSessionId(a.ctx),
            ctx: a.ctx,
            index: i,
          });
          // A turn-ending prose response is not proof that the tracked work
          // list advanced. Without this gate a leader can say that an item is
          // finished while leaving it `in_progress`; TUI auto mode then
          // re-submits the exact same grounded continuation until its loop
          // guard halts. Give the model a bounded in-run reconciliation chance
          // before exposing the turn as complete. The todo tool remains the
          // authority: this gate never guesses that work succeeded or marks a
          // card done from prose alone.
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
                'If the current item is genuinely unfinished, continue doing the work before answering; do not merely repeat the previous final response or emit <nextsteps>.',
            );
            await a.extensions.runAfterIteration(a.ctx, i);
            continue;
          }
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
            sessionId: resolveEventSessionId(a.ctx),
            ctx: a.ctx,
            index: i,
          });
          await a.extensions.runAfterIteration(a.ctx, i);
          continue;
        }

        await compactContextIfNeeded();
        emitContextPct();
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
