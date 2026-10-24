import { isTextBlock, isToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Config } from '@wrongstack/contracts/types/config';
import {
  isFallbackWorthy,
  type Provider,
  ProviderError,
  type Response,
} from '@wrongstack/contracts/types/provider';
import type { FallbackChain } from './fallback-profile-manager.js';
import { FallbackProfileManager } from './fallback-profile-manager.js';

export function fallbackProfileChain(config: Config, profileName: string | undefined): string[] {
  if (!profileName) return [];
  const mgr = new FallbackProfileManager(config);
  return mgr.resolve(profileName).map((e) => `${e.providerId}/${e.model}`);
}

/**
 * Check if an error should trigger a fallback. Returns the status for
 * logging, or null if the error doesn't warrant a fallback attempt.
 *
 * Branches on the canonical `ProviderError.kind`: capacity/availability
 * failures (rate limit, overload, server error, stream hang, timeout,
 * network) are worth trying on another provider; request-shaped failures
 * (auth, invalid request, context overflow, content filter) would fail
 * identically anywhere — or need a different remedy (compaction, key fix) —
 * so they surface instead.
 */
export function shouldFallback(err: unknown): number | null {
  if (err instanceof ProviderError || ProviderError.isProviderError(err)) {
    const kind = (err as ProviderError).kind;
    return isFallbackWorthy(kind) ? (err as ProviderError).status : null;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed') ||
      msg.includes('failed to fetch') ||
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('504') ||
      msg.includes('overloaded') ||
      msg.includes('rate limit') ||
      msg.includes('quota')
    ) {
      return 503;
    }
  }
  return null;
}

export function isUsableModelResponse(response: Response): boolean | undefined {
  if (!response?.content) return undefined;
  return response.content.some(
    (block) => isToolUseBlock(block) || (isTextBlock(block) && block.text.trim().length > 0),
  );
}

export function ensureUsableModelResponse(
  response: Response,
  providerId: string,
  model: string,
  signal?: AbortSignal | undefined,
): Response {
  const usable = isUsableModelResponse(response);
  // undefined content means the caller didn't provide a content field (e.g. test mocks) — let it through
  if (usable !== false) return response;

  // A cancelled run yields no usable blocks because the stream was cut short,
  // which is indistinguishable from a genuine empty response here. Reporting it
  // as `overloaded` is wrong in KIND and in CONSEQUENCE: `overloaded` is
  // fallback-eligible, so a run being torn down rotates through every configured
  // model instead of stopping. Same shape as the streaming abort bug fixed in
  // runFallbackChain (the `ctx_.signal?.aborted` checks) — an abort must never
  // be laundered into a capacity error.
  //
  // Optional chaining throughout: test mocks supply partial Context objects
  // without a `signal`.
  if (signal?.aborted) {
    throw new ProviderError(
      `Empty response from ${providerId}/${model}: the run was aborted`,
      499,
      false,
      providerId,
      { kind: 'unknown' },
    );
  }

  throw new ProviderError(
    `Empty response from ${providerId}/${model}; trying the next configured model`,
    503,
    true,
    providerId,
    { kind: 'overloaded' },
  );
}

export function smartDefaultFallbackChain(config: Config): string[] {
  const mgr = new FallbackProfileManager(config);
  return mgr.resolveEffective({ fallbackAuto: true }).map((e) => `${e.providerId}/${e.model}`);
}

/**
 * The effective fallback chain for a turn: the explicit `fallbackModels` list
 * when non-empty, otherwise the selected profile, otherwise the smart default
 * (unless `fallbackAuto` is off).
 *
 * NOTE: this is the SELECTED chain, not the full runtime order — it omits the
 * bridge, the primary re-insertion, the extra `default`-profile depth and the
 * last-resort sweep that {@link runtimeFallbackChain} adds. Use
 * `runtimeFallbackChain` for anything shown to a user as "what will be tried".
 */
export function effectiveFallbackChain(config: Config): string[] {
  const mgr = new FallbackProfileManager(config);
  return mgr
    .resolveEffective({
      fallbackModels: config.fallbackModels,
      fallbackProfile: config.fallbackProfile,
      fallbackAuto: config.fallbackAuto,
    })
    .map((e) => `${e.providerId}/${e.model}`);
}

/**
 * The chain the agent loop will ACTUALLY rotate through, in order, if the
 * current primary fails right now — the same `resolveCandidates` call the
 * fallback extension makes, including bridge, primary re-insertion, the
 * `default`-profile depth and the last-resort sweep.
 *
 * `/fallback` used to render `effectiveFallbackChain` instead, so the
 * displayed chain could be four entries while the runtime rotated through
 * seventeen — the view was structurally unable to match the behavior it
 * claimed to describe.
 */
export function runtimeFallbackChain(config: Config): string[] {
  const mgr = new FallbackProfileManager(config);
  const current = primaryTarget(config);
  return mgr.resolveCandidates(current, {}).map((e) => `${e.providerId}/${e.model}`);
}

export function sameTarget(
  a: { providerId: string; model: string } | undefined,
  b: { providerId: string; model: string },
): boolean {
  return !!a && a.providerId === b.providerId && a.model === b.model;
}

export function fallbackCandidates(
  config: Config,
  current: { providerId: string; model: string },
  opts: {
    fallbackModels?: readonly string[] | undefined;
    fallbackProfile?: string | undefined;
    sharedManager?: FallbackProfileManager | undefined;
    primary?: { providerId: string; model: string } | undefined;
    closedWorld?: boolean | undefined;
  } = {},
): FallbackChain {
  const mgr = opts.sharedManager ?? new FallbackProfileManager(config);
  return mgr.resolveCandidates(current, {
    fallbackModels: opts.fallbackModels,
    fallbackProfile: opts.fallbackProfile,
    primary: opts.primary ?? primaryTarget(config),
    closedWorld: opts.closedWorld,
  });
}

export const primaryTarget = (cfg: Config) => ({ providerId: cfg.provider, model: cfg.model });

export function maxContextOf(provider: Provider): number {
  const max = provider.capabilities.maxContext;
  return typeof max === 'number' && Number.isFinite(max) ? max : 0;
}

export function contextWindowWarning(
  currentProvider: Provider,
  nextProvider: Provider,
  currentTokens: unknown,
):
  | { fromMaxContext: number; toMaxContext: number; currentTokens?: number | undefined }
  | undefined {
  const fromMaxContext = maxContextOf(currentProvider);
  const toMaxContext = maxContextOf(nextProvider);
  if (fromMaxContext <= 0 || toMaxContext <= 0 || toMaxContext >= fromMaxContext) return undefined;
  return {
    fromMaxContext,
    toMaxContext,
    ...(typeof currentTokens === 'number' && currentTokens > 0 ? { currentTokens } : {}),
  };
}
