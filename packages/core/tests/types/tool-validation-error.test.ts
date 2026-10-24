import {
  ERROR_CODES,
  isToolValidationError,
  ToolValidationError,
  WrongStackError,
} from '@wrongstack/contracts/types/errors';
import { describe, expect, it } from 'vitest';

/**
 * P2 #6 (before-release.md): classifyToolError() detected validation errors by
 * checking `err.message.includes('validation')` — fragile and locale-dependent.
 * The fix adds a structured `ToolValidationError` subclass that the classifier
 * matches via `instanceof` (locale-independent, no false positives). These
 * tests pin the subclass contract the classifier depends on.
 *
 * Note: the class is named `ToolValidationError` (not `ValidationError`) to
 * avoid colliding with the existing `ValidationError` interface exported by
 * json-schema-validate.ts (a validation-result shape, not an Error subclass).
 */
describe('ToolValidationError — structured validation error (P2 #6)', () => {
  it('is a WrongStackError with VALIDATION_ERROR code', () => {
    const err = new ToolValidationError({ message: 'old_string cannot be empty' });
    expect(err).toBeInstanceOf(WrongStackError);
    expect(err).toBeInstanceOf(ToolValidationError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(err.name).toBe('ToolValidationError');
  });

  it('carries the message verbatim', () => {
    const err = new ToolValidationError({ message: 'path is required' });
    expect(err.message).toBe('path is required');
  });

  it('records the field that failed validation in context', () => {
    const err = new ToolValidationError({
      message: 'value out of range',
      field: 'count',
    });
    expect(err.context).toMatchObject({ field: 'count' });
  });

  it('preserves a cause for error chaining', () => {
    const root = new Error('underlying parse failure');
    const err = new ToolValidationError({
      message: 'input failed validation',
      cause: root,
    });
    expect(err.cause).toBe(root);
  });

  it('is non-recoverable by default (validation errors are not retryable)', () => {
    const err = new ToolValidationError({ message: 'bad input' });
    expect(err.recoverable).toBe(false);
  });

  it('is detected by isToolValidationError type guard', () => {
    const err = new ToolValidationError({ message: 'bad' });
    const plain = new Error('validation failed'); // bare Error, not the subclass
    expect(isToolValidationError(err)).toBe(true);
    expect(isToolValidationError(plain)).toBe(false);
    expect(isToolValidationError(null)).toBe(false);
    expect(isToolValidationError('string')).toBe(false);
    expect(isToolValidationError(undefined)).toBe(false);
  });

  it('an error whose message contains "validation" is NOT automatically a ToolValidationError', () => {
    // This is the regression P2 #6 fixes: a third-party error like
    // "input validation timeout" should not be misclassified. The instanceof
    // check is the reliable discriminator; the message substring is only a
    // legacy fallback in classifyToolError.
    const impostor = new Error('input validation timeout');
    expect(isToolValidationError(impostor)).toBe(false);
    expect(impostor instanceof ToolValidationError).toBe(false);
  });
});
