/**
 * Parsing of AI output for `AISpecBuilder`: locating a JSON object / array in
 * free text and validating + normalizing a specification object.
 */
import type { Specification, SpecRequirement, SpecSection } from '@wrongstack/contracts/types';
import { ERROR_CODES, SddError } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';

/**
 * Parse a spec from a JSON string (from AI output). Validates and normalizes
 * the structure; `fallbackTitle` applies when the JSON has none, `sessionId`
 * is recorded in the spec metadata.
 */
export function parseSpecificationJSON(
  jsonStr: string,
  fallbackTitle: string,
  sessionId: string,
): Specification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new SddError({
      message: 'Invalid JSON for spec',
      code: ERROR_CODES.SDD_PARSE_FAILED,
      cause: e,
      context: { detail: toErrorMessage(e) },
    });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new SddError({
      message: 'Spec JSON must be an object',
      code: ERROR_CODES.SDD_VALIDATION_FAILED,
      context: { actualType: typeof parsed },
    });
  }

  const raw = parsed as Record<string, unknown>;
  const now = Date.now();

  const title = String(raw.title ?? fallbackTitle);
  const overview = String(raw.overview ?? '');

  // Validate overview is not empty
  if (!overview || overview === 'undefined') {
    throw new SddError({
      message: 'Spec must have an overview',
      code: ERROR_CODES.SDD_VALIDATION_FAILED,
      context: { field: 'overview', title },
    });
  }

  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  const sections: SpecSection[] = rawSections
    .filter((s: unknown) => s && typeof s === 'object')
    .map((s: Record<string, unknown>) => ({
      type: ([
        'overview',
        'requirements',
        'architecture',
        'api',
        'data',
        'security',
        'acceptance',
      ].includes(String(s.type))
        ? String(s.type)
        : 'overview') as SpecSection['type'],
      title: String(s.title ?? ''),
      content: String(s.content ?? ''),
      level: Number(s.level) || 1,
    }));

  const rawReqs = Array.isArray(raw.requirements) ? raw.requirements : [];
  const requirements: SpecRequirement[] = rawReqs
    .filter((r: unknown) => r && typeof r === 'object')
    .map((r: Record<string, unknown>, i: number) => ({
      id: String(r.id ?? `REQ-${i + 1}`),
      type: (['functional', 'non-functional', 'security', 'performance', 'ux'].includes(
        String(r.type),
      )
        ? String(r.type)
        : 'functional') as SpecRequirement['type'],
      priority: (['critical', 'high', 'medium', 'low'].includes(String(r.priority))
        ? String(r.priority)
        : 'medium') as SpecRequirement['priority'],
      description: String(r.description ?? ''),
      acceptanceCriteria: Array.isArray(r.acceptanceCriteria)
        ? r.acceptanceCriteria.map(String)
        : [],
    }));

  const spec: Specification = {
    id: crypto.randomUUID(),
    title,
    version: '0.1.0',
    status: 'draft',
    overview,
    sections,
    requirements,
    createdAt: now,
    updatedAt: now,
    metadata: {
      generatedBy: 'AISpecBuilder',
      sessionId,
    },
  };

  return spec;
}

/** Extract JSON from AI output (handles ```json blocks and raw JSON). */
export function extractJSONFromText(text: string): string | null {
  // Try ```json ... ``` first
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try ``` ... ``` without language tag
  const genericBlockMatch = text.match(/```\s*([\s\S]*?)```/);
  if (genericBlockMatch?.[1]) {
    const trimmed = genericBlockMatch[1].trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return trimmed;
    }
  }

  // Try raw JSON object
  const jsonMatch = text.match(/(\{[\s\S]*\})/);
  if (jsonMatch?.[1]) {
    try {
      JSON.parse(jsonMatch[1]);
      return jsonMatch[1];
    } catch {
      // not valid JSON
    }
  }

  return null;
}

/** Extract a JSON array from AI output (for task lists). */
export function extractJSONArrayFromText(text: string): string | null {
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    const trimmed = codeBlockMatch[1].trim();
    if (trimmed.startsWith('[')) return trimmed;
  }

  const arrayMatch = text.match(/(\[[\s\S]*\])/);
  if (arrayMatch?.[1]) {
    try {
      const parsed = JSON.parse(arrayMatch[1]);
      if (Array.isArray(parsed)) return arrayMatch[1];
    } catch {
      // not valid
    }
  }

  return null;
}
