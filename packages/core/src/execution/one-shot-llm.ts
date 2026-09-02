import type { FallbackChain } from '../core/fallback-profile-manager.js';
import { evaluateModelCalendar } from '../core/model-availability-calendar.js';
import { isProviderFailureTracked } from '../core/provider-runner.js';
import { isTextBlock } from '../types/blocks.js';
import type { Config } from '../types/config.js';
import type { Message } from '../types/messages.js';
import type {
  OneShotLLMInput,
  OneShotLLMResult,
  OneShotOrchestratorOptions,
} from '../types/one-shot-llm.js';
import {
  isFallbackWorthy,
  type Provider,
  ProviderError,
  type Request,
  type Response,
} from '../types/provider.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';

/**
 * Default timeout for one-shot LLM calls when the caller doesn't specify one.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default max output tokens when the caller doesn't specify.
 */
const DEFAULT_MAX_TOKENS = 1024;

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
 *   fallbackModels: ['anthropic/claude-haiku'],
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
        attempts: 0,
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
        attempts: 0,
        error: `Cannot build provider "${target.providerId}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ── 2. Build the request ───────────────────────────────────────
    const request = this.buildRequest(input, target.model);
    // External cancellation lives for the WHOLE call; each provider attempt
    // (primary + fallback entries) mints its OWN fresh timeout via
    // attemptSignal IMMEDIATELY before its tryCall, so neither a slow
    // buildProvider nor a blocked primary can silently consume an
    // attempt's budget.
    const externalSignal = input.signal;

    // ── 3. Build fallback chain ────────────────────────────────────
    const chain = this.resolveFallbackChain(input, config, target);

    // ── 4. Attempt the call with fallback rotation ─────────────────
    const tracker = this.opts.statusTracker;
    let servingProviderId = provider.id;
    let servingModel = target.model;
    let fromFallback = false;
    let lastError: unknown;
    let fallbackEligible = false;
    // Provider invocations actually made (primary + fallbacks) — reported on
    // the result so consumers can account for the true cost of a call.
    let attempts = 0;

    // Check if the primary target is blocked
    if (
      (tracker && !tracker.isAvailable(target.providerId, target.model)) ||
      !evaluateModelCalendar(config.modelAvailabilitySchedule, target.providerId, target.model)
        .allowed
    ) {
      this.opts.logger?.debug(
        `one-shot: primary "${target.providerId}/${target.model}" is blocked — trying fallback`,
      );
      // Fall through to the fallback chain
    } else {
      attempts += 1;
      // Mint the primary's timeout HERE — the same semantic point as the
      // fallback entries: immediately before tryCall, after buildProvider.
      const primarySignal = this.attemptSignal(externalSignal, input.timeoutMs);
      const primaryAttempt = await this.tryCall(
        provider,
        request,
        primarySignal,
        target.providerId,
        target.model,
        externalSignal,
      );
      const result = primaryAttempt.response;
      lastError = primaryAttempt.error;
      fallbackEligible = primaryAttempt.fallbackEligible;

      if (result) {
        tracker?.recordSuccess(target.providerId, target.model);
        servingProviderId = provider.id;
        servingModel = target.model;
        return this.buildResult(
          result,
          servingProviderId,
          servingModel,
          false,
          startedAt,
          attempts,
        );
      }

      if (!fallbackEligible || chain.length === 0) {
        return this.buildErrorResult(
          lastError,
          target.providerId,
          target.model,
          false,
          startedAt,
          attempts,
        );
      }
    }

    // ── 4b. Fallback chain ──────────────────────────────────────────
    // Estimate request tokens lazily — only reached when the primary call
    // failed or was blocked. Used to pre-filter fallback entries whose context
    // window is provably too small, avoiding a guaranteed context_overflow.
    const estimatedTokens = estimateRequestTokens(request.messages, request.system, []).total;

    // Filter blocked entries from the chain
    const usableChain = tracker
      ? chain.filter((e) => tracker.isAvailable(e.providerId, e.model))
      : chain;

    for (const entry of usableChain) {
      // The user cancelled while earlier attempts were in flight — stop
      // rotating instead of burning a buildProvider per remaining entry.
      if (externalSignal?.aborted) break;
      if (
        !evaluateModelCalendar(config.modelAvailabilitySchedule, entry.providerId, entry.model)
          .allowed
      )
        continue;
      // Re-check availability right before attempting — a concurrent failure
      // may have pushed this entry into the waiting room since the chain was
      // filtered. Skipping here avoids a wasted provider call.
      if (tracker && !tracker.isAvailable(entry.providerId, entry.model)) {
        continue;
      }
      if (entry.providerId === provider.id && entry.model === target.model) continue;

      let fbProvider: Provider;
      try {
        fbProvider = await this.opts.buildProvider(entry.providerId, entry.model);
      } catch (err) {
        lastError = err;
        continue;
      }

      // Pre-filter: skip entries whose context window is provably too small
      // for the current request. A guaranteed context_overflow is not
      // fallback-worthy and would surface as an error, wasting the call.
      const fbMaxContext = fbProvider.capabilities.maxContext;
      if (
        typeof fbMaxContext === 'number' &&
        Number.isFinite(fbMaxContext) &&
        fbMaxContext > 0 &&
        estimatedTokens > fbMaxContext
      ) {
        this.opts.logger?.debug(
          `one-shot: skipping "${entry.providerId}/${entry.model}" — context window ` +
            `(${fbMaxContext}) is smaller than request tokens (${estimatedTokens})`,
        );
        continue;
      }

      servingProviderId = fbProvider.id;
      servingModel = entry.model;
      attempts += 1;
      // Fresh per-attempt timeout — this entry gets the FULL budget, not
      // whatever the primary and earlier entries happened to leave behind.
      const attemptSignal = this.attemptSignal(externalSignal, input.timeoutMs);
      const attempt = await this.tryCall(
        fbProvider,
        this.buildRequest(input, entry.model),
        attemptSignal,
        entry.providerId,
        entry.model,
        externalSignal,
      );
      if (attempt.response) {
        tracker?.recordSuccess(entry.providerId, entry.model);
        fromFallback = true;
        return this.buildResult(
          attempt.response,
          servingProviderId,
          servingModel,
          true,
          startedAt,
          attempts,
        );
      }

      lastError = attempt.error;
      // Do NOT break on a non-fallback-eligible error from a chain entry.
      // Only the primary's eligibility (checked above at the gate) decides
      // whether we enter the chain at all. A stale entry (deleted model →
      // 404 → invalid_request) must not abort every healthy entry after it.
      // Mirrors the agent-loop fix in fallback-model.ts (lines 464–481).
    }

    // Total failure — all providers exhausted or non-retryable error.
    return this.buildErrorResult(
      lastError,
      servingProviderId,
      servingModel,
      fromFallback,
      startedAt,
      attempts,
    );
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
    // Role-based routing via the ModelRouter.
    //
    // A MATRIX pick is explicit user intent (`/setmodel`) and outranks a
    // caller-supplied target. A HEURISTIC pick does not: it is a capability
    // guess, and letting it silently replace an explicit providerId/model
    // would make those fields unreliable for every caller that also passes a
    // role — Council seats carry both (persona role + resolved seat target).
    if (input.role && this.opts.modelRouter) {
      const pick = this.opts.modelRouter.pickForTask(input.role, '');
      const hasExplicitTarget = Boolean(input.providerId || input.model);
      if (pick && (pick.fromMatrix === true || !hasExplicitTarget)) {
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
   * Compose the abort signal for ONE provider attempt: a fresh hard-timeout
   * signal (default 30s) plus the caller's external cancellation when
   * present. Fresh-per-attempt is what keeps fallback rotation alive after
   * a slow or hung primary exhausts its own budget — `timeout` and
   * `stream_hang` are fallback-worthy kinds, so the chain must rotate with
   * a full budget of its own.
   */
  private attemptSignal(
    external: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return external ? AbortSignal.any([external, timeoutSignal]) : timeoutSignal;
  }

  /**
   * Build the fallback model chain from input + config + current target.
   * Delegates to {@link FallbackProfileManager.resolveCandidates} — the
   * shared constructor used by both the agent loop and the one-shot path,
   * so both produce identical ordering, depth, and fromExplicitSource
   * semantics.
   *
   * The injected {@link OneShotOrchestratorOptions.fallbackProfileManager}
   * is the only allowed manager — OneShot never owns a private snapshot
   * so a live `ConfigStore` change reaches every call without rebuilding
   * the manager.
   */
  private resolveFallbackChain(
    input: OneShotLLMInput,
    config: Config,
    target: { providerId: string; model: string },
  ): FallbackChain {
    return this.opts.fallbackProfileManager.resolveCandidates(target, {
      fallbackModels:
        input.fallbackModels && input.fallbackModels.length > 0
          ? input.fallbackModels
          : config.fallbackModels,
      // The one-shot already tried `target` as the primary before entering
      // the chain. Passing it as `primary` suppresses the primary-insertion
      // step in resolveCandidates (primary === current → not pushed).
      primary: target,
    });
  }

  /** Attempt a provider call while preserving the actual failure for callers. */
  private async tryCall(
    provider: Provider,
    request: Request,
    signal: AbortSignal,
    providerId?: string,
    model?: string,
    externalSignal?: AbortSignal | undefined,
  ): Promise<CallAttempt> {
    try {
      // Through the host's extension chain when it has one — the same chain the
      // agent loop uses. `prompt-firewall` lives there; without this, a plugin
      // calling `api.llm` shipped unredacted context to a third-party provider
      // while the firewall reported itself active.
      const direct = (req: Request): Promise<Response> => provider.complete(req, { signal });
      const response = this.opts.wrapProviderCall
        ? await this.opts.wrapProviderCall(request, direct)
        : await direct(request);
      return { response, fallbackEligible: false };
    } catch (err) {
      // Record the failure in the tracker — unless an inner layer (the
      // provider-runner funnel) already wrote this exact wire failure to the
      // waiting room and marked the error. Counting it again would halve
      // every consecutive-failure threshold. Mirrors the contract the
      // agent-loop path honours in fallback-model.ts.
      if (err instanceof ProviderError && providerId && model && !isProviderFailureTracked(err)) {
        this.opts.statusTracker?.recordFailure(
          providerId,
          model,
          err.kind,
          err.status,
          err.describe(),
          { retryAfterMs: err.body?.retryAfterMs },
        );
      }
      return {
        error: err,
        // Eligibility keys off the EXTERNAL signal only: the per-attempt
        // timeout firing (the attempt signal aborting) is itself a
        // fallback-worthy failure, while a user-initiated cancel is not —
        // a cancelled caller must not trigger rotation.
        fallbackEligible:
          !(externalSignal?.aborted ?? false) &&
          (err instanceof ProviderError
            ? isFallbackWorthy(err.kind)
            : this.opts.wrapProviderCall === undefined),
      };
    }
  }

  /** Build a success result from a provider Response. */
  private buildResult(
    response: Response,
    servingProviderId: string,
    servingModel: string,
    fromFallback: boolean,
    startedAt: number,
    attempts: number,
  ): OneShotLLMResult {
    const textBlocks = response.content.filter(isTextBlock);
    const text = textBlocks
      .map((b) => b.text)
      .join('\n')
      .trim();
    return {
      text: text || '(empty response)',
      model: response.model ?? servingModel,
      provider: servingProviderId,
      tokens: {
        input: response.usage?.input ?? 0,
        output: response.usage?.output ?? 0,
        total: (response.usage?.input ?? 0) + (response.usage?.output ?? 0),
      },
      durationMs: Math.round(performance.now() - startedAt),
      fromFallback,
      attempts,
      stopReason: response.stopReason,
    };
  }

  /** Build a total-failure error result. */
  private buildErrorResult(
    error: unknown,
    servingProviderId: string,
    servingModel: string,
    fromFallback: boolean,
    startedAt: number,
    attempts: number,
  ): OneShotLLMResult {
    return {
      text: '',
      model: servingModel,
      provider: servingProviderId,
      tokens: { input: 0, output: 0, total: 0 },
      durationMs: Math.round(performance.now() - startedAt),
      fromFallback,
      attempts,
      error: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
    };
  }
}

/**
 * Normalize system prompt to TextBlock[].
 */
function asTextBlocks(
  system: string | import('../types/blocks.js').TextBlock[] | undefined,
): import('../types/blocks.js').TextBlock[] {
  if (!system) return [];
  if (Array.isArray(system)) return system;
  return [{ type: 'text', text: system }];
}
