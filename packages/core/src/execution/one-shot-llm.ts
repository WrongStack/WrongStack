import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { OneShotLLMInput, OneShotLLMResult, OneShotOrchestratorOptions } from '../types/one-shot-llm.js';
import {
  type Provider,
  ProviderError,
  type ProviderErrorKind,
  type Request,
  type Response,
} from '../types/provider.js';
import { effectiveFallbackChain, fallbackProfileChain, parseModelRef } from '../core/fallback-model.js';

/**
 * Default timeout for one-shot LLM calls when the caller doesn't specify one.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default max output tokens when the caller doesn't specify.
 */
const DEFAULT_MAX_TOKENS = 1024;

/**
 * Fallback-worthy provider error kinds — same set used by fallback-model.ts.
 */
const FALLBACK_WORTHY_KINDS: Record<ProviderErrorKind, boolean> = {
  stream_hang: true,
  rate_limit: true,
  overloaded: true,
  server: true,
  timeout: true,
  network: true,
  auth: false,
  context_overflow: false,
  content_filter: false,
  invalid_request: false,
  unknown: false,
};

type CallAttempt =
  | { response: Response; error?: never; fallbackEligible: false }
  | { response?: never; error: unknown; fallbackEligible: boolean };

/**
 * OneShotOrchestrator — a stateless, reusable utility for making single
 * LLM calls with provider resolution, fallback chains, and structured results.
 *
 * Usage:
 * ```ts
 * const oneShot = new OneShotOrchestrator({ buildProvider, getConfig });
 * const result = await oneShot.call({
 *   system: 'You are a helpful assistant.',
 *   userPrompt: 'Summarize this conversation.',
 *   model: 'deepseek-chat',
 *   fallbackProfile: 'summary',
 * });
 * console.log(result.text);
 * ```
 *
 * Every method is stateless — a single instance can be shared across
 * the entire process lifetime.
 */
export class OneShotOrchestrator {
  private readonly opts: OneShotOrchestratorOptions;

  constructor(opts: OneShotOrchestratorOptions) {
    this.opts = opts;
  }

  /**
   * Make a one-shot LLM call. Resolves provider+model, applies fallback
   * chain on transient errors, and returns a structured result.
   *
   * Never throws — all errors are captured in `OneShotLLMResult.error`.
   */
  async call(input: OneShotLLMInput): Promise<OneShotLLMResult> {
    const startedAt = performance.now();
    const config = this.opts.getConfig();

    // ── 1. Resolve target provider + model ─────────────────────────
    const target = this.resolveTarget(input, config);
    if (!target) {
      return {
        text: '',
        model: input.model ?? config.model ?? 'unknown',
        provider: input.providerId ?? config.provider ?? 'unknown',
        tokens: { input: 0, output: 0, total: 0 },
        durationMs: Math.round(performance.now() - startedAt),
        fromFallback: false,
        error: 'No provider or model could be resolved. Check your config.',
      };
    }

    let provider: Provider;
    try {
      provider = await this.opts.buildProvider(target.providerId, target.model);
    } catch (err) {
      return {
        text: '',
        model: target.model,
        provider: target.providerId,
        tokens: { input: 0, output: 0, total: 0 },
        durationMs: Math.round(performance.now() - startedAt),
        fromFallback: false,
        error: `Cannot build provider "${target.providerId}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ── 2. Build the request ───────────────────────────────────────
    const request = this.buildRequest(input, target.model);
    const signal = this.resolveSignal(input);

    // ── 3. Build fallback chain ────────────────────────────────────
    const chain = this.resolveFallbackChain(input, config, target);

    // ── 4. Attempt the call with fallback rotation ─────────────────
    let servingProviderId = provider.id;
    let servingModel = target.model;
    let fromFallback = false;

    const primaryAttempt = await this.tryCall(provider, request, signal);
    let result = primaryAttempt.response;
    let lastError = primaryAttempt.error;
    let fallbackEligible = primaryAttempt.fallbackEligible;

    if (!result && fallbackEligible && chain.length > 0) {
      for (const ref of chain) {
        const parsed = parseModelRef(ref);
        if (!parsed.model) continue;
        const fbProviderId = parsed.provider ?? config.provider;
        if (fbProviderId === provider.id && parsed.model === target.model) continue;

        servingProviderId = fbProviderId;
        servingModel = parsed.model;

        let fbProvider: Provider;
        try {
          fbProvider = await this.opts.buildProvider(fbProviderId, parsed.model);
        } catch (err) {
          lastError = err;
          continue;
        }

        servingProviderId = fbProvider.id;
        const attempt = await this.tryCall(
          fbProvider,
          this.buildRequest(input, parsed.model),
          signal,
        );
        if (attempt.response) {
          result = attempt.response;
          fromFallback = true;
          break;
        }

        lastError = attempt.error;
        fallbackEligible = attempt.fallbackEligible;
        if (!fallbackEligible) break;
      }
    }

    // ── 5. Build the final result ──────────────────────────────────
    const elapsed = Math.round(performance.now() - startedAt);

    if (result) {
      const textBlocks = result.content.filter(isTextBlock);
      const text = textBlocks.map((b) => b.text).join('\n').trim();

      return {
        text: text || '(empty response)',
        model: result.model ?? servingModel,
        provider: servingProviderId,
        tokens: {
          input: result.usage?.input ?? 0,
          output: result.usage?.output ?? 0,
          total: (result.usage?.input ?? 0) + (result.usage?.output ?? 0),
        },
        durationMs: elapsed,
        fromFallback,
        stopReason: result.stopReason,
      };
    }

    // Total failure — all providers exhausted or non-retryable error.
    return {
      text: '',
      model: servingModel,
      provider: servingProviderId,
      tokens: { input: 0, output: 0, total: 0 },
      durationMs: elapsed,
      fromFallback,
      error: lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown error'),
    };
  }

  // ── Private helpers ─────────────────────────────────────────────

  /**
   * Resolve the target provider + model from input + config.
   * Priority: role-based routing > explicit providerId+model > defaults.
   */
  private resolveTarget(
    input: OneShotLLMInput,
    config: import('../types/config.js').Config,
  ): { providerId: string; model: string } | undefined {
    // Role-based routing via ModelRouter (highest priority)
    if (input.role && this.opts.modelRouter) {
      const pick = this.opts.modelRouter.pickForTask(input.role, '');
      if (pick) {
        return { providerId: pick.provider, model: pick.model };
      }
    }

    // Explicit providerId + model
    if (input.providerId && input.model) {
      return { providerId: input.providerId, model: input.model };
    }

    // Model only — use default provider
    if (input.model) {
      return { providerId: config.provider, model: input.model };
    }

    // Provider only — use default model
    if (input.providerId) {
      return { providerId: input.providerId, model: config.model };
    }

    // Neither — use session defaults
    if (config.provider && config.model) {
      return { providerId: config.provider, model: config.model };
    }

    return undefined;
  }

  /**
   * Build a Provider Request from the input.
   */
  private buildRequest(input: OneShotLLMInput, model: string): Request {
    const messages: Message[] = [...(input.messages ?? [])];
    if (input.userPrompt) {
      messages.push({ role: 'user', content: input.userPrompt });
    }

    const system = asTextBlocks(input.system);

    return {
      model,
      ...(system.length > 0 ? { system } : {}),
      messages,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
    };
  }

  /**
   * Resolve the abort signal. Provider calls always receive the per-call
   * timeout, composed with external cancellation when the caller supplies it.
   */
  private resolveSignal(input: OneShotLLMInput): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  }

  /**
   * Build the fallback model chain from input + config + current target.
   */
  private resolveFallbackChain(
    input: OneShotLLMInput,
    config: import('../types/config.js').Config,
    target: { providerId: string; model: string },
  ): string[] {
    // Explicit chain wins
    if (input.fallbackModels && input.fallbackModels.length > 0) {
      return input.fallbackModels;
    }

    // Named profile
    if (input.fallbackProfile) {
      const profile = fallbackProfileChain(config, input.fallbackProfile);
      if (profile.length > 0) return profile;
    }

    // Smart default from config (same logic as fallback-model.ts)
    if (config.fallbackAuto !== false) {
      return effectiveFallbackChain(config).filter((ref) => {
        const parsed = parseModelRef(ref);
        const fbProvider = parsed.provider ?? config.provider;
        return !(fbProvider === target.providerId && parsed.model === target.model);
      });
    }

    return [];
  }

  /** Attempt a provider call while preserving the actual failure for callers. */
  private async tryCall(
    provider: Provider,
    request: Request,
    signal: AbortSignal,
  ): Promise<CallAttempt> {
    try {
      return {
        response: await provider.complete(request, { signal }),
        fallbackEligible: false,
      };
    } catch (err) {
      return {
        error: err,
        fallbackEligible:
          !signal.aborted &&
          (!(err instanceof ProviderError) || FALLBACK_WORTHY_KINDS[err.kind]),
      };
    }
  }
}

/**
 * Normalize system prompt to TextBlock[].
 */
function asTextBlocks(system: string | import('../types/blocks.js').TextBlock[] | undefined): import('../types/blocks.js').TextBlock[] {
  if (!system) return [];
  if (Array.isArray(system)) return system;
  return [{ type: 'text', text: system }];
}
