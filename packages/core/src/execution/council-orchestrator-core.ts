/**
 * Construction, profile resolution and the guarded LLM call path (seat / judge
 * caller selection, fallback-profile targets, deadlines, usage) of the
 * {@link CouncilOrchestrator} (council-orchestrator.ts).
 */

import type { Config } from '@wrongstack/contracts/types/config';
import type {
  CouncilLLMCaller,
  CouncilModelTarget,
  CouncilProfileConfig,
  CouncilQuestion,
  CouncilVoteResult,
  ResolvedCouncilProfile,
} from '@wrongstack/contracts/types/council';
import type { OneShotLLMResult } from '@wrongstack/contracts/types/one-shot-llm';
import type { FallbackProfileManager } from '../core/fallback-profile-manager.js';
import {
  addUsage,
  CALL_CANCELLED_REASON,
  COUNCIL_REFUSAL_OPTION_ID,
  DEFAULT_COUNCIL_MAX_CONCURRENCY,
  OVERALL_TIMEOUT_REASON,
  type UsageAccumulator,
  validateConcurrency,
} from './council-orchestrator-helpers.js';
import {
  type CouncilPersonaRegistry,
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
} from './council-personas.js';
import {
  type CouncilProfileRegistry,
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
  resolveCouncilProfile,
} from './council-profiles.js';
import { buildCouncilJudgeSystemPrompt, buildCouncilJudgeUserPrompt } from './council-prompts.js';
import {
  errorMessage,
  type ParsedJudge,
  parseJudge,
  withTruncationNote,
} from './council-response-parser.js';
import { callWithDeadline } from './llm-call-deadline.js';
export interface CouncilOrchestratorOptions {
  /**
   * Shared LLM caller used for every seat and the judge when no per-seat
   * caller is configured.
   */
  caller?: CouncilLLMCaller | undefined;
  personas?: CouncilPersonaRegistry | undefined;
  profiles?: CouncilProfileRegistry | undefined;
  defaultProfile?: string | undefined;
  maxConcurrency?: number | undefined;
  refusalOptionId?: string | undefined;
  getConfig?: (() => Config) | undefined;
  fallbackProfileManager?: FallbackProfileManager | undefined;
  seatCaller?: ((seatIndex: number) => CouncilLLMCaller) | undefined;
  judgeCaller?: CouncilLLMCaller | undefined;
}
export abstract class CouncilOrchestratorCore {
  protected readonly caller: CouncilLLMCaller | undefined;
  protected readonly personas: CouncilPersonaRegistry;
  protected readonly profiles: CouncilProfileRegistry;
  protected readonly defaultProfile: string | undefined;
  protected readonly maxConcurrency: number;
  protected readonly refusalOptionId: string;
  protected readonly fallbackProfileManager: FallbackProfileManager | undefined;
  protected readonly seatCaller: ((seatIndex: number) => CouncilLLMCaller) | undefined;
  protected readonly judgeCaller: CouncilLLMCaller | undefined;

  constructor(opts: CouncilOrchestratorOptions) {
    if (!opts.caller && !opts.seatCaller && !opts.judgeCaller) {
      throw new Error('CouncilOrchestrator: provide `caller`, `seatCaller`, or `judgeCaller`.');
    }
    this.caller = opts.caller;
    this.personas = opts.personas ?? DEFAULT_COUNCIL_PERSONA_REGISTRY;
    this.profiles = opts.profiles ?? DEFAULT_COUNCIL_PROFILE_REGISTRY;
    this.defaultProfile = opts.defaultProfile;
    this.maxConcurrency = validateConcurrency(
      opts.maxConcurrency ?? DEFAULT_COUNCIL_MAX_CONCURRENCY,
    );
    this.refusalOptionId = opts.refusalOptionId?.trim() || COUNCIL_REFUSAL_OPTION_ID;
    this.fallbackProfileManager = opts.fallbackProfileManager;
    this.seatCaller = opts.seatCaller;
    this.judgeCaller = opts.judgeCaller;
  }

  protected resolveProfile(
    profile: string | CouncilProfileConfig | undefined,
  ): ResolvedCouncilProfile {
    return resolveCouncilProfile(profile, {
      registry: this.profiles,
      personas: this.personas,
      defaultProfile: this.defaultProfile,
    });
  }
  protected async callJudge(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    votes: CouncilVoteResult[],
    target: CouncilModelTarget,
    reason: string,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<{ ok: true; value: ParsedJudge } | { ok: false; error: string }> {
    const result = await this.safeCall({
      system: buildCouncilJudgeSystemPrompt(),
      userPrompt: buildCouncilJudgeUserPrompt(question, votes, {
        reason,
        refusalOptionId: question.options?.length ? this.refusalOptionId : undefined,
      }),
      target,
      maxTokens: profile.judgeMaxTokens,
      timeoutMs: profile.perCallTimeoutMs,
      signal,
      usage,
    });
    if (result.error) {
      if (signal.aborted && !question.signal?.aborted) {
        return { ok: false, error: OVERALL_TIMEOUT_REASON };
      }
      if (question.signal?.aborted) {
        return { ok: false, error: CALL_CANCELLED_REASON };
      }
      return { ok: false, error: result.error };
    }
    const judged = parseJudge(result.text, question, this.refusalOptionId);
    if (!judged.ok) {
      return {
        ok: false,
        error: withTruncationNote(judged.error, result, profile.judgeMaxTokens),
      };
    }
    return judged;
  }

  protected resolveCaller(seatIndex?: number): CouncilLLMCaller {
    if (seatIndex !== undefined) {
      if (this.seatCaller) return this.seatCaller(seatIndex);
      return (this.caller ?? this.judgeCaller) as CouncilLLMCaller;
    }
    if (this.judgeCaller) return this.judgeCaller;
    if (this.seatCaller) return this.seatCaller(0);
    return this.caller as CouncilLLMCaller;
  }

  protected async safeCall(input: {
    system: string;
    userPrompt: string;
    target?: CouncilModelTarget | undefined;
    /** Unset = the model's own output ceiling. */
    maxTokens: number | undefined;
    timeoutMs: number;
    signal: AbortSignal;
    usage: UsageAccumulator;
    seatIndex?: number | undefined;
  }): Promise<OneShotLLMResult> {
    const effectiveCaller = this.resolveCaller(input.seatIndex);
    const resolvedTarget = this.resolveCouncilTarget(input.target);
    const startedAt = Date.now();

    try {
      const result = await callWithDeadline(
        (signal) =>
          effectiveCaller.call({
            system: input.system,
            userPrompt: input.userPrompt,
            responseFormat: { type: 'json_object' },
            ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
            timeoutMs: input.timeoutMs,
            signal,
            ...(resolvedTarget?.providerId ? { providerId: resolvedTarget.providerId } : {}),
            ...(resolvedTarget?.model ? { model: resolvedTarget.model } : {}),
            ...(resolvedTarget?.role ? { role: resolvedTarget.role } : {}),
            ...(resolvedTarget?.fallbackModels && resolvedTarget.fallbackModels.length > 0
              ? { fallbackModels: [...resolvedTarget.fallbackModels] }
              : {}),
          }),
        input.signal,
        input.timeoutMs,
        'Council call timeout exceeded.',
      );
      addUsage(input.usage, result);
      return result;
    } catch (error) {
      const failed: OneShotLLMResult = {
        text: '',
        model: resolvedTarget?.model ?? '',
        provider: resolvedTarget?.providerId ?? '',
        tokens: { input: 0, output: 0, total: 0 },
        durationMs: Math.max(0, Date.now() - startedAt),
        fromFallback: false,
        error: errorMessage(error),
      };
      addUsage(input.usage, failed);
      return failed;
    }
  }

  protected resolveCouncilTarget(
    target?: CouncilModelTarget | undefined,
  ): CouncilModelTarget | undefined {
    if (!target) return undefined;
    if (!target.fallbackProfile) return target;

    const mgr = this.fallbackProfileManager;
    if (!mgr) return target;
    const chain = mgr.resolve(target.fallbackProfile);
    if (chain.length === 0) return target;

    const combined = [
      ...chain.map((e) => `${e.providerId}/${e.model}`),
      ...(target.fallbackModels ?? []),
    ];
    const seen = new Set<string>();
    const deduped = combined.filter((ref) => {
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    });

    return {
      ...(target.providerId ? { providerId: target.providerId } : {}),
      ...(target.model ? { model: target.model } : {}),
      ...(target.role ? { role: target.role } : {}),
      fallbackModels: deduped,
    };
  }
}
