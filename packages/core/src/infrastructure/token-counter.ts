import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { ModelsRegistry, ResolvedModel } from '@wrongstack/contracts/types/models-registry';
import { promptCacheHitRatio, type Usage } from '@wrongstack/contracts/types/provider';
import type { CacheStats, TokenCounter } from '@wrongstack/contracts/types/token-counter';

interface PriceEntry {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  cacheWrite5m?: number | undefined;
  cacheWrite1h?: number | undefined;
}

const PRICE_CACHE_MAX_SIZE = 100;

/**
 * Token counter that derives pricing from the ModelsRegistry instead of a
 * hardcoded table. If a model is unknown to the registry (or the registry is
 * unavailable) the counter still tracks token totals but reports zero cost.
 */
export class DefaultTokenCounter implements TokenCounter {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cacheWrite5m = 0;
  private cacheWrite1h = 0;
  private costInput = 0;
  private costOutput = 0;
  private cacheSaved = 0;
  private readonly cacheByProvider = new Map<
    string,
    {
      input: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite5m: number;
      cacheWrite1h: number;
    }
  >();
  private readonly registry?: ModelsRegistry | undefined;
  private readonly providerId?: string | (() => string | undefined) | undefined;
  private readonly events?: EventBus | undefined;
  private sessionId?: string | (() => string | undefined) | undefined;
  /**
   * Agent this counter belongs to, stamped onto every `token.accounted`.
   * Undefined for the leader. Subagent counters are constructed with the HOST
   * session id (so live cost UIs stay on one row), which makes this the only
   * thing separating a subagent's tokens from the leader's downstream.
   */
  private readonly agentId?: string | (() => string | undefined) | undefined;
  private priceCache = new Map<string, PriceEntry>();
  /** Most recently accounted request's tokens. Used for per-request context pressure. */
  private lastInput = 0;
  private lastCacheRead = 0;
  private lastCacheWrite = 0;
  /**
   * The last request the PROVIDER reported, for `cacheStats().last`. Kept apart
   * from `last*` above: `/compact` overwrites those with an estimate for the
   * context bar, and a hit ratio derived from that estimate (cacheRead 0) would
   * report a miss that never happened.
   */
  private lastReported: Usage | undefined;

  /**
   * Provider usage crosses an untrusted response boundary, and `typeof x ===
   * 'number'` admits NaN/Infinity. A single non-finite field poisons every
   * accumulator permanently — `NaN + finite === NaN`, and `currentRequestTokens()`
   * then feeds `eternal-autonomy.ts` a `total / maxCtx >= threshold` comparison
   * that is false for ANY ceiling, silently disabling the context-pressure
   * compaction gate. Same invariant the token-throttle and token-budget
   * wrappers normalize at this boundary (2026-09-12); this core accumulator was
   * missed. Non-finite normalizes to 0 so a malformed response contributes
   * nothing rather than corrupting the session.
   */
  private static finiteUsage(usage: Usage): Usage {
    const n = (v: number | undefined): number | undefined =>
      v === undefined ? undefined : Number.isFinite(v) ? v : 0;
    return {
      ...usage,
      input: n(usage.input) ?? 0,
      output: n(usage.output) ?? 0,
      cacheRead: n(usage.cacheRead),
      cacheWrite: n(usage.cacheWrite),
      cacheWrite5m: n(usage.cacheWrite5m),
      cacheWrite1h: n(usage.cacheWrite1h),
    };
  }

  constructor(
    opts: {
      registry?: ModelsRegistry | undefined;
      providerId?: string | (() => string | undefined) | undefined;
      events?: EventBus | undefined;
      sessionId?: string | (() => string | undefined) | undefined;
      agentId?: string | (() => string | undefined) | undefined;
    } = {},
  ) {
    this.registry = opts.registry;
    this.providerId = opts.providerId;
    this.events = opts.events;
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
  }

  setSessionId(sessionId: string | (() => string | undefined) | undefined): void {
    this.sessionId = sessionId;
  }

  account(rawUsage: Usage, model?: string, providerId = this.currentProviderId()): void {
    const usage = DefaultTokenCounter.finiteUsage(rawUsage);
    const eventSessionId = this.currentSessionId();
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead ?? 0;
    // Anthropic-family providers (including MiniMax on the Anthropic surface)
    // split cache-write tokens into 5-min and 1-hour TTL buckets via
    // cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens.
    // OpenAI-family gateways emit only the aggregate. Some hybrid adapters
    // forward TTL fields without an aggregate — derive it here so the rest of
    // the telemetry (writeTokens, per-provider totals, current-request
    // snapshot, hit ratio) stays consistent with the TTL split we surface.
    const ttlAggregate =
      usage.cacheWrite5m !== undefined || usage.cacheWrite1h !== undefined
        ? (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0)
        : 0;
    const cacheWriteTotal = usage.cacheWrite ?? ttlAggregate;
    this.cacheWrite += cacheWriteTotal;
    // Mirror the TTL split. `?? undefined` preserves the "absent" signal so
    // cacheStats() can omit the TTL row when the upstream never exposed one,
    // instead of advertising two fabricated zeros.
    this.cacheWrite5m += usage.cacheWrite5m ?? 0;
    this.cacheWrite1h += usage.cacheWrite1h ?? 0;
    this.recordProviderCache(usage, providerId, cacheWriteTotal);
    // Snapshot per-request tokens for context pressure tracking.
    this.lastInput = usage.input;
    this.lastCacheRead = usage.cacheRead ?? 0;
    this.lastCacheWrite = cacheWriteTotal;
    this.lastReported = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: cacheWriteTotal,
    };

    const priceKey = providerId && model ? `${providerId}\0${model}` : undefined;
    const price = priceKey ? this.priceCache.get(priceKey) : undefined;
    if (price) {
      const deltaCost = this.applyPrice(usage, price);
      this.emitAccounted(eventSessionId, model, providerId, usage, deltaCost);
      return;
    }

    if (this.registry && providerId && model) {
      // Evict oldest entry when cache is full before async lookup.
      if (this.priceCache.size >= PRICE_CACHE_MAX_SIZE) {
        const keys = [...this.priceCache.keys()];
        this.priceCache.delete(keys[0] ?? '');
      }
      // Async lookup — populate cache, but don't block this call.
      void this.registry
        .getModel(providerId, model)
        .then((m) => {
          let deltaCost: { input: number; output: number; total: number } | undefined;
          if (m) {
            const p = priceFromModel(m);
            this.priceCache.set(priceKey!, p);
            deltaCost = this.applyPrice(usage, p);
          }
          // Token totals are authoritative even when pricing is unresolved.
          // Emit after the lookup settles so live UIs update for unknown models
          // without double-emitting when pricing is resolved.
          this.emitAccounted(eventSessionId, model, providerId, usage, deltaCost);
        })
        .catch(() => {
          // Emit so observability tooling can detect unknown models.
          this.events?.emit('token.cost_estimate_unavailable', {
            ...(eventSessionId ? { sessionId: eventSessionId } : {}),
            model: model ?? '<unknown>',
          });
          this.emitAccounted(eventSessionId, model, providerId, usage);
          return undefined;
        });
      return;
    }

    // No pricing source exists. Still emit token totals so live UIs do not stay
    // at 0 just because cost cannot be estimated.
    this.emitAccounted(eventSessionId, model, providerId, usage);
  }

  /** Synchronous variant for code paths that have already resolved the model. */
  accountWithModel(rawUsage: Usage, resolved: ResolvedModel): void {
    const usage = DefaultTokenCounter.finiteUsage(rawUsage);
    const eventSessionId = this.currentSessionId();
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead ?? 0;
    // Mirror the TTL-derived aggregate in account() — see that path for the
    // rationale (hybrid adapters may forward TTL fields without an aggregate,
    // and the rest of the telemetry must stay consistent with the split).
    const ttlAggregate =
      usage.cacheWrite5m !== undefined || usage.cacheWrite1h !== undefined
        ? (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0)
        : 0;
    const cacheWriteTotal = usage.cacheWrite ?? ttlAggregate;
    this.cacheWrite += cacheWriteTotal;
    // Mirror the TTL split captured in `account()` for the synchronous path.
    // When the upstream only emits an aggregate (OpenAI family), both fields
    // are undefined and the per-TTL counters stay at zero — the aggregate
    // writeTokens above remains the authoritative figure.
    this.cacheWrite5m += usage.cacheWrite5m ?? 0;
    this.cacheWrite1h += usage.cacheWrite1h ?? 0;
    this.recordProviderCache(usage, resolved.providerId, cacheWriteTotal);
    // Snapshot per-request tokens for context pressure tracking.
    this.lastInput = usage.input;
    this.lastCacheRead = usage.cacheRead ?? 0;
    this.lastCacheWrite = cacheWriteTotal;
    this.lastReported = {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: cacheWriteTotal,
    };
    const price = priceFromModel(resolved);
    if (this.priceCache.size >= PRICE_CACHE_MAX_SIZE) {
      const keys = [...this.priceCache.keys()];
      this.priceCache.delete(keys[0] ?? '');
    }
    this.priceCache.set(`${resolved.providerId}\0${resolved.modelId}`, price);
    const deltaCost = this.applyPrice(usage, price);
    this.emitAccounted(eventSessionId, resolved.modelId, resolved.providerId, usage, deltaCost);
  }

  total(): Usage {
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
    };
  }

  currentRequestTokens(): { input: number; cacheRead: number; cacheWrite: number } {
    return {
      input: this.lastInput,
      cacheRead: this.lastCacheRead,
      cacheWrite: this.lastCacheWrite,
    };
  }

  setCurrentRequestTokens(input: number, cacheRead?: number, cacheWrite?: number): void {
    this.lastInput = input;
    this.lastCacheRead = cacheRead ?? 0;
    this.lastCacheWrite = cacheWrite ?? 0;
  }

  estimateCost(): { input: number; output: number; total: number; currency: 'USD' } {
    return {
      input: round4(this.costInput),
      output: round4(this.costOutput),
      total: round4(this.costInput + this.costOutput),
      currency: 'USD',
    };
  }

  cacheStats(): CacheStats {
    // Include cache-write/creation tokens in the complete prompt context.
    // The shared helper also clamps malformed gateway telemetry to [0, 1].
    // The 5-min / 1-hour split is surfaced when the upstream exposed it on
    // at least one request in the session. When the provider only ever emits
    // an aggregate (OpenAI family), both stay undefined so the UI can render
    // a single combined "write" figure instead of misleading 5-min/1-hour
    // sub-totals that never came from the wire.
    const exposeTtlSplit = this.cacheWrite5m > 0 || this.cacheWrite1h > 0;
    return {
      readTokens: this.cacheRead,
      writeTokens: this.cacheWrite,
      ...(exposeTtlSplit
        ? { cacheWrite5m: this.cacheWrite5m, cacheWrite1h: this.cacheWrite1h }
        : {}),
      hitRatio: promptCacheHitRatio({
        input: this.input,
        output: this.output,
        cacheRead: this.cacheRead,
        cacheWrite: this.cacheWrite,
      }),
      savedUsd: round4(this.cacheSaved),
      ...(this.lastReported
        ? {
            last: {
              input: this.lastReported.input,
              cacheRead: this.lastReported.cacheRead ?? 0,
              cacheWrite: this.lastReported.cacheWrite ?? 0,
              hitRatio: promptCacheHitRatio(this.lastReported),
            },
          }
        : {}),
      providers: [...this.cacheByProvider.entries()]
        .map(([provider, usage]) => ({
          provider,
          input: usage.input,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          ...(usage.cacheWrite5m > 0 || usage.cacheWrite1h > 0
            ? { cacheWrite5m: usage.cacheWrite5m, cacheWrite1h: usage.cacheWrite1h }
            : {}),
          hitRatio: promptCacheHitRatio({ ...usage, output: 0 }),
        }))
        .sort((a, b) => b.cacheRead - a.cacheRead),
    };
  }

  /** Invalidate cached prices so the next account() call fetches fresh data. */
  invalidateCache(): void {
    this.priceCache.clear();
  }

  private emitAccounted(
    sessionId = this.currentSessionId(),
    model?: string,
    providerId = this.currentProviderId(),
    deltaUsage?: Usage,
    deltaCost?: { input: number; output: number; total: number },
  ): void {
    const agentId = this.currentAgentId();
    this.events?.emit('token.accounted', {
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      usage: this.total(),
      ...(deltaUsage ? { deltaUsage: { ...deltaUsage } } : {}),
      ...(deltaCost ? { deltaCost } : {}),
      cost: {
        input: this.costInput,
        output: this.costOutput,
        total: this.costInput + this.costOutput,
      },
      ...(providerId ? { provider: providerId } : {}),
      ...(model ? { model } : {}),
    });
  }

  private currentSessionId(): string | undefined {
    const value = typeof this.sessionId === 'function' ? this.sessionId() : this.sessionId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private currentProviderId(): string | undefined {
    const value = typeof this.providerId === 'function' ? this.providerId() : this.providerId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private currentAgentId(): string | undefined {
    const value = typeof this.agentId === 'function' ? this.agentId() : this.agentId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  reset(): void {
    this.input = 0;
    this.output = 0;
    this.cacheRead = 0;
    this.cacheWrite = 0;
    this.cacheWrite5m = 0;
    this.cacheWrite1h = 0;
    this.costInput = 0;
    this.costOutput = 0;
    this.cacheSaved = 0;
    this.cacheByProvider.clear();
    this.lastInput = 0;
    this.lastCacheRead = 0;
    this.lastCacheWrite = 0;
    this.lastReported = undefined;
    this.emitAccounted(undefined, undefined, undefined, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }

  private recordProviderCache(
    usage: Usage,
    providerId: string | undefined,
    derivedCacheWrite: number,
  ): void {
    const key = providerId ?? 'unknown';
    const current = this.cacheByProvider.get(key) ?? {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    };
    current.input += usage.input;
    current.cacheRead += usage.cacheRead ?? 0;
    // Use the caller-derived aggregate so per-provider cacheWrite agrees
    // with the session-level writeTokens even when usage.cacheWrite is
    // absent but TTL fields are present.
    current.cacheWrite += derivedCacheWrite;
    current.cacheWrite5m += usage.cacheWrite5m ?? 0;
    current.cacheWrite1h += usage.cacheWrite1h ?? 0;
    this.cacheByProvider.set(key, current);
  }

  private applyPrice(
    usage: Usage,
    price: PriceEntry,
  ): { input: number; output: number; total: number } | undefined {
    const beforeInput = this.costInput;
    const beforeOutput = this.costOutput;
    if (price.input) this.costInput += (usage.input / 1_000_000) * price.input;
    if (price.output) this.costOutput += (usage.output / 1_000_000) * price.output;
    // Adapters report cache tokens OUTSIDE `usage.input`, so a cache count
    // with no catalog cache price must still be billed — at the input rate,
    // the most a provider charges for reading its own cache. Pricing it at 0
    // made every model without catalog cache prices look cheaper the better
    // its cache worked.
    const cacheReadRate = price.cacheRead ?? price.input;
    if (usage.cacheRead && cacheReadRate) {
      this.costInput += (usage.cacheRead / 1_000_000) * cacheReadRate;
    }
    // Gross read savings: what those cached tokens would have cost at the full
    // input rate, minus the discounted cache-read rate actually billed.
    // An unknown cache-read rate is billed at the input rate above, so it
    // saves nothing.
    if (usage.cacheRead && price.input !== undefined && price.cacheRead !== undefined) {
      this.cacheSaved += (usage.cacheRead / 1_000_000) * (price.input - price.cacheRead);
    }
    const hasCacheWriteSplit = usage.cacheWrite5m !== undefined || usage.cacheWrite1h !== undefined;
    const cacheWrite5m = usage.cacheWrite5m ?? (hasCacheWriteSplit ? 0 : usage.cacheWrite);
    const cacheWrite1h = usage.cacheWrite1h ?? 0;
    // Same for writes: providers that do not price them separately bill them
    // as ordinary input.
    const write5mRate = price.cacheWrite5m ?? price.cacheWrite ?? price.input;
    if (cacheWrite5m && write5mRate) {
      this.costInput += (cacheWrite5m / 1_000_000) * write5mRate;
    }
    const write1hRate = price.cacheWrite1h ?? price.cacheWrite ?? price.input;
    if (cacheWrite1h && write1hRate) {
      this.costInput += (cacheWrite1h / 1_000_000) * write1hRate;
    }
    const known = (tokens: number | undefined, rate: number | undefined) =>
      !tokens || (rate !== undefined && Number.isFinite(rate) && rate >= 0);
    if (
      !known(usage.input, price.input) ||
      !known(usage.output, price.output) ||
      !known(usage.cacheRead, cacheReadRate) ||
      !known(cacheWrite5m, write5mRate) ||
      !known(cacheWrite1h, write1hRate)
    )
      return undefined;
    const input = this.costInput - beforeInput;
    const output = this.costOutput - beforeOutput;
    return { input, output, total: input + output };
  }
}

function priceFromModel(m: ResolvedModel): PriceEntry {
  return {
    input: m.cost?.input,
    output: m.cost?.output,
    cacheRead: m.cost?.cache_read,
    cacheWrite: m.cost?.cache_write,
    cacheWrite5m: m.cost?.cache_write_5m ?? m.cost?.cache_write,
    cacheWrite1h:
      m.cost?.cache_write_1h ?? (m.cost?.input !== undefined ? m.cost.input * 2 : undefined),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
