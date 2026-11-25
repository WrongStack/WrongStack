/**
 * Field-level validators shared by the mailbox input codecs. Split out of
 * mailbox-codecs.ts.
 */
import type { MailboxActorContext, MailboxCapability } from './mailbox-types.js';
import { hasMailboxCapability, type MailboxAudience } from './mailbox-types.js';

// ── Internal helpers ─────────────────────────────────────────────────

/** Reject unknown fields on mutation inputs. */
export function rejectUnknownFields(
  payload: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  op: string,
): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new MailboxValidationError(
        'VALIDATION_ERROR',
        key,
        `unknown field "${key}" in ${op} payload`,
      );
    }
  }
}

export function requireString(payload: Record<string, unknown>, field: string, op: string): string {
  const val = Object.hasOwn(payload, field) ? payload[field] : undefined;
  if (val === undefined || val === null) {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      field,
      `missing required field "${field}" in ${op}`,
    );
  }
  if (typeof val !== 'string') {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      field,
      `field "${field}" must be a string`,
    );
  }
  if (val.length === 0) {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      field,
      `field "${field}" must not be empty`,
    );
  }
  return val;
}

export function optionalString(
  payload: Record<string, unknown>,
  field: string,
  _op: string,
): string | undefined {
  const val = Object.hasOwn(payload, field) ? payload[field] : undefined;
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      field,
      `field "${field}" must be a string`,
    );
  }
  return val || undefined;
}

export function optionalBoolean(
  payload: Record<string, unknown>,
  field: string,
  _op: string,
): boolean | undefined {
  const val = Object.hasOwn(payload, field) ? payload[field] : undefined;
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      field,
      `field "${field}" must be a boolean`,
    );
  }
  return val;
}

export function optionalNonNegInt(
  payload: Record<string, unknown>,
  field: string,
  _op: string,
): number | undefined {
  const val = Object.hasOwn(payload, field) ? payload[field] : undefined;
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      field,
      `field "${field}" must be a non-negative number`,
    );
  }
  return Math.floor(val);
}

export function validatePriority(val: unknown): 'low' | 'normal' | 'high' {
  if (val === undefined || val === null) return 'normal';
  if (typeof val !== 'string') {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      'priority',
      'field "priority" must be a string',
    );
  }
  if (val === 'low' || val === 'normal' || val === 'high') return val;
  throw new MailboxValidationError('VALIDATION_ERROR', 'priority', `invalid priority "${val}"`);
}

export function validateAudience(val: unknown): MailboxAudience {
  if (val === undefined || val === null) return 'all';
  if (typeof val !== 'string') {
    throw new MailboxValidationError(
      'VALIDATION_ERROR',
      'audience',
      'field "audience" must be a string',
    );
  }
  if (val === 'all' || val === 'leaders') return val;
  throw new MailboxValidationError('VALIDATION_ERROR', 'audience', `invalid audience "${val}"`);
}

/**
 * Assert that the actor holds a capability. Uses implication rules:
 * if the actor holds a higher-tier capability that implies the required
 * one, the check passes.
 */
export function assertCapability(
  actor: Pick<MailboxActorContext, 'capabilities'>,
  cap: MailboxCapability,
  op: string,
): void {
  // Delegates to the canonical graph in `mailbox-auth-types.ts`. This used to
  // carry a hand-maintained INVERSE of that table (required capability → the
  // capabilities that imply it). It happened to agree, but an inverse index of
  // a table that already exists is a drift waiting to happen: adding one edge
  // to `MAILBOX_CAPABILITY_IMPLICATIONS` and forgetting to invert it here
  // fails open on one surface and closed on the other, with nothing to catch
  // it. `hasMailboxCapability` computes the closure from the single table.
  if (hasMailboxCapability(actor, cap)) return;
  throw new MailboxValidationError(
    'FORBIDDEN',
    'capabilities',
    `actor lacks required capability "${cap}" for ${op}`,
  );
}

// ── Error class ──────────────────────────────────────────────────────

/**
 * Structured validation error from a boundary codec. Carries a stable
 * error code and field path so every surface produces the same shape.
 */
export class MailboxValidationError extends Error {
  readonly code: string;
  readonly field: string;
  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = 'MailboxValidationError';
    this.code = code;
    this.field = field;
  }
}
