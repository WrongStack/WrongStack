import type { EventBus } from '../kernel/events.js';
import type { ModelsRegistry, ResolvedModel } from '../types/models-registry.js';
import { promptCacheHitRatio, type Usage } from '../types/provider.js';
import type { CacheStats, TokenCounter } from '../types/token-counter.js';

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
  private costInput = 0;
  private costOutput = 0;
  private cacheSaved = 0;
  private readonly cacheByProvider = new Map<
    string,
    { input: number; cacheRead: number; cacheWrite: number }
  >();
  private readonly registry?: ModelsRegistry | undefined;
  private readonly providerId?: string | (() => string | undefined) | undefined;
  private readonly events?: EventBus | undefined;
  private sessionId?: string | (() => string | undefined) | undefined;
  private priceCache = new Map<string, PriceEntry>();
  /** Most recently accounted request's tokens. Used for per-request context pressure. */
  private lastInput = 0;
  private lastCacheRead = 0;
  private lastCacheWrite = 0;

  constructor(
    opts: {
      registry?: ModelsRegistry | undefined;
      providerId?: string | (() => string | undefined) | undefined;
      events?: EventBus | undefined;
      sessionId?: string | (() => string | undefined) | undefined;
    } = {},
  ) {
    this.registry = opts.registry;
    this.providerId = opts.providerId;
    this.events = opts.events;
    this.sessionId = opts.sessionId;
  }

  setSessionId(sessionId: string | (() => string | undefined) | undefined): void {
    this.sessionId = sessionId;
  }

  account(usage: Usage, model?: string, providerId = this.currentProviderId()): void {
    const eventSessionId = this.currentSessionId();
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead ?? 0;
    this.cacheWrite += usage.cacheWrite ?? 0;
    this.recordProviderCache(usage, providerId);
    // Snapshot per-request tokens for context pressure tracking.
    this.lastInput = usage.input;
    this.lastCacheRead = usage.cacheRead ?? 0;
    this.lastCacheWrite = usage.cacheWrite ?? 0;

    const priceKey = providerId && model ? `${providerId}\0${model}` : undefined;
    const price = priceKey ? this.priceCache.get(priceKey) : undefined;
    if (price) {
      this.applyPrice(usage, price);
      this.emitAccounted(eventSessionId, model, providerId, usage);
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
          if (m) {
            const p = priceFromModel(m);
            this.priceCache.set(priceKey!, p);
            this.applyPrice(usage, p);
          }
          // Token totals are authoritative even when pricing is unresolved.
          // Emit after the lookup settles so live UIs update for unknown models
          // without double-emitting when pricing is resolved.
          this.emitAccounted(eventSessionId, model, providerId, usage);
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
  accountWithModel(usage: Usage, resolved: ResolvedModel): void {
    const eventSessionId = this.currentSessionId();
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead ?? 0;
    this.cacheWrite += usage.cacheWrite ?? 0;
    this.recordProviderCache(usage, resolved.providerId);
    // Snapshot per-request tokens for context pressure tracking.
    this.lastInput = usage.input;
    this.lastCacheRead = usage.cacheRead ?? 0;
    this.lastCacheWrite = usage.cacheWrite ?? 0;
    const price = priceFromModel(resolved);
    if (this.priceCache.size >= PRICE_CACHE_MAX_SIZE) {
      const keys = [...this.priceCache.keys()];
      this.priceCache.delete(keys[0] ?? '');
    }
    this.priceCache.set(`${resolved.providerId}\0${resolved.modelId}`, price);
    this.applyPrice(usage, price);
    this.emitAccounted(eventSessionId, resolved.modelId, resolved.providerId, usage);
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
    return {
      readTokens: this.cacheRead,
      writeTokens: this.cacheWrite,
      hitRatio: promptCacheHitRatio({
        input: this.input,
        output: this.output,
        cacheRead: this.cacheRead,
        cacheWrite: this.cacheWrite,
      }),
      savedUsd: round4(this.cacheSaved),
      providers: [...this.cacheByProvider.entries()]
        .map(([provider, usage]) => ({
          provider,
          ...usage,
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
  ): void {
    this.events?.emit('token.accounted', {
      ...(sessionId ? { sessionId } : {}),
      usage: this.total(),
      ...(deltaUsage ? { deltaUsage: { ...deltaUsage } } : {}),
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

  reset(): void {
    this.input = 0;
    this.output = 0;
    this.cacheRead = 0;
    this.cacheWrite = 0;
    this.costInput = 0;
    this.costOutput = 0;
    this.cacheSaved = 0;
    this.cacheByProvider.clear();
    this.lastInput = 0;
    this.lastCacheRead = 0;
    this.lastCacheWrite = 0;
    this.emitAccounted(undefined, undefined, undefined, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }

  private recordProviderCache(usage: Usage, providerId?: string): void {
    const key = providerId ?? 'unknown';
    const current = this.cacheByProvider.get(key) ?? { input: 0, cacheRead: 0, cacheWrite: 0 };
    current.input += usage.input;
    current.cacheRead += usage.cacheRead ?? 0;
    current.cacheWrite += usage.cacheWrite ?? 0;
    this.cacheByProvider.set(key, current);
  }

  private applyPrice(usage: Usage, price: PriceEntry): void {
    if (price.input) this.costInput += (usage.input / 1_000_000) * price.input;
    if (price.output) this.costOutput += (usage.output / 1_000_000) * price.output;
    if (usage.cacheRead && price.cacheRead) {
      this.costInput += (usage.cacheRead / 1_000_000) * price.cacheRead;
    }
    // Gross read savings: what those cached tokens would have cost at the full
    // input rate, minus the discounted cache-read rate actually billed.
    if (usage.cacheRead && price.input !== undefined) {
      this.cacheSaved += (usage.cacheRead / 1_000_000) * (price.input - (price.cacheRead ?? 0));
    }
    const hasCacheWriteSplit = usage.cacheWrite5m !== undefined || usage.cacheWrite1h !== undefined;
    const cacheWrite5m = usage.cacheWrite5m ?? (hasCacheWriteSplit ? 0 : usage.cacheWrite);
    const cacheWrite1h = usage.cacheWrite1h ?? 0;
    if (cacheWrite5m && (price.cacheWrite5m ?? price.cacheWrite)) {
      this.costInput += (cacheWrite5m / 1_000_000) * (price.cacheWrite5m ?? price.cacheWrite ?? 0);
    }
    if (cacheWrite1h && (price.cacheWrite1h ?? price.cacheWrite)) {
      this.costInput += (cacheWrite1h / 1_000_000) * (price.cacheWrite1h ?? price.cacheWrite ?? 0);
    }
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
