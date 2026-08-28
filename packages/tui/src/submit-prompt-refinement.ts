import { parseModelRef } from '@wrongstack/core/agent';
import {
  buildRefinerContextSections,
  DEFAULT_REFINER_RETRY_FEEDBACK,
  type EnhanceFailureKind,
  enhanceUserPrompt,
  nextEnhanceTimeout,
  normalizedEqual,
  recentTextTurns,
  shouldEnhance,
} from '@wrongstack/core/execution';
import type { Provider, ReasoningRequest } from '@wrongstack/core/types';
import type { Action, State } from './app-reducer.js';
import type {
  RefineFailureDecision,
  RefineFailureModel,
} from './components/refine-failure-panel.js';
import { ATTACHMENT_TOKEN_SRC } from './input-tokens.js';
import { startPromptRefinement } from './prompt-refinement-start.js';
import type { MutableCell } from './shared-types.js';
import type { PromptRefinementCapabilities } from './tui-host-capabilities.js';

interface PromptRefinementHost {
  readonly capabilities: PromptRefinementCapabilities;
  readonly status: State['status'];
  readonly enabled: MutableCell<boolean>;
  readonly original: MutableCell<string>;
  readonly abortController: MutableCell<AbortController | null>;
  readonly cancelled: MutableCell<boolean>;
  /** Grace period in seconds before the refiner LLM call starts. 0 = skip. */
  readonly preRefineSeconds: number;
  dispatch(action: Action): void;
  clearDraft(): void;
  setDraft(buffer: string, cursor: number): void;
  setStartedAt(value: number | null): void;
  setDuration(value: number | null): void;
  setProviderId(value: string | null): void;
  setModel(value: string | null): void;
}

type PromptRefinementResult = { kind: 'send'; effectiveText: string } | { kind: 'cancel' };

/** Refine one submitted prompt and resolve every recovery/preview decision. */
export async function refineSubmittedPrompt(
  host: PromptRefinementHost,
  trimmed: string,
  options: { steering: boolean; continuationResolved: boolean },
): Promise<PromptRefinementResult> {
  let effectiveText = trimmed;
  const chips: string[] = [];
  let cleanText = trimmed;
  const chipPattern = new RegExp(ATTACHMENT_TOKEN_SRC, 'g');
  for (const chipMatch of trimmed.matchAll(chipPattern)) chips.push(chipMatch[0]);
  if (chips.length > 0) {
    cleanText = trimmed
      .replace(chipPattern, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!cleanText) {
      cleanText = trimmed;
      chips.length = 0;
    }
  }

  if (
    !host.enabled.current ||
    host.status !== 'idle' ||
    options.steering ||
    options.continuationResolved ||
    !shouldEnhance(cleanText)
  ) {
    return { kind: 'send', effectiveText };
  }

  // ── Pre-refine grace countdown ───────────────────────────────────
  // Give the user a few seconds to bail before the refiner LLM call
  // starts. Any key sends as-is (skip); Esc cancels back to the
  // composer; countdown expiry proceeds into normal refinement.
  // 0 = skip the countdown entirely (go straight to refinement).
  if (host.preRefineSeconds > 0) {
    let countdownInfo: NonNullable<State['refineCountdown']> | undefined;
    const countdownDecision = await new Promise<'proceed' | 'skip' | 'cancel'>((resolve) => {
      countdownInfo = {
        original: trimmed,
        seconds: host.preRefineSeconds,
        resolve,
      };
      host.dispatch({ type: 'refineCountdownOpen', info: countdownInfo });
    });
    // Scoped to this countdown: if a newer one has taken over the slot, this
    // (superseded) flow must not close it out from under its own caller.
    host.dispatch({
      type: 'refineCountdownClose',
      ...(countdownInfo ? { info: countdownInfo } : {}),
    });
    if (countdownDecision === 'skip') {
      return { kind: 'send', effectiveText };
    }
    if (countdownDecision === 'cancel') {
      host.setDraft(trimmed, trimmed.length);
      return { kind: 'cancel' };
    }
    // 'proceed' — fall through to normal refinement.
    if (host.cancelled.current) {
      host.cancelled.current = false;
      host.setDraft(trimmed, trimmed.length);
      return { kind: 'cancel' };
    }
  }

  const { capabilities } = host;
  const { agent } = capabilities;
  let refineDurationMs = 0;
  host.setDuration(null);
  const controller = new AbortController();
  const baseTimeoutMs = 90_000;
  const contextSections = await startPromptRefinement({
    original: trimmed,
    controller,
    originalSlot: host.original,
    abortSlot: host.abortController,
    setStartedAt: host.setStartedAt,
    setBusy: (on) => host.dispatch({ type: 'enhanceBusy', on }),
    clearDraft: host.clearDraft,
    prepareContext: () =>
      buildRefinerContextSections({
        text: cleanText,
        memoryStore: capabilities.memoryStore,
        context: agent.ctx,
      }),
    fallbackContext: [],
  });

  const restoreCancelledPreflight = (): boolean => {
    if (!controller.signal.aborted) return false;
    host.cancelled.current = false;
    host.abortController.current = null;
    host.dispatch({ type: 'enhanceBusy', on: false });
    host.setStartedAt(null);
    host.setDuration(null);
    host.setDraft(trimmed, trimmed.length);
    return true;
  };
  if (restoreCancelledPreflight()) return { kind: 'cancel' };

  type RefineOutcome = {
    result: { refined: string; english: string } | null;
    kind: EnhanceFailureKind | undefined;
    reason: string | null;
  };
  type RefineAttemptHints = {
    previousRefinement?: { refined: string; english: string } | undefined;
    retryFeedback?: string | undefined;
  };
  const runAttempt = async (
    provider: Provider,
    model: string,
    timeoutMs: number,
    reasoning: ReasoningRequest | undefined,
    hints: RefineAttemptHints = {},
  ): Promise<RefineOutcome> => {
    let kind: EnhanceFailureKind | undefined;
    let reason: string | null = null;
    const attemptStartedAt = Date.now();
    host.setStartedAt(attemptStartedAt);
    host.setDuration(null);
    host.setProviderId(provider.id);
    host.setModel(model);
    host.abortController.current = controller;
    host.dispatch({ type: 'enhanceBusy', on: true });
    let result: { refined: string; english: string } | null = null;
    try {
      result = (await enhanceUserPrompt({
        provider,
        model,
        text: cleanText,
        signal: controller.signal,
        timeoutMs,
        onError: (message, failureKind) => {
          reason = message;
          kind = failureKind;
        },
        history: recentTextTurns(agent.ctx.messages),
        contextSections,
        ...(hints.previousRefinement ? { previousRefinement: hints.previousRefinement } : {}),
        ...(hints.retryFeedback ? { retryFeedback: hints.retryFeedback } : {}),
        ...(reasoning ? { reasoning } : {}),
      })) as { refined: string; english: string } | null;
    } finally {
      refineDurationMs = Math.max(0, Date.now() - attemptStartedAt);
      host.setDuration(refineDurationMs);
      host.abortController.current = null;
      host.dispatch({ type: 'enhanceBusy', on: false });
    }
    return { result, kind, reason };
  };

  let initialProvider = agent.ctx.provider;
  let initialModel = agent.ctx.model;
  let initialReasoning = await capabilities.getEnhancerReasoning?.(
    initialProvider.id,
    initialModel,
  );
  const configuredRef = capabilities.getConfiguredRefinerRef?.();
  if (configuredRef && capabilities.buildEnhancerProvider) {
    const ref = parseModelRef(configuredRef);
    const providerId = ref.provider ?? agent.ctx.provider.id;
    if (ref.model) {
      let built: Provider | undefined;
      try {
        built = await capabilities.buildEnhancerProvider(providerId, ref.model);
      } catch {
        built = undefined;
      }
      if (built) {
        initialProvider = built;
        initialModel = ref.model;
        initialReasoning = await capabilities.getEnhancerReasoning?.(providerId, ref.model);
      }
    }
  }
  if (restoreCancelledPreflight()) return { kind: 'cancel' };
  let outcome = await runAttempt(initialProvider, initialModel, baseTimeoutMs, initialReasoning);
  if (outcome.result === null && outcome.kind === 'timeout' && !controller.signal.aborted) {
    outcome = await runAttempt(
      initialProvider,
      initialModel,
      nextEnhanceTimeout(baseTimeoutMs, undefined),
      initialReasoning,
    );
  }

  let sendOriginal = false;
  let editLoad = false;
  while (true) {
    while (outcome.result === null && !controller.signal.aborted) {
      const fallbackRef = capabilities.getEnhanceFallbackRef?.();
      const models: RefineFailureModel[] = capabilities.buildEnhancerProvider
        ? await (async () => {
            try {
              const providers = (await capabilities.getPickableProviders?.()) ?? [];
              const flattened: RefineFailureModel[] = [];
              for (const provider of providers) {
                for (const model of provider.models) {
                  if (provider.id === agent.ctx.provider.id && model === agent.ctx.model) continue;
                  flattened.push({ providerId: provider.id, model, label: provider.family });
                  if (flattened.length >= 200) return flattened;
                }
              }
              return flattened;
            } catch {
              return [];
            }
          })()
        : [];
      const decision = await new Promise<RefineFailureDecision>((resolve) => {
        host.dispatch({
          type: 'refineFailureOpen',
          info: {
            original: trimmed,
            ...(outcome.reason ? { error: outcome.reason } : {}),
            elapsedMs: refineDurationMs,
            ...(fallbackRef && capabilities.buildEnhancerProvider ? { fallbackRef } : {}),
            models,
            resolve,
          },
        });
      });
      host.dispatch({ type: 'refineFailureClose' });
      if (decision.kind === 'original') {
        sendOriginal = true;
        break;
      }
      if (decision.kind === 'edit') {
        editLoad = true;
        break;
      }
      const retryTimeout = nextEnhanceTimeout(baseTimeoutMs, undefined);
      if (decision.kind === 'retry') {
        outcome = await runAttempt(
          agent.ctx.provider,
          agent.ctx.model,
          retryTimeout,
          await capabilities.getEnhancerReasoning?.(agent.ctx.provider.id, agent.ctx.model),
        );
        continue;
      }
      const ref =
        decision.kind === 'fallback'
          ? parseModelRef(fallbackRef ?? '')
          : { provider: decision.providerId, model: decision.model };
      const providerId = ref.provider ?? agent.ctx.provider.id;
      const model = ref.model;
      let built: Provider | undefined;
      try {
        built = await capabilities.buildEnhancerProvider?.(providerId, model);
      } catch {
        built = undefined;
      }
      if (!built || !model) {
        host.dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: `✨ couldn't use ${providerId}/${model} for refinement` },
        });
        outcome = {
          result: null,
          kind: 'provider_error',
          reason: `couldn't build ${providerId}/${model}`,
        };
        continue;
      }
      outcome = await runAttempt(
        built,
        model,
        retryTimeout,
        await capabilities.getEnhancerReasoning?.(providerId, model),
      );
    }

    host.setStartedAt(null);
    host.setDuration(null);
    const result = outcome.result;
    if (editLoad) {
      host.setDraft(trimmed, trimmed.length);
      return { kind: 'cancel' };
    }
    if (host.cancelled.current) {
      host.cancelled.current = false;
      host.setDraft(trimmed, trimmed.length);
      return { kind: 'cancel' };
    }
    if (sendOriginal || result === null) return { kind: 'send', effectiveText: trimmed };
    if (!normalizedEqual(result.refined, cleanText)) {
      const chipSuffix = chips.length > 0 ? ` ${chips.join(' ')}` : '';
      const refinedWithChips = result.refined + chipSuffix;
      const englishWithChips = result.english + chipSuffix;
      const decision = await new Promise<
        'refined' | 'english' | 'original' | 'edit' | 'cancel' | 'retry'
      >((resolve) => {
        host.dispatch({
          type: 'enhanceOpen',
          info: {
            original: trimmed,
            refined: refinedWithChips,
            english: englishWithChips,
            resolve,
          },
        });
      });
      host.dispatch({ type: 'enhanceClose' });
      host.setStartedAt(null);
      host.setDuration(null);
      if (decision === 'retry') {
        outcome = await runAttempt(
          agent.ctx.provider,
          agent.ctx.model,
          nextEnhanceTimeout(baseTimeoutMs, undefined),
          await capabilities.getEnhancerReasoning?.(agent.ctx.provider.id, agent.ctx.model),
          { previousRefinement: result, retryFeedback: DEFAULT_REFINER_RETRY_FEEDBACK },
        );
        continue;
      }
      if (decision === 'cancel') {
        host.setDraft(trimmed, trimmed.length);
        return { kind: 'cancel' };
      }
      if (decision === 'edit') {
        host.setDraft(refinedWithChips, refinedWithChips.length);
        return { kind: 'cancel' };
      }
      effectiveText =
        decision === 'english'
          ? englishWithChips
          : decision === 'refined'
            ? refinedWithChips
            : trimmed;
    }
    return { kind: 'send', effectiveText };
  }
}
