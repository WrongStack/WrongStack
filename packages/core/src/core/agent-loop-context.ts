import { AgentError, ERROR_CODES } from '@wrongstack/contracts/types/errors';
import type { Request } from '@wrongstack/contracts/types/provider';
import {
  CONTEXT_REQUEST_OVERHEAD_META,
  type ContextRequestOverhead,
  computeContextWindowBudget,
} from '../utils/context-budget.js';
import {
  estimateMessageTokens,
  estimateRequestTokens,
  estimateRequestTokensUpperBound,
  getCalibrationState,
  type RequestTokenBreakdown,
} from '../utils/token-estimate.js';
import type { AgentInternals } from './agent-internals.js';
import { keepsOwnContext, readAgentContext } from './agent-owned-context.js';
import type { AgentResponseHandler } from './agent-response.js';
import { type RunOptions, resolveEventSessionId } from './context.js';
import {
  readRealAnchoredContextTokens,
  recordContextRequestBasis,
} from './context-usage-anchor.js';

export interface AgentLoopContextManager {
  refreshProviderContextLimit(
    provider: import('@wrongstack/contracts/types/provider').Provider,
    model: string,
    opts?: { probe?: boolean },
  ): Promise<void>;
  compactContextIfNeeded(): Promise<boolean>;
  stashRequestTokens(req: Request): RequestTokenBreakdown;
  refreshContextRequestTokenStash(opts?: { force?: boolean | undefined }): number;
  buildRequestWithPreflightCompaction(opts: RunOptions): Promise<{
    req: Request;
    provider: import('@wrongstack/contracts/types/provider').Provider;
    preFlight: RequestTokenBreakdown;
  }>;
  emitContextPct(): void;
  currentMaxContext(): number;
  calibrationKey(model?: string): string;
  get lastPreFlightMsgCount(): number;
}

function isContextOverflowError(err: unknown): boolean {
  return err instanceof AgentError && err.code === ERROR_CODES.AGENT_CONTEXT_OVERFLOW;
}

interface PreparedRequestCheck {
  maxContext: number;
  inputTokens: number;
  availableInputTokens: number;
  overflowTokens: number;
  /** Request tokens the durable transcript does not account for. */
  wireOverheadTokens: number;
  /** Over budget even with the whole conversation history compacted away. */
  irreducible: boolean;
}

/**
 * Pre-send compaction passes for one request before it is sent as-is. Each
 * pass must shrink the transcript; this only stops a pathological loop.
 */
const MAX_PRESEND_OVERFLOW_RESCUES = 3;

export function createAgentLoopContextManager(
  a: AgentInternals,
  handlers: { response: AgentResponseHandler },
): AgentLoopContextManager {
  let _lastEmittedMsgCount = -1;
  let _lastEmittedToolCount = -1;
  let _lastEmittedRevision = -1;
  let _lastEmittedMaxContext = -1;
  let _lastEmittedAccountingIdentity = '';
  let _lastEmittedSystemRef: unknown = null;
  let _lastEmittedToolsRef: unknown = null;
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
  let _lastCompactionAccountingIdentity = '';

  let _cachedSysRef: unknown = null;
  let _cachedToolsRef: readonly unknown[] | null = null;
  let _cachedOverheadTokens = 0;

  const calibrationKey = (model: string = a.ctx.model): string =>
    `${a.ctx.provider?.id ?? 'unknown'}/${model}`;

  // 0 = unknown. Never substitute an invented window: a made-up ceiling below
  // the model's real one truncates and compacts sessions for no reason.
  function currentMaxContext(): number {
    const metaLimit = a.ctx.meta?.['effectiveMaxContext'];
    const providerMax = a.ctx.provider.capabilities.maxContext;
    return typeof metaLimit === 'number' && metaLimit > 0
      ? metaLimit
      : typeof providerMax === 'number' && providerMax > 0
        ? providerMax
        : 0;
  }

  async function refreshProviderContextLimit(
    provider: import('@wrongstack/contracts/types/provider').Provider,
    model: string,
    opts: { probe?: boolean } = {},
  ): Promise<void> {
    a.ctx.meta ??= {};
    const routeKey = `${provider.id}/${model}`;
    const previousRouteKey = a.ctx.meta['contextLimitRouteKey'];
    const routeChanged = previousRouteKey !== undefined && previousRouteKey !== routeKey;
    const previousMaxContext = currentMaxContext();

    if (routeChanged) {
      a.ctx.lastRealInputTokens = undefined;
      delete a.ctx.meta['realAnchorMsgCount'];
      delete a.ctx.meta['providerOverflowMaxContext'];
      delete a.ctx.meta['contextLimitBaseline'];
      delete a.ctx.meta['providerLimitEffectiveMaxContext'];
      delete a.ctx.meta['effectiveMaxContext'];
      delete a.ctx.meta['effectiveMaxContextSource'];
      delete a.ctx.meta['contextLimitLastEmittedMaxContext'];
      delete a.ctx.meta['contextLimitLastEmittedSource'];
    }
    a.ctx.meta['contextLimitRouteKey'] = routeKey;

    const routeMeta = a.ctx.meta['effectiveMaxContext'];
    const routeProviderCap = provider.capabilities.maxContext;
    const currentEffective =
      typeof routeMeta === 'number' && routeMeta > 0
        ? routeMeta
        : typeof routeProviderCap === 'number' && routeProviderCap > 0
          ? routeProviderCap
          : 0;
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
    emitEffectiveLimit(effective, effectiveSource);
  }

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
    recordContextRequestBasis(a.ctx, req);
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
        _lastPreFlightRevision === revision &&
        _cachedSysRef === a.ctx.systemPrompt &&
        _cachedToolsRef === a.ctx.tools
      ) {
        return stashed;
      }
    }

    const refreshed = estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
    a.ctx.lastRequestTokens = refreshed;
    recordContextRequestBasis(a.ctx);
    _lastPreFlightMsgCount = msgCount;
    _lastPreFlightToolCount = toolCount;
    _lastPreFlightRevision = revision;
    a.ctx.meta['lastRequestTokensAt'] = { msgCount, toolCount, revision };
    return refreshed;
  }

  function compactionAccountingIdentity(): string {
    const key = calibrationKey();
    const cal = getCalibrationState(key);
    return JSON.stringify([
      key,
      cal.ratio,
      cal.calibrated,
      a.ctx.lastRealInputTokens,
      a.ctx.meta?.['realAnchorMsgCount'],
      readAgentContext(a.ctx)?.used,
    ]);
  }

  async function compactContextIfNeeded(): Promise<boolean> {
    // The agent compacts its own context; trimming the transcript frees none of it.
    if (keepsOwnContext(a.ctx.provider)) return false;
    const msgCount = a.ctx.messages.length;
    const maxContext = currentMaxContext();
    const revision = a.ctx.state.revision;
    const toolsRef = a.ctx.tools;
    const systemRef = a.ctx.systemPrompt;
    const requestTokens = a.ctx.lastRequestTokens;
    const accountingIdentity = compactionAccountingIdentity();
    if (
      _lastCompactionAccountingIdentity === accountingIdentity &&
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
    try {
      await a.pipelines.contextWindow.run(a.ctx);
    } catch (err) {
      // Compaction that cannot reach its hard line (or whose compactor failed
      // at hard pressure) must not end the turn here: this also runs after a
      // final answer. The pre-send check measures the real request and is the
      // one place that decides whether a send is impossible.
      if (a.ctx.signal?.aborted || !isContextOverflowError(err)) throw err;
    }
    _lastCompactionMsgCount = a.ctx.messages.length;
    _lastCompactionRevision = a.ctx.state.revision;
    _lastCompactionToolsRef = a.ctx.tools;
    _lastCompactionSystemRef = a.ctx.systemPrompt;
    _lastCompactionMaxContext = maxContext;
    _lastCompactionAccountingIdentity = compactionAccountingIdentity();
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

  async function buildRequestWithPreflightCompaction(opts: RunOptions): Promise<{
    req: Request;
    provider: import('@wrongstack/contracts/types/provider').Provider;
    preFlight: RequestTokenBreakdown;
  }> {
    let prepared = await handlers.response.buildAndRunRequestPipeline(opts);
    let req = prepared.request;
    let preFlight = stashRequestTokens(req);

    let probedRouteKey = `${prepared.provider.id}/${req.model}`;
    await refreshProviderContextLimit(prepared.provider, req.model);

    if (await compactContextIfNeeded()) {
      prepared = await handlers.response.buildAndRunRequestPipeline(opts);
      req = prepared.request;
      preFlight = stashRequestTokens(req);
      const rebuiltRouteKey = `${prepared.provider.id}/${req.model}`;
      if (rebuiltRouteKey !== probedRouteKey) {
        probedRouteKey = rebuiltRouteKey;
        await refreshProviderContextLimit(prepared.provider, req.model);
        if (await compactContextIfNeeded()) {
          prepared = await handlers.response.buildAndRunRequestPipeline(opts);
          req = prepared.request;
          preFlight = stashRequestTokens(req);
        }
      }
    }

    // The request pipeline can add wire-only system blocks, tools or messages
    // that durable-history compaction never measured. Check the rebuilt
    // request itself; when it is over budget, tell compaction how much more it
    // must free and run it again instead of failing the turn. The window is
    // whatever the route reports today, so this must hold for any limit.
    let rescueTokens = 0;
    let check: PreparedRequestCheck | undefined;
    for (let attempt = 0; ; attempt++) {
      check = measurePreparedRequest(prepared.provider, req);
      if (!check) break;
      // Compacting history cannot fix an irreducible overflow; don't shred it trying.
      const overflowing =
        check.overflowTokens > 0 && !check.irreducible && attempt < MAX_PRESEND_OVERFLOW_RESCUES;
      if (overflowing) rescueTokens += check.overflowTokens;
      const overhead: ContextRequestOverhead = {
        routeKey: `${prepared.provider.id}/${req.model}`,
        tokens: check.wireOverheadTokens + rescueTokens,
      };
      a.ctx.meta[CONTEXT_REQUEST_OVERHEAD_META] = overhead;
      if (!overflowing) break;
      // The overhead moved, so a cached "nothing to do" verdict is stale.
      _lastCompactionWasNoop = false;
      if (!(await compactContextIfNeeded())) break;
      prepared = await handlers.response.buildAndRunRequestPipeline(opts);
      req = prepared.request;
      preFlight = stashRequestTokens(req);
      const rebuiltRouteKey = `${prepared.provider.id}/${req.model}`;
      if (rebuiltRouteKey !== probedRouteKey) {
        probedRouteKey = rebuiltRouteKey;
        await refreshProviderContextLimit(prepared.provider, req.model);
      }
    }
    // Only content no compaction can touch (system, tools, wire-only blocks)
    // makes the send impossible. Anything else still over the estimate is
    // sent: the estimate is an upper bound, and a real provider overflow is
    // recovered by the error handler (learned limit + compaction + retry).
    if (check && check.overflowTokens > 0 && check.irreducible) {
      throw new AgentError({
        message: 'Request content outside the conversation history exceeds the context window',
        code: ERROR_CODES.AGENT_CONTEXT_OVERFLOW,
        recoverable: true,
        context: {
          maxContext: check.maxContext,
          inputTokens: check.inputTokens,
          availableInputTokens: check.availableInputTokens,
          overflowTokens: check.overflowTokens,
          providerId: prepared.provider.id,
          modelId: req.model,
        },
      });
    }
    return { req, provider: prepared.provider, preFlight };
  }

  /**
   * Upper-bound size of a prepared request against its route's window, plus
   * how much of it the durable transcript does not account for. Undefined
   * when context-window management does not apply to this request.
   */
  function measurePreparedRequest(
    provider: import('@wrongstack/contracts/types/provider').Provider,
    req: Request,
  ): PreparedRequestCheck | undefined {
    if (
      a.ctx.signal?.aborted ||
      keepsOwnContext(provider) ||
      a.pipelines.contextWindow.size() === 0 ||
      a.ctx.meta?.['contextAutoCompact'] === false
    ) {
      return undefined;
    }
    // The live context may already point to the next provider. This request
    // must use the window resolved for its captured route, not the new tab state.
    const routeLimit = a.ctx.meta?.['effectiveMaxContext'];
    const nativeLimit = provider.capabilities.maxContext;
    const maxContext =
      typeof routeLimit === 'number' && Number.isFinite(routeLimit) && routeLimit > 0
        ? routeLimit
        : typeof nativeLimit === 'number' && Number.isFinite(nativeLimit) && nativeLimit > 0
          ? nativeLimit
          : 0;
    // Unknown window: there is no ceiling to overflow.
    if (maxContext <= 0) return undefined;
    const routeKey = `${provider.id}/${req.model}`;
    const inputTokens = estimateRequestTokensUpperBound(
      req.messages,
      req.system,
      req.tools ?? [],
      routeKey,
    ).total;
    const durable = estimateRequestTokensUpperBound(
      a.ctx.messages,
      a.ctx.systemPrompt,
      a.ctx.tools ?? [],
      routeKey,
    );
    const reserve = (key: string): number | undefined => {
      const value = a.ctx.meta?.[key];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
    };
    const budget = computeContextWindowBudget({
      maxContext,
      inputTokens,
      maxOutput: provider.capabilities.maxOutput,
      outputReserveTokens: reserve('contextOutputReserveTokens'),
      safetyBufferTokens: reserve('contextSafetyBufferTokens'),
    });
    return {
      maxContext: budget.maxContext,
      inputTokens,
      availableInputTokens: budget.availableInputTokens,
      overflowTokens: budget.overflowTokens,
      wireOverheadTokens: Math.max(0, inputTokens - durable.total),
      irreducible: inputTokens - durable.messages >= budget.availableInputTokens,
    };
  }

  function emitContextPct(): void {
    const agentContext = readAgentContext(a.ctx);
    const anchored = agentContext ? agentContext.used : readRealAnchoredContextTokens(a.ctx);
    const msgCount = a.ctx.messages.length;
    const toolCount = (a.ctx.tools ?? []).length;
    const maxContext = agentContext?.size || currentMaxContext();
    const revision = a.ctx.state.revision;
    const accountingIdentity = compactionAccountingIdentity();
    const systemRef = a.ctx.systemPrompt;
    const toolsRef = a.ctx.tools;
    const overheadChanged =
      systemRef !== _lastEmittedSystemRef || toolsRef !== _lastEmittedToolsRef;
    if (
      !overheadChanged &&
      accountingIdentity === _lastEmittedAccountingIdentity &&
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
    _lastEmittedAccountingIdentity = accountingIdentity;
    _lastEmittedSystemRef = systemRef;
    _lastEmittedToolsRef = toolsRef;

    if (
      overheadChanged ||
      msgCount !== _lastPreFlightMsgCount ||
      toolCount !== _lastPreFlightToolCount ||
      revision !== _lastPreFlightRevision
    ) {
      refreshContextRequestTokenStash({ force: true });
    }

    let total: number;
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

  return {
    refreshProviderContextLimit,
    compactContextIfNeeded,
    stashRequestTokens,
    refreshContextRequestTokenStash,
    buildRequestWithPreflightCompaction,
    emitContextPct,
    currentMaxContext,
    calibrationKey,
    get lastPreFlightMsgCount() {
      return _lastPreFlightMsgCount;
    },
  };
}
