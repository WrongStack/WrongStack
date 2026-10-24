import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Provider, ResponseFormat, Usage } from '@wrongstack/contracts/types/provider';
import type { BrainDecision, BrainDecisionRequest } from '../brain/brain.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import { safeParse } from '../utils/safe-json.js';
import type { BrainCircuitBreaker } from './brain-circuit.js';
import { callWithDeadline } from './llm-call-deadline.js';

export interface BrainLlmTarget {
  provider: Provider;
  model: string;
  label?: string | undefined;
}

export interface BrainLlmCallResult {
  text: string;
  usage?: Usage | undefined;
  stopReason?: string | undefined;
}

/** True when the model was cut off at its output budget rather than finishing. */
export function isTruncated(stopReason: string | undefined): boolean {
  return stopReason === 'max_tokens' || stopReason === 'length';
}

/**
 * Per-call decision timeout. 15s starves the same reasoning models the token
 * budget did — they spend it thinking and the call is aborted mid-response.
 * Matches `BRAIN_COUNCIL_DEFAULT_PER_CALL_TIMEOUT_MS`.
 */
export const DEFAULT_BRAIN_TIMEOUT_MS = 45_000;

/**
 * How many targets' worth of wall clock one decision may spend in total.
 *
 * The per-call timeout alone bounds nothing: the tier walks every target in
 * order, so a 10-model fallback chain of dead endpoints blocks the caller for
 * 10 x the per-call budget — over seven minutes at the default. A Brain
 * decision sits in front of a working agent, so the walk gets a deadline:
 * the primary plus two fallbacks' worth of time, then it stops and reports
 * an exhausted budget instead of grinding through the rest of the chain.
 *
 * Expressed in ATTEMPTS rather than as an absolute floor so the cap scales
 * with whatever per-call timeout is configured — a pool of fast local models
 * is not held to the same wall clock as a pool of reasoning models.
 */
export const BRAIN_LLM_MAX_BUDGETED_ATTEMPTS = 3;

export type BrainLlmDenyKind = 'unavailable' | 'unparseable' | 'refused';

const denyKinds = new WeakMap<object, BrainLlmDenyKind>();

export function markDenyKind(decision: BrainDecision, kind: BrainLlmDenyKind): BrainDecision {
  denyKinds.set(decision, kind);
  return decision;
}

export function readLlmDenyKind(decision: BrainDecision): BrainLlmDenyKind | undefined {
  return denyKinds.get(decision);
}

export function buildBrainUserMessage(request: BrainDecisionRequest): string {
  const optionsText = request.options?.length
    ? '\nOptions:\n' +
      request.options
        .map(
          (o) =>
            `  [${o.id}] ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}${o.recommended ? ' ★ recommended' : ''}`,
        )
        .join('\n')
    : '';

  return [
    `Question: ${request.question}`,
    request.context ? `\nContext:\n${request.context}` : '',
    optionsText,
  ]
    .filter(Boolean)
    .join('\n');
}

export function withDecisionDigest(user: string, digest: string | undefined): string {
  if (!digest?.trim()) return user;
  return `${user}\n\nOutcome history of similar past decisions (learn from it):\n${digest}`;
}

export async function completeBrainLlm(
  target: BrainLlmTarget,
  input: {
    system: string;
    user: string;
    timeoutMs: number;
    maxTokens?: number | undefined;
    responseFormat?: ResponseFormat | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<string> {
  return (await completeBrainLlmDetailed(target, input)).text;
}

export async function completeBrainLlmDetailed(
  target: BrainLlmTarget,
  input: {
    system: string;
    user: string;
    timeoutMs: number;
    maxTokens?: number | undefined;
    responseFormat?: ResponseFormat | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<BrainLlmCallResult> {
  if (input.signal?.aborted) {
    throw new DOMException('Brain call aborted before it started.', 'AbortError');
  }
  const response = await callWithDeadline(
    (signal) =>
      target.provider.complete(
        {
          model: target.model,
          system: [{ type: 'text', text: input.system }],
          messages: [{ role: 'user', content: input.user || 'Decide.' }],
          // Unset = the model's ceiling: a reasoning model's thinking draws from
          // this same allowance, and fixed caps (200, then 2000) left empty or
          // mid-JSON replies that the tier reported as `unparseable`.
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
          ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
        },
        { signal },
      ),
    input.signal,
    input.timeoutMs,
    'Brain call timeout exceeded.',
  );
  return {
    text: extractText(response).trim(),
    usage: extractUsage(response),
    stopReason: extractStopReason(response),
  };
}

export function extractUsage(result: unknown): Usage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const usage = (result as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input === 'number' ? u.input : undefined;
  const output = typeof u.output === 'number' ? u.output : undefined;
  if (input === undefined && output === undefined) return undefined;
  return { input: input ?? 0, output: output ?? 0 };
}

export function extractStopReason(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const reason = (result as { stopReason?: unknown }).stopReason;
  return typeof reason === 'string' ? reason : undefined;
}

export function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return (r.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  if (Array.isArray(r.choices)) {
    return (r.choices as Array<{ message?: { content?: string } }>)[0]?.message?.content ?? '';
  }
  return typeof r.text === 'string' ? r.text : '';
}

export function extractConfidence(rawText: string): number | undefined {
  const text = rawText.trim();
  const wholeFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  const candidate = wholeFence ? (wholeFence[1] ?? '').trim() : text;
  const parsed = safeParse<{ confidence?: unknown }>(candidate, 16_384);
  if (!parsed.ok || !parsed.value) return undefined;
  const value = parsed.value.confidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

const LLM_NON_ANSWER =
  /\b(?:insufficient evidence|not enough (?:information|context|evidence)|cannot determine|can't determine|unable to determine|i (?:don't|do not) know|unclear|please (?:clarify|specify)|need more (?:information|context|detail)|as an ai)\b/i;

export function isNonAnswer(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || LLM_NON_ANSWER.test(trimmed);
}

export interface BrainFreeTextEnvelope {
  decision: string;
  rationale?: string | undefined;
  confidence?: number | undefined;
}

export function parseFreeTextDecision(rawText: string): BrainFreeTextEnvelope | null {
  const text = rawText.trim();
  if (text.length === 0) return null;

  const wholeFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  const candidate = wholeFence ? (wholeFence[1] ?? '').trim() : text;
  const parsed = safeParse<{ decision?: unknown; rationale?: unknown; confidence?: unknown }>(
    candidate,
    16_384,
  );
  if (parsed.ok && parsed.value && typeof parsed.value.decision === 'string') {
    const decision = parsed.value.decision.trim();
    if (isNonAnswer(decision)) return null;
    return {
      decision,
      rationale:
        typeof parsed.value.rationale === 'string' && parsed.value.rationale.trim()
          ? parsed.value.rationale.trim()
          : undefined,
      confidence:
        typeof parsed.value.confidence === 'number' && Number.isFinite(parsed.value.confidence)
          ? Math.min(1, Math.max(0, parsed.value.confidence))
          : undefined,
    };
  }

  if (isNonAnswer(text)) return null;
  return { decision: text };
}

export function parseOptionDecision(
  rawText: string,
  options: NonNullable<BrainDecisionRequest['options']>,
): BrainDecision | null {
  const text = rawText.trim();
  const byId = new Map(options.map((option) => [option.id, option] as const));

  const wholeFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  const jsonCandidate = wholeFence ? (wholeFence[1] ?? '').trim() : text;
  const parsed = safeParse<{ optionId?: unknown; rationale?: unknown }>(jsonCandidate, 16_384);
  if (parsed.ok && parsed.value && typeof parsed.value.optionId === 'string') {
    const option = byId.get(parsed.value.optionId);
    if (!option) return null;
    return {
      type: 'answer',
      optionId: option.id,
      text: option.label,
      rationale:
        typeof parsed.value.rationale === 'string' && parsed.value.rationale.trim()
          ? parsed.value.rationale.trim()
          : undefined,
    };
  }

  const legacy = /^\s*\[([^\]\r\n]+)\](?:\s*(?:—|-|:)\s*)?([\s\S]*)$/.exec(text);
  if (!legacy) return null;
  const option = byId.get((legacy[1] ?? '').trim());
  if (!option) return null;
  const rationale = (legacy[2] ?? '').trim();
  return {
    type: 'answer',
    optionId: option.id,
    text: option.label,
    rationale: rationale || undefined,
  };
}

function parseLlmVerdict(
  request: BrainDecisionRequest,
  text: string,
  truncated: boolean,
  maxTokens: number | undefined,
  quality: { rejectUncertain: boolean; minConfidence: number } | undefined,
): BrainDecision {
  const withTruncation = (reason: string) =>
    truncated
      ? `${reason} (response truncated at ${maxTokens === undefined ? "the model's output ceiling" : `maxTokens=${maxTokens}`})`
      : reason;
  const minConfidence = quality?.minConfidence ?? 0;
  const confidence = extractConfidence(text);
  if (minConfidence > 0 && confidence !== undefined && confidence < minConfidence) {
    return markDenyKind(
      {
        type: 'deny',
        reason: `Autonomy Brain reported confidence ${confidence} below the ${minConfidence} floor.`,
      },
      'unparseable',
    );
  }
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/i, '$1')
    .trim();
  const refusal = safeParse<{ type?: unknown; reason?: unknown }>(candidate, 16_384);
  if (
    refusal.ok &&
    refusal.value?.type === 'deny' &&
    typeof refusal.value.reason === 'string' &&
    refusal.value.reason.trim()
  ) {
    return markDenyKind({ type: 'deny', reason: refusal.value.reason.trim() }, 'refused');
  }
  if (request.options?.length) {
    const parsed = parseOptionDecision(text, request.options);
    return (
      parsed ??
      markDenyKind(
        {
          type: 'deny',
          reason: withTruncation('Autonomy Brain returned no exact valid option id.'),
        },
        'unparseable',
      )
    );
  }
  const envelope = parseFreeTextDecision(text);
  if ((quality?.rejectUncertain ?? true) && !envelope) {
    return markDenyKind(
      {
        type: 'deny',
        reason: withTruncation('Autonomy Brain returned no usable decision (empty or declined).'),
      },
      'unparseable',
    );
  }
  return {
    type: 'answer',
    text:
      envelope?.decision ||
      (request.fallback === 'continue' ? 'Continue execution.' : 'Denied by autonomy policy.'),
    rationale: envelope?.rationale ?? envelope?.decision ?? undefined,
  };
}

export async function llmDecide(
  request: BrainDecisionRequest,
  targets: BrainLlmTarget[],
  timeoutMs: number,
  digest?: string | undefined,
  trace?: { events: EventBus; content: boolean } | undefined,
  maxTokens?: number | undefined,
  quality?: { rejectUncertain: boolean; minConfidence: number } | undefined,
  circuit?: BrainCircuitBreaker | undefined,
): Promise<BrainDecision> {
  const systemPrompt = readBundledInstructionText('llm/autonomy-brain.md');
  const userMessage = withDecisionDigest(buildBrainUserMessage(request), digest);

  const effectiveMaxTokens = maxTokens;
  // Bound the whole pool walk, not just each call. Without this a deep
  // fallback chain of dead endpoints blocks the caller for N x timeoutMs.
  const overallBudgetMs = timeoutMs * Math.min(targets.length, BRAIN_LLM_MAX_BUDGETED_ATTEMPTS);
  const deadline = Date.now() + overallBudgetMs;

  let lastInvalid: BrainDecision | undefined;
  let deadlineHit = false;
  for (const [attempt, target] of targets.entries()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      deadlineHit = true;
      break;
    }
    const startedAt = Date.now();
    try {
      const result = await completeBrainLlmDetailed(target, {
        system: systemPrompt,
        user: userMessage,
        // Never let one target overrun the decision's whole budget.
        timeoutMs: Math.min(timeoutMs, remaining),
        maxTokens: effectiveMaxTokens,
        // The system prompt demands "exactly one JSON object and no
        // markdown", but asking for it in prose is not the same as asking
        // for it on the wire - which is precisely what reasoning-heavy
        // models ignore. Providers without the field drop it harmlessly.
        responseFormat: { type: 'json_object' },
      });
      const text = result.text;
      const truncated = isTruncated(result.stopReason);
      const verdict = parseLlmVerdict(request, text, truncated, effectiveMaxTokens, quality);
      const usable = verdict.type === 'answer' || readLlmDenyKind(verdict) === 'refused';
      if (usable) circuit?.recordSuccess(target.label ?? target.model);
      else circuit?.recordFailure(target.label ?? target.model);
      trace?.events.emit('brain.llm_call', {
        sessionId: request.sessionId,
        requestId: request.id,
        tier: 'llm',
        providerId: target.provider.id,
        model: target.model,
        label: target.label,
        attempt,
        ok: true,
        durationMs: Date.now() - startedAt,
        // A truncated call SUCCEEDED at the transport level, so it stays
        // `ok: true`; the flag is what lets a reader tell "the model returned
        // garbage" from "the model was cut off". Reporting it as `error` on
        // an ok row (the previous shape) forced every consumer to pick one
        // reading or the other.
        ...(truncated ? { truncated: true } : {}),
        ...(trace.content ? { responseText: text } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        at: Date.now(),
      });
      if (usable) return verdict;
      lastInvalid = verdict;
    } catch (err) {
      circuit?.recordFailure(target.label ?? target.model);
      trace?.events.emit('brain.llm_call', {
        sessionId: request.sessionId,
        requestId: request.id,
        tier: 'llm',
        providerId: target.provider.id,
        model: target.model,
        label: target.label,
        attempt,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
    }
  }

  if (!lastInvalid) {
    return markDenyKind(
      {
        type: 'deny',
        reason: deadlineHit
          ? 'Autonomy Brain LLM pool exhausted its ' + overallBudgetMs + 'ms decision budget.'
          : 'Autonomy Brain LLM unavailable for decision.',
      },
      'unavailable',
    );
  }

  return lastInvalid;
}
