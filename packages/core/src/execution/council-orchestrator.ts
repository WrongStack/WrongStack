import type {
  CouncilLLMCaller,
  CouncilModelTarget,
  CouncilQuestion,
  CouncilResult,
  CouncilUsage,
  CouncilVoteResult,
  ResolvedCouncilProfile,
  ResolvedCouncilSeat,
} from '../types/council.js';
import type { OneShotLLMResult } from '../types/one-shot-llm.js';
import {
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
  type CouncilPersonaRegistry,
} from './council-personas.js';
import {
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
  type CouncilProfileRegistry,
  resolveCouncilProfile,
} from './council-profiles.js';
import {
  buildCouncilJudgeSystemPrompt,
  buildCouncilJudgeUserPrompt,
  buildCouncilVoterSystemPrompt,
  buildCouncilVoterUserPrompt,
} from './council-prompts.js';
import { resolveCouncilVotes } from './council-resolution.js';

/** Synthetic ballot entry for "refuse every real option". */
export const COUNCIL_REFUSAL_OPTION_ID = 'council_refuse';
export const DEFAULT_COUNCIL_MAX_CONCURRENCY = 3;
export const MAX_COUNCIL_CONCURRENCY = 8;

export interface CouncilOrchestratorOptions {
  caller: CouncilLLMCaller;
  personas?: CouncilPersonaRegistry | undefined;
  profiles?: CouncilProfileRegistry | undefined;
  defaultProfile?: string | undefined;
  maxConcurrency?: number | undefined;
  refusalOptionId?: string | undefined;
}

interface ParsedVote {
  optionId?: string | undefined;
  stance?: string | undefined;
  rationale?: string | undefined;
}

interface ParsedJudge {
  optionId?: string | undefined;
  answer?: string | undefined;
  rationale?: string | undefined;
}

interface UsageAccumulator {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Provider-neutral Council runner backed by an injected one-shot LLM caller. */
export class CouncilOrchestrator {
  private readonly caller: CouncilLLMCaller;
  private readonly personas: CouncilPersonaRegistry;
  private readonly profiles: CouncilProfileRegistry;
  private readonly defaultProfile: string | undefined;
  private readonly maxConcurrency: number;
  private readonly refusalOptionId: string;

  constructor(opts: CouncilOrchestratorOptions) {
    this.caller = opts.caller;
    this.personas = opts.personas ?? DEFAULT_COUNCIL_PERSONA_REGISTRY;
    this.profiles = opts.profiles ?? DEFAULT_COUNCIL_PROFILE_REGISTRY;
    this.defaultProfile = opts.defaultProfile;
    this.maxConcurrency = validateConcurrency(
      opts.maxConcurrency ?? DEFAULT_COUNCIL_MAX_CONCURRENCY,
    );
    this.refusalOptionId = opts.refusalOptionId?.trim() || COUNCIL_REFUSAL_OPTION_ID;
  }

  async ask(question: CouncilQuestion): Promise<CouncilResult> {
    const startedAt = Date.now();
    const profile = resolveCouncilProfile(question.profile, {
      registry: this.profiles,
      personas: this.personas,
      defaultProfile: this.defaultProfile,
    });
    validateRefusalCollision(question, this.refusalOptionId);

    const timeoutSignal = AbortSignal.timeout(profile.overallTimeoutMs);
    const signal = question.signal
      ? AbortSignal.any([question.signal, timeoutSignal])
      : timeoutSignal;
    const usage: UsageAccumulator = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const votes = await mapConcurrent(
      profile.seats,
      Math.min(this.maxConcurrency, profile.seats.length),
      async (seat) => {
        try {
          return await this.callSeat(question, profile, seat, signal, usage);
        } catch (error) {
          return {
            seatId: seat.id,
            persona: seat.persona,
            status: signal.aborted ? 'cancelled' : 'failed',
            error: errorMessage(error),
          } satisfies CouncilVoteResult;
        }
      },
    );
    const warnings = distinctnessWarnings(votes, profile);
    const errors = votes
      .filter((vote) => vote.status === 'failed' || vote.status === 'invalid')
      .map((vote) => `${vote.seatId}: ${vote.error ?? vote.status}`);

    if (question.signal?.aborted) {
      return resultEnvelope({
        status: 'cancelled',
        reason: 'Council call cancelled.',
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (timeoutSignal.aborted) {
      return resultEnvelope({
        status: 'failed',
        reason: 'Council overall timeout exceeded.',
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors: [...errors, 'Council overall timeout exceeded.'],
      });
    }

    if (!question.options || question.options.length === 0) {
      return this.resolveOpenQuestion(
        question,
        profile,
        votes,
        signal,
        usage,
        startedAt,
        warnings,
        errors,
      );
    }
    return this.resolveOptionQuestion(
      question,
      profile,
      votes,
      signal,
      usage,
      startedAt,
      warnings,
      errors,
    );
  }

  private async callSeat(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    seat: ResolvedCouncilSeat,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<CouncilVoteResult> {
    if (signal.aborted) return cancelledVote(seat);
    let persona;
    try {
      persona = this.personas.require(seat.persona);
    } catch (error) {
      return {
        seatId: seat.id,
        persona: seat.persona,
        status: 'failed',
        error: errorMessage(error),
      };
    }
    const result = await this.safeCall({
      system: buildCouncilVoterSystemPrompt(persona),
      userPrompt: buildCouncilVoterUserPrompt(question, seat, {
        refusalOptionId: question.options?.length ? this.refusalOptionId : undefined,
      }),
      target: seat.target,
      maxTokens: profile.voterMaxTokens,
      timeoutMs: profile.perCallTimeoutMs,
      signal,
      usage,
    });

    const metadata = callMetadata(result);
    if (result.error) {
      return {
        seatId: seat.id,
        persona: seat.persona,
        status: signal.aborted ? 'cancelled' : 'failed',
        ...metadata,
        error: result.error,
      };
    }
    const parsed = parseVote(result.text, question, this.refusalOptionId);
    if (!parsed.ok) {
      return {
        seatId: seat.id,
        persona: seat.persona,
        status: 'invalid',
        ...metadata,
        error: parsed.error,
      };
    }
    return {
      seatId: seat.id,
      persona: seat.persona,
      status: 'valid',
      ...parsed.vote,
      ...metadata,
    };
  }

  private async resolveOptionQuestion(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    votes: CouncilVoteResult[],
    signal: AbortSignal,
    usage: UsageAccumulator,
    startedAt: number,
    warnings: string[],
    errors: string[],
  ): Promise<CouncilResult> {
    const validVotes = votes.filter(
      (vote): vote is CouncilVoteResult & { optionId: string } =>
        vote.status === 'valid' && typeof vote.optionId === 'string',
    );
    const resolution = resolveCouncilVotes({
      seats: profile.seats.map((seat) => ({
        id: seat.id,
        weight: seat.weight,
        veto: seat.veto,
      })),
      votes: validVotes.map((vote) => ({ seatId: vote.seatId, optionId: vote.optionId })),
      refusalOptionId: this.refusalOptionId,
      quorumFraction: profile.quorumFraction,
      approvalFraction: profile.approvalFraction,
    });

    if (resolution.status === 'abstained') {
      return resultEnvelope({
        status: 'abstained',
        reason: 'Council quorum was not met.',
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (resolution.status === 'denied') {
      return resultEnvelope({
        status: 'denied',
        optionId: resolution.optionId,
        reason: `Council denied the proposal via ${resolution.method}.`,
        resolution: resolution.method,
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (resolution.status === 'decided') {
      return resultEnvelope({
        status: 'decided',
        optionId: resolution.optionId,
        answer: optionLabel(question, resolution.optionId),
        resolution: 'majority',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (!profile.judge) {
      return resultEnvelope({
        status: 'abstained',
        reason: `Council requires a judge (${resolution.reason}), but this profile has none.`,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }

    const judged = await this.callJudge(
      question,
      profile,
      votes,
      profile.judge,
      resolution.reason,
      signal,
      usage,
    );
    if (!judged.ok) {
      return resultEnvelope({
        status: signal.aborted ? 'cancelled' : 'abstained',
        reason: judged.error,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors: [...errors, judged.error],
        judgeUsed: true,
      });
    }
    if (judged.value.optionId === this.refusalOptionId) {
      return resultEnvelope({
        status: 'denied',
        optionId: this.refusalOptionId,
        reason: judged.value.rationale ?? 'Council judge refused all options.',
        resolution: 'judge',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
        judgeUsed: true,
      });
    }
    return resultEnvelope({
      status: 'decided',
      optionId: judged.value.optionId,
      answer: optionLabel(question, judged.value.optionId),
      reason: judged.value.rationale,
      resolution: 'judge',
      votes,
      profile,
      usage,
      startedAt,
      warnings,
      errors,
      judgeUsed: true,
    });
  }

  private async resolveOpenQuestion(
    question: CouncilQuestion,
    profile: ResolvedCouncilProfile,
    votes: CouncilVoteResult[],
    signal: AbortSignal,
    usage: UsageAccumulator,
    startedAt: number,
    warnings: string[],
    errors: string[],
  ): Promise<CouncilResult> {
    const valid = votes.filter(
      (vote): vote is CouncilVoteResult & { stance: string } =>
        vote.status === 'valid' && typeof vote.stance === 'string',
    );
    if (valid.length / profile.seats.length < profile.quorumFraction) {
      return resultEnvelope({
        status: 'abstained',
        reason: 'Council quorum was not met.',
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }
    if (!profile.judge) {
      const first = valid[0];
      if (!first) {
        return resultEnvelope({
          status: 'failed',
          reason: 'Council produced no valid stance.',
          resolution: 'none',
          votes,
          profile,
          usage,
          startedAt,
          warnings,
          errors,
        });
      }
      return resultEnvelope({
        status: 'decided',
        answer: first.stance,
        reason: first.rationale,
        resolution: 'first_stance',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors,
      });
    }

    const judged = await this.callJudge(
      question,
      profile,
      votes,
      profile.judge,
      'open_question_synthesis',
      signal,
      usage,
    );
    if (!judged.ok) {
      return resultEnvelope({
        status: signal.aborted ? 'cancelled' : 'failed',
        reason: judged.error,
        resolution: 'none',
        votes,
        profile,
        usage,
        startedAt,
        warnings,
        errors: [...errors, judged.error],
        judgeUsed: true,
      });
    }
    return resultEnvelope({
      status: 'decided',
      answer: judged.value.answer,
      reason: judged.value.rationale,
      resolution: 'judge',
      votes,
      profile,
      usage,
      startedAt,
      warnings,
      errors,
      judgeUsed: true,
    });
  }

  private async callJudge(
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
    if (result.error) return { ok: false, error: result.error };
    return parseJudge(result.text, question, this.refusalOptionId);
  }

  private async safeCall(input: {
    system: string;
    userPrompt: string;
    target?: CouncilModelTarget | undefined;
    maxTokens: number;
    timeoutMs: number;
    signal: AbortSignal;
    usage: UsageAccumulator;
  }): Promise<OneShotLLMResult> {
    try {
      const result = await this.caller.call({
        system: input.system,
        userPrompt: input.userPrompt,
        responseFormat: { type: 'json_object' },
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        ...(input.target?.providerId ? { providerId: input.target.providerId } : {}),
        ...(input.target?.model ? { model: input.target.model } : {}),
        ...(input.target?.role ? { role: input.target.role } : {}),
        ...(input.target?.fallbackProfile
          ? { fallbackProfile: input.target.fallbackProfile }
          : {}),
        ...(input.target?.fallbackModels
          ? { fallbackModels: [...input.target.fallbackModels] }
          : {}),
      });
      addUsage(input.usage, result);
      return result;
    } catch (error) {
      input.usage.calls += 1;
      return emptyCallResult(errorMessage(error));
    }
  }
}

function parseVote(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
): { ok: true; vote: ParsedVote } | { ok: false; error: string } {
  const parsed = parseObject(text);
  if (!parsed.ok) return parsed;
  const rationale = optionalString(parsed.value['rationale']);
  if (question.options && question.options.length > 0) {
    const optionId = optionalString(parsed.value['optionId']);
    const allowed = new Set([...question.options.map((option) => option.id.trim()), refusalOptionId]);
    if (!optionId || !allowed.has(optionId)) {
      return { ok: false, error: 'Voter returned an unknown or missing optionId.' };
    }
    return { ok: true, vote: { optionId, ...(rationale ? { rationale } : {}) } };
  }
  const stance = optionalString(parsed.value['stance']);
  if (!stance) return { ok: false, error: 'Voter returned an empty or missing stance.' };
  return { ok: true, vote: { stance, ...(rationale ? { rationale } : {}) } };
}

function parseJudge(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
): { ok: true; value: ParsedJudge } | { ok: false; error: string } {
  const parsed = parseObject(text);
  if (!parsed.ok) return parsed;
  const rationale = optionalString(parsed.value['rationale']);
  if (question.options && question.options.length > 0) {
    const optionId = optionalString(parsed.value['optionId']);
    const allowed = new Set([...question.options.map((option) => option.id.trim()), refusalOptionId]);
    if (!optionId || !allowed.has(optionId)) {
      return { ok: false, error: 'Judge returned an unknown or missing optionId.' };
    }
    return { ok: true, value: { optionId, ...(rationale ? { rationale } : {}) } };
  }
  const answer = optionalString(parsed.value['answer']);
  if (!answer) return { ok: false, error: 'Judge returned an empty or missing answer.' };
  return { ok: true, value: { answer, ...(rationale ? { rationale } : {}) } };
}

function parseObject(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last < first) return { ok: false, error: 'LLM response did not contain JSON.' };
  try {
    const value: unknown = JSON.parse(trimmed.slice(first, last + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'LLM response JSON must be an object.' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `Invalid LLM response JSON: ${errorMessage(error)}` };
  }
}

function resultEnvelope(input: {
  status: CouncilResult['status'];
  answer?: string | undefined;
  optionId?: string | undefined;
  reason?: string | undefined;
  resolution: CouncilResult['resolution'];
  votes: CouncilVoteResult[];
  profile: ResolvedCouncilProfile;
  usage: UsageAccumulator;
  startedAt: number;
  warnings: string[];
  errors: string[];
  judgeUsed?: boolean | undefined;
}): CouncilResult {
  const validVoteCount = input.votes.filter((vote) => vote.status === 'valid').length;
  return {
    status: input.status,
    ...(input.answer ? { answer: input.answer } : {}),
    ...(input.optionId ? { optionId: input.optionId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    resolution: input.resolution,
    votes: Object.freeze([...input.votes]),
    configuredSeatCount: input.profile.seats.length,
    validVoteCount,
    distinctTargetCount: distinctTargetCount(input.votes, input.profile),
    judgeUsed: input.judgeUsed ?? false,
    usage: usageResult(input.usage, input.startedAt),
    ...(input.warnings.length > 0 ? { warnings: Object.freeze([...input.warnings]) } : {}),
    ...(input.errors.length > 0 ? { errors: Object.freeze([...input.errors]) } : {}),
  };
}

function callMetadata(result: OneShotLLMResult): Omit<CouncilVoteResult, 'seatId' | 'persona' | 'status'> {
  return {
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.model ? { model: result.model } : {}),
    ...(result.fromFallback ? { fromFallback: true } : {}),
    durationMs: result.durationMs,
  };
}

function addUsage(usage: UsageAccumulator, result: OneShotLLMResult): void {
  usage.calls += 1;
  usage.inputTokens += result.tokens.input;
  usage.outputTokens += result.tokens.output;
  usage.totalTokens += result.tokens.total;
}

function usageResult(usage: UsageAccumulator, startedAt: number): CouncilUsage {
  return Object.freeze({ ...usage, durationMs: Math.max(0, Date.now() - startedAt) });
}

function cancelledVote(seat: ResolvedCouncilSeat): CouncilVoteResult {
  return { seatId: seat.id, persona: seat.persona, status: 'cancelled', error: 'Cancelled.' };
}

function distinctTargetCount(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): number {
  const keys = votes
    .filter((vote) => vote.status === 'valid')
    .map((vote) =>
      profile.distinctness === 'provider'
        ? vote.provider
        : `${vote.provider ?? ''}/${vote.model ?? ''}`,
    )
    .filter(Boolean);
  return new Set(keys).size;
}

function distinctnessWarnings(
  votes: readonly CouncilVoteResult[],
  profile: ResolvedCouncilProfile,
): string[] {
  if (profile.distinctness === 'none') return [];
  const valid = votes.filter((vote) => vote.status === 'valid');
  const distinct = distinctTargetCount(valid, profile);
  if (valid.length > 1 && distinct < valid.length) {
    return [
      `Council distinctness policy "${profile.distinctness}" was not met: ${distinct} distinct target(s) served ${valid.length} valid vote(s).`,
    ];
  }
  return [];
}

function optionLabel(question: CouncilQuestion, optionId: string | undefined): string | undefined {
  if (!optionId) return undefined;
  return question.options?.find((option) => option.id.trim() === optionId)?.label.trim();
}

function validateRefusalCollision(question: CouncilQuestion, refusalOptionId: string): void {
  if (question.options?.some((option) => option.id.trim() === refusalOptionId)) {
    throw new Error(`CouncilOrchestrator: option id "${refusalOptionId}" is reserved.`);
  }
}

function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_COUNCIL_CONCURRENCY) {
    throw new Error(
      `CouncilOrchestrator: maxConcurrency must be an integer in [1, ${MAX_COUNCIL_CONCURRENCY}].`,
    );
  }
  return value;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function emptyCallResult(error: string): OneShotLLMResult {
  return {
    text: '',
    model: '',
    provider: '',
    tokens: { input: 0, output: 0, total: 0 },
    durationMs: 0,
    fromFallback: false,
    error,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
