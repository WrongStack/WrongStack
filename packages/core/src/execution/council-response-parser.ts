import type { CouncilQuestion, CouncilVoteResult } from '../types/council.js';
import type { OneShotLLMResult } from '../types/one-shot-llm.js';

export interface ParsedVote {
  optionId?: string | undefined;
  stance?: string | undefined;
  rationale?: string | undefined;
}

export interface ParsedJudge {
  optionId?: string | undefined;
  answer?: string | undefined;
  rationale?: string | undefined;
}

export interface ParsedCouncilResponse {
  optionId?: string | undefined;
  stance?: string | undefined;
  answer?: string | undefined;
  rationale?: string | undefined;
}

export function parseObject(
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

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseCouncilResponse(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
  opts: { role: 'voter' | 'judge'; freeTextField: 'stance' | 'answer' },
): { ok: true; value: ParsedCouncilResponse } | { ok: false; error: string } {
  const roleLabel = opts.role === 'judge' ? 'Judge' : 'Voter';
  const parsed = parseObject(text);
  if (!parsed.ok && (!question.options || question.options.length === 0)) {
    const fallback = text.trim();
    if (fallback) return { ok: true, value: { [opts.freeTextField]: fallback } };
    return { ok: false, error: `${roleLabel} returned an empty response.` };
  }
  if (!parsed.ok) return parsed;
  const rationale = optionalString(parsed.value['rationale']);
  if (question.options && question.options.length > 0) {
    const optionId = optionalString(parsed.value['optionId']);
    const allowed = new Set([
      ...question.options.map((option) => option.id.trim()),
      refusalOptionId,
    ]);
    if (!optionId || !allowed.has(optionId)) {
      return { ok: false, error: `${roleLabel} returned an unknown or missing optionId.` };
    }
    return { ok: true, value: { optionId, ...(rationale ? { rationale } : {}) } };
  }
  const freeText = optionalString(parsed.value[opts.freeTextField]);
  if (!freeText) {
    return {
      ok: false,
      error: `${roleLabel} returned an empty or missing ${opts.freeTextField}.`,
    };
  }
  return {
    ok: true,
    value: { [opts.freeTextField]: freeText, ...(rationale ? { rationale } : {}) },
  };
}

export function divergentStances(
  valid: readonly (CouncilVoteResult & { stance: string })[],
): boolean {
  const seen = new Set<string>();
  for (const vote of valid) {
    const normalized = vote.stance
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .toLowerCase()
      .replace(/[.!?;:,]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return true;
    seen.add(normalized);
    if (seen.size > 1) return true;
  }
  return false;
}

export function parseVote(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
): { ok: true; vote: ParsedVote } | { ok: false; error: string } {
  const parsed = parseCouncilResponse(text, question, refusalOptionId, {
    role: 'voter',
    freeTextField: 'stance',
  });
  if (!parsed.ok) return parsed;
  const { optionId, stance, rationale } = parsed.value;
  return {
    ok: true,
    vote: {
      ...(optionId ? { optionId } : {}),
      ...(stance ? { stance } : {}),
      ...(rationale ? { rationale } : {}),
    },
  };
}

export function parseJudge(
  text: string,
  question: CouncilQuestion,
  refusalOptionId: string,
): { ok: true; value: ParsedJudge } | { ok: false; error: string } {
  const parsed = parseCouncilResponse(text, question, refusalOptionId, {
    role: 'judge',
    freeTextField: 'answer',
  });
  if (!parsed.ok) return parsed;
  const { optionId, answer, rationale } = parsed.value;
  return {
    ok: true,
    value: {
      ...(optionId ? { optionId } : {}),
      ...(answer ? { answer } : {}),
      ...(rationale ? { rationale } : {}),
    },
  };
}

export function withTruncationNote(
  error: string,
  result: OneShotLLMResult,
  maxTokens: number,
): string {
  if (result.stopReason !== 'max_tokens') return error;
  return `${error} (response truncated at maxTokens=${maxTokens} — reasoning models may need a larger budget)`;
}
