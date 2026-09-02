import type { BrainDecision, BrainDecisionRequest } from '../coordination/brain.js';
import type { EventBus } from '../kernel/events.js';
import type { Provider, ResponseFormat, Usage } from '../types/provider.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import { safeParse } from '../utils/safe-json.js';
import type { BrainCircuitBreaker } from './brain-circuit.js';

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

export const DEFAULT_BRAIN_MAX_TOKENS = 200;

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
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const response = await target.provider.complete(
    {
      model: target.model,
      system: [{ type: 'text', text: input.system }],
      messages: [{ role: 'user', content: input.user || 'Decide.' }],
      maxTokens: input.maxTokens ?? DEFAULT_BRAIN_MAX_TOKENS,
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
    },
    { signal },
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

  let text: string | null = null;
  for (const [attempt, target] of targets.entries()) {
    const startedAt = Date.now();
    try {
      const result = await completeBrainLlmDetailed(target, {
        system: systemPrompt,
        user: userMessage,
        timeoutMs,
        maxTokens,
      });
      text = result.text;
      circuit?.recordSuccess(target.label ?? target.model);
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
        ...(result.stopReason === 'max_tokens' ? { error: 'response truncated at maxTokens' } : {}),
        ...(trace.content ? { responseText: text } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        at: Date.now(),
      });
      break;
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

  if (text === null) {
    return markDenyKind(
      { type: 'deny', reason: 'Autonomy Brain LLM unavailable for decision.' },
      'unavailable',
    );
  }

  const minConfidence = quality?.minConfidence ?? 0;
  const rejectUncertain = quality?.rejectUncertain ?? true;
  const confidence = extractConfidence(text);
  const belowConfidence =
    minConfidence > 0 && confidence !== undefined && confidence < minConfidence;

  if (request.options?.length) {
    const parsed = parseOptionDecision(text, request.options);
    if (parsed && !belowConfidence) {
      return parsed;
    }
    return markDenyKind(
      {
        type: 'deny',
        reason: belowConfidence
          ? `Autonomy Brain reported confidence ${confidence} below the ${minConfidence} floor.`
          : 'Autonomy Brain returned no exact valid option id.',
      },
      'unparseable',
    );
  }

  const envelope = parseFreeTextDecision(text);
  if (rejectUncertain && (!envelope || belowConfidence)) {
    return markDenyKind(
      {
        type: 'deny',
        reason: belowConfidence
          ? `Autonomy Brain reported confidence ${confidence} below the ${minConfidence} floor.`
          : 'Autonomy Brain returned no usable decision (empty or declined).',
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
