import type { Context } from '../core/context.js';
import type { Compactor } from '../types/compactor.js';
import type { Config } from '../types/config.js';
import type { ErrorHandler, RecoveryDecision } from '../types/error-handler.js';
import type { ModelsRegistry } from '../types/models-registry.js';
import {
  isContextOverflowShaped,
  isRetryableKind,
  ProviderError,
  type ProviderErrorKind,
} from '../types/provider.js';
import { defaultContextOutputReserve } from './context-budget.js';
import { NETWORK_ERR_RE } from './regex-patterns.js';

/**
 * Tiered error recovery strategies.
 * Each strategy is attempted in order until one returns a decision.
 */
export interface RecoveryStrategy {
  /** Human-readable label for logs. */
  label: string;
  /** Optional compactor for context_overflow recovery. */
  compactor?: Compactor | undefined;
  /** Returns an explicit recovery decision, or null to fall through. */
  attempt: (err: unknown, ctx: Context) => Promise<RecoveryDecision | null>;
}

/**
 * Builds the ordered list of recovery strategies used by DefaultErrorHandler.
 * Exported so callers can customise or extend the strategy chain.
 */
export function buildRecoveryStrategies(opts?: {
  compactor?: Compactor | undefined;
  modelsRegistry?: ModelsRegistry | undefined;
  getConfig?: (() => Config) | undefined;
}): RecoveryStrategy[] {
  return [
    {
      label: 'context_overflow_reduce',
      compactor: opts?.compactor,
      async attempt(err, ctx) {
        if (!ProviderError.isProviderError(err)) return null;
        // Accept both the cleanly-classified overflow AND an overflow-shaped
        // error a gateway mislabeled (413, or an overflow phrase under a
        // generic invalid_request/400) — see isContextOverflowShaped.
        if (err.kind !== 'context_overflow' && !isContextOverflowShaped(err)) return null;

        // Catalog limits describe the native model, but gateways and
        // subscription routes can enforce a smaller effective window. A
        // provider overflow is authoritative evidence that the current
        // denominator is too large. Learn a session-local ceiling from the
        // rejected request so the context bar and subsequent compaction use
        // the route's observed limit instead of continuing to advertise (for
        // example) 1M while the gateway rejects around 650K.
        learnEffectiveContextLimitFromOverflow(ctx);

        if (this.compactor) {
          try {
            const report = await this.compactor.compact(ctx, { aggressive: true });
            // Compaction rewrote the message array, so the real-usage anchor
            // (captured for the pre-compaction array) is stale — drop it so the
            // retry's pre-flight estimates the compacted array afresh until the
            // next response re-anchors.
            ctx.lastRealInputTokens = undefined;
            if (report.after < report.before) {
              return { action: 'retry', reason: 'context_compacted' };
            }
          } catch {
            // compact failed; fall through
          }
        }
        return null;
      },
    },
    {
      label: 'rate_limit_backoff',
      async attempt(err, ctx) {
        if (!ProviderError.isProviderError(err) || err.kind !== 'rate_limit') return null;

        // Prefer the parsed Retry-After hint the provider extracted into
        // body.retryAfterMs; fall back to 5s when absent.
        const delayMs = err.body?.retryAfterMs ?? 5_000;
        // Clamp between 1s and 60s.
        const delay = Math.min(60_000, Math.max(1_000, delayMs));
        // Race the backoff sleep against the abort signal so a Ctrl+C /
        // cancellation doesn't hang for the full delay window.
        // Guard: ctx may be undefined in test calls that construct the
        // strategy directly without a context.
        if (ctx?.signal) {
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) {
              resolve();
              return;
            }
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const onAbort = (): void => finish();
            const finish = (): void => {
              if (settled) return;
              settled = true;
              if (timer !== undefined) clearTimeout(timer);
              ctx.signal.removeEventListener('abort', onAbort);
              resolve();
            };
            timer = setTimeout(finish, delay);
            ctx.signal.addEventListener('abort', onAbort, { once: true });
          });
        } else {
          await new Promise((r) => setTimeout(r, delay));
        }
        return { action: 'retry', reason: 'rate_limit_backoff' };
      },
    },
    {
      label: 'downgrade_model',
      async attempt(err, ctx) {
        if (!ProviderError.isProviderError(err)) return null;
        // rate_limit is intentionally NOT handled here: the rate_limit_backoff
        // strategy above always returns a decision for it, so this strategy
        // is never reached. Downgrade applies to overload and generic server
        // errors only.
        if (err.kind !== 'overloaded' && err.kind !== 'server' && err.kind !== 'stream_hang') {
          return null;
        }

        const registry = opts?.modelsRegistry;
        if (!registry) return null;

        try {
          const providerId = ctx.provider?.id;
          if (!providerId) return null;
          const provider = await registry.getProvider(providerId);
          if (!provider) return null;

          const currentModel = await registry.getModel(providerId, ctx.model);
          if (!currentModel) return null;

          // Find a cheaper fallback model with the same capabilities.
          // Prefer models with lower input cost, preferring the same family.
          const visibleModels = opts?.getConfig?.().providers?.[providerId]?.models;
          const candidates = provider.models.filter((m) => {
            if (visibleModels !== undefined && !visibleModels.includes(m.id)) return false;
            const modelCost = m.cost?.input ?? Number.POSITIVE_INFINITY;
            const currentCost = currentModel.cost?.input ?? Number.POSITIVE_INFINITY;
            if (modelCost >= currentCost) return false;
            if (currentModel.capabilities.tools && !m.tool_call) return false;
            if (currentModel.capabilities.vision && !m.modalities?.input?.includes('image'))
              return false;
            return true;
          });

          if (candidates.length === 0) return null;

          // Pick the cheapest candidate. Treat a missing input cost as
          // +Infinity (most expensive) — matching the filter above, which
          // already excludes undefined-cost models — so the sentinel stays
          // consistent if the filter is ever loosened.
          const fallback = candidates.reduce((prev, curr) =>
            (curr.cost?.input ?? Number.POSITIVE_INFINITY) <
            (prev.cost?.input ?? Number.POSITIVE_INFINITY)
              ? curr
              : prev,
          );

          return {
            action: 'retry',
            reason: 'model_downgrade',
            model: fallback.id,
          };
        } catch {
          return null;
        }
      },
    },
    {
      label: 'content_filter_reroute',
      async attempt(err, ctx) {
        if (!ProviderError.isProviderError(err) || err.kind !== 'content_filter') return null;

        const registry = opts?.modelsRegistry;
        if (!registry) return null;

        try {
          const providerId = ctx.provider?.id;
          if (!providerId) return null;
          const provider = await registry.getProvider(providerId);
          if (!provider) return null;

          const currentModel = await registry.getModel(providerId, ctx.model);
          if (!currentModel) return null;

          const visibleModels = opts?.getConfig?.().providers?.[providerId]?.models;
          const candidates = provider.models.filter((m) => {
            if (m.id === ctx.model) return false;
            if (visibleModels !== undefined && !visibleModels.includes(m.id)) return false;
            if (currentModel.capabilities.tools && !m.tool_call) return false;
            if (currentModel.capabilities.vision && !m.modalities?.input?.includes('image'))
              return false;
            return true;
          });
          if (candidates.length === 0) return null;

          // Content filters are model/deployment-specific (Azure-style false
          // positives especially), so the same request may pass a sibling
          // model. This is a reroute, not a downgrade: pick the closest-COST
          // sibling to stay in the same quality tier, tie-broken by id for
          // determinism. The agent loop's recoveryRetries cap (2) bounds any
          // ping-pong between two filtering models.
          const currentCost = currentModel.cost?.input;
          const distance = (m: (typeof candidates)[number]) =>
            currentCost === undefined || m.cost?.input === undefined
              ? Number.POSITIVE_INFINITY
              : Math.abs(m.cost.input - currentCost);
          const reroute = candidates.reduce((prev, curr) => {
            const delta = distance(curr) - distance(prev);
            if (delta < 0) return curr;
            if (delta === 0 && curr.id < prev.id) return curr;
            return prev;
          });

          return { action: 'retry', reason: 'content_filter_reroute', model: reroute.id };
        } catch {
          return null;
        }
      },
    },
  ];
}

/**
 * Clamp a session's effective context ceiling after a provider-authoritative
 * overflow. The rejected request proves that `input + output reserve` is at
 * or beyond the route's real limit. This is intentionally session-local: it
 * must not overwrite user config based on one transient provider route.
 */
export function learnEffectiveContextLimitFromOverflow(ctx: Context): number | undefined {
  const inputTokens = positiveFinite(ctx.lastRequestTokens);
  if (!inputTokens) return undefined;

  const advertised =
    positiveFinite(ctx.meta?.['effectiveMaxContext']) ??
    positiveFinite(ctx.provider?.capabilities?.maxContext);
  if (!advertised) return undefined;

  const configuredOutputReserve = nonNegativeFinite(ctx.meta?.['contextOutputReserveTokens']);
  const outputReserve = configuredOutputReserve ?? defaultContextOutputReserve(advertised);
  const observedCeiling = Math.max(1, Math.floor(inputTokens + outputReserve));
  const learned = Math.min(advertised, observedCeiling);
  if (learned >= advertised) return advertised;

  ctx.meta ??= {};
  ctx.meta['effectiveMaxContext'] = learned;
  ctx.meta['providerOverflowMaxContext'] = learned;
  ctx.meta['effectiveMaxContextSource'] = 'provider_overflow';
  return learned;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export const DEFAULT_RECOVERY_STRATEGIES = buildRecoveryStrategies();

type HandlerKind = ReturnType<ErrorHandler['classify']>['kind'];

/** Canonical taxonomy → the handler's public (coarser) union. Exhaustive over
 *  every kind except 'unknown' (special-cased to preserve err.retryable). */
const HANDLER_KIND_BY_PROVIDER_KIND: Record<
  Exclude<ProviderErrorKind, 'unknown'>,
  Exclude<HandlerKind, 'abort' | 'unknown'>
> = {
  rate_limit: 'rate_limit',
  quota_exhausted: 'rate_limit',
  overloaded: 'overloaded',
  server: 'server',
  stream_hang: 'server',
  timeout: 'network',
  network: 'network',
  context_overflow: 'context_overflow',
  content_filter: 'content_filter',
  auth: 'client',
  invalid_request: 'client',
};

export class DefaultErrorHandler implements ErrorHandler {
  private readonly strategies: RecoveryStrategy[];

  constructor(strategies: RecoveryStrategy[] = DEFAULT_RECOVERY_STRATEGIES) {
    this.strategies = strategies;
  }

  classify(err: unknown): ReturnType<ErrorHandler['classify']> {
    // AbortError can be thrown in both browser (DOMException) and Node (Error).
    // Guard with typeof check so Node builds don't reference the browser-only DOMException.
    if (
      typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'AbortError'
    ) {
      return { kind: 'abort', retryable: false };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { kind: 'abort', retryable: false };
    }
    if (ProviderError.isProviderError(err)) {
      // Map the canonical taxonomy onto the handler's public (coarser) union.
      // Exhaustive by construction — a new ProviderErrorKind refuses to
      // compile until it is mapped here. Retryability comes from the kind
      // (the canonical source), not the instance's constructor flag.
      if (err.kind === 'unknown') return { kind: 'unknown', retryable: err.retryable };
      return {
        kind: HANDLER_KIND_BY_PROVIDER_KIND[err.kind],
        retryable: isRetryableKind(err.kind),
      };
    }
    if (err instanceof Error && NETWORK_ERR_RE.test(err.message)) {
      return { kind: 'network', retryable: true };
    }
    return { kind: 'unknown', retryable: false };
  }

  async recover(err: unknown, ctx: Context): Promise<RecoveryDecision | null> {
    for (const strategy of this.strategies) {
      const result = await strategy.attempt(err, ctx);
      if (result !== null) return result;
    }
    return null;
  }
}
