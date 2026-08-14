import type { Request } from '../types/provider.js';
import {
  estimateMessageTokens,
  estimateRequestTokens,
  getCalibrationState,
  type RequestTokenBreakdown,
  realAnchoredInputTokens,
} from '../utils/token-estimate.js';
import type { AgentInternals } from './agent-internals.js';
import type { AgentResponseHandler } from './agent-response.js';
import { type RunOptions, resolveEventSessionId } from './context.js';

export interface AgentLoopContextManager {
  refreshProviderContextLimit(
    provider: import('../types/provider.js').Provider,
    model: string,
    opts?: { probe?: boolean },
  ): Promise<void>;
  compactContextIfNeeded(): Promise<boolean>;
  stashRequestTokens(req: Request): RequestTokenBreakdown;
  refreshContextRequestTokenStash(opts?: { force?: boolean | undefined }): number;
  buildRequestWithPreflightCompaction(opts: RunOptions): Promise<{
    req: Request;
    provider: import('../types/provider.js').Provider;
    preFlight: RequestTokenBreakdown;
  }>;
  emitContextPct(): void;
  currentMaxContext(): number;
  calibrationKey(model?: string): string;
  get lastPreFlightMsgCount(): number;
}

export function createAgentLoopContextManager(
  a: AgentInternals,
  handlers: { response: AgentResponseHandler },
): AgentLoopContextManager {
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

  let _cachedSysRef: unknown = null;
  let _cachedToolsRef: readonly unknown[] | null = null;
  let _cachedOverheadTokens = 0;

  const calibrationKey = (model: string = a.ctx.model): string =>
    `${a.ctx.provider?.id ?? 'unknown'}/${model}`;

  function currentMaxContext(): number {
    const metaLimit = a.ctx.meta?.['effectiveMaxContext'];
    const providerMax = a.ctx.provider.capabilities.maxContext;
    return typeof metaLimit === 'number' && metaLimit > 0
      ? metaLimit
      : typeof providerMax === 'number' && providerMax > 0
        ? providerMax
        : 200_000;
  }

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

  async function buildRequestWithPreflightCompaction(opts: RunOptions): Promise<{
    req: Request;
    provider: import('../types/provider.js').Provider;
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
