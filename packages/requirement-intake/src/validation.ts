/**
 * Requirements Intake — deterministic input validation.
 *
 * User-provided text is untrusted data. It is validated for shape and size
 * only; it is never executed or interpreted as instructions. Prompt-injection
 * text such as "ignore all previous instructions" passes validation unchanged
 * and is stored as ordinary request content.
 */
import { z } from 'zod';
import {
  INTAKE_ATTACHMENT_KINDS,
  INTAKE_PRIORITIES,
  INTAKE_QUESTION_STATUSES,
  type IntakeFieldSource,
  MAX_ANSWER_LENGTH,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENTS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_ENTRIES,
  MAX_QUESTION_LENGTH,
  MAX_REFERENCE_LENGTH,
  MAX_RELATED_RESOURCES,
  MAX_REQUEST_LENGTH,
  MAX_STRING_FIELD_LENGTH,
  MAX_TITLE_LENGTH,
  RELATED_RESOURCE_KINDS,
  REQUEST_TYPES,
  type RequestType,
} from './constants.js';
import { IntakeValidationError, type IntakeValidationIssue } from './errors.js';
import type {
  AddAnswerInput,
  AttachResourceInput,
  CreateIntakeInput,
  IntakeAttachmentInput,
  IntakeQuestionTemplateInput,
  RelatedResourceInput,
  UpdateIntakeInput,
} from './types.js';

export const requestTypeSchema = z.enum(REQUEST_TYPES);
export const prioritySchema = z.enum(INTAKE_PRIORITIES);
export const intakeQuestionStatusSchema = z.enum(INTAKE_QUESTION_STATUSES);
export const fieldSourceSchema = z.enum(['user', 'llm', 'deterministic', 'system']);

const httpUrlSchema = z
  .string()
  .trim()
  .max(MAX_REFERENCE_LENGTH)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be a valid http(s) URL');

const idSchema = z.string().trim().min(1).max(128);
const nonBlankString = (max: number, label: string) =>
  z
    .string()
    .max(max, `${label} exceeds the maximum length of ${max} characters`)
    .refine((value) => value.trim().length > 0, `${label} must not be empty or whitespace-only`);
const normalizedOptionalString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional();

export const attachmentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(INTAKE_ATTACHMENT_KINDS),
    path: z.string().trim().min(1).max(MAX_REFERENCE_LENGTH).optional(),
    url: httpUrlSchema.optional(),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    mimeType: normalizedOptionalString(100),
  })
  .refine((value) => (value.path === undefined) !== (value.url === undefined), {
    message: 'exactly one of path or url is required',
  });

export const relatedResourceInputSchema = z
  .object({
    kind: z.enum(RELATED_RESOURCE_KINDS),
    reference: z.string().trim().min(1).max(MAX_REFERENCE_LENGTH),
    title: normalizedOptionalString(200),
  })
  .refine((value) => value.kind !== 'url' || httpUrlSchema.safeParse(value.reference).success, {
    path: ['reference'],
    message: 'URL resource reference must be a valid http(s) URL',
  });

export const questionTemplateInputSchema = z.object({
  field: z.string().trim().min(1).max(64),
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  required: z.boolean().optional(),
});

export const metadataSchema = z
  .record(z.string().max(64), z.unknown())
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);
    if (keys.length > MAX_METADATA_ENTRIES) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `metadata exceeds the maximum of ${MAX_METADATA_ENTRIES} entries`,
      });
    }
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      ctx.addIssue({ code: 'custom', path: [], message: 'metadata must be JSON-serializable' });
      return;
    }
    if (bytes > MAX_METADATA_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `metadata exceeds the maximum size of ${MAX_METADATA_BYTES} bytes`,
      });
    }
  });

const optionalString = (max: number) => z.string().max(max).optional();
const optionalStringArray = z
  .array(z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH))
  .max(MAX_ARRAY_ITEMS)
  .optional();
const optionalAttachmentArray = z.array(attachmentInputSchema).max(MAX_ATTACHMENTS).optional();
const optionalRelatedResourceArray = z
  .array(relatedResourceInputSchema)
  .max(MAX_RELATED_RESOURCES)
  .optional();

/** Strict, bounded representation of resumable VIBE protocol state. */
export const vibeProtocolStateSchema = z
  .object({
    isVibeMode: z.literal(true),
    detectedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    stage: z.enum(['synthesizer', 'coder', 'auditor', 'passed']),
    synthesizedSpec: z.string().max(MAX_ANSWER_LENGTH).optional(),
    coderContract: z.string().max(MAX_ANSWER_LENGTH).optional(),
    auditVerdict: z.enum(['PASS', 'REJECT']).optional(),
    auditNotes: z.array(z.string().max(MAX_STRING_FIELD_LENGTH)).max(MAX_ARRAY_ITEMS).optional(),
  })
  .strict();

export const createIntakeSchema = z
  .object({
    projectId: idSchema,
    originalRequest: nonBlankString(MAX_REQUEST_LENGTH, 'originalRequest'),
    title: optionalString(MAX_TITLE_LENGTH),
    requestType: z.string().max(64).optional(),
    priority: prioritySchema.optional(),
    requestedBy: idSchema,
    businessGoal: optionalString(MAX_STRING_FIELD_LENGTH),
    targetUsers: optionalStringArray,
    expectedOutcome: optionalString(MAX_STRING_FIELD_LENGTH),
    scopeNotes: optionalString(MAX_STRING_FIELD_LENGTH),
    constraints: optionalStringArray,
    providedContext: optionalStringArray,
    attachments: optionalAttachmentArray,
    relatedResources: optionalRelatedResourceArray,
    metadata: metadataSchema.optional(),
    idempotencyKey: z.string().trim().max(MAX_IDEMPOTENCY_KEY_LENGTH).optional(),
    knownFields: z.array(z.string().trim().min(1).max(64)).max(MAX_ARRAY_ITEMS).optional(),
    questions: z.array(questionTemplateInputSchema).max(50).optional(),
    isVibeMode: z.boolean().optional(),
    vibeProtocol: vibeProtocolStateSchema.optional(),
  })
  .strict();

export const updateIntakeSchema = z
  .object({
    title: optionalString(MAX_TITLE_LENGTH),
    requestType: z.string().max(64).optional(),
    priority: prioritySchema.optional(),
    businessGoal: optionalString(MAX_STRING_FIELD_LENGTH),
    targetUsers: optionalStringArray,
    expectedOutcome: optionalString(MAX_STRING_FIELD_LENGTH),
    scopeNotes: optionalString(MAX_STRING_FIELD_LENGTH),
    constraints: optionalStringArray,
    providedContext: optionalStringArray,
    metadata: metadataSchema.optional(),
    isVibeMode: z.boolean().optional(),
    vibeProtocol: vibeProtocolStateSchema.optional(),
  })
  .strict();

export const answerInputSchema = z.object({
  field: z
    .string()
    .trim()
    .min(1, 'answer field must not be empty or whitespace-only')
    .max(64, 'answer field exceeds the maximum length of 64 characters'),
  answer: z.string().trim().min(1).max(MAX_ANSWER_LENGTH),
  question: z
    .string()
    .trim()
    .max(MAX_QUESTION_LENGTH)
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
});

export const attachResourceInputSchema = z
  .object({
    attachment: attachmentInputSchema.optional(),
    relatedResource: relatedResourceInputSchema.optional(),
  })
  .refine((value) => (value.attachment === undefined) !== (value.relatedResource === undefined), {
    message: 'exactly one of attachment or relatedResource must be provided',
  });

/**
 * Normalize a request-type candidate to the authoritative enum.
 * Unknown/unsupported values map to `other`; missing/non-string values map
 * to `unspecified`. Uncontrolled strings are never persisted.
 */
export function normalizeRequestType(value: unknown): RequestType {
  if (typeof value !== 'string') return 'unspecified';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return 'unspecified';
  const normalized = trimmed.replace(/-/g, '_');
  if ((REQUEST_TYPES as readonly string[]).includes(normalized)) return normalized as RequestType;
  return 'other';
}

/** True when a string is empty or whitespace-only. */
export function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Parse unknown input against a zod schema and throw a field-level
 * `IntakeValidationError` on failure.
 */
export function parseWithIssues<T>(schema: z.ZodType<T>, data: unknown, scope: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues: IntakeValidationIssue[] = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return {
      field: path === '' ? scope : `${scope}.${path}`,
      message: issue.message,
    };
  });
  throw new IntakeValidationError(issues);
}

/** Validate a create payload. Returns the normalized (still untrusted-free) input. */
export function validateCreateInput(data: unknown): CreateIntakeInput {
  return parseWithIssues(createIntakeSchema, data, 'createIntake');
}

export function validateUpdateInput(data: unknown): UpdateIntakeInput {
  return parseWithIssues(updateIntakeSchema, data, 'updateIntake');
}

export function validateAnswerInput(data: unknown): AddAnswerInput {
  return parseWithIssues(answerInputSchema, data, 'addAnswer');
}

export function validateAttachResourceInput(data: unknown): AttachResourceInput {
  return parseWithIssues(attachResourceInputSchema, data, 'attachResource');
}

export function validateAttachmentInput(data: unknown): IntakeAttachmentInput {
  return parseWithIssues(attachmentInputSchema, data, 'attachment');
}

export function validateRelatedResourceInput(data: unknown): RelatedResourceInput {
  return parseWithIssues(relatedResourceInputSchema, data, 'relatedResource');
}

export function validateQuestionTemplateInput(data: unknown): IntakeQuestionTemplateInput {
  return parseWithIssues(questionTemplateInputSchema, data, 'question');
}

export function validateFieldSource(value: unknown): IntakeFieldSource {
  const parsed = fieldSourceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new IntakeValidationError([{ field: 'source', message: 'invalid field source' }]);
}

/**
 * UTF-16-safe cut end for the `slice(0, end)` + ellipsis truncations below.
 * When the last retained unit is a high surrogate, its low partner falls at
 * or beyond the cut, and the result would be persisted and re-serialized as
 * ill-formed text — a lone surrogate escapes as `\udXXX`, which strict JSON
 * consumers reject outright. Walk back one unit instead (the same boundary
 * rule `primitives/string.ts` truncate pins). BMP text is unaffected: the
 * check only fires on a straddling surrogate pair.
 */
function safeTruncateEnd(text: string, end: number): number {
  const lastRetained = text.charCodeAt(end - 1);
  return lastRetained >= 0xd800 && lastRetained <= 0xdbff ? end - 1 : end;
}

/** Deterministic fallback summary derived from the original request. */
export function deterministicSummary(originalRequest: string, maxLength = 240): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
  if (limit === 0) return '';
  const collapsed = originalRequest.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, safeTruncateEnd(collapsed, limit - 1)).trimEnd()}…`;
}

/** Deterministic fallback title derived from the original request. */
export function deterministicTitle(originalRequest: string, maxLength = MAX_TITLE_LENGTH): string {
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
  if (limit === 0) return '';
  const newlineIdx = originalRequest.search(/\r?\n/);
  const firstLine = (
    newlineIdx >= 0 ? originalRequest.slice(0, newlineIdx) : originalRequest
  ).trim();
  const title = firstLine.length === 0 ? 'Untitled request' : firstLine;
  if (title.length <= limit) return title;
  return `${title.slice(0, safeTruncateEnd(title, limit - 1)).trimEnd()}…`;
}
